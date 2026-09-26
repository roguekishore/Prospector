'use strict';

/**
 * The only place a MySQL connection is opened (R3.1).
 *
 * One pool, at most four connections, shared by every stage in the process. The
 * box is a 2-vCPU t4g.small and mavdb is a `db.t4g.micro` with 1 GiB of memory
 * shared by every app in clasher — a pool sized to the work rather than to the
 * concurrency of the caller is the whole reason this is one module and not a
 * `createConnection` at each call site.
 *
 * ## Two configurations, one rule
 *
 * `DATABASE_URL` wins when it is set: that is the laptop and every test, where
 * the server is a local MySQL with no TLS and the database name must be free to
 * end in `_test`. Otherwise the box's own configuration is assembled from
 * `DB_HOST` and `DB_PASSWORD`, which `load-env.sh` writes into
 * `/run/prospector/env` from SSM, and TLS is verified against the pinned RDS CA
 * bundle — `rejectUnauthorized` makes Node check the host name too, so a
 * peering route that lands on the wrong endpoint fails closed (R3.2).
 *
 * `DATABASE_URL` must never reach SSM. `./p secrets` copies named keys only;
 * keep it that way, or the box would silently prefer an unverified connection.
 *
 * ## Every stage closes the pool
 *
 * A pool holds the event loop open. A CLI stage that returns without calling
 * `close()` leaves the process hanging after its last log line, which looks
 * exactly like a stage that is still working.
 */

const fs = require('fs');

const mysql = require('mysql2/promise');

/** Fail loudly rather than connect to a default that is not the box's. */
function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (and DATABASE_URL is not set either)`);
  return v;
}

const CA_PATH = '/opt/prospector/rds-global-bundle.pem';

function config() {
  if (process.env.DATABASE_URL) return { uri: process.env.DATABASE_URL };
  return {
    host:     must('DB_HOST'),
    user:     'prospector',
    password: must('DB_PASSWORD'),
    database: 'prospector',
    ssl: {
      ca: fs.readFileSync(process.env.RDS_CA_PATH || CA_PATH),
      rejectUnauthorized: true,
    },
  };
}

let pool = null;

/**
 * The shared pool. Created on first use so a stage that never queries — `doctor`,
 * `--dry-run` — never opens a connection and never needs credentials.
 */
function db() {
  if (!pool) {
    pool = mysql.createPool({
      ...config(),
      connectionLimit:    4,
      waitForConnections: true,
      enableKeepAlive:    true,
      // DATETIME and DATE come back as the strings MySQL stores, not as Date
      // objects in the laptop's timezone. Every timestamp here is already UTC;
      // converting it twice is how a `captured_at` moves by five and a half
      // hours between the box and the deck.
      dateStrings:        true,
      supportBigNumbers:  true,
      bigNumberStrings:   true,
    });
  }
  return pool;
}

/** InnoDB's "restart the transaction" errors, which are not failures. */
const RETRYABLE = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);
const TX_ATTEMPTS = 4;

/**
 * Run `fn` inside one transaction on one connection.
 *
 * Commits when `fn` resolves, rolls back and rethrows when it does not. The
 * connection is released on every path — a leaked connection out of a pool of
 * four hangs the process on its fifth query, minutes later and nowhere near the
 * bug.
 *
 * ## READ COMMITTED, not the default
 *
 * `recordDomain` opens with `SELECT … WHERE city = ? AND domain = ? FOR UPDATE`
 * over the non-unique `by_site` index. Under REPEATABLE READ that takes
 * next-key locks, which cover the *gaps* between index entries — so two ingest
 * workers recording `alpha.com` and `beta.com`, which sit next to each other in
 * that index, lock each other's gaps and deadlock. With eight workers that is
 * not a rare race: it happened on the first run of the ingest test.
 *
 * READ COMMITTED takes no gap locks, so each transaction locks only the rows of
 * its own domain. Nothing here needs the stronger isolation: every transaction
 * reads and writes exactly one `(city, domain)` group, which it holds for the
 * duration.
 *
 * ## And a retry anyway
 *
 * InnoDB can still deadlock — foreign-key checks on `links` take their own locks
 * — and when it does it says so by rolling one transaction back and telling the
 * client to try again. That is an instruction, not an error: `fn` is re-run from
 * the beginning on a fresh transaction, which is safe because `recordDomain`
 * reads its "before" state inside the transaction rather than being handed it.
 */
async function tx(fn) {
  let lastErr;
  for (let attempt = 1; attempt <= TX_ATTEMPTS; attempt++) {
    const conn = await db().getConnection();
    try {
      await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await conn.beginTransaction();
      try {
        const out = await fn(conn);
        await conn.commit();
        return out;
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      }
    } catch (err) {
      if (!RETRYABLE.has(err.code) || attempt === TX_ATTEMPTS) throw err;
      lastErr = err;
      // A little backoff, and a different amount per attempt, so two
      // transactions that just deadlocked do not retry in lockstep.
      await new Promise(r => setTimeout(r, 20 * attempt + Math.floor(Math.random() * 20)));
    } finally {
      conn.release();
    }
  }
  throw lastErr;
}

/** Close the pool. Every CLI stage calls this before it returns. */
async function close() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

module.exports = { db, tx, close };

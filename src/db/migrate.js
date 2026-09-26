'use strict';

/**
 * `node src/cli migrate [--import-verticals <file>]`
 *
 * Numbered plain-SQL files in `db/migrations/`, applied in order and recorded in
 * `schema_migrations`. Re-running is a no-op (R3.4).
 *
 * ## Its own connection, not the pool
 *
 * `multipleStatements` lets one file hold several `CREATE TABLE`s, and it is a
 * connection-level flag that must never be on for the rest of the application:
 * with it enabled a single unescaped `;` in a parameter turns one query into
 * two. So migrate opens one connection with it, and `src/db/mysql.js`'s pool
 * never has it.
 *
 * ## One migrator at a time
 *
 * `GET_LOCK` around the whole run. Two boxes, or a box and a laptop, applying
 * `0001` at the same moment would each see an empty `schema_migrations` and both
 * try to create the tables; `IF NOT EXISTS` makes that survivable but the
 * bookkeeping insert would still race.
 *
 * ## DDL auto-commits
 *
 * MySQL has no transactional DDL, so a file that fails half way leaves what ran
 * before it applied and the file unrecorded. Every migration is therefore
 * written so that re-running it is safe (`CREATE TABLE IF NOT EXISTS`, and the
 * same for later `ALTER`s — check before you add one).
 */

const fs   = require('fs');
const path = require('path');

const mysql = require('mysql2/promise');

const LOCK_NAME    = 'prospector_migrate';
const LOCK_TIMEOUT = 30;

const SCHEMA_MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INT          NOT NULL,
    name       VARCHAR(255) NOT NULL,
    applied_at DATETIME     NOT NULL,
    PRIMARY KEY (version)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

/** `0001_init.sql` → `{ version: 1, name: 'init', file }`, ordered by version. */
function migrationFiles(root) {
  const dir = path.join(root, 'db', 'migrations');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter(n => /^\d+_.+\.sql$/.test(n))
    .map(n => ({
      version: parseInt(n.slice(0, n.indexOf('_')), 10),
      name:    n.slice(n.indexOf('_') + 1).replace(/\.sql$/, ''),
      file:    path.join(dir, n),
    }))
    .sort((a, b) => a.version - b.version);
}

/**
 * One connection with `multipleStatements`. Built from the same environment as
 * the pool, so there is one story about where the credentials come from.
 */
async function _connect() {
  if (process.env.DATABASE_URL) {
    return mysql.createConnection({ uri: process.env.DATABASE_URL, multipleStatements: true });
  }
  const host = process.env.DB_HOST;
  const password = process.env.DB_PASSWORD;
  if (!host || !password) {
    throw new Error('DB_HOST and DB_PASSWORD are required (or set DATABASE_URL)');
  }
  return mysql.createConnection({
    host, password,
    user:     'prospector',
    database: 'prospector',
    multipleStatements: true,
    ssl: {
      ca: fs.readFileSync(process.env.RDS_CA_PATH || '/opt/prospector/rds-global-bundle.pem'),
      rejectUnauthorized: true,
    },
  });
}

/**
 * Apply every migration not yet recorded.
 *
 * @returns {Promise<number>} how many files were applied
 */
async function migrate(conn, root, log) {
  await conn.query(SCHEMA_MIGRATIONS);
  const [rows] = await conn.query('SELECT version FROM schema_migrations');
  const done = new Set(rows.map(r => Number(r.version)));

  const pending = migrationFiles(root).filter(m => !done.has(m.version));
  if (!pending.length) {
    log.info('migrate: up to date');
    return 0;
  }

  for (const m of pending) {
    log.info(`migrate: applying ${String(m.version).padStart(4, '0')}_${m.name}`);
    const sql = fs.readFileSync(m.file, 'utf8');
    await conn.query(sql);
    await conn.query(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, UTC_TIMESTAMP())',
      [m.version, m.name]);
  }
  log.info(`migrate: applied ${pending.length} migration(s)`);
  return pending.length;
}

/**
 * Load a JSON array of verticals into the `verticals` table, once (R3.6).
 *
 * Existing slugs are left exactly as they are: the table is the source of truth
 * once seeded, and a re-import must not quietly replace keywords that a run has
 * already been discovered under.
 *
 * Which ones were new is read from the table beforehand, not from
 * `affectedRows`: mysql2 connects with `CLIENT_FOUND_ROWS`, so a duplicate
 * whose `ON DUPLICATE KEY UPDATE` changed nothing still reports a row and a
 * re-import of the same file would claim to have inserted all of it.
 */
async function importVerticals(conn, file, log) {
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = Array.isArray(list) ? list : Object.values(list);
  if (!rows.length) { log.warn(`--import-verticals: ${file} holds no verticals`); return; }

  const [present] = await conn.query('SELECT slug FROM verticals');
  const had = new Set(present.map(r => r.slug));

  let inserted = 0;
  let skipped = 0;
  for (const v of rows) {
    if (!v || !v.slug) {
      log.warn(`--import-verticals: skipping an entry with no slug`);
      skipped++;
      continue;
    }
    await conn.query(
      `INSERT INTO verticals (slug, label, enabled, priority, keywords)
       VALUES (?, ?, ?, ?, CAST(? AS JSON))
       ON DUPLICATE KEY UPDATE vertical_id = vertical_id`,
      [
        v.slug,
        v.label || v.slug,
        v.enabled !== false,
        Number.isFinite(Number(v.priority)) ? Number(v.priority) : 0,
        JSON.stringify(Array.isArray(v.keywords) ? v.keywords : []),
      ]);
    // A slug listed twice in one file is one insert, not two.
    if (!had.has(v.slug)) { had.add(v.slug); inserted++; }
  }
  const already = rows.length - skipped - inserted;
  log.info(`--import-verticals: ${inserted} inserted, ${already} already present`);
}

function _flags(argv) {
  const out = {};
  const arr = (argv || []).slice();
  while (arr.length) {
    const a = arr.shift();
    if (!a.startsWith('--')) continue;
    out[a.slice(2)] = arr.length && !arr[0].startsWith('--') ? arr.shift() : true;
  }
  return out;
}

async function run(argv, ctx) {
  const { root, log } = ctx;
  const flags = _flags(argv);

  const conn = await _connect();
  try {
    const [[lock]] = await conn.query('SELECT GET_LOCK(?, ?) AS got', [LOCK_NAME, LOCK_TIMEOUT]);
    if (Number(lock.got) !== 1) {
      throw new Error(`another migrate holds ${LOCK_NAME} (waited ${LOCK_TIMEOUT}s)`);
    }
    try {
      await migrate(conn, root, log);
      if (flags['import-verticals']) {
        if (flags['import-verticals'] === true) {
          throw new Error('--import-verticals needs a path to a JSON file');
        }
        await importVerticals(conn, path.resolve(root, flags['import-verticals']), log);
      }
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
  } finally {
    await conn.end();
  }
  return { ok: 1, err: 0 };
}

module.exports = { run, migrate, importVerticals, migrationFiles };

'use strict';

/**
 * Offline tests for everything that writes MySQL: migrate, discover, qualify,
 * `recordDomain` and `ingest`.
 *
 *     DATABASE_URL=mysql://root:pw@127.0.0.1:3306/prospector_test npm run test:db
 *
 * No network, no AWS, no browser. Discover runs `--source fixture`, qualify's
 * probe is stubbed, and ingest is given a stub S3 client reading a temp folder.
 * `scripts/test-db-helper.js` refuses to run against a database whose name does
 * not end in `_test`.
 *
 * No framework: plain assertions to stdout, exit 1 on the first that fails.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const helper = require('./test-db-helper');
const { ROOT, resetTestDatabase, truncate, seedVerticals, quietLog } = helper;

const { db, tx, close } = require('../src/db/mysql');
const { recordDomain, validateExtract } = require('../src/db/record');

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`); failed++; failures.push(name); }
}

function eq(name, got, want) {
  assert(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const CITY = 'coimbatore';
const ctx  = { root: ROOT, config: { runId: 'test-run' }, log: quietLog() };

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------
async function testMigrate() {
  console.log('\n--- migrate ---');
  const lines = [];
  const log = (...a) => lines.push(a.join(' '));
  log.info = log; log.warn = log; log.error = log;

  await require('../src/db/migrate').run([], { root: ROOT, log });
  assert('a second migrate is a no-op and says so',
    lines.some(l => l.includes('up to date')), lines.join(' | '));

  const conn = db();
  const [[c]] = await conn.query('SELECT COUNT(*) AS n FROM schema_migrations');
  assert('schema_migrations has a row per file', Number(c.n) >= 1);

  // R3.5 — the columns are the contract, so the contract is what is checked.
  const [cols] = await conn.query(
    'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS' +
    '  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', ['companies']);
  const byName = Object.fromEntries(cols.map(c2 => [c2.COLUMN_NAME, c2]));
  assert('companies.place_id exists', !!byName.place_id);
  eq('companies.https_status is the three-value enum',
    byName.https_status && byName.https_status.COLUMN_TYPE, "enum('ok','expired','none')");
  eq('companies.tier is the four-value enum',
    byName.tier && byName.tier.COLUMN_TYPE, "enum('A','B','C','X')");
  assert('companies.pitch is NOT NULL', byName.pitch && byName.pitch.IS_NULLABLE === 'NO');
  assert('no scoring column survived',
    !['score', 'tier_machine', 'gate', 'angle', 'flaws', 'signals'].some(n => byName[n]),
    Object.keys(byName).join(', '));

  const [idx] = await conn.query(
    'SELECT INDEX_NAME FROM information_schema.STATISTICS' +
    '  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? GROUP BY INDEX_NAME', ['companies']);
  const names = idx.map(i => i.INDEX_NAME);
  for (const want of ['PRIMARY', 'by_place', 'by_site', 'by_work']) {
    assert(`companies has index ${want}`, names.includes(want), names.join(', '));
  }
}

/**
 * R3.6 — `--import-verticals` seeds the table once and says truthfully how much
 * of the file was new.
 *
 * The counts are the point of this test. `affectedRows` cannot produce them:
 * mysql2 connects with `CLIENT_FOUND_ROWS`, so a duplicate that changed nothing
 * still reports a row and a re-import claims to have inserted the whole file.
 */
async function testImportVerticals() {
  console.log('\n--- migrate --import-verticals ---');
  await truncate();

  const file = path.join(os.tmpdir(), `prospector-verticals-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify([
    { slug: 'alpha', label: 'Alpha', priority: 1, keywords: ['a'] },
    { slug: 'beta',  label: 'Beta',  priority: 2, keywords: ['b'] },
  ]));

  const migrate = require('../src/db/migrate');
  const conn = db();

  const run = async () => {
    const lines = [];
    const log = (...a) => lines.push(a.join(' '));
    log.info = log; log.warn = log; log.error = log;
    await migrate.importVerticals(conn, file, log);
    return lines.join(' | ');
  };

  try {
    const first = await run();
    assert('a first import reports both as inserted',
      first.includes('2 inserted, 0 already present'), first);

    const [[n1]] = await conn.query('SELECT COUNT(*) AS n FROM verticals');
    eq('and both rows are there', Number(n1.n), 2);

    const second = await run();
    assert('a re-import reports none inserted, not all of them',
      second.includes('0 inserted, 2 already present'), second);

    const [[n2]] = await conn.query('SELECT COUNT(*) AS n FROM verticals');
    eq('and inserted nothing', Number(n2.n), 2);

    // A file that is half new: the count has to split, which is exactly what
    // `affectedRows` collapses.
    fs.writeFileSync(file, JSON.stringify([
      { slug: 'beta',  label: 'Beta renamed', priority: 9, keywords: ['b2'] },
      { slug: 'gamma', label: 'Gamma',        priority: 3, keywords: ['g'] },
    ]));
    const third = await run();
    assert('a half-new file splits the count',
      third.includes('1 inserted, 1 already present'), third);

    const [[keep]] = await conn.query(
      'SELECT label FROM verticals WHERE slug = ?', ['beta']);
    eq('an existing slug is left exactly as it was', keep.label, 'Beta');
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------
async function testDiscover() {
  console.log('\n--- discover --source fixture ---');
  await truncate();
  await seedVerticals();

  const discover = require('../src/discover/index');
  await discover._run(['interior-design', '--source', 'fixture'], ctx);

  const conn = db();
  const [[n]] = await conn.query('SELECT COUNT(*) AS n FROM companies');
  eq('one row per place id across both fixture tiles', Number(n.n), 12);

  const [rows] = await conn.query(
    'SELECT place_id, domain, status, skip_reason, review_count, name, city' +
    '  FROM companies ORDER BY place_id');
  const by = Object.fromEntries(rows.map(r => [r.place_id, r]));

  eq('city is the config slug', by.ChIJblitzglobe001.city, CITY);
  eq('a normal listing gets a domain', by.ChIJblitzglobe001.domain, 'blitzglobe.com');
  eq('and status NULL, for qualify to pick up', by.ChIJblitzglobe001.status, null);
  eq('www is stripped from the key',
    by.ChIJsrivarudhini001.domain, 'srivarudhiniinteriors.com');
  eq('a co.in domain keeps both labels',
    by.ChIJlakshmifalseceiling001.domain, 'lakshmifalseceiling.co.in');

  eq('no website → status -1', by.ChIJnowebsite001.status, -1);
  eq('no website → skip_reason', by.ChIJnowebsite001.skip_reason, 'no-website');
  eq('no website → domain NULL', by.ChIJnowebsite001.domain, null);
  eq('a facebook-only listing → -1', by.ChIJsocial001.status, -1);
  eq('a facebook-only listing → skip_reason',
    by.ChIJsocial001.skip_reason, 'aggregator-or-social-only');
  eq('a wixsite listing → skip_reason',
    by.ChIJwixsite001.skip_reason, 'aggregator-or-social-only');

  // R4.4 — two listings on one website are two rows, not one merged row.
  const blitz = rows.filter(r => r.domain === 'blitzglobe.com');
  eq('two place ids sharing a website stay two rows', blitz.length, 2);
  assert('and both keep their own review_count',
    blitz.map(r => Number(r.review_count)).sort((a, b) => a - b).join(',') === '60,87',
    blitz.map(r => r.review_count).join(','));

  // R4.2 — first write wins, and a re-run inserts nothing.
  const lines = [];
  const loud = (...a) => lines.push(a.join(' '));
  loud.info = loud; loud.warn = loud; loud.error = loud;
  await discover._run(['interior-design', '--source', 'fixture'],
    { ...ctx, log: loud });
  const [[again]] = await conn.query('SELECT COUNT(*) AS n FROM companies');
  eq('a second discover inserts nothing', Number(again.n), 12);

  // …and says so. `affectedRows` reports the batch size whatever happened
  // (mysql2 sets CLIENT_FOUND_ROWS), which read as a wholly new run.
  const summary = lines.filter(l => l.includes('new rows')).join(' | ');
  assert('and reports 0 new rows, not 12',
    /\b0 new rows\b/.test(summary), summary);
  const claimsNew = lines.filter(l => / (\d+) new /.test(l) && !/ 0 new /.test(l));
  assert('and no tile claims a new row either',
    claimsNew.length === 0, claimsNew.join(' | '));
}

/**
 * R4.6 — killing discover part-way keeps every row already inserted.
 *
 * Simulated by a logger that throws on the first tile's line, which is emitted
 * after that tile's insert has committed. Faithful because the insert is the
 * only thing between the search and the log, and because discover's own
 * try/catch is around `adapter.search`, not around the whole loop.
 */
async function testDiscoverInterrupted() {
  console.log('\n--- discover, killed part-way ---');
  await truncate();
  await seedVerticals();

  const discover = require('../src/discover/index');
  const boom = (...a) => {
    const line = a.join(' ');
    if (line.includes('tile0 kw="interior designer"')) throw new Error('killed');
  };
  boom.info = boom; boom.warn = () => {}; boom.error = () => {};

  let threw = false;
  try {
    await discover._run(['interior-design', '--source', 'fixture'],
      { root: ROOT, config: {}, log: boom });
  } catch (e) { threw = e.message === 'killed'; }
  assert('the run was interrupted', threw);

  const conn = db();
  const [[n]] = await conn.query('SELECT COUNT(*) AS n FROM companies');
  eq('the rows inserted before the kill are still there', Number(n.n), 10);

  await discover._run(['interior-design', '--source', 'fixture'], ctx);
  const [[m]] = await conn.query('SELECT COUNT(*) AS n FROM companies');
  eq('re-running inserts only what was missing', Number(m.n), 12);
}

// ---------------------------------------------------------------------------
// qualify
// ---------------------------------------------------------------------------
async function testQualify() {
  console.log('\n--- qualify (probe stubbed) ---');
  await truncate();
  await seedVerticals();
  await require('../src/discover/index')._run(['interior-design', '--source', 'fixture'], ctx);

  const qualify = require('../src/qualify/index');
  const real = qualify.qualifyOne;

  const probes = [];
  qualify.qualifyOne = async (b) => {
    probes.push(b.domain);
    if (b.domain === 'bestinterior.co') {
      return { eligible: false, reason: 'parked', http_status: 200,
        final_url: 'http://bestinterior.co/', https_status: 'none', cert_expires: null };
    }
    if (b.domain === 'happyhomesinteriors.com') {
      return { eligible: true, reason: null, http_status: 200,
        final_url: 'https://happyhomesinteriors.com/',
        https_status: 'expired', cert_expires: '2025-04-01' };
    }
    return { eligible: true, reason: null, http_status: 200,
      final_url: `https://${b.domain}/`, https_status: 'ok', cert_expires: '2027-01-14' };
  };

  try {
    await qualify._run(['interior-design'], ctx);
  } finally {
    qualify.qualifyOne = real;
  }

  // R5.1 — one probe per distinct domain, not one per row.
  eq('seven distinct domains were probed', probes.length, 7);
  eq('a website listed twice was probed once',
    probes.filter(d => d === 'blitzglobe.com').length, 1);

  const conn = db();
  const [rows] = await conn.query(
    'SELECT place_id, domain, status, skip_reason, https_status, cert_expires,' +
    '       http_status, final_url, qualified_at FROM companies ORDER BY place_id');
  const by = Object.fromEntries(rows.map(r => [r.place_id, r]));

  eq('eligible → status 0', by.ChIJblitzglobe001.status, 0);
  eq('and the other row on that website too', by.ChIJblitzglobe002.status, 0);
  eq('skipped → status -1', by.ChIJbestinterior001.status, -1);
  eq('skipped → skip_reason', by.ChIJbestinterior001.skip_reason, 'parked');
  eq('https ok', by.ChIJblitzglobe001.https_status, 'ok');
  eq('https expired is still eligible', by.ChIJhappyhomes001.status, 0);
  eq('https expired is recorded as such', by.ChIJhappyhomes001.https_status, 'expired');
  eq('cert_expires is a DATE', by.ChIJhappyhomes001.cert_expires, '2025-04-01');
  eq('plain http has no certificate date', by.ChIJbestinterior001.cert_expires, null);
  assert('qualified_at was set', !!by.ChIJblitzglobe001.qualified_at);

  // The discover-time skips are untouched: qualify never probed them.
  eq("discover's no-website row is unchanged", by.ChIJnowebsite001.skip_reason, 'no-website');
  eq('and was not given a qualified_at', by.ChIJnowebsite001.qualified_at, null);

  // R5.4 — re-running probes nothing, because nothing is status NULL.
  probes.length = 0;
  qualify.qualifyOne = async (b) => { probes.push(b.domain); throw new Error('should not be called'); };
  try { await qualify._run(['interior-design'], ctx); }
  finally { qualify.qualifyOne = real; }
  eq('re-running qualify probes nothing', probes.length, 0);
}

/**
 * R5's sibling inheritance: a later discover finds a new place id for a website
 * that is already qualified and captured. Probing it again is wasteful; leaving
 * it at `status = 0` is worse, because capture skips the domain as already done
 * and the row sits pending forever.
 */
async function testQualifyInheritance() {
  console.log('\n--- qualify, sibling inheritance ---');
  await truncate();
  const ids = await seedVerticals();
  const conn = db();

  await conn.query(
    'INSERT INTO companies (place_id, city, vertical_id, name, website_raw, domain,' +
    '  discovered_run, discovered_at, status, final_url, https_status, cert_expires,' +
    '  qualified_at, captured_at, extract_status, email)' +
    " VALUES ('old', ?, ?, 'Old', 'https://shared.com/', 'shared.com', 'r1', UTC_TIMESTAMP()," +
    "   1, 'https://shared.com/', 'ok', '2027-01-01', UTC_TIMESTAMP(), UTC_TIMESTAMP(), 1, 'a@shared.com')",
    [CITY, ids['interior-design']]);
  const [[old]] = await conn.query("SELECT company_id FROM companies WHERE place_id = 'old'");
  await conn.query(
    'INSERT INTO links (company_id, url, target_domain, kind, region, text)' +
    " VALUES (?, 'https://instagram.com/shared', 'instagram.com', 'social', 'footer', 'insta')",
    [old.company_id]);

  await conn.query(
    'INSERT INTO companies (place_id, city, vertical_id, name, website_raw, domain,' +
    '  discovered_run, discovered_at, status)' +
    " VALUES ('new', ?, ?, 'New', 'https://shared.com/', 'shared.com', 'r2', UTC_TIMESTAMP(), NULL)",
    [CITY, ids['interior-design']]);

  const qualify = require('../src/qualify/index');
  const real = qualify.qualifyOne;
  let probed = 0;
  qualify.qualifyOne = async () => { probed++; throw new Error('should not probe'); };
  try { await qualify._run(['interior-design'], ctx); }
  finally { qualify.qualifyOne = real; }

  eq('the new row was not probed', probed, 0);

  const [[row]] = await conn.query(
    "SELECT status, https_status, cert_expires, extract_status, email, captured_at" +
    " FROM companies WHERE place_id = 'new'");
  eq('it inherited the capture status', row.status, 1);
  eq('and the certificate', row.https_status, 'ok');
  eq('and the extract status', row.extract_status, 1);
  eq('and the email', row.email, 'a@shared.com');
  assert('and the captured_at', !!row.captured_at);

  const [[links]] = await conn.query(
    "SELECT COUNT(*) AS n FROM links l JOIN companies c ON c.company_id = l.company_id" +
    " WHERE c.place_id = 'new'");
  eq("it inherited the sibling's links", Number(links.n), 1);
}

// ---------------------------------------------------------------------------
// recordDomain
// ---------------------------------------------------------------------------
async function testRecord() {
  console.log('\n--- recordDomain ---');
  await truncate();
  const ids = await seedVerticals();
  const conn = db();

  async function insert(placeId, domain) {
    await conn.query(
      'INSERT INTO companies (place_id, city, vertical_id, name, domain,' +
      '  discovered_run, discovered_at, status)' +
      " VALUES (?, ?, ?, ?, ?, 'r1', UTC_TIMESTAMP(), 0)",
      [placeId, CITY, ids['interior-design'], placeId, domain]);
  }
  await insert('one', 'one.com');
  await insert('two-a', 'two.com');
  await insert('two-b', 'two.com');
  await insert('bad', 'bad.com');
  await insert('nox', 'nox.com');

  const extract = {
    domain: 'one.com', email: 'hello@one.com',
    links: [{ url: 'https://instagram.com/one', target_domain: 'instagram.com',
              kind: 'social', region: 'footer', text: 'insta' }],
  };

  // The same timestamps both times, because that is what ingest passes: S3's
  // LastModified for the object, which does not move between runs.
  const capturedAt  = new Date('2026-09-01T10:00:00Z');
  const extractedAt = new Date('2026-09-01T10:00:05Z');

  let wrote = await tx(c => recordDomain(c, {
    city: CITY, domain: 'one.com', complete: true, capturedAt, extract, extractedAt,
  }, quietLog()));
  assert('a complete capture is a write', wrote);

  let [[r]] = await conn.query("SELECT * FROM companies WHERE place_id = 'one'");
  eq('complete → status 1', r.status, 1);
  eq('capture_error is cleared', r.capture_error, null);
  eq('captured_at is the capture time', r.captured_at, '2026-09-01 10:00:00');
  eq('extract → extract_status 1', r.extract_status, 1);
  eq('email is copied', r.email, 'hello@one.com');

  // R7.5 — a second pass over the same state writes nothing.
  wrote = await tx(c => recordDomain(c, {
    city: CITY, domain: 'one.com', complete: true, capturedAt, extract, extractedAt,
  }, quietLog()));
  assert('an unchanged domain is not written again', wrote === false);

  // A shared website gets the links under every company id.
  await tx(c => recordDomain(c, {
    city: CITY, domain: 'two.com', complete: true, capturedAt: new Date(),
    extract: { domain: 'two.com', email: null, links: extract.links },
  }, quietLog()));
  const [[two]] = await conn.query(
    'SELECT COUNT(*) AS n FROM links l JOIN companies c ON c.company_id = l.company_id' +
    "  WHERE c.domain = 'two.com'");
  eq('both rows of a shared website get the links', Number(two.n), 2);
  const [twoRows] = await conn.query("SELECT status FROM companies WHERE domain = 'two.com'");
  assert('and both are status 1', twoRows.every(x => x.status === 1));

  // A failed capture.
  await tx(c => recordDomain(c, {
    city: CITY, domain: 'bad.com', complete: false, errorKind: 'nav-timeout',
  }, quietLog()));
  [[r]] = await conn.query("SELECT * FROM companies WHERE place_id = 'bad'");
  eq('a failed capture → status -2', r.status, -2);
  eq('and the kind is kept', r.capture_error, 'nav-timeout');
  eq('and extract_status is untouched', r.extract_status, null);

  // Complete, but nothing extracted yet.
  await tx(c => recordDomain(c, {
    city: CITY, domain: 'nox.com', complete: true, capturedAt: new Date(),
  }, quietLog()));
  [[r]] = await conn.query("SELECT * FROM companies WHERE place_id = 'nox'");
  eq('complete with no extract → extract_status -2', r.extract_status, -2);
  eq('but the capture still counts', r.status, 1);

  // A malformed extract.json is a bug in extract, not a lost capture.
  assert('validateExtract rejects a bad kind',
    !!validateExtract({ links: [{ url: 'u', target_domain: 'd', kind: 'nope', region: 'footer' }] }));
  await tx(c => recordDomain(c, {
    city: CITY, domain: 'nox.com', complete: true, capturedAt: new Date(),
    extract: { email: 'x@y.com', links: [{ url: 'u' }] },
  }, quietLog()));
  [[r]] = await conn.query("SELECT * FROM companies WHERE place_id = 'nox'");
  eq('a malformed extract.json leaves extract_status -2', r.extract_status, -2);
  eq('and does not write its email', r.email, null);

  // R7.7 — a decision is never touched.
  await conn.query(
    "UPDATE companies SET tier = 'A', pitch = TRUE, note = 'mine', reviewed_at = UTC_TIMESTAMP()" +
    " WHERE place_id = 'one'");
  await tx(c => recordDomain(c, {
    city: CITY, domain: 'one.com', complete: true, capturedAt: new Date(),
    extract: { ...extract, email: 'changed@one.com' },
  }, quietLog()));
  [[r]] = await conn.query("SELECT * FROM companies WHERE place_id = 'one'");
  eq('the operator tier survives a re-record', r.tier, 'A');
  eq('the pitch flag survives', r.pitch === 1 || r.pitch === true, true);
  eq('the note survives', r.note, 'mine');
  eq('but the email is updated', r.email, 'changed@one.com');
}

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

/**
 * An S3 stub reading a folder laid out like the bucket.
 *
 * Matches on the command's constructor name, which is what the real client
 * dispatches on too, so the ingest code under test is unmodified.
 */
function stubS3(rootDir, opts = {}) {
  const calls = { list: 0, get: 0 };
  return {
    calls,
    async send(cmd) {
      const kind = cmd.constructor.name;
      if (kind === 'ListObjectsV2Command') {
        calls.list++;
        const prefix = cmd.input.Prefix;
        const base = path.join(rootDir, prefix);
        const contents = [];
        const walk = (dir, rel) => {
          let entries = [];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full, `${rel}${e.name}/`);
            else {
              const st = fs.statSync(full);
              contents.push({ Key: prefix + rel + e.name, Size: st.size, LastModified: st.mtime });
            }
          }
        };
        walk(base, '');
        return { Contents: contents, IsTruncated: false };
      }
      if (kind === 'GetObjectCommand') {
        calls.get++;
        if (opts.onGet) opts.onGet(cmd.input.Key);
        return { Body: fs.readFileSync(path.join(rootDir, cmd.input.Key)) };
      }
      throw new Error(`stub S3 got an unexpected ${kind}`);
    },
  };
}

function writeBucketFile(bucketDir, domain, name, body) {
  const dir = path.join(bucketDir, CITY, 'companies', domain);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
}

async function testIngest() {
  console.log('\n--- ingest (stub S3) ---');
  await truncate();
  const ids = await seedVerticals();
  const conn = db();

  const work = path.join(os.tmpdir(), `prospector-ingest-${process.pid}`);
  fs.rmSync(work, { recursive: true, force: true });
  const bucketDir = path.join(work, 'bucket');
  const dataRoot  = path.join(work, 'tree');
  fs.mkdirSync(path.join(dataRoot, 'config'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'config', 'city.json'),
                  path.join(dataRoot, 'config', 'city.json'));

  for (const [placeId, domain] of [['a', 'alpha.com'], ['b', 'beta.com'], ['c', 'gamma.com']]) {
    await conn.query(
      'INSERT INTO companies (place_id, city, vertical_id, name, domain,' +
      "  discovered_run, discovered_at, status) VALUES (?, ?, ?, ?, ?, 'r1', UTC_TIMESTAMP(), 0)",
      [placeId, CITY, ids['interior-design'], placeId, domain]);
  }

  // Two complete domains and one that failed.
  for (const domain of ['alpha.com', 'beta.com']) {
    writeBucketFile(bucketDir, domain, 'desktop.webp', Buffer.from('desktop'));
    writeBucketFile(bucketDir, domain, 'mobile.webp',  Buffer.from('mobile'));
    writeBucketFile(bucketDir, domain, 'rendered.html', '<html></html>');
    writeBucketFile(bucketDir, domain, 'extract.json', JSON.stringify({
      domain, email: `hi@${domain}`,
      links: [{ url: `https://instagram.com/${domain}`, target_domain: 'instagram.com',
                kind: 'social', region: 'footer', text: '' }],
    }));
  }
  writeBucketFile(bucketDir, 'gamma.com', 'error.json',
    JSON.stringify({ domain: 'gamma.com', kind: 'nav-timeout', message: 'timed out' }));

  process.env.CAPTURE_BUCKET = 'stub-bucket';
  const ingest = require('../src/ingest/index');
  const ictx = { root: dataRoot, config: {}, log: quietLog() };

  let s3 = stubS3(bucketDir);
  await ingest._run([], ictx, { s3 });

  eq('the bucket was listed once', s3.calls.list, 1);

  const [rows] = await conn.query('SELECT place_id, status, extract_status, email FROM companies ORDER BY place_id');
  const by = Object.fromEntries(rows.map(r => [r.place_id, r]));
  eq('a complete capture → status 1', by.a.status, 1);
  eq('the other one too', by.b.status, 1);
  eq('a failed capture → status -2', by.c.status, -2);
  eq('extract loaded', by.a.extract_status, 1);
  eq('and its email', by.a.email, 'hi@alpha.com');

  for (const name of ['desktop.webp', 'mobile.webp', 'extract.json']) {
    assert(`${name} is on local disk`,
      fs.existsSync(path.join(dataRoot, 'data', CITY, 'companies', 'alpha.com', name)));
  }
  // R7.3 — rendered.html only with --with-html.
  assert('rendered.html was not downloaded without --with-html',
    !fs.existsSync(path.join(dataRoot, 'data', CITY, 'companies', 'alpha.com', 'rendered.html')));
  assert('no .tmp was left behind',
    fs.readdirSync(path.join(dataRoot, 'data', CITY, 'companies', 'alpha.com'))
      .every(f => !f.endsWith('.tmp')));

  const [[links]] = await conn.query("SELECT COUNT(*) AS n FROM links");
  eq('one link row per company', Number(links.n), 2);

  // R7.5 — a second run over an unchanged bucket writes nothing and downloads
  // nothing. `gamma.com` stays in the work set (status -2), so this is also the
  // proof that a re-listed failure is not rewritten.
  const [before] = await conn.query('SELECT company_id, updated_at FROM companies ORDER BY company_id');
  s3 = stubS3(bucketDir);
  await ingest._run([], ictx, { s3 });
  eq('a second run downloads nothing', s3.calls.get, 0);
  const [after] = await conn.query('SELECT company_id, updated_at FROM companies ORDER BY company_id');
  eq('and writes nothing',
    JSON.stringify(after.map(x => String(x.updated_at))),
    JSON.stringify(before.map(x => String(x.updated_at))));

  fs.rmSync(work, { recursive: true, force: true });
  delete process.env.CAPTURE_BUCKET;
}

/**
 * R7.5 — killing ingest after the downloads and before the commit must never
 * leave a row at `status = 1` whose screenshots are not on disk.
 *
 * The throw goes in the download of the *last* file, so the earlier ones are on
 * disk and the transaction never opens.
 */
async function testIngestCrash() {
  console.log('\n--- ingest, killed before the commit ---');
  await truncate();
  const ids = await seedVerticals();
  const conn = db();

  const work = path.join(os.tmpdir(), `prospector-ingest-crash-${process.pid}`);
  fs.rmSync(work, { recursive: true, force: true });
  const bucketDir = path.join(work, 'bucket');
  const dataRoot  = path.join(work, 'tree');
  fs.mkdirSync(path.join(dataRoot, 'config'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'config', 'city.json'),
                  path.join(dataRoot, 'config', 'city.json'));

  await conn.query(
    'INSERT INTO companies (place_id, city, vertical_id, name, domain,' +
    "  discovered_run, discovered_at, status) VALUES ('x', ?, ?, 'X', 'delta.com', 'r1', UTC_TIMESTAMP(), 0)",
    [CITY, ids['interior-design']]);

  writeBucketFile(bucketDir, 'delta.com', 'desktop.webp', Buffer.from('desktop'));
  writeBucketFile(bucketDir, 'delta.com', 'mobile.webp',  Buffer.from('mobile'));
  writeBucketFile(bucketDir, 'delta.com', 'rendered.html', '<html></html>');
  writeBucketFile(bucketDir, 'delta.com', 'extract.json', JSON.stringify(
    { domain: 'delta.com', email: null, links: [] }));

  process.env.CAPTURE_BUCKET = 'stub-bucket';
  const ingest = require('../src/ingest/index');
  const ictx = { root: dataRoot, config: {}, log: quietLog() };

  const s3 = stubS3(bucketDir, {
    onGet(key) { if (key.endsWith('extract.json')) throw new Error('killed'); },
  });
  await ingest._run([], ictx, { s3 });   // the per-domain failure is caught and counted

  let [[r]] = await conn.query("SELECT status FROM companies WHERE place_id = 'x'");
  eq('the row was not marked captured', r.status, 0);

  await ingest._run([], ictx, { s3: stubS3(bucketDir) });
  [[r]] = await conn.query("SELECT status FROM companies WHERE place_id = 'x'");
  eq('re-running finishes the job', r.status, 1);
  assert('and the screenshots really are on disk',
    ['desktop.webp', 'mobile.webp'].every(n =>
      fs.existsSync(path.join(dataRoot, 'data', CITY, 'companies', 'delta.com', n))));

  fs.rmSync(work, { recursive: true, force: true });
  delete process.env.CAPTURE_BUCKET;
}

// ---------------------------------------------------------------------------
// the guard itself
// ---------------------------------------------------------------------------
function testGuard() {
  console.log('\n--- the _test guard ---');
  const saved = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = 'mysql://root:pw@127.0.0.1:3306/prospector';
    let threw = false;
    try { helper.requireTestDatabase(); } catch { threw = true; }
    assert('a database not ending in _test is refused', threw);

    process.env.DATABASE_URL = 'mysql://root:p%40ss%2Fword@127.0.0.1:3306/x_test';
    eq('a password with @ and / does not confuse the name',
      helper.databaseName(process.env.DATABASE_URL), 'x_test');
  } finally {
    process.env.DATABASE_URL = saved;
  }
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('=== MySQL tests ===');
  testGuard();
  await resetTestDatabase();

  try {
    await testMigrate();
    await testImportVerticals();
    await testDiscover();
    await testDiscoverInterrupted();
    await testQualify();
    await testQualifyInheritance();
    await testRecord();
    await testIngest();
    await testIngestCrash();
  } finally {
    // Leave nothing behind (R13.1). The tables stay — the database is a scratch
    // one — but they are empty.
    await truncate().catch(() => {});
    await close();
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failures.length) console.log('Failed:', failures.join(', '));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('\n[test-db fatal]', e.stack || e.message);
  close().catch(() => {});
  process.exit(1);
});

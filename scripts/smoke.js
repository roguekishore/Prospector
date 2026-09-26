/* scripts/smoke.js
   A real 5-domain capture, against five real websites.

   Seeds `companies` at `status = 0` from scripts/smoke-companies.json — no
   Places API call and no quota — then runs `capture`, which captures, extracts
   and records each domain. The assertions are over both the folder on disk and
   the rows in MySQL, because those are the two things the deck reads.

   Needs DATABASE_URL pointing at a scratch database whose name ends in `_test`.
   Usage: npm run test:run */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SEED = path.join(__dirname, 'smoke-companies.json');
const VERTICAL = 'interior-design-smoke';

const { companyDir, readCity } = require('../lib-keys');
const { registrable } = require('../src/capture/extract/links.js');
const { isComplete }  = require('../src/capture/capture-domain.js');
const { db, close }   = require('../src/db/mysql');
const { requireTestDatabase, resetTestDatabase, seedVerticals } = require('./test-db-helper');

const CAPTURE_FILES = ['desktop.webp', 'mobile.webp', 'rendered.html', 'extract.json'];

// Load .env the same way the CLI does
try {
  const raw = fs.readFileSync(path.join(ROOT, '.env'));
  let text;
  if (raw[0] === 0xFF && raw[1] === 0xFE) text = raw.slice(2).toString('utf16le');
  else if (raw.length > 4 && raw[1] === 0x00 && raw[3] === 0x00) text = raw.toString('utf16le');
  else text = raw.toString('utf8').replace(/^﻿/, '');
  text = text.replace(/\0/g, '');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

function log(...a)  { console.log('[smoke]', ...a); }
log.info  = (...a) => console.log('[info]',  ...a);
log.warn  = (...a) => console.warn('[warn]',  ...a);
log.error = (...a) => console.error('[error]', ...a);

let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`); failed++; }
}

/**
 * What landed for one domain, on disk and in the database.
 *
 * A domain whose capture failed is reported, not asserted on: the smoke run
 * depends on five third-party websites being up, and a dead host is news about
 * the website rather than about this repo. Every domain that *did* capture must
 * hold exactly the four files, an extract.json with no self-links, and a row at
 * `status = 1` with its links.
 */
async function checkDomain(city, domain) {
  const dir  = companyDir(ROOT, city, domain);
  const conn = db();
  const [rows] = await conn.query(
    'SELECT company_id, status, extract_status, capture_error, email, captured_at' +
    '  FROM companies WHERE city = ? AND domain = ?', [city, domain]);
  assert(`${domain}: has a row`, rows.length === 1, `${rows.length} rows`);
  const row = rows[0] || {};

  if (!fs.existsSync(dir)) { assert(`${domain}: folder exists`, false, dir); return; }
  const files = fs.readdirSync(dir).sort();

  if (!isComplete(dir)) {
    log.warn(`${domain}: capture incomplete — ${files.join(', ') || 'nothing'}`);
    assert(`${domain}: a failed capture wrote error.json`, files.includes('error.json'),
      files.join(', '));
    assert(`${domain}: and the row says so`, row.status === -2,
      `status ${row.status}, capture_error ${row.capture_error}`);
    return;
  }

  for (const name of CAPTURE_FILES) {
    assert(`${domain}: ${name}`, files.includes(name), files.join(', '));
  }
  const extra = files.filter(f => !CAPTURE_FILES.includes(f) && f !== 'error.json');
  assert(`${domain}: nothing else in the folder`, extra.length === 0, extra.join(', '));

  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(dir, 'extract.json'), 'utf8')); }
  catch (e) { assert(`${domain}: extract.json parses`, false, e.message); return; }

  assert(`${domain}: extract.json has domain, email, links`,
    JSON.stringify(Object.keys(doc)) === '["domain","email","links"]',
    JSON.stringify(Object.keys(doc)));

  const own  = registrable(`https://${domain}/`);
  const self = (doc.links || []).filter(l => l.target_domain === own);
  assert(`${domain}: no link points at its own registrable domain`,
    self.length === 0, JSON.stringify(self.slice(0, 3)));

  // The row is the other half of the contract: a capture nothing recorded is a
  // capture the deck cannot show.
  assert(`${domain}: status 1`, row.status === 1, String(row.status));
  assert(`${domain}: extract_status 1`, row.extract_status === 1, String(row.extract_status));
  assert(`${domain}: captured_at is set`, !!row.captured_at);
  assert(`${domain}: email matches extract.json`, (row.email || null) === (doc.email || null),
    `row ${row.email}, file ${doc.email}`);

  const [links] = await conn.query('SELECT COUNT(*) AS n FROM links WHERE company_id = ?',
    [row.company_id]);
  assert(`${domain}: ${doc.links.length} link row(s)`,
    Number(links[0].n) === doc.links.length, `${links[0].n} in the table`);

  log(`${domain}: email=${doc.email || 'none'}  links=${(doc.links || []).length}`);
}

async function main() {
  requireTestDatabase();
  await resetTestDatabase();

  const city = readCity(ROOT).slug;
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const domains = seed.map(b => b.domain);

  log(`seeding ${seed.length} companies at status 0`);
  const ids  = await seedVerticals();
  const conn = db();
  for (const b of seed) {
    await conn.query(
      'INSERT INTO companies (place_id, city, vertical_id, name, website_raw, domain,' +
      '  rating, review_count, address, phone, lat, lng, business_status, primary_type,' +
      '  discovered_run, discovered_at, status, final_url, http_status, https_status,' +
      '  cert_expires, qualified_at)' +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'smoke', UTC_TIMESTAMP()," +
      '  0, ?, 200, ?, ?, UTC_TIMESTAMP())',
      [b.place_id, city, ids[VERTICAL], b.name, b.website_raw, b.domain,
       b.rating, b.review_count, b.address, b.phone, b.lat, b.lng,
       b.business_status, b.primary_type, b.final_url, b.https_status, b.cert_expires]);
  }
  log(`domains: ${domains.join(', ')}`);

  const config = {
    city:  'Coimbatore',
    runId: `smoke-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}Z`,
  };
  const ctx = { root: ROOT, config, log };

  log('--- capture ---');
  const result = await require('../src/capture/index.js')._run([VERTICAL, '--concurrency', '2'], ctx);
  log(`capture returned ${JSON.stringify(result)}`);

  log(`--- checking data/${city}/companies/ and the rows ---`);
  for (const domain of domains) await checkDomain(city, domain);

  console.log(failed ? `\n[smoke] ${failed} assertion(s) failed` : '\n[smoke] all assertions passed');
  log(`results in data/${city}/companies/`);
  log('run `npm run test:clean` when finished');
  await close();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error('[smoke fatal]', e.stack || e.message);
  await close().catch(() => {});
  process.exit(1);
});

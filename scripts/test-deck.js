'use strict';

/**
 * Offline tests for the deck's HTTP surface.
 *
 *     DATABASE_URL=mysql://root:pw@127.0.0.1:3306/prospector_test npm run test:deck
 *
 * Fastify's `inject()` against the real routes — no socket, no port, and no
 * second copy of the routing that could drift from the one that ships. The
 * database is the scratch one `scripts/test-db-helper.js` guards.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { ROOT, resetTestDatabase, truncate, seedVerticals } = require('./test-db-helper');
const { db, close } = require('../src/db/mysql');

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

/** A tree with its own config/ and data/, so the shot route has somewhere to look. */
let TREE;
let IDS;

async function seed() {
  await truncate();
  IDS = await seedVerticals();
  const conn = db();

  // Six captured leads with different shapes, one failed capture that must never
  // appear as a lead, and two listings with no website at all.
  const leads = [
    // place_id, name,   domain,        reviews, https,     cert,         email
    ['p1', 'Alpha Interiors',  'alpha.com',  120, 'none',    null,         'a@alpha.com'],
    ['p2', 'Beta Designs',     'beta.com',    90, 'expired', '2025-02-01', null],
    ['p3', 'Gamma Studio',     'gamma.com',   90, 'ok',      '2027-06-01', 'g@gamma.com'],
    ['p4', 'Delta Works',      'delta.com',   40, 'ok',      '2027-06-01', null],
    ['p5', 'Epsilon Spaces',   'epsilon.com', 10, 'ok',      '2027-06-01', null],
    ['p6', '=Zeta, "Quoted"',  'zeta.com',     5, 'ok',      '2027-06-01', 'z@zeta.com'],
  ];
  for (const [placeId, name, domain, reviews, https, cert, email] of leads) {
    await conn.query(
      'INSERT INTO companies (place_id, city, vertical_id, name, domain, review_count,' +
      '  rating, address, phone, primary_type, discovered_run, discovered_at,' +
      '  status, extract_status, https_status, cert_expires, email, final_url, http_status)' +
      " VALUES (?, ?, ?, ?, ?, ?, 4.5, '1 Road, Coimbatore', '+91 90000 00000'," +
      "  'interior_designer', 'r1', UTC_TIMESTAMP(), 1, 1, ?, ?, ?, ?, 200)",
      [placeId, CITY, IDS['interior-design'], name, domain, reviews, https, cert, email,
       `https://${domain}/`]);
  }

  await conn.query(
    'INSERT INTO companies (place_id, city, vertical_id, name, domain, review_count,' +
    "  discovered_run, discovered_at, status, capture_error)" +
    " VALUES ('pfail', ?, ?, 'Failed Capture', 'failed.com', 500, 'r1', UTC_TIMESTAMP(), -2, 'nav-timeout')",
    [CITY, IDS['interior-design']]);

  for (const [placeId, name, reviews] of [['pn1', 'No Site One', 70], ['pn2', 'No Site Two', 30]]) {
    await conn.query(
      'INSERT INTO companies (place_id, city, vertical_id, name, domain, review_count,' +
      "  phone, address, rating, discovered_run, discovered_at, status, skip_reason)" +
      " VALUES (?, ?, ?, ?, NULL, ?, '+91 90000 00001', 'Somewhere', 4.1, 'r1', UTC_TIMESTAMP(), -1, 'no-website')",
      [placeId, CITY, IDS['interior-design'], name, reviews]);
  }

  const [[alpha]] = await conn.query("SELECT company_id FROM companies WHERE place_id = 'p1'");
  await conn.query(
    'INSERT INTO links (company_id, url, target_domain, kind, region, text) VALUES' +
    " (?, 'https://instagram.com/alpha', 'instagram.com', 'social', 'footer', 'insta')," +
    " (?, 'https://partner.example/x', 'partner.example', 'external', 'main', 'partner')",
    [alpha.company_id, alpha.company_id]);

  return alpha.company_id;
}

function makeTree() {
  const dir = path.join(os.tmpdir(), `prospector-deck-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'config', 'city.json'), path.join(dir, 'config', 'city.json'));
  // `preview/` is served from the same root, so it has to be reachable from here.
  fs.mkdirSync(path.join(dir, 'preview'), { recursive: true });
  for (const f of ['index.html', 'app.css', 'app.js']) {
    fs.copyFileSync(path.join(ROOT, 'preview', f), path.join(dir, 'preview', f));
  }
  const shots = path.join(dir, 'data', CITY, 'companies', 'alpha.com');
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, 'desktop.webp'), Buffer.from('desktop-bytes'));
  fs.writeFileSync(path.join(shots, 'mobile.webp'), Buffer.from('mobile-bytes'));
  return dir;
}

// ---------------------------------------------------------------------------

async function testVerticals(app) {
  console.log('\n--- GET /api/verticals ---');
  const res = await app.inject({ method: 'GET', url: '/api/verticals' });
  eq('200', res.statusCode, 200);
  const list = res.json();
  const v = list.find(x => x.slug === 'interior-design');
  eq('leads counts only status 1', v.leads, 6);
  eq('no_website counts the domainless rows', v.no_website, 2);
  eq('nothing is reviewed yet', v.reviewed, 0);
  assert('a vertical with no rows still appears',
    list.some(x => x.slug === 'interior-design-smoke'), JSON.stringify(list.map(x => x.slug)));
}

async function testLeads(app) {
  console.log('\n--- GET /api/leads ---');
  let res = await app.inject({ method: 'GET', url: '/api/leads?vertical=interior-design' });
  eq('200', res.statusCode, 200);
  let body = res.json();
  eq('total is the whole result set', body.total, 6);
  eq('and the page holds all six', body.rows.length, 6);
  assert('a failed capture is not a lead',
    !body.rows.some(r => r.domain === 'failed.com'));

  // R9.3 — review count descending, then name.
  eq('sorted by review count first', body.rows[0].domain, 'alpha.com');
  eq('ties break on name', body.rows[1].name, 'Beta Designs');
  eq('and then the next', body.rows[2].name, 'Gamma Studio');

  assert('no machine judgement is on the wire',
    !/\b(score|angle|agency|signals|gate|flaws|verdict)\b/i.test(JSON.stringify(body.rows[0])),
    JSON.stringify(body.rows[0]));

  // R9.6 — the page size is capped whatever the request asks for.
  res = await app.inject({ method: 'GET', url: '/api/leads?vertical=interior-design&limit=500' });
  eq('limit is capped at 60', res.json().rows.length <= 60, true);

  res = await app.inject({ method: 'GET', url: '/api/leads?vertical=interior-design&limit=2&offset=2' });
  body = res.json();
  eq('a page holds exactly its limit', body.rows.length, 2);
  eq('total is unaffected by paging', body.total, 6);
  eq('and the offset lands on the third row', body.rows[0].name, 'Gamma Studio');

  res = await app.inject({ method: 'GET', url: '/api/leads?vertical=../etc' });
  eq('a slug that is not a slug is 400', res.statusCode, 400);
}

async function testFilters(app) {
  console.log('\n--- filters ---');
  const cases = [
    ['http', 1, 'plain http'],
    ['expired', 1, 'expired certificate'],
    ['email', 3, 'has an email'],
    ['unreviewed', 6, 'not yet reviewed'],
    ['pitch', 0, 'flagged for a pitch'],
    ['tier:A', 0, 'tier A'],
  ];
  for (const [key, want, label] of cases) {
    const res = await app.inject({
      method: 'GET', url: `/api/leads?vertical=interior-design&filter=${encodeURIComponent(key)}` });
    eq(`filter ${key} (${label})`, res.json().total, want);
  }

  let res = await app.inject({
    method: 'GET', url: '/api/leads?vertical=interior-design&filter=email,unreviewed' });
  eq('two filters combine with AND', res.json().total, 3);

  res = await app.inject({ method: 'GET', url: '/api/leads?vertical=interior-design&filter=nope' });
  eq('an unknown filter is 400', res.statusCode, 400);

  res = await app.inject({
    method: 'GET',
    url: `/api/leads?vertical=interior-design&filter=${encodeURIComponent("x' OR 1=1 --")}` });
  eq('and so is an attempt to inject one', res.statusCode, 400);
}

async function testNoWebsite(app) {
  console.log('\n--- the no-website view ---');
  const res = await app.inject({
    method: 'GET', url: '/api/leads?vertical=interior-design&view=no-website' });
  const body = res.json();
  eq('only the domainless rows', body.total, 2);
  assert('every one really has no domain', body.rows.every(r => r.domain === null));
  eq('sorted by review count', body.rows[0].name, 'No Site One');
}

async function testDetail(app, alphaId) {
  console.log('\n--- GET /api/leads/:id ---');
  let res = await app.inject({ method: 'GET', url: `/api/leads/${alphaId}` });
  eq('200', res.statusCode, 200);
  const row = res.json();
  eq('the row is the one asked for', row.domain, 'alpha.com');
  eq('social links are grouped', row.links.social.length, 1);
  eq('and the rest are not', row.links.other.length, 1);
  eq('the social one is the instagram profile', row.links.social[0].target_domain, 'instagram.com');

  res = await app.inject({ method: 'GET', url: '/api/leads/99999999' });
  eq('an unknown id is 404', res.statusCode, 404);
}

async function testDecision(app, alphaId) {
  console.log('\n--- PUT /api/leads/:id/decision ---');
  const put = (id, body) => app.inject({
    method: 'PUT', url: `/api/leads/${id}/decision`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body) });

  let res = await put(alphaId, { tier: 'A', pitch: true, note: 'call them' });
  eq('a valid decision is 204', res.statusCode, 204);

  const conn = db();
  let [[r]] = await conn.query('SELECT * FROM companies WHERE company_id = ?', [alphaId]);
  eq('tier is stored', r.tier, 'A');
  eq('pitch is stored', r.pitch === 1 || r.pitch === true, true);
  eq('the note is stored', r.note, 'call them');
  assert('reviewed_at is set from the server clock', !!r.reviewed_at);

  // R9.7's other half — the deck writes four columns and no others.
  eq('status is untouched', r.status, 1);
  eq('email is untouched', r.email, 'a@alpha.com');
  eq('https_status is untouched', r.https_status, 'none');

  res = await put(alphaId, { tier: null, pitch: false, note: null });
  eq('clearing is 204', res.statusCode, 204);
  [[r]] = await conn.query('SELECT * FROM companies WHERE company_id = ?', [alphaId]);
  eq('tier is cleared', r.tier, null);
  eq('and reviewed_at with it', r.reviewed_at, null);

  res = await put(alphaId, { tier: 'Z' });
  eq('an unknown tier is 400', res.statusCode, 400);
  res = await put(alphaId, { pitch: 'yes' });
  eq('a non-boolean pitch is 400', res.statusCode, 400);
  res = await put(alphaId, { note: 'x'.repeat(4001) });
  eq('an over-long note is 400', res.statusCode, 400);
  res = await put(99999999, { tier: 'A' });
  eq('an unknown id is 404', res.statusCode, 404);

  // Put one back, for the CSV below.
  await put(alphaId, { tier: 'A', pitch: true, note: 'call them' });
}

async function testCsv(app) {
  console.log('\n--- GET /api/export/pitch.csv ---');
  const conn = db();
  const [[zeta]] = await conn.query("SELECT company_id FROM companies WHERE place_id = 'p6'");
  await app.inject({
    method: 'PUT', url: `/api/leads/${zeta.company_id}/decision`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ tier: 'B', pitch: true, note: 'has a "quote" in the name' }) });

  const res = await app.inject({ method: 'GET', url: '/api/export/pitch.csv' });
  eq('200', res.statusCode, 200);
  assert('it downloads', /attachment; filename="pitch.csv"/.test(res.headers['content-disposition']),
    res.headers['content-disposition']);

  const body = res.body;
  assert('it starts with a BOM', body.charCodeAt(0) === 0xFEFF);
  assert('the lines are CRLF', body.includes('\r\n'));
  assert('only pitched rows are in it', !body.includes('Gamma Studio'), body);
  assert('the pitched rows are', body.includes('Alpha Interiors'));
  // A name beginning with `=` is a formula to a spreadsheet, not a name.
  assert('a leading = is defused with an apostrophe', body.includes(`"'=Zeta`), body);
  assert('an embedded quote is doubled', body.includes('""Quoted""'), body);
  assert('and so is one in a note', body.includes('has a ""quote"" in the name'), body);
  assert('no judgement column is exported',
    !/\b(score|angle|agency|signals)\b/i.test(body), body.split('\r\n')[0]);
}

async function testShots(app) {
  console.log('\n--- GET /shots/:domain/:file ---');
  let res = await app.inject({ method: 'GET', url: '/shots/alpha.com/desktop.webp' });
  eq('a real shot is served', res.statusCode, 200);
  eq('as webp', res.headers['content-type'], 'image/webp');
  assert('and cached privately', /private/.test(res.headers['cache-control'] || ''),
    res.headers['cache-control']);

  res = await app.inject({ method: 'GET', url: '/shots/alpha.com/rendered.html' });
  eq('rendered.html is not a screenshot', res.statusCode, 400);
  res = await app.inject({ method: 'GET', url: '/shots/alpha.com/extract.json' });
  eq('nor is extract.json', res.statusCode, 400);

  for (const bad of ['..', '..%2f..%2fetc', 'ALPHA.COM', 'not_a_domain', 'a/b']) {
    res = await app.inject({ method: 'GET', url: `/shots/${bad}/desktop.webp` });
    assert(`a domain of "${bad}" is refused`, res.statusCode === 400 || res.statusCode === 404,
      String(res.statusCode));
  }

  res = await app.inject({ method: 'GET', url: '/shots/never-captured.com/desktop.webp' });
  eq('a domain with no capture is 404', res.statusCode, 404);
}

async function testStatic(app) {
  console.log('\n--- static files ---');
  let res = await app.inject({ method: 'GET', url: '/' });
  eq('the page is served', res.statusCode, 200);
  assert('as html', /text\/html/.test(res.headers['content-type']));
  res = await app.inject({ method: 'GET', url: '/app.js' });
  eq('and its script', res.statusCode, 200);
  res = await app.inject({ method: 'GET', url: '/../package.json' });
  assert('nothing outside preview/ is reachable', res.statusCode >= 400, String(res.statusCode));
  res = await app.inject({ method: 'GET', url: '/secrets.env' });
  eq('an unlisted name is 404', res.statusCode, 404);
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('=== deck tests ===');
  await resetTestDatabase();
  const alphaId = await seed();
  TREE = makeTree();

  const { build } = require('../src/server/index');
  const app = build({ root: TREE, log: { info() {}, warn() {}, error() {} } });
  await app.ready();

  try {
    await testVerticals(app);
    await testLeads(app);
    await testFilters(app);
    await testNoWebsite(app);
    await testDetail(app, alphaId);
    await testDecision(app, alphaId);
    await testCsv(app);
    await testShots(app);
    await testStatic(app);
  } finally {
    await app.close();
    await truncate().catch(() => {});
    await close();
    fs.rmSync(TREE, { recursive: true, force: true });
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failures.length) console.log('Failed:', failures.join(', '));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('\n[test-deck fatal]', e.stack || e.message);
  close().catch(() => {});
  process.exit(1);
});

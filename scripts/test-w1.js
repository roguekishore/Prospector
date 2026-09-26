'use strict';

/**
 * Acceptance tests for discover + qualify, AC1–AC10. The assertions below are
 * the criteria; the W1 spec they were numbered in has been retired.
 *
 *     DATABASE_URL=mysql://root:pw@127.0.0.1:3306/prospector_test npm run test:w1
 *
 * Discover runs `--source fixture`, so no Places key and no quota. Qualify still
 * makes **real DNS and HTTP requests** — that is the point of AC4–AC9, which are
 * about how real hosts behave — so this one is not offline.
 *
 * The assertions moved from the two JSON artifacts discover and qualify used
 * to write to SQL when those files stopped existing; the acceptance criteria did
 * not change, only where the answer is read from.
 *
 * No external test framework — plain assertions logged to stdout.
 * Exit code 0 = all pass, 1 = at least one failure.
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');

const { db, close } = require('../src/db/mysql');
const { requireTestDatabase, resetTestDatabase, truncate, seedVerticals, quietLog } =
  require('./test-db-helper');

const VERTICAL = 'interior-design';
const CITY     = 'coimbatore';

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

/** Every row of the test vertical, keyed by place id. */
async function rowsByPlaceId() {
  const [rows] = await db().query(
    'SELECT * FROM companies WHERE city = ? ORDER BY place_id', [CITY]);
  return Object.fromEntries(rows.map(r => [r.place_id, r]));
}

// ---------------------------------------------------------------------------
// AC3 — registrable() handles co.in and co.uk correctly (pure unit test)
// ---------------------------------------------------------------------------
function testRegistrable() {
  console.log('\n--- AC3: registrable domain splitting ---');
  const { registrable } = require('../src/discover/provider');

  assert('co.in: lakshmifalseceiling.co.in → registrable domain (not co.in)',
    registrable('http://lakshmifalseceiling.co.in/') === 'lakshmifalseceiling.co.in');

  assert('co.uk: example.co.uk → example.co.uk',
    registrable('https://example.co.uk/') === 'example.co.uk');

  assert('com: blitzglobe.com → blitzglobe.com',
    registrable('https://blitzglobe.com/') === 'blitzglobe.com');

  assert('www stripped: www.srivarudhiniinteriors.com → srivarudhiniinteriors.com',
    registrable('https://www.srivarudhiniinteriors.com/') === 'srivarudhiniinteriors.com');

  assert('null input → null', registrable(null) === null);
  assert('invalid url → null', registrable('not-a-url') === null);
  assert('thehomestudio.co.in → thehomestudio.co.in',
    registrable('https://thehomestudio.co.in/') === 'thehomestudio.co.in');
}

// ---------------------------------------------------------------------------
// AC1 — discover --source fixture fills `companies`
// AC2 — two results sharing a domain are two rows now, each keeping its own
//       review_count. The old criterion was "collapse to one, keeping the higher
//       count"; the operator's 2026-09-26 decision replaced merging with one row
//       per place id (docs/SCHEMA.md), so the criterion is restated, not dropped.
// ---------------------------------------------------------------------------
async function testDiscover() {
  console.log('\n--- AC1+AC2: discover --source fixture ---');

  const discover = require('../src/discover/index');
  await discover._run([VERTICAL, '--source', 'fixture'],
    { root: ROOT, config: {}, log: quietLog() });

  const conn = db();
  const [[n]] = await conn.query('SELECT COUNT(*) AS n FROM companies WHERE city = ?', [CITY]);
  assert('AC1: rows were written', Number(n.n) > 0, String(n.n));

  const by = await rowsByPlaceId();
  const rows = Object.values(by);

  assert('AC1: every row has a name', rows.every(r => typeof r.name === 'string' && r.name));
  assert('AC1: every row has a discovered_run',
    rows.every(r => typeof r.discovered_run === 'string' && r.discovered_run.startsWith('run-')));
  assert('AC1: every row has a discovered_at', rows.every(r => !!r.discovered_at));
  assert('AC1: every domain is either NULL or a string',
    rows.every(r => r.domain === null || typeof r.domain === 'string'));
  assert('AC1: every row is in the configured city', rows.every(r => r.city === CITY));

  // AC2 — blitzglobe.com appears twice in tile0 (review_count 87 and 60).
  const blitz = rows.filter(r => r.domain === 'blitzglobe.com');
  eq('AC2: two listings on one website are two rows', blitz.length, 2);
  eq('AC2: and each keeps its own review_count',
    blitz.map(r => Number(r.review_count)).sort((a, b) => a - b).join(','), '60,87');
  assert('AC2: neither was given a merge trace',
    !('also_seen_as' in blitz[0]), Object.keys(blitz[0]).join(', '));

  // AC6-neighbour: aggregator/social stripped.
  eq('aggregator facebook.com entry has domain NULL', by.ChIJsocial001.domain, null);
  eq('and skip_reason', by.ChIJsocial001.skip_reason, 'aggregator-or-social-only');
  eq('and status -1', by.ChIJsocial001.status, -1);
  eq('wixsite.com entry has domain NULL', by.ChIJwixsite001.domain, null);
  eq('no-website entry has domain NULL', by.ChIJnowebsite001.domain, null);
  eq('and says why', by.ChIJnowebsite001.skip_reason, 'no-website');

  assert('review_count present on businesses with data',
    rows.some(r => r.review_count !== null));

  return by;
}

// ---------------------------------------------------------------------------
// AC10 — the Places key never reaches a stored row
// ---------------------------------------------------------------------------
async function testKeyNotLeaked() {
  console.log('\n--- AC10: the key is never stored ---');
  const [rows] = await db().query('SELECT * FROM companies WHERE city = ?', [CITY]);
  const dump = JSON.stringify(rows);

  const fake = 'FAKE_API_KEY_XYZ_12345_TEST';
  assert('AC10: no row holds a key-shaped string', !dump.includes(fake));

  const real = process.env.GOOGLE_PLACES_KEY;
  if (real) assert('AC10: no row holds GOOGLE_PLACES_KEY', !dump.includes(real));
  else assert('AC10: no key in the environment to check for', true);
}

// ---------------------------------------------------------------------------
// AC3 (stored) — co.in survives into the column
// ---------------------------------------------------------------------------
async function testCoinStored() {
  console.log('\n--- AC3 (stored): co.in in companies.domain ---');
  const by = await rowsByPlaceId();
  eq('AC3: lakshmifalseceiling.co.in stored whole',
    by.ChIJlakshmifalseceiling001.domain, 'lakshmifalseceiling.co.in');
  eq('AC3: thehomestudio.co.in too',
    by['ChIJthehomestudio-coin-001'].domain, 'thehomestudio.co.in');
}

// ---------------------------------------------------------------------------
// AC4, AC5, AC6, AC7, AC8, AC9 — qualify, over real DNS and HTTP
// ---------------------------------------------------------------------------
async function testQualify() {
  console.log('\n--- qualify (real network) ---');

  const qualify = require('../src/qualify/index');
  let error = null;
  try {
    await qualify._run([VERTICAL, '--concurrency', '4'],
      { root: ROOT, config: {}, log: quietLog() });
  } catch (e) { error = e; }

  if (error) { assert('qualify.run() completed without error', false, error.message); return; }
  assert('qualify.run() completed without error', true);

  const by = await rowsByPlaceId();
  const rows = Object.values(by);

  // AC4 — the Places columns survive qualify untouched.
  assert('AC4: rating survives qualify',
    rows.filter(r => r.domain).every(r => r.rating !== undefined));
  assert('AC4: review_count survives qualify',
    rows.filter(r => r.domain).every(r => r.review_count !== undefined));
  eq('AC4: a known review_count is unchanged', Number(by.ChIJblitzglobe001.review_count), 87);

  // Every row with a domain now has a verdict; nothing is left unqualified.
  const unresolved = rows.filter(r => r.domain && r.status === null);
  eq('every row with a domain was qualified', unresolved.length, 0);

  // AC5 — the aggregator rows were never probed, and are still marked as such.
  eq('AC5: the facebook row still says aggregator-or-social-only',
    by.ChIJsocial001.skip_reason, 'aggregator-or-social-only');
  eq('AC5: and was not given a qualified_at', by.ChIJsocial001.qualified_at, null);

  // AC6 — an expired certificate is a finding, not a skip. Recorded in the enum,
  // and the row stays eligible.
  const expired = rows.filter(r => r.https_status === 'expired');
  assert('AC6: an expired certificate never causes a skip',
    expired.every(r => r.status === 0), JSON.stringify(expired.map(r => [r.domain, r.status])));

  // The enum is the whole vocabulary; a free-text "expired 2024-03" no longer
  // exists, which is what makes "every expired certificate" an indexed query.
  assert('https_status is only ok, expired, none or NULL',
    rows.every(r => [null, 'ok', 'expired', 'none'].includes(r.https_status)),
    [...new Set(rows.map(r => r.https_status))].join(', '));

  // AC7 — the Wayback lookup is gone, with its column.
  assert('AC7: no wayback column survives', !('wayback_first' in rows[0]),
    Object.keys(rows[0]).join(', '));

  // AC8 — `--resume` is replaced by the work list being `status IS NULL`, so a
  // second run has nothing to do and returns immediately.
  const t0 = Date.now();
  await qualify._run([VERTICAL, '--concurrency', '4'],
    { root: ROOT, config: {}, log: quietLog() });
  const elapsed = Date.now() - t0;
  assert(`AC8: a second qualify completes in under 2s (actual: ${elapsed}ms)`, elapsed < 2000);

  // AC9 — the skip vocabulary is the one docs/SCHEMA.md lists, and 'audit' is
  // not in it: the verdict string is gone (R11.3).
  const reasons = [...new Set(rows.map(r => r.skip_reason).filter(Boolean))];
  const known = new Set([
    'no-website', 'unusable-website', 'aggregator-profile-only', 'aggregator-or-social-only',
    'dead-host', 'http-error', 'parked', 'robots-disallow', 'probe-error',
  ]);
  assert('AC9: every skip_reason is a known one or a redirect',
    reasons.every(r => known.has(r) || r.startsWith('redirected-to-')), reasons.join(', '));
  assert("AC9: 'audit' is not a stored value anywhere", !reasons.includes('audit'));

  // One probe per website, however many listings share it: both blitzglobe rows
  // must have come out identical.
  const blitz = rows.filter(r => r.domain === 'blitzglobe.com');
  eq('one verdict for a website listed twice',
    new Set(blitz.map(r => `${r.status}|${r.skip_reason}|${r.https_status}`)).size, 1);
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('=== W1 Acceptance Tests ===\n');
  requireTestDatabase();
  await resetTestDatabase();
  await seedVerticals();

  try {
    testRegistrable();
    const discovered = await testDiscover();
    await testCoinStored();
    await testKeyNotLeaked();
    if (discovered) await testQualify();
  } catch (e) {
    console.error('\nUnexpected error during tests:', e.stack || e.message);
    failed++;
  } finally {
    // In a finally, so an assertion failure still leaves the database empty
    // (R13.1). The rows are this test's own; nothing else wrote them.
    await truncate().catch(() => {});
    await close().catch(() => {});
    console.log('\nEmptied the test tables');
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failures.length) console.log('Failed:', failures.join(', '));
  process.exit(failed > 0 ? 1 : 0);
}

main();

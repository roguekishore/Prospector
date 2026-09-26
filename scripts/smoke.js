/* scripts/smoke.js
   Runs a real 5-domain pipeline against data/interior-design-smoke/.
   Seeds from scripts/smoke-seed.json — no Places API call needed.

   Two stages, because capture runs extract itself: seed, capture, then assert
   over what landed in data/<city>/companies/<domain>/.
   Usage: npm run test:run */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT    = path.join(__dirname, '..');
const SEED    = path.join(__dirname, 'smoke-seed.json');
const DATADIR = path.join(ROOT, 'data', 'interior-design-smoke');

const { companyDir, readCity } = require('../lib-keys');
const { registrable } = require('../src/extract/links.js');
const { isComplete }  = require('../src/capture/capture-domain.js');

const CAPTURE_FILES = ['desktop.webp', 'mobile.webp', 'rendered.html', 'extract.json'];

// Load .env same way the CLI does
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
 * What landed for one domain.
 *
 * A domain whose capture failed is reported, not asserted on: the smoke run
 * depends on five third-party websites being up, and a dead host is news about
 * the website rather than about this repo. Every domain that *did* capture must
 * hold exactly the four files and an extract.json with no self-links.
 */
function checkDomain(city, domain) {
  const dir = companyDir(ROOT, city, domain);
  if (!fs.existsSync(dir)) { assert(`${domain}: folder exists`, false, dir); return; }

  const files = fs.readdirSync(dir).sort();
  if (!isComplete(dir)) {
    log.warn(`${domain}: capture incomplete — ${files.join(', ') || 'nothing'}`);
    assert(`${domain}: a failed capture wrote error.json`, files.includes('error.json'),
      files.join(', '));
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

  const own = registrable(`https://${domain}/`);
  const self = (doc.links || []).filter(l => l.target_domain === own);
  assert(`${domain}: no link points at its own registrable domain`,
    self.length === 0, JSON.stringify(self.slice(0, 3)));

  log(`${domain}: email=${doc.email || 'none'}  links=${(doc.links || []).length}`);
}

async function main() {
  // 1. Seed
  log('seeding data/interior-design-smoke/qualified.json');
  fs.mkdirSync(DATADIR, { recursive: true });
  fs.copyFileSync(SEED, path.join(DATADIR, 'qualified.json'));

  const seed    = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const domains = seed.businesses.map(b => b.domain);
  log(`domains: ${domains.join(', ')}`);

  const config = {
    city:  'Coimbatore',
    runId: `smoke-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}Z`,
  };
  const ctx = { root: ROOT, config, log };

  // 2. Capture — which runs extract per domain
  log('--- capture ---');
  const capture = require('../src/capture/index.js');
  const result  = await capture.run(['interior-design-smoke', '--concurrency', '2'], ctx);
  log(`capture returned ${JSON.stringify(result)}`);

  // 3. Assert over the output tree
  const city = readCity(ROOT).slug;
  log(`--- checking data/${city}/companies/ ---`);
  for (const domain of domains) checkDomain(city, domain);

  console.log(failed ? `\n[smoke] ${failed} assertion(s) failed` : '\n[smoke] all assertions passed');
  log(`results in data/${city}/companies/`);
  log('run `npm run test:clean` when finished');
  process.exit(failed ? 1 : 0);
}

main().catch(e => {
  console.error('[smoke fatal]', e.message);
  process.exit(1);
});

/* scripts/smoke.js
   Runs a real 5-domain pipeline against data/interior-design-smoke/.
   Seeds from scripts/smoke-seed.json — no Places API call needed.
   Usage: npm run test:run */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT    = path.join(__dirname, '..');
const SEED    = path.join(__dirname, 'smoke-seed.json');
const DATADIR = path.join(ROOT, 'data', 'interior-design-smoke');

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

async function main() {
  // 1. Seed
  log('seeding data/interior-design-smoke/_qualified.json');
  fs.mkdirSync(DATADIR, { recursive: true });
  fs.copyFileSync(SEED, path.join(DATADIR, '_qualified.json'));

  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  log(`domains: ${seed.businesses.map(b => b.domain).join(', ')}`);

  const config = {
    refYear: 2026,
    city:    'Coimbatore',
    runId:   `smoke-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}Z`,
  };
  const ctx = { root: ROOT, config, log };

  // 2. Audit
  log('--- audit ---');
  const audit = require('../src/capture/index.js');
  await audit.run(['interior-design-smoke', '--concurrency', '2'], ctx);

  // 3. Extract
  log('--- extract ---');
  const extract = require('../src/extract/index.js');
  await extract.run(['--no-probe'], ctx);

  // 4. Report
  log('--- report ---');
  const report = require('../src/report/index.js');
  await report.run(['--no-agency-fetch'], ctx);

  log('done — results in data/interior-design-smoke/');
  log('run `npm run test:clean` when finished');
}

main().catch(e => {
  console.error('[smoke fatal]', e.message);
  process.exit(1);
});

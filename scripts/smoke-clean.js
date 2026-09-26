/* scripts/smoke-clean.js
   Removes everything `npm run test:run` created: the seeded vertical and each
   seed domain's company folder under data/<city>/companies/.
   Usage: npm run test:clean */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT    = path.join(__dirname, '..');
const SEED    = path.join(__dirname, 'smoke-seed.json');
const DATADIR = path.join(ROOT, 'data', 'interior-design-smoke');

const { companyDir, readCity } = require('../lib-keys');

function rm(target, label) {
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`[smoke] deleted ${label}`);
  return true;
}

let removed = rm(DATADIR, 'data/interior-design-smoke/');

// The capture output no longer lives under the vertical, so deleting the
// vertical is not enough — each domain has its own folder under the city.
const city = readCity(ROOT).slug;
try {
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  for (const biz of (seed.businesses || [])) {
    if (!biz.domain) continue;
    const dir = companyDir(ROOT, city, biz.domain);
    if (rm(dir, path.relative(ROOT, dir).split(path.sep).join('/') + '/')) removed = true;
  }
} catch (e) {
  console.error(`[smoke] could not read the seed: ${e.message}`);
  process.exit(1);
}

// Only if the smoke domains were the only thing in there — a real run's captures
// live under the same city and must survive this.
const companies = path.join(ROOT, 'data', city, 'companies');
for (const dir of [companies, path.join(ROOT, 'data', city)]) {
  try {
    if (fs.readdirSync(dir).length === 0) rm(dir, path.relative(ROOT, dir).split(path.sep).join('/') + '/');
  } catch { /* already gone */ }
}

if (!removed) console.log('[smoke] nothing to clean');

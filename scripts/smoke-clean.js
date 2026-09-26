/* scripts/smoke-clean.js
   Removes everything `npm run test:run` created: each seed domain's company
   folder under data/<city>/companies/, and the rows in the test database.
   Usage: npm run test:clean */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SEED = path.join(__dirname, 'smoke-companies.json');

const { companyDir, readCity } = require('../lib-keys');

function rm(target, label) {
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`[smoke] deleted ${label}`);
  return true;
}

async function main() {
  let removed = false;
  const city = readCity(ROOT).slug;

  // Each domain has its own folder under the city — deleting a vertical
  // directory would not touch them, because the capture output is not keyed by
  // vertical.
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  for (const biz of seed) {
    if (!biz.domain) continue;
    const dir = companyDir(ROOT, city, biz.domain);
    if (rm(dir, path.relative(ROOT, dir).split(path.sep).join('/') + '/')) removed = true;
  }

  // Only if the smoke domains were the only thing in there — a real run's
  // captures live under the same city and must survive this.
  for (const dir of [path.join(ROOT, 'data', city, 'companies'), path.join(ROOT, 'data', city)]) {
    try {
      if (fs.readdirSync(dir).length === 0) {
        rm(dir, path.relative(ROOT, dir).split(path.sep).join('/') + '/');
      }
    } catch { /* already gone */ }
  }

  // The rows, when there is a test database to empty. The `_test` guard in the
  // helper is what keeps this from ever reaching a real one; with no
  // DATABASE_URL set there is nothing to clean and that is not an error.
  if (process.env.DATABASE_URL) {
    try {
      const { truncate } = require('./test-db-helper');
      await truncate();
      console.log('[smoke] emptied the test tables');
      removed = true;
    } catch (e) {
      console.error(`[smoke] could not empty the test tables: ${e.message}`);
      process.exitCode = 1;
    }
  } else {
    console.log('[smoke] DATABASE_URL is not set — leaving the database alone');
  }

  if (!removed) console.log('[smoke] nothing to clean');
}

main().catch(e => {
  console.error(`[smoke] ${e.message}`);
  process.exit(1);
});

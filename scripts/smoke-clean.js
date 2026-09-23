/* scripts/smoke-clean.js
   Deletes data/interior-design-smoke/ entirely.
   Usage: npm run test:clean */
'use strict';

const fs   = require('fs');
const path = require('path');

const DATADIR = path.join(__dirname, '..', 'data', 'interior-design-smoke');

if (fs.existsSync(DATADIR)) {
  fs.rmSync(DATADIR, { recursive: true, force: true });
  console.log('[smoke] deleted data/interior-design-smoke/');
} else {
  console.log('[smoke] nothing to clean — data/interior-design-smoke/ does not exist');
}

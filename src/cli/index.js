/* src/cli/index.js
   Dispatcher for all pipeline stages.
   Interface contract: every stage module exports { run: async (argv, ctx) => {} }
   ctx = { root, config, log }
   W3-extract-score.md §11 */
'use strict';

const path = require('path');
const fs   = require('fs');

const ROOT = path.join(__dirname, '..', '..');

// Load .env into process.env — handles UTF-8 and UTF-16 LE (PowerShell default)
try {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const raw = fs.readFileSync(envFile);
    // Detect UTF-16 LE BOM (FF FE) or wide chars (every odd byte is 0x00)
    let text;
    if (raw[0] === 0xFF && raw[1] === 0xFE) {
      text = raw.slice(2).toString('utf16le');
    } else if (raw.length > 4 && raw[1] === 0x00 && raw[3] === 0x00) {
      text = raw.toString('utf16le');
    } else {
      text = raw.toString('utf8').replace(/^﻿/, '');
    }
    // Strip embedded NUL chars that utf16le can leave behind
    text = text.replace(/\0/g, '');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {}

// ---- arg parser ----
function parseArgs(raw) {
  const argv = { _: [] };
  let i = 0;
  while (i < raw.length) {
    const a = raw[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = raw[i + 1];
      if (next && !next.startsWith('--')) {
        argv[key] = next;
        i += 2;
      } else {
        argv[key] = true;
        i++;
      }
    } else {
      argv._.push(a);
      i++;
    }
  }
  return argv;
}

// ---- load config ----
function loadConfig() {
  let city = {};
  try { city = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'city.json'), 'utf8')); }
  catch {}
  return {
    city:    city.city || 'Coimbatore',
    runId:   `run-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}Z`,
  };
}

// ---- logger ----
// Callable as log(...) for W1-style stages AND as log.info/warn/error for W3-style stages.
function log(...a) { console.log('[info]', ...a); }
log.info  = (...a) => console.log('[info]',  ...a);
log.warn  = (...a) => console.warn('[warn]',  ...a);
log.error = (...a) => console.error('[error]',...a);

// ---- stage loader (never crashes the dispatcher) ----
function loadStage(name) {
  // Map stage names to their module directories
  const dirMap = {
    discover: 'discover',
    qualify:  'qualify',
    capture:  'capture',
    extract:  'extract',
    ingest:   'ingest',
    control:  'control',
    serve:    'server',
  };

  // `migrate` is a file, not a directory: it is one script with no stage of its
  // own, and giving it a folder would suggest there is more of it than there is.
  if (name === 'migrate') {
    try { return require(path.join(ROOT, 'src', 'db', 'migrate.js')); }
    catch (e) {
      log.error(`Failed to load stage 'migrate': ${e.message}`);
      process.exit(2);
    }
  }

  const dir = dirMap[name] || name;
  const candidate = path.join(ROOT, 'src', dir, 'index.js');

  if (fs.existsSync(candidate)) {
    try { return require(candidate); }
    catch (e) {
      log.error(`Failed to load stage '${name}': ${e.message}`);
      process.exit(2);
    }
  }

  // Stage module does not exist yet — fail clearly, never crash
  return {
    run: async () => {
      log.error(`Stage '${name}' is not implemented yet (module not found at src/${dir}/index.js).`);
      process.exit(2);
    },
  };
}

// ---- main ----
async function main() {
  const [,, stageArg, ...rest] = process.argv;

  if (!stageArg || stageArg === '--help' || stageArg === '-h') {
    console.log(`
PROSPECTOR pipeline runner

  node src/cli <stage> [<vertical>] [options]

Stages:
  migrate                 Apply db/migrations/ to MySQL (--import-verticals <file>)
  discover   <vertical>   Grid-tile the city, keyword variants, insert companies
  qualify                 HEAD + cert + parked-page probe per domain
  capture                 Playwright shots + rendered.html, then extract
  extract                 Re-run extract over captures that need it
  ingest                  Pull Lambda captures out of S3 and record them
  control                 Progress dashboard + run control (--port 7778)
  serve                   The review deck (--port 7777)
  all                     discover → qualify → capture

Common options:
  --concurrency N         Parallel workers (default: 4)
  --only <domain>         Process one domain only
  --dry-run               Print what would happen, touch nothing
  --verbose               More output

Stage-specific:
  capture:  --headful  --timeout 30000  --deadline 60000  --retry-failed
  ingest:   --with-html

Every stage but migrate reads MySQL. DATABASE_URL overrides DB_HOST/DB_PASSWORD.
`.trim());
    process.exit(0);
  }

  const argv   = rest;          // raw array — each stage parses its own flags
  const config = loadConfig();
  const ctx    = { root: ROOT, config, log };

  // `ingest` is deliberately not in `all`: `all` ends in a local capture, which
  // records itself, and ingest is for the Lambda path where the bytes land in S3
  // (R7.1).
  const STAGES = ['migrate','discover','qualify','capture','extract','ingest','control','serve'];

  if (stageArg === 'all') {
    for (const stage of ['discover','qualify','capture']) {
      const mod    = loadStage(stage);
      const result = await mod.run(argv, ctx);
      if (result && result.ok === 0 && result.err === 0) {
        log.warn(`Stage '${stage}' produced zero output — stopping.`);
        process.exit(1);
      }
      if (result && result.err > 0) process.exitCode = 1;
    }
    process.exit(process.exitCode || 0);
  }

  if (!STAGES.includes(stageArg)) {
    log.error(`Unknown stage '${stageArg}'. Valid stages: ${STAGES.join(', ')}`);
    process.exit(2);
  }

  const mod = loadStage(stageArg);

  try {
    const result = await mod.run(argv, ctx);
    if (result && result.err > 0) process.exit(1);
    process.exit(0);
  } catch (e) {
    log.error(`Fatal error in stage '${stageArg}': ${e.message}`);
    if (argv.verbose) console.error(e.stack);
    process.exit(2);
  }
}

main().catch(e => {
  console.error('[fatal]', e.message);
  process.exit(2);
});

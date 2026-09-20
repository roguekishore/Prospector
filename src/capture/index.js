'use strict';

/**
 * W2 — Capture stage entry point.
 *
 * Implements the frozen stage interface:
 *   module.exports = { run: async (argv, ctx) => {} }
 *   ctx = { root, config, log }
 *
 * CLI:
 *   node src/cli audit [<vertical>] [--resume] [--concurrency 4]
 *                      [--only <domain>] [--headful] [--timeout 30000]
 */

const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { captureDomain, isComplete } = require('./capture-domain');

// ---------------------------------------------------------------------------
// Per-host throttle: enforce 1500ms minimum spacing between requests to the
// same host. One in-flight context per host (effectively achieved by the
// 1500ms gap + concurrency cap on contexts).
// ---------------------------------------------------------------------------
const hostLastMs = new Map();

async function _waitForHost(host) {
  const now  = Date.now();
  const last = hostLastMs.get(host) || 0;
  const wait = 1500 - (now - last);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  hostLastMs.set(host, Date.now());
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function run(argv, ctx) {
  const { root, config, log } = ctx;

  // ── Parse argv ────────────────────────────────────────────────────────────
  const args        = _parseArgs(argv);
  const resume      = args.resume;
  const concurrency = Math.max(1, Number(args.concurrency) || 4);
  const onlyDomain  = args.only || null;
  const headful     = !!args.headful;
  const navTimeout  = Number(args.timeout) || 30_000;
  const vertical    = args._[0] || null;   // optional filter

  // ── Find _qualified.json files ────────────────────────────────────────────
  const dataDir  = path.join(root, 'data');
  const vertDirs = _verticalDirs(dataDir, vertical);

  if (vertDirs.length === 0) {
    log.warn('No verticals found under data/. Run `qualify` first.');
    return;
  }

  // Build the work queue: one entry per business with verdict === "audit"
  const queue = [];
  for (const { vertSlug, vertDir } of vertDirs) {
    const qualPath = path.join(vertDir, '_qualified.json');
    if (!fs.existsSync(qualPath)) {
      log.warn(`No _qualified.json in ${vertDir} — skipping`);
      continue;
    }
    const qualified = JSON.parse(fs.readFileSync(qualPath, 'utf8'));
    const runId     = qualified.run || 'unknown-run';

    for (const biz of (qualified.businesses || [])) {
      if (!biz.domain) continue;
      if (!biz.qualify || biz.qualify.verdict !== 'audit') continue;
      if (onlyDomain && biz.domain !== onlyDomain) continue;

      const outDir = path.join(vertDir, biz.domain);
      queue.push({ vertSlug, biz, outDir, runId });
    }
  }

  if (queue.length === 0) {
    log.warn('No domains marked for audit.');
    return;
  }

  const total = queue.length;
  log.info(`Audit: ${total} domain(s) to capture  concurrency=${concurrency}  resume=${resume}`);

  // ── Launch browser ────────────────────────────────────────────────────────
  let browser = await _launchBrowser(headful);
  let completed = 0;
  const startAll = Date.now();

  // ── Worker pool ───────────────────────────────────────────────────────────
  const idx = { n: 0 };   // shared index into queue

  async function worker() {
    while (true) {
      const i = idx.n++;
      if (i >= queue.length) return;

      const { biz, outDir, runId } = queue[i];
      const domain = biz.domain;
      const pos    = i + 1;

      // Resume: skip if all output files already exist
      if (resume && isComplete(outDir)) {
        completed++;
        log.info(`[${_pad(pos, total)}]  -  ${domain}  (skipped — complete)`);
        continue;
      }

      // Per-host throttle
      const host = _hostOf(biz.qualify.final_url || `https://${domain}/`);
      await _waitForHost(host);

      // Ensure browser is alive
      if (!browser.isConnected()) {
        browser = await _launchBrowser(headful);
      }

      const t0 = Date.now();
      let result;

      // First attempt
      result = await _attemptCapture(browser, biz, outDir, headful, navTimeout, log);

      // Retry policy (§8.1)
      if (!result.ok && _shouldRetry(result.kind)) {
        const retryWait = result.kind === 'blocked-429' ? 30_000 : 5_000;
        log.info(`[${_pad(pos, total)}]  ×  ${domain}  ${result.kind} (retry in ${retryWait / 1000}s)`);
        await new Promise(r => setTimeout(r, retryWait));

        // For 403: retry headful (§8.2)
        const useHeadful = headful || result.kind === 'blocked-403';
        if (!browser.isConnected()) browser = await _launchBrowser(useHeadful);
        result = await _attemptCapture(browser, biz, outDir, useHeadful, navTimeout, log, 2);

        // Record headful in headers.json if it was used
        if (result.ok && useHeadful && !headful) {
          _patchHeadersJson(outDir, { headful: true });
        }
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      completed++;

      if (result.ok) {
        const mb  = result.transferBytes ? (result.transferBytes / 1_048_576).toFixed(1) + 'MB' : '?MB';
        const lcp = result.timing && result.timing.lcp_ms
                    ? (result.timing.lcp_ms / 1000).toFixed(1) + 's'
                    : '?s';
        const con = result.consentSeen ? 'consent:yes' : 'consent:no';
        log.info(`[${_pad(pos, total)}]  A  ${domain}  3 shots  ${mb}  lcp ${lcp}  ${con}  ${elapsed}s`);
      } else {
        log.info(`[${_pad(pos, total)}]  ×  ${domain}  ${result.kind}: ${result.message || ''}`);
      }
    }
  }

  // Run N workers concurrently
  await Promise.all(Array.from({ length: concurrency }, worker));

  await browser.close().catch(() => {});

  const totalSec = ((Date.now() - startAll) / 1000).toFixed(1);
  log.info(`Audit complete: ${completed}/${total} domains in ${totalSec}s`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function _attemptCapture(browser, biz, outDir, headful, timeout, log, attempt = 1) {
  try {
    // Crash recovery: rebuild browser if disconnected (§8.3)
    if (!browser.isConnected()) {
      browser = await _launchBrowser(headful);
    }
    return await captureDomain({ browser, business: biz, outDir, headful, timeout, log });
  } catch (err) {
    // Handle browser crash: reconnect and bubble a crash result
    const kind = (err.message || '').toLowerCase().includes('crash') ? 'crash' : 'unknown';
    _writeError(outDir, biz.domain, kind, err.message, attempt);
    return { ok: false, domain: biz.domain, kind, message: err.message };
  }
}

function _shouldRetry(kind) {
  return kind === 'nav-timeout' || kind === 'crash' || kind === 'blocked-429' || kind === 'blocked-403';
}

async function _launchBrowser(headful) {
  return chromium.launch({
    channel:  'chromium',
    headless: !headful,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
}

function _verticalDirs(dataDir, filterSlug) {
  let entries;
  try {
    entries = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isDirectory() && (!filterSlug || e.name === filterSlug))
    .map(e => ({ vertSlug: e.name, vertDir: path.join(dataDir, e.name) }));
}

function _hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function _pad(pos, total) {
  const w = String(total).length;
  return String(pos).padStart(w, ' ') + '/' + total;
}

function _writeError(outDir, domain, kind, message, attempts) {
  fs.mkdirSync(outDir, { recursive: true });
  const existing = _safeReadPartial(outDir);
  const doc = {
    domain,
    stage:    'audit',
    at:       new Date().toISOString(),
    kind,
    message,
    partial:  existing,
    attempts,
  };
  const tmp = path.join(outDir, 'error.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  fs.renameSync(tmp, path.join(outDir, 'error.json'));
}

// Which shots made it to disk before the failure, named by the extension they
// actually carry — a compressed tree holds .webp where a fresh capture holds
// .png. Diagnostic only: this lands in error.json as `partial`.
function _safeReadPartial(outDir) {
  const found = [];
  for (const shot of ['mobile', 'desktop', 'full']) {
    for (const ext of ['.png', '.webp']) {
      try {
        if (fs.statSync(path.join(outDir, shot + ext)).isFile()) { found.push(shot + ext); break; }
      } catch { /* try next ext */ }
    }
  }
  return found;
}

function _patchHeadersJson(outDir, extra) {
  const p = path.join(outDir, 'raw', 'headers.json');
  try {
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    Object.assign(doc, extra);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch { /* headers.json not written yet — skip */ }
}

// ---------------------------------------------------------------------------
// Minimal argv parser (no external dep)
// ---------------------------------------------------------------------------
function _parseArgs(argv) {
  const out = { _: [] };
  const arr = (argv || []).slice();
  while (arr.length) {
    const a = arr.shift();
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = arr[0];
      if (!next || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = arr.shift();
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

module.exports = { run };

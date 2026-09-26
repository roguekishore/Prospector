'use strict';

/**
 * W2 — Capture stage entry point. Capture, then extract, per domain.
 *
 * Extract runs in the same worker slot as the capture that produced its input:
 * it is cheerio over one local file, so the alternative — a second pass over the
 * whole estate — buys nothing and leaves a window where `rendered.html` exists
 * with no `extract.json`. The Lambda does the same thing in one container.
 *
 * Implements the frozen stage interface:
 *   module.exports = { run: async (argv, ctx) => {} }
 *   ctx = { root, config, log }
 *
 * CLI:
 *   node src/cli capture [<vertical>] [--resume] [--concurrency 4]
 *                        [--only <domain>] [--headful] [--timeout 30000]
 *                        [--deadline 60000]
 */

const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { captureDomain, isComplete } = require('./capture-domain');
const { extractDir } = require('../extract');
const { companyDir, canonicalDomain, readCity } = require('../../lib-keys');

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
  const { root, log } = ctx;

  // ── Parse argv ────────────────────────────────────────────────────────────
  const args        = _parseArgs(argv);
  const resume      = !!args.resume;
  const concurrency = Math.max(1, Number(args.concurrency) || 4);
  const onlyDomain  = args.only || null;
  const headful     = !!args.headful;
  const navTimeout  = Number(args.timeout) || 30_000;
  const deadline    = Number(args.deadline) || 60_000;
  const vertical    = args._[0] || null;   // optional filter

  const city = readCity(root).slug;

  // ── Find qualified.json files ────────────────────────────────────────────
  const dataDir  = path.join(root, 'data');
  const vertDirs = _verticalDirs(dataDir, vertical);

  if (vertDirs.length === 0) {
    log.warn('No verticals found under data/. Run `qualify` first.');
    return { ok: 0, err: 0, skipped: 0 };
  }

  // Build the work queue: one entry per *domain* marked for capture.
  //
  // Deduped by canonical domain across every vertical, first occurrence wins.
  // The output folder is keyed by domain alone, so two verticals listing one
  // website would otherwise capture it twice into the same folder — paying for
  // the second capture and racing the first.
  const queue = [];
  const seen  = new Set();
  for (const { vertDir } of vertDirs) {
    const qualPath = path.join(vertDir, 'qualified.json');
    if (!fs.existsSync(qualPath)) continue;   // not a vertical dir, or qualify hasn't run

    const qualified = JSON.parse(fs.readFileSync(qualPath, 'utf8'));
    const runId     = qualified.run || 'unknown-run';

    for (const biz of (qualified.businesses || [])) {
      if (!biz.domain) continue;
      if (!biz.qualify || biz.qualify.verdict !== 'audit') continue;

      let domain;
      try { domain = canonicalDomain(biz.domain); }
      catch (e) { log.warn(`skipping ${biz.domain}: ${e.message}`); continue; }

      if (onlyDomain && domain !== canonicalDomain(onlyDomain)) continue;
      if (seen.has(domain)) continue;
      seen.add(domain);

      queue.push({ biz, domain, outDir: companyDir(root, city, domain), runId });
    }
  }

  if (queue.length === 0) {
    log.warn('No domains marked for capture.');
    return { ok: 0, err: 0, skipped: 0 };
  }

  const total = queue.length;
  log.info(`Capture: ${total} domain(s)  concurrency=${concurrency}  resume=${resume}`);

  // ── Launch browser ────────────────────────────────────────────────────────
  let browser = await _launchBrowser(headful);
  let ok = 0, err = 0, skipped = 0, extractFailed = 0;
  const startAll = Date.now();

  // ── Worker pool ───────────────────────────────────────────────────────────
  const idx = { n: 0 };   // shared index into queue

  async function worker() {
    while (true) {
      const i = idx.n++;
      if (i >= queue.length) return;

      const { biz, domain, outDir } = queue[i];
      const pos = i + 1;

      // Resume has three answers, not two. A complete capture with no
      // extract.json is a bug fix or an interrupted run, and re-capturing it
      // would spend a page load to produce bytes that are already on disk.
      const complete   = isComplete(outDir);
      const hasExtract = fs.existsSync(path.join(outDir, 'extract.json'));

      if (resume && complete && hasExtract) {
        skipped++;
        log.info(`[${_pad(pos, total)}]  -  ${domain}  (skipped — complete)`);
        continue;
      }

      if (resume && complete && !hasExtract) {
        const t0 = Date.now();
        const extracted = _extract(outDir, domain, biz.qualify.final_url, log);
        ok++;
        if (!extracted) extractFailed++;
        log.info(`[${_pad(pos, total)}]  A  ${domain}  (capture kept)  ` +
                 `extract ${extracted ? 'ok' : 'failed'}  ` +
                 `${((Date.now() - t0) / 1000).toFixed(1)}s`);
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
      let result = await _attemptCapture(browser, biz, outDir, headful, navTimeout, log, 1, deadline);

      // Retry policy (§8.1)
      if (!result.ok && _shouldRetry(result.kind)) {
        const retryWait = result.kind === 'blocked-429' ? 30_000 : 5_000;
        log.info(`[${_pad(pos, total)}]  ×  ${domain}  ${result.kind} (retry in ${retryWait / 1000}s)`);
        await new Promise(r => setTimeout(r, retryWait));

        // For 403: retry headful (§8.2)
        const useHeadful = headful || result.kind === 'blocked-403';
        if (!browser.isConnected()) browser = await _launchBrowser(useHeadful);
        result = await _attemptCapture(browser, biz, outDir, useHeadful, navTimeout, log, 2, deadline);
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      if (result.ok) {
        ok++;
        // Extract only when the capture completed: without rendered.html there
        // is nothing to read, and a failure here never marks the capture failed.
        const extracted = _extract(outDir, domain, result.finalUrl, log);
        if (!extracted) extractFailed++;
        log.info(`[${_pad(pos, total)}]  A  ${domain}  2 shots  ` +
                 `extract ${extracted ? 'ok' : 'failed'}  ${elapsed}s`);
      } else {
        err++;
        log.info(`[${_pad(pos, total)}]  ×  ${domain}  ${result.kind}: ${result.message || ''}`);
      }
    }
  }

  // Run N workers concurrently
  await Promise.all(Array.from({ length: concurrency }, worker));

  await browser.close().catch(() => {});

  const totalSec = ((Date.now() - startAll) / 1000).toFixed(1);
  log.info(`Capture complete: ${ok} ok  ${err} failed  ${skipped} skipped  ` +
           `${extractFailed} extract failures  of ${total} in ${totalSec}s`);

  return { ok, err, skipped };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract one domain's folder. Returns true on success.
 *
 * Wrapped here rather than at the call sites so a thrown extract can never end a
 * worker: the capture it followed is already on disk and paid for, and an extract
 * bug affecting every domain would otherwise abandon the whole run.
 */
function _extract(outDir, domain, finalUrl, log) {
  try {
    extractDir({ dir: outDir, domain, finalUrl });
    return true;
  } catch (e) {
    log.warn(`extract failed [${domain}]: ${e.message}`);
    return false;
  }
}

async function _attemptCapture(browser, biz, outDir, headful, timeout, log, attempt = 1, deadline = 60_000) {
  try {
    // Crash recovery: rebuild browser if disconnected (§8.3)
    if (!browser.isConnected()) {
      browser = await _launchBrowser(headful);
    }
    return await captureDomain({ browser, business: biz, outDir, headful, timeout, deadline, log });
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

/**
 * Directories under `data/` that could hold a `qualified.json`.
 *
 * `data/<city>/` — the capture output — has none, so it is filtered out by the
 * caller's `existsSync` check and never treated as a vertical.
 */
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
    stage:    'capture',
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
// actually carry — an older tree holds .png where a fresh capture holds .webp.
// Diagnostic only: this lands in error.json as `partial`.
function _safeReadPartial(outDir) {
  const found = [];
  for (const shot of ['mobile', 'desktop']) {
    for (const ext of ['.webp', '.png']) {
      try {
        if (fs.statSync(path.join(outDir, shot + ext)).isFile()) { found.push(shot + ext); break; }
      } catch { /* try next ext */ }
    }
  }
  return found;
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

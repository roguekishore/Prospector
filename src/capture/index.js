'use strict';

/**
 * W2 — Capture stage entry point. Capture, then extract, per domain.
 *
 * Extract runs in the same worker slot as the capture that produced its input:
 * it is cheerio over one local file, so the alternative — a second pass over the
 * whole estate — buys nothing and leaves a window where `rendered.html` exists
 * with no `extract.json`. The Lambda does the same thing in one container.
 *
 * ## The work list is a query, not a file
 *
 * `SELECT DISTINCT domain … WHERE status = 0` — one row per domain, whatever
 * vertical it came from, because the output folder is keyed by domain alone.
 * `--resume` is gone with it: a captured domain is `status = 1` and is simply
 * not in the next work list.
 *
 * ## A local capture is recorded here, not by ingest
 *
 * Local captures are never uploaded, so ingest — which lists S3 — would never
 * see them. `recordDomain` is the same function ingest uses, so a row written
 * here is indistinguishable from a row written by a Lambda capture.
 *
 * Implements the frozen stage interface:
 *   module.exports = { run: async (argv, ctx) => {} }
 *   ctx = { root, config, log }
 *
 * CLI:
 *   node src/cli capture [<vertical>] [--concurrency 4] [--retry-failed]
 *                        [--only <domain>] [--headful] [--timeout 30000]
 *                        [--deadline 60000]
 */

const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { captureDomain, isComplete } = require('./capture-domain');
const { extractDir } = require('../extract');
const { companyDir, canonicalDomain, readCity } = require('../../lib-keys');
const { db, tx, close } = require('../db/mysql');
const { recordDomain }  = require('../db/record');

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
  const concurrency = Math.max(1, Number(args.concurrency) || 4);
  const onlyDomain  = args.only || null;
  const headful     = !!args.headful;
  const navTimeout  = Number(args.timeout) || 30_000;
  const deadline    = Number(args.deadline) || 60_000;
  const retryFailed = !!args['retry-failed'];
  const vertical    = args._[0] || null;   // optional filter

  // The control panel still passes --resume on an older release; accept it and
  // say why it does nothing rather than failing a run that was fine.
  if (args.resume) log.warn('--resume is implied now (the work list is status = 0) — ignoring it');

  const city = readCity(root).slug;
  const conn = db();

  let verticalId = null;
  if (vertical) {
    const [rows] = await conn.query('SELECT vertical_id FROM verticals WHERE slug = ?', [vertical]);
    if (!rows.length) { log.error(`No such vertical: ${vertical}`); return { ok: 0, err: 1, skipped: 0 }; }
    verticalId = rows[0].vertical_id;
  }

  const statuses = retryFailed ? [0, -2] : [0];
  const [work] = await conn.query(
    'SELECT domain, MIN(final_url) AS final_url FROM companies' +
    `  WHERE city = ? AND domain IS NOT NULL AND status IN (${statuses.map(() => '?').join(',')})` +
    (verticalId === null ? '' : ' AND vertical_id = ?') +
    '  GROUP BY domain ORDER BY MIN(company_id)',
    verticalId === null ? [city, ...statuses] : [city, ...statuses, verticalId]);

  const queue = [];
  for (const row of work) {
    let domain;
    try { domain = canonicalDomain(row.domain); }
    catch (e) { log.warn(`skipping ${row.domain}: ${e.message}`); continue; }
    if (onlyDomain && domain !== canonicalDomain(onlyDomain)) continue;
    queue.push({
      biz:    { domain, qualify: { final_url: row.final_url }, run: ctx.config?.runId },
      domain,
      outDir: companyDir(root, city, domain),
    });
  }

  if (queue.length === 0) {
    log.warn('No domains pending capture.');
    return { ok: 0, err: 0, skipped: 0 };
  }

  const total = queue.length;
  log.info(`Capture: ${total} domain(s)  concurrency=${concurrency}` +
           (retryFailed ? '  (including previously failed)' : ''));

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

      // Disk first. A domain that is already complete on disk but still at
      // `status = 0` is a run that was killed between the capture and the
      // record — re-capturing it would spend a page load to produce bytes that
      // are already there.
      const complete   = isComplete(outDir);
      const hasExtract = fs.existsSync(path.join(outDir, 'extract.json'));

      if (complete) {
        const t0 = Date.now();
        let extracted = hasExtract;
        if (!hasExtract) extracted = _extract(outDir, domain, biz.qualify.final_url, log);
        await _record(city, domain, outDir, log);
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
        await _record(city, domain, outDir, log);
        log.info(`[${_pad(pos, total)}]  A  ${domain}  2 shots  ` +
                 `extract ${extracted ? 'ok' : 'failed'}  ${elapsed}s`);
      } else {
        err++;
        await _record(city, domain, outDir, log);
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
 * Write this domain's outcome to MySQL, reading it off the folder that was just
 * written. The same `recordDomain` ingest uses, so a locally captured row and a
 * Lambda-captured row are identical.
 *
 * A database failure here must not abandon a capture that is already on disk and
 * already paid for: it is logged, and the next run — or `ingest`, if the folder
 * was ever uploaded — records it.
 */
async function _record(city, domain, outDir, log) {
  const state = { city, domain, complete: false, errorKind: null, capturedAt: null, extract: null };
  try {
    state.complete = isComplete(outDir);
    if (state.complete) {
      state.capturedAt = fs.statSync(path.join(outDir, 'rendered.html')).mtime;
    } else {
      const err = _readJson(path.join(outDir, 'error.json'));
      state.errorKind = err && err.kind ? err.kind : null;
    }
    const doc = _readJson(path.join(outDir, 'extract.json'));
    if (doc) {
      state.extract = doc;
      try { state.extractedAt = fs.statSync(path.join(outDir, 'extract.json')).mtime; } catch { /* now */ }
    }
    await tx(conn => recordDomain(conn, state, log));
  } catch (e) {
    log.warn(`could not record ${domain} in MySQL: ${e.message}`);
  }
}

function _readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

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

/** The CLI closes nothing for us; a stage that leaves the pool open hangs. */
async function runAndClose(argv, ctx) {
  try { return await run(argv, ctx); }
  finally { await close(); }
}

module.exports = { run: runAndClose, _run: run };

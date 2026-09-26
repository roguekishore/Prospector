'use strict';

/**
 * Per-domain capture: two screenshots and the post-JavaScript DOM.
 *
 * Exactly three files, flat in `outDir`, and `rendered.html` is written last so
 * its presence is the completion marker (`completionFiles`, and `COMPLETION` in
 * `s3.js`). Nothing here measures the page: no headers, timings, asset tally or
 * mobile metrics. The deck shows the shots, `extract` reads the DOM, and neither
 * wants a number this stage could produce. W2-capture.md.
 */

const fs   = require('fs');
const path = require('path');
const sharp = require('sharp');
const { isAllowed } = require('./robots');

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Capture one domain.
 *
 * @param {object} opts
 * @param {import('playwright').Browser} opts.browser
 * @param {object}  opts.business   { domain, qualify: { final_url } }
 * @param {string}  opts.outDir     absolute path to data/<city>/companies/<domain>/
 * @param {boolean} [opts.headful]  override: launch headful context
 * @param {number}  [opts.timeout]  nav timeout ms (default 30000)
 * @param {object}  [opts.log]      logger with .info / .warn
 * @returns {Promise<CaptureResult>}
 */
async function captureDomain(opts) {
  const { browser, business, outDir, headful = false, timeout = 30000,
          deadline = DEFAULT_DEADLINE_MS, log = console } = opts;
  const domain   = business.domain;
  const url      = business.qualify.final_url || `https://${domain}/`;
  const runId    = business.run || 'unknown-run';

  // ── robots.txt ──────────────────────────────────────────────────────────
  const origin   = new URL(url).origin;
  const pathname = new URL(url).pathname || '/';
  const allowed  = await isAllowed(origin, pathname);
  if (!allowed) {
    return _errorResult(domain, 'robots', 'robots.txt disallows /', outDir, runId);
  }

  // ── context ─────────────────────────────────────────────────────────────
  let ctx;
  try {
    ctx = await _newContext(browser, headful);
  } catch (err) {
    return _errorResult(domain, 'unknown', err.message, outDir, runId);
  }

  // ── capture, under a hard deadline ──────────────────────────────────────
  // `timeout` bounds navigation only — not the settle sequence, not
  // `_forceImageDecode`. One capture in run 1 ran 677s against a 12s mean. This
  // is the outer bound on the whole thing, and it is what makes a batch's worst
  // case finite: 10 domains x 60s = 600s, inside Lambda's 900s ceiling.
  let result;
  const capture = _doCapture({ ctx, domain, url, runId, outDir, timeout });

  // Promise.race leaves the loser running. When the deadline wins we close the
  // context, which makes `_doCapture` reject; an unobserved rejection would take
  // the whole run down, so it is swallowed here rather than left dangling.
  capture.catch(() => {});

  let timer = null;
  const expiry = new Promise(resolve => { timer = setTimeout(() => resolve(DEADLINE), deadline); });

  try {
    const raced = await Promise.race([capture, expiry]);
    if (raced !== DEADLINE) {
      result = raced;
    } else {
      // Keep whatever landed before the cut — a desktop shot with no mobile one
      // is still worth more than an empty directory.
      const partial = SHOTS
        .map(s => _findShot(outDir, s))
        .filter(Boolean)
        .map(p => path.basename(p));
      if (log && log.warn) {
        log.warn(`[capture] ${domain}: deadline ${deadline}ms exceeded, kept ${partial.length}/2 shots`);
      }
      result = _errorResult(domain, 'deadline', `capture exceeded ${deadline}ms`,
                            outDir, runId, partial);
    }
  } finally {
    if (timer) clearTimeout(timer);   // else the process holds a live timer per capture
    await ctx.close().catch(() => {});
  }
  return result;
}

const SHOTS = ['mobile', 'desktop'];
const SHOT_EXTS = ['.png', '.webp'];

/**
 * Hard ceiling on one whole capture, override with `--deadline`.
 *
 * 60s is ~5x the 11.5s mean measured at concurrency 1 on an 8-vCPU box. A
 * 2-vCPU t4g.small is slower, so watch the `deadline` count on the first
 * vertical: if legitimate captures are being cut, raise it rather than losing
 * the pages.
 */
const DEFAULT_DEADLINE_MS = 60_000;

/** Race marker. A Symbol so no capture result can ever collide with it. */
const DEADLINE = Symbol('capture-deadline');

/** Path of the shot on disk, whichever extension it was written with. */
function _findShot(outDir, shot) {
  for (const ext of SHOT_EXTS) {
    const p = path.join(outDir, shot + ext);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* try next ext */ }
  }
  return null;
}

/**
 * Return the set of files that indicate a complete, successful capture.
 * Used by --resume logic and by `src/control/status.js`.
 *
 * `rendered.html` is last both here and in the write order, so a capture cut by
 * the deadline after one screenshot never looks complete. A shot resolves to
 * whichever extension is on disk, so an older tree whose captures are .png still
 * counts as complete — otherwise --resume would re-capture every domain.
 * Falls back to the .webp name when neither exists, so a missing shot still
 * reports under the name this stage writes.
 *
 * Mirrors `COMPLETION` in `s3.js`. The two must stay in step.
 */
function completionFiles(outDir) {
  return [
    ...SHOTS.map(s => _findShot(outDir, s) || path.join(outDir, s + '.webp')),
    path.join(outDir, 'rendered.html'),
  ];
}

/**
 * True when all completion files exist.
 */
function isComplete(outDir) {
  return completionFiles(outDir).every(f => {
    try { return fs.statSync(f).isFile(); } catch { return false; }
  });
}

module.exports = { captureDomain, isComplete, completionFiles };

// ---------------------------------------------------------------------------
// Context factory
// ---------------------------------------------------------------------------

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 ' +
  'ProspectorBot/1.0 (+mailto:prospector@example.com)';

async function _newContext(browser, headful) {
  // headful is handled at browser-launch level in the runner; here we just
  // create the context with the frozen options.
  return browser.newContext({
    viewport:          { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale:            'en-IN',
    timezoneId:        'Asia/Kolkata',
    userAgent:         UA,
    ignoreHTTPSErrors: true,   // expired certs are a finding; must still capture
    serviceWorkers:    'block',
    reducedMotion:     'reduce',
    colorScheme:       'light',
    bypassCSP:         false,
  });
}

// ---------------------------------------------------------------------------
// Main capture pipeline
// ---------------------------------------------------------------------------

async function _doCapture({ ctx, domain, url, runId, outDir, timeout }) {
  fs.mkdirSync(outDir, { recursive: true });

  const page = await ctx.newPage();

  // ── Cookie-consent: block known consent scripts before navigation ────────
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (/cookiebot|onetrust|cookieyes|termly|iubenda|osano|quantcast|cookie-?consent|cookie-?notice|gdpr|borlabs/i.test(u)) {
      return route.abort();
    }
    return route.continue();
  });

  // ── Navigation ──────────────────────────────────────────────────────────
  let mainResponse = null;
  try {
    mainResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (err) {
    // Capture whatever rendered on timeout; on other errors, bail.
    if (!_isTimeout(err)) {
      const kind = _classifyError(err, mainResponse);
      return _errorResult(domain, kind, err.message, outDir, runId, []);
    }
  }

  // `page.url()` rather than the response URL: a JavaScript redirect after
  // `domcontentloaded` moves the page without a new main response, and extract
  // needs the URL the DOM actually belongs to in order to resolve relative
  // hrefs and to know which domain is the site's own.
  const finalUrl = page.url() || (mainResponse ? mainResponse.url() : url);

  // ── Settle sequence (§3.1) ───────────────────────────────────────────────
  const settleDeadline = Date.now() + 10_000;

  // 1. Freeze animations
  await _freezeAnimations(page);

  // 2. Dismiss consent
  await _dismissConsent(page, settleDeadline);

  // 3. Fonts ready (capped 3s)
  await Promise.race([
    page.evaluate(() => document.fonts.ready).catch(() => {}),
    _delay(3000),
  ]);

  // 4. Scroll + lazy load (§5)
  await _scrollAndLoad(page, settleDeadline);

  // 5. Force-eager image decode (capped 5s, §5.2)
  await Promise.race([
    _forceImageDecode(page),
    _delay(5000),
  ]);

  // 6. Re-freeze (lazy content may add animations)
  await _freezeAnimations(page);

  // 7. Settle wait 1200ms
  await _delay(1200);

  // ── Capture desktop.webp ─────────────────────────────────────────────────
  await page.setViewportSize({ width: 1440, height: 900 });
  await _atomicScreenshot(page, path.join(outDir, 'desktop.webp'), { fullPage: false });

  // ── Mobile viewport (§6.3) ───────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

  // Re-run scroll + decode, then extra settle
  await _scrollAndLoad(page, Date.now() + 8000);
  await Promise.race([_forceImageDecode(page), _delay(5000)]);
  await _freezeAnimations(page);
  await page.waitForTimeout(800);

  await _atomicScreenshot(page, path.join(outDir, 'mobile.webp'), { fullPage: false });

  // ── Rendered HTML, last ───────────────────────────────────────────────────
  // Written after both shots because its presence is what `isComplete` and
  // `captureComplete` read as "this domain is done".
  const renderedHtml = await page.content().catch(() => '');
  _atomicWrite(path.join(outDir, 'rendered.html'), renderedHtml);

  return { ok: true, domain, finalUrl };
}

// ---------------------------------------------------------------------------
// Settle helpers
// ---------------------------------------------------------------------------

async function _freezeAnimations(page) {
  await page.addStyleTag({ content: `
    *, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      caret-color: transparent !important;
    }
    html { scroll-behavior: auto !important; }
    video { visibility: visible !important; }
  ` }).catch(() => {});

  await page.evaluate(() => {
    document.querySelectorAll('video').forEach(v => {
      try { v.pause(); v.currentTime = 0; v.removeAttribute('autoplay'); } catch {}
    });
  }).catch(() => {});
}

async function _dismissConsent(page, deadline) {
  const result = { seen: false };

  // Strategy 2: Click by text (first match wins, 2s timeout)
  const acceptPatterns = [
    /^accept all$/i, /^accept all cookies$/i, /^i accept$/i, /^accept$/i,
    /^allow all$/i, /^got it$/i, /^ok$/i, /^i agree$/i, /^agree$/i,
    /^understood$/i, /^continue$/i, /^close$/i, /^sounds good$/i,
  ];

  const negative = /settings|preferences|manage|customi[sz]e|reject|decline|more info/i;

  let clicked = false;
  const clickDeadline = Math.min(deadline, Date.now() + 2000);

  for (const pattern of acceptPatterns) {
    if (Date.now() > clickDeadline) break;
    try {
      const btn = page.getByRole('button', { name: pattern });
      const txt = await btn.textContent({ timeout: 300 }).catch(() => null);
      if (txt && !negative.test(txt)) {
        await btn.click({ timeout: 500 });
        result.seen   = true;
        result.method = 'click';
        result.label  = txt.trim();
        clicked = true;
        break;
      }
    } catch { /* not found */ }
  }

  if (!clicked) {
    // Fallback: getByText
    for (const pattern of acceptPatterns) {
      if (Date.now() > clickDeadline) break;
      try {
        const el = page.getByText(pattern, { exact: false });
        const txt = await el.textContent({ timeout: 300 }).catch(() => null);
        if (txt && !negative.test(txt)) {
          await el.click({ timeout: 500 });
          result.seen   = true;
          result.method = 'text';
          result.label  = txt.trim();
          clicked = true;
          break;
        }
      } catch { /* not found */ }
    }
  }

  // Strategy 3: Remove fixed overlays that survived
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el);
      if ((s.position === 'fixed' || s.position === 'sticky') &&
          parseInt(s.zIndex || '0', 10) > 900 &&
          el.getBoundingClientRect().height > 60 &&
          /cookie|consent|gdpr|privacy/i.test(el.textContent || '')) {
        el.remove();
      }
    }
  }).catch(() => {});

  return result;
}

async function _scrollAndLoad(page, deadline) {
  await page.evaluate(async () => {
    const step = Math.floor(window.innerHeight * 0.8);
    const max  = Math.min(document.body.scrollHeight, 30000);
    for (let y = 0; y < max; y += step) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 250));
  }).catch(() => {});
}

async function _forceImageDecode(page) {
  await page.evaluate(() => {
    document.querySelectorAll('img[loading="lazy"]').forEach(i => { i.loading = 'eager'; });
    document.querySelectorAll('img[data-src]').forEach(i => {
      if (!i.src) i.src = i.dataset.src;
    });
  }).catch(() => {});

  await page.evaluate(() =>
    Promise.all(
      [...document.images]
        .filter(i => !i.complete)
        .map(i => i.decode().catch(() => {}))
    ).then(() => {})
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// Atomic file writes
// ---------------------------------------------------------------------------

function _atomicWrite(filePath, text) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filePath);
}

async function _atomicScreenshot(page, filePath, opts) {
  const tmp = filePath + '.tmp';
  try {
    const buf = await page.screenshot({ type: 'png', ...opts });
    const webp = await sharp(buf)
      .resize({ width: 720, withoutEnlargement: true, fit: 'inside' })
      .webp({ quality: 50, effort: 4 })
      .toBuffer();
    fs.writeFileSync(tmp, webp);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Error result
// ---------------------------------------------------------------------------

function _errorResult(domain, kind, message, outDir, runId, partial = []) {
  fs.mkdirSync(outDir, { recursive: true });
  const doc = {
    domain,
    stage:    'capture',
    at:       new Date().toISOString(),
    kind,
    message,
    partial,
    attempts: 1,
  };
  _atomicWrite(path.join(outDir, 'error.json'), JSON.stringify(doc, null, 2));
  return { ok: false, domain, kind, message };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function _delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function _isTimeout(err) {
  return err && (err.message || '').toLowerCase().includes('timeout');
}

function _classifyError(err, resp) {
  if (!err) return 'unknown';
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('net::err_name_not_resolved') || msg.includes('dns')) return 'dns';
  if (msg.includes('net::err_connection_refused')) return 'refused';
  if (msg.includes('timeout')) return 'nav-timeout';
  if (resp) {
    const s = resp.status();
    if (s === 403) return 'blocked-403';
    if (s === 429) return 'blocked-429';
  }
  if (msg.includes('crash')) return 'crash';
  return 'unknown';
}

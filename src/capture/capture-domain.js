'use strict';

/**
 * Per-domain capture: screenshots, raw HTML, headers.json.
 * W2-capture.md — full implementation.
 */

const fs   = require('fs');
const path = require('path');
const { isAllowed } = require('./robots');

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Capture one domain.
 *
 * @param {object} opts
 * @param {import('playwright').Browser} opts.browser
 * @param {object}  opts.business   entry from _qualified.json businesses[]
 * @param {string}  opts.outDir     absolute path to data/<vertical>/<domain>/
 * @param {boolean} [opts.headful]  override: launch headful context
 * @param {number}  [opts.timeout]  nav timeout ms (default 30000)
 * @param {object}  [opts.log]      logger with .info / .warn
 * @returns {Promise<CaptureResult>}
 */
async function captureDomain(opts) {
  const { browser, business, outDir, headful = false, timeout = 30000, log = console } = opts;
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

  let result;
  try {
    result = await _doCapture({ ctx, domain, url, runId, outDir, timeout, log });
  } finally {
    await ctx.close().catch(() => {});
  }
  return result;
}

const SHOTS = ['mobile', 'desktop', 'full'];
const SHOT_EXTS = ['.png', '.webp'];

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
 * Used by --resume logic.
 *
 * A shot resolves to whichever extension is on disk, so a tree whose captures
 * have been compressed to WebP still counts as complete — otherwise --resume
 * would re-capture every domain and overwrite the compressed set. Falls back
 * to the .png name when neither exists, so a missing shot still reports under
 * its expected name.
 */
function completionFiles(outDir) {
  return [
    ...SHOTS.map(s => _findShot(outDir, s) || path.join(outDir, s + '.png')),
    path.join(outDir, 'raw', 'headers.json'),
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

async function _doCapture({ ctx, domain, url, runId, outDir, timeout, log }) {
  // Ensure output directories exist
  fs.mkdirSync(path.join(outDir, 'raw'), { recursive: true });

  const assets        = [];
  let   consoleErrors = 0;
  const brokenRequests = [];
  let   mainResponse  = null;
  const redirectChain = [];

  const page = await ctx.newPage();

  // ── Instrumentation ─────────────────────────────────────────────────────
  page.on('response', async r => {
    const h = r.headers();
    assets.push({
      url:           r.url(),
      type:          r.request().resourceType(),
      status:        r.status(),
      bytes:         Number(h['content-length'] || 0),
      last_modified: h['last-modified'] || null,
    });
  });

  page.on('console', m => {
    if (m.type() === 'error') consoleErrors++;
  });

  page.on('requestfailed', r => {
    brokenRequests.push({ url: r.url(), status: 0 });
  });

  // ── Cookie-consent: block known consent scripts before navigation ────────
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (/cookiebot|onetrust|cookieyes|termly|iubenda|osano|quantcast|cookie-?consent|cookie-?notice|gdpr|borlabs/i.test(u)) {
      return route.abort();
    }
    return route.continue();
  });

  // ── Navigation ──────────────────────────────────────────────────────────
  let navErr = null;
  try {
    mainResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (err) {
    navErr = err;
    // Capture whatever rendered on timeout; on other errors, bail.
    if (!_isTimeout(err)) {
      const kind = _classifyError(err, mainResponse);
      return _errorResult(domain, kind, err.message, outDir, runId, []);
    }
  }

  // Collect redirect chain from the response chain
  if (mainResponse) {
    let r = mainResponse.request();
    while (r) {
      redirectChain.unshift(r.url());
      r = r.redirectedFrom();
    }
    if (redirectChain.length === 0) redirectChain.push(url);
  } else {
    redirectChain.push(url);
  }

  // Capture served bytes before any JS mutations
  let rawHtmlBuffer = Buffer.alloc(0);
  let rawCharset    = 'utf-8';
  if (mainResponse) {
    try {
      rawHtmlBuffer = await mainResponse.body();
      const ct = (mainResponse.headers()['content-type'] || '');
      const m  = ct.match(/charset=([^\s;]+)/i);
      if (m) rawCharset = m[1].toLowerCase();
    } catch { /* partial load — keep empty buffer */ }
  }

  const finalUrl = mainResponse ? mainResponse.url() : url;
  const httpStatus = mainResponse ? mainResponse.status() : 0;
  const respHeaders = mainResponse ? mainResponse.headers() : {};

  // ── Settle sequence (§3.1) ───────────────────────────────────────────────
  const settleStart = Date.now();
  const settleDeadline = settleStart + 10_000;

  // 1. Freeze animations
  await _freezeAnimations(page);

  // 2. Dismiss consent
  const consentResult = await _dismissConsent(page, settleDeadline);

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

  // ── Performance metrics (§7.3) ───────────────────────────────────────────
  const timing = await _collectTiming(page);

  // ── Capture desktop.png ──────────────────────────────────────────────────
  await page.setViewportSize({ width: 1440, height: 900 });
  const desktopPath = path.join(outDir, 'desktop.png');
  await _atomicScreenshot(page, desktopPath, { fullPage: false });

  // ── Capture full.png ─────────────────────────────────────────────────────
  const fullPath = path.join(outDir, 'full.png');
  const scrollH  = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
  let fullClipped = false;
  if (scrollH > 20000) {
    fullClipped = true;
    // Clip by setting viewport height temporarily
    await page.setViewportSize({ width: 1440, height: 20000 });
    await _atomicScreenshot(page, fullPath, { fullPage: false });
    await page.setViewportSize({ width: 1440, height: 900 });
  } else {
    await _atomicScreenshot(page, fullPath, { fullPage: true });
  }

  // ── Mobile viewport (§6.3) ───────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

  // Re-run scroll + decode, then extra settle
  await _scrollAndLoad(page, Date.now() + 8000);
  await Promise.race([_forceImageDecode(page), _delay(5000)]);
  await _freezeAnimations(page);
  await page.waitForTimeout(800);

  // ── Measure layout at 390px (§6.4) ───────────────────────────────────────
  const mobileMetrics = await page.evaluate(() => {
    const d = document.documentElement;
    return {
      scrollWidth:  d.scrollWidth,
      clientWidth:  d.clientWidth,
      overflowPx:   Math.max(0, d.scrollWidth - d.clientWidth),
      hasViewportMeta: !!document.querySelector('meta[name="viewport" i]'),
      tapTargetsUnder44: [...document.querySelectorAll('a,button,[role="button"],input,select')]
        .filter(e => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44);
        }).length,
      smallText: [...document.querySelectorAll('p,li,span,div')]
        .filter(e => e.textContent.trim().length > 20 &&
                     parseFloat(getComputedStyle(e).fontSize) < 14).length,
    };
  }).catch(() => ({ scrollWidth: 0, clientWidth: 0, overflowPx: 0,
                    hasViewportMeta: false, tapTargetsUnder44: 0, smallText: 0 }));

  const mobilePath = path.join(outDir, 'mobile.png');
  await _atomicScreenshot(page, mobilePath, { fullPage: false });

  // ── Rendered HTML ─────────────────────────────────────────────────────────
  const renderedHtml = await page.content().catch(() => '');

  // ── Tally asset stats ─────────────────────────────────────────────────────
  const transferBytes = assets.reduce((s, a) => s + (a.bytes || 0), 0);
  const imageBytes    = assets.filter(a => a.type === 'image')
                              .reduce((s, a) => s + (a.bytes || 0), 0);
  const videoBytes    = assets.filter(a => a.type === 'media' || a.type === 'video')
                              .reduce((s, a) => s + (a.bytes || 0), 0);

  // ── Write raw/ ────────────────────────────────────────────────────────────
  const rawDir = path.join(outDir, 'raw');
  _atomicWriteBuffer(path.join(rawDir, 'home.html'), rawHtmlBuffer);
  _atomicWrite(path.join(rawDir, 'rendered.html'), renderedHtml);

  const headersDoc = {
    domain,
    final_url:      finalUrl,
    status:         httpStatus,
    redirect_chain: redirectChain,
    charset:        rawCharset !== 'utf-8' ? rawCharset : undefined,
    headers:        _flattenHeaders(respHeaders),
    timing: {
      lcp_ms:         timing.lcp_ms,
      cls:            timing.cls,
      transfer_bytes: transferBytes,
      requests:       assets.length,
      image_bytes:    imageBytes,
      video_bytes:    videoBytes,
    },
    assets,
    console_errors:  consoleErrors,
    broken_requests: brokenRequests,
    consent:         consentResult,
    mobile:          mobileMetrics,
    full_clipped:    fullClipped || undefined,
    headful:         undefined, // set by caller if headful was used
    captured_at:     new Date().toISOString(),
  };

  _atomicWrite(path.join(rawDir, 'headers.json'), JSON.stringify(headersDoc, null, 2));

  return {
    ok:            true,
    domain,
    finalUrl,
    status:        httpStatus,
    transferBytes,
    timing,
    consentSeen:   consentResult.seen,
    mobileMetrics,
    partialTimeout: !!navErr,
  };
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
// Performance metrics
// ---------------------------------------------------------------------------

async function _collectTiming(page) {
  return page.evaluate(() => new Promise(resolve => {
    let lcp = 0, cls = 0;
    try {
      new PerformanceObserver(l => {
        for (const e of l.getEntries())
          lcp = Math.max(lcp, e.renderTime || e.loadTime || e.startTime || 0);
      }).observe({ type: 'largest-contentful-paint', buffered: true });

      new PerformanceObserver(l => {
        for (const e of l.getEntries())
          if (!e.hadRecentInput) cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {}
    setTimeout(() => resolve({
      lcp_ms: Math.round(lcp),
      cls:    Math.round(cls * 1000) / 1000,
    }), 1500);
  })).catch(() => ({ lcp_ms: 0, cls: 0 }));
}

// ---------------------------------------------------------------------------
// Atomic file writes
// ---------------------------------------------------------------------------

function _atomicWrite(filePath, text) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filePath);
}

function _atomicWriteBuffer(filePath, buf) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, filePath);
}

async function _atomicScreenshot(page, filePath, opts) {
  const tmp = filePath + '.tmp';
  try {
    await page.screenshot({ path: tmp, type: 'png', ...opts });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Clean up tmp on failure; do not throw — partial result is better than none.
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
    stage:    'audit',
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

function _flattenHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    // Only include useful headers; skip set-cookie noise.
    if (k.toLowerCase() === 'set-cookie') continue;
    out[k] = v;
  }
  return out;
}

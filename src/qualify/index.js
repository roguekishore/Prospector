'use strict';

/**
 * qualify/index.js — Stage 2
 *
 * Runs cheap probes (HEAD, TLS, parked-page, Wayback CDX) over every domain
 * in discovered.json, producing qualified.json. No browser.
 *
 * CLI contract: module.exports = { run: async (argv, ctx) => {} }
 * where ctx = { root, config, log }
 */

const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const https   = require('https');
const { URL } = require('url');
const { registrable } = require('../discover/provider');

// ---------------------------------------------------------------------------
// Domains that are never leads (§2.6 of W1 spec) — also checked after redirect
// ---------------------------------------------------------------------------
const REJECT_DOMAINS = new Set([
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com',
  'youtube.com', 'justdial.com', 'sulekha.com', 'indiamart.com',
  'tradeindia.com', 'urbanpro.com', 'wa.me', 'api.whatsapp.com',
  'linktr.ee', 'bit.ly', 'goo.gl', 'maps.app.goo.gl', 'sites.google.com',
  'business.site', 'wixsite.com', 'weebly.com', 'blogspot.com',
  'wordpress.com', 'jimdosite.com',
]);
const REJECT_PATTERNS = [/^webnode\./];

function isDomainRejected(urlOrHost) {
  let host;
  try {
    host = new URL(urlOrHost).hostname.toLowerCase();
  } catch {
    host = urlOrHost.toLowerCase();
  }
  const reg = registrable('https://' + host);
  if (reg && REJECT_DOMAINS.has(reg)) return true;
  for (const pat of REJECT_PATTERNS) {
    if (pat.test(host)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Parked-page detection patterns
// ---------------------------------------------------------------------------
const PARKED_PATTERNS = [
  /this domain (is for sale|has expired)/i,
  /buy this domain/i,
  /sedoparking|parkingcrew|bodis|afternic|dan\.com/i,
  /default web site page|apache2 (ubuntu|debian) default/i,
  /index of \//i,
  /<title>\s*(untitled|new page \d)/i,
];

/**
 * @param {string} body8k
 * @param {number} bodyLen  total size if known, else body8k.length
 * @returns {boolean}
 */
function isParked(body8k, bodyLen) {
  for (const pat of PARKED_PATTERNS) {
    if (pat.test(body8k)) return true;
  }
  // "coming soon" only when body is small
  if (bodyLen < 2048 && /coming soon/i.test(body8k)) return true;
  // Under 512 bytes, no img and no <a href>
  if (bodyLen < 512 && !/<img/i.test(body8k) && !/<a\s[^>]*href/i.test(body8k)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Robots.txt cache (per host, per run)
// ---------------------------------------------------------------------------
const robotsCache = new Map(); // host → Set of disallowed path prefixes

/**
 * Fetch and parse robots.txt for the host. Results are cached.
 * Returns the set of disallowed path prefixes for *.
 * On any failure returns an empty set (fail-open: don't block the domain).
 *
 * @param {string} host
 * @param {string} scheme  'http' | 'https'
 * @returns {Promise<Set<string>>}
 */
async function getRobotRules(host, scheme) {
  const key = `${scheme}://${host}`;
  if (robotsCache.has(key)) return robotsCache.get(key);

  const rules = new Set();
  try {
    const body = await fetchSmall(`${key}/robots.txt`, 8000, 8192);
    if (body) {
      let inStar = false;
      for (const line of body.split('\n')) {
        const trimmed = line.trim();
        if (/^user-agent\s*:\s*\*/i.test(trimmed)) { inStar = true; continue; }
        if (/^user-agent\s*:/i.test(trimmed)) { inStar = false; continue; }
        if (inStar && /^disallow\s*:/i.test(trimmed)) {
          const p = trimmed.replace(/^disallow\s*:\s*/i, '').split('#')[0].trim();
          if (p) rules.add(p);
        }
      }
    }
  } catch { /* fail-open */ }

  robotsCache.set(key, rules);
  return rules;
}

/**
 * Returns true if the path is disallowed by the rules set.
 * @param {Set<string>} rules
 * @param {string} pathname
 * @returns {boolean}
 */
function isRobotsDisallowed(rules, pathname) {
  for (const prefix of rules) {
    if (prefix === '/' || pathname.startsWith(prefix)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-host concurrency and rate limiting
// ---------------------------------------------------------------------------
const hostQueues    = new Map(); // host → Promise (last inflight)
const hostLastSeen  = new Map(); // host → timestamp of last request start
const MIN_DELAY_MS  = 1500;

/**
 * Enqueue a task for a host, ensuring:
 * - One concurrent request per host
 * - At least MIN_DELAY_MS between requests to the same host
 *
 * @param {string} host
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withHostQueue(host, fn) {
  const prev = hostQueues.get(host) || Promise.resolve();

  const next = prev.then(async () => {
    const last = hostLastSeen.get(host) || 0;
    const wait = MIN_DELAY_MS - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    hostLastSeen.set(host, Date.now());
    return fn();
  });

  // Store the chain (suppress unhandled rejections from queueing)
  hostQueues.set(host, next.catch(() => {}));
  return next;
}

// ---------------------------------------------------------------------------
// Simple HTTP helpers
// ---------------------------------------------------------------------------
const USER_AGENT = 'Prospector/1.0 (+https://github.com/local/prospector; contact@example.com)';

/**
 * Fetch up to `maxBytes` from a URL, returning the body string.
 * Follows up to 5 redirects. Does NOT honour robots.txt — caller must check.
 * Returns null on any error.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @param {number} maxBytes
 * @returns {Promise<string|null>}
 */
function fetchSmall(url, timeoutMs = 8000, maxBytes = 8192) {
  return new Promise((resolve) => {
    let resolved = false;
    let redirects = 0;

    function doFetch(currentUrl) {
      let parsed;
      try { parsed = new URL(currentUrl); } catch { return resolve(null); }

      const mod = parsed.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        headers:  {
          'User-Agent': USER_AGENT,
          'Range': `bytes=0-${maxBytes - 1}`,
          'Accept-Encoding': 'identity',
        },
        timeout: timeoutMs,
      };

      const req = mod.request(options, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (++redirects > 5) return resolve(null);
          const loc = res.headers['location'];
          if (!loc) return resolve(null);
          const next = loc.startsWith('http') ? loc : new URL(loc, currentUrl).href;
          return doFetch(next);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length >= maxBytes) {
            req.destroy();
            if (!resolved) { resolved = true; resolve(body.slice(0, maxBytes)); }
          }
        });
        res.on('end', () => {
          if (!resolved) { resolved = true; resolve(body.slice(0, maxBytes)); }
        });
        res.on('error', () => { if (!resolved) { resolved = true; resolve(null); } });
      });

      req.on('timeout', () => { req.destroy(); if (!resolved) { resolved = true; resolve(null); } });
      req.on('error',   () => { if (!resolved) { resolved = true; resolve(null); } });
      req.end();
    }

    doFetch(url);
  });
}

/**
 * HTTP HEAD (or GET range on 405) returning { status, finalUrl, redirectChain, headers, body8k, certExpires, certValid }
 *
 * @param {string} startUrl
 * @returns {Promise<object>}
 */
async function probe(startUrl) {
  const TIMEOUT = 8000;
  const result = {
    status:        null,
    finalUrl:      startUrl,
    redirectChain: [],
    headers:       {},
    body8k:        null,
    certExpires:   null,
    certValid:     true,
    error:         null,
  };

  return new Promise((resolve) => {
    let resolved = false;
    let redirects = 0;

    function finish() { if (!resolved) { resolved = true; resolve(result); } }

    function doHead(currentUrl) {
      let parsed;
      try { parsed = new URL(currentUrl); } catch {
        result.error = `invalid URL: ${currentUrl}`;
        return finish();
      }

      result.redirectChain.push(currentUrl);
      const mod = parsed.protocol === 'https:' ? https : http;

      const options = {
        hostname:           parsed.hostname,
        port:               parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:               parsed.pathname + parsed.search,
        method:             'HEAD',
        headers:            { 'User-Agent': USER_AGENT },
        timeout:            TIMEOUT,
        rejectUnauthorized: false, // capture expired certs, don't skip them
      };

      const req = mod.request(options, (res) => {
        // Extract TLS certificate info
        if (parsed.protocol === 'https:' && res.socket && res.socket.getPeerCertificate) {
          try {
            const cert = res.socket.getPeerCertificate();
            if (cert && cert.valid_to) {
              result.certExpires = cert.valid_to;
              result.certValid   = new Date(cert.valid_to) > new Date();
            }
          } catch { /* ignore */ }
        }

        const status = res.statusCode;
        result.status = status;
        result.headers = res.headers || {};
        res.resume();

        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(status)) {
          const loc = res.headers['location'];
          if (!loc || ++redirects > 10) { result.finalUrl = currentUrl; return finish(); }
          const next = loc.startsWith('http') ? loc : new URL(loc, currentUrl).href;
          result.finalUrl = next;
          return doHead(next);
        }

        result.finalUrl = currentUrl;

        // 405 — try GET with Range
        if (status === 405) {
          return doGetRange(currentUrl);
        }

        // For non-2xx without redirect, no body needed for HEAD
        if (status < 200 || status >= 400) {
          return finish();
        }

        // Success — we need body for parked-page check and viewport probe.
        // Re-fetch with GET Range (HEAD gave us headers/status already).
        return doGetRange(currentUrl);
      });

      req.on('timeout', () => { req.destroy(); result.error = 'timeout'; finish(); });
      req.on('error',   (e) => { result.error = e.message; finish(); });
      req.end();
    }

    function doGetRange(url) {
      let parsed;
      try { parsed = new URL(url); } catch { return finish(); }

      const mod = parsed.protocol === 'https:' ? https : http;
      const options = {
        hostname:           parsed.hostname,
        port:               parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:               parsed.pathname + parsed.search,
        method:             'GET',
        headers:            { 'User-Agent': USER_AGENT, 'Range': 'bytes=0-8191' },
        timeout:            TIMEOUT,
        rejectUnauthorized: false,
      };

      // Also capture cert here if not already done (http→https redirect case)
      const req = mod.request(options, (res) => {
        if (parsed.protocol === 'https:' && !result.certExpires && res.socket && res.socket.getPeerCertificate) {
          try {
            const cert = res.socket.getPeerCertificate();
            if (cert && cert.valid_to) {
              result.certExpires = cert.valid_to;
              result.certValid   = new Date(cert.valid_to) > new Date();
            }
          } catch { /* ignore */ }
        }

        // If HEAD said 405, use GET's status
        if (result.status === 405) {
          result.status = res.statusCode;
          result.headers = res.headers || {};
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length >= 8192) req.destroy();
        });
        res.on('end',   () => { result.body8k = body.slice(0, 8192); finish(); });
        res.on('error', () => finish());
        res.resume();
      });

      req.on('timeout', () => { req.destroy(); finish(); });
      req.on('error',   () => finish());
      req.end();
    }

    doHead(startUrl);
  });
}

// ---------------------------------------------------------------------------
// Wayback CDX
// ---------------------------------------------------------------------------
/**
 * Fetch first (and optionally last) snapshot year for a domain from Wayback CDX.
 * Returns { first: "YYYY" | "none", last: "YYYY" | "none" }
 * Never throws — Wayback being down must not fail a run.
 *
 * @param {string} domain
 * @returns {Promise<{first: string, last: string}>}
 */
async function waybackYears(domain) {
  const base = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&output=json&fl=timestamp&filter=statuscode:200`;

  async function fetch1(url) {
    try {
      const ac = new AbortController();
      const tid = setTimeout(() => ac.abort(), 8000);
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal:  ac.signal,
      }).finally(() => clearTimeout(tid));
      if (!res.ok) return null;
      const json = await res.json();
      // First row is the header ["timestamp"], skip it
      if (!Array.isArray(json) || json.length < 2) return null;
      return json[1][0]; // timestamp string e.g. "20150312143000"
    } catch {
      return null;
    }
  }

  const firstTs = await fetch1(`${base}&limit=1`);
  const first   = firstTs ? firstTs.slice(0, 4) : 'none';

  let last = 'none';
  if (firstTs) {
    const lastTs = await fetch1(`${base}&limit=-1`);
    last = lastTs ? lastTs.slice(0, 4) : 'none';
  }

  return { first, last };
}

// ---------------------------------------------------------------------------
// Format cert expiry → the string the spec wants
// ---------------------------------------------------------------------------
/**
 * Given `certExpires` (the TLS cert's valid_to string) and `certValid` boolean,
 * return the `https` field value:
 *   "ok"              — valid cert
 *   "expired YYYY-MM" — expired cert (high-value finding, NOT a skip)
 *   "none — http only" — no https at all (never called for non-https)
 *
 * @param {boolean} certValid
 * @param {string|null} certExpires  e.g. "Jan 14 12:00:00 2027 GMT"
 * @returns {string}
 */
function certStatus(certValid, certExpires) {
  if (!certExpires) return 'none — http only';
  if (certValid) return 'ok';
  // Format expiry as "YYYY-MM"
  try {
    const d = new Date(certExpires);
    const yr  = d.getUTCFullYear();
    const mo  = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `expired ${yr}-${mo}`;
  } catch {
    return 'expired';
  }
}

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------
function writeAtomic(filepath, data) {
  const dir = path.dirname(filepath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filepath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filepath);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------
/**
 * @param {string[]} argv
 * @param {object}  ctx   { root, config, log }
 */
async function run(argv, ctx) {
  const { root, log } = ctx;

  const verticalSlug  = argv[0] || null;
  const resume        = argv.includes('--resume');
  const concurrencyArg = getFlag(argv, '--concurrency');
  const CONCURRENCY   = concurrencyArg ? parseInt(concurrencyArg, 10) : 8;

  // Load configs to find vertical slugs
  const verticalsConfig = JSON.parse(fs.readFileSync(path.join(root, 'config', 'verticals.json'), 'utf8'));

  const verticals = verticalSlug
    ? [verticalsConfig.find(v => v.slug === verticalSlug)].filter(Boolean)
    : verticalsConfig.filter(v => v.enabled);

  if (verticals.length === 0) throw new Error(`No vertical found: ${verticalSlug || '(enabled)'}`);

  for (const vertical of verticals) {
    await qualifyVertical(vertical.slug, root, { resume, concurrency: CONCURRENCY, log });
  }
}

async function qualifyVertical(verticalSlug, root, { resume, concurrency, log }) {
  const discoveredPath = path.join(root, 'data', verticalSlug, 'discovered.json');
  if (!fs.existsSync(discoveredPath)) {
    log(`[qualify] ERROR: ${discoveredPath} not found. Run discover first.`);
    return;
  }

  const discovered = JSON.parse(fs.readFileSync(discoveredPath, 'utf8'));
  const runId      = discovered.run;

  const outPath = path.join(root, 'data', verticalSlug, 'qualified.json');

  // --resume: load existing qualified output so we can skip already-done domains
  let existingByDomain = {};
  if (resume && fs.existsSync(outPath)) {
    const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    for (const b of (existing.businesses || [])) {
      if (b.domain && b.qualify) existingByDomain[b.domain] = b.qualify;
    }
    log(`[qualify] resume: ${Object.keys(existingByDomain).length} domains already qualified`);
  }

  const businesses = discovered.businesses || [];
  const toQualify  = businesses.filter(b => b.domain && !b.skip_reason);

  log(`[qualify] vertical=${verticalSlug} total=${businesses.length} to_probe=${toQualify.length} concurrency=${concurrency}`);

  // Process with global concurrency cap
  const results = new Array(businesses.length).fill(null);
  const nonDomainIdxs = [];
  const workQueue     = [];

  for (let i = 0; i < businesses.length; i++) {
    const b = businesses[i];
    if (!b.domain || b.skip_reason) {
      nonDomainIdxs.push(i);
      results[i] = b; // pass through as-is
    } else {
      workQueue.push({ i, b });
    }
  }

  // Run workQueue with concurrency limit
  let qi = 0;
  async function worker() {
    while (true) {
      let item;
      // Grab next item atomically
      if (qi >= workQueue.length) break;
      item = workQueue[qi++];

      const { i, b } = item;

      // --resume short-circuit
      if (existingByDomain[b.domain]) {
        results[i] = { ...b, qualify: existingByDomain[b.domain] };
        continue;
      }

      const qResult = await qualifyOne(b, root, log);
      results[i] = { ...b, qualify: qResult };
    }
  }

  const workers = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);

  // Build output businesses array (preserving original order)
  const outputBusinesses = results.map(r => r);

  // Summary stats
  const total       = outputBusinesses.length;
  const withDomain  = outputBusinesses.filter(b => b.domain).length;
  const qualified   = outputBusinesses.filter(b => b.qualify && b.qualify.verdict === 'audit').length;
  const skipped     = outputBusinesses.filter(b => b.qualify && b.qualify.verdict === 'skip').length;

  const skipReasons = {};
  for (const b of outputBusinesses) {
    if (b.qualify?.verdict === 'skip') {
      const r = b.qualify.reason || 'unknown';
      skipReasons[r] = (skipReasons[r] || 0) + 1;
    }
    if (b.skip_reason) {
      const r = b.skip_reason;
      skipReasons[r] = (skipReasons[r] || 0) + 1;
    }
  }

  const mobileBroken  = outputBusinesses.filter(b => b.qualify?.viewport_meta === false).length;
  const expiredCerts  = outputBusinesses.filter(b => b.qualify?.https?.startsWith('expired')).length;

  // Print summary table
  log('');
  log(`discovered      ${total}`);
  log(`with domain     ${withDomain}   (${pct(withDomain, total)}%)`);
  log(`qualified       ${qualified}`);
  log(`  skipped       ${skipped}`);
  for (const [reason, count] of Object.entries(skipReasons).sort((a, b) => b[1] - a[1])) {
    log(`    ${reason.padEnd(20)} ${count}`);
  }
  log(`mobile-broken   ${mobileBroken}   (${pct(mobileBroken, qualified)}% of qualified)`);
  log(`expired certs   ${expiredCerts}   <- highest-value leads`);
  log('');

  const output = {
    run:      runId,
    vertical: verticalSlug,
    source:   discovered.source,
    queried_at: discovered.queried_at,
    qualified_at: new Date().toISOString(),
    tiles:    discovered.tiles,
    keywords: discovered.keywords,
    raw_results: discovered.raw_results,
    businesses: outputBusinesses,
  };

  writeAtomic(outPath, output);
  log(`[qualify] wrote ${outPath}`);
}

// ---------------------------------------------------------------------------
// Qualify a single business
// ---------------------------------------------------------------------------
async function qualifyOne(b, root, log) {
  const domain = b.domain;
  const startUrl = b.website_raw || `https://${domain}/`;

  // Normalise start URL — try https first, fall back later if needed
  const tryUrl = startUrl.startsWith('http') ? startUrl : `https://${domain}/`;

  // --- Probe 1: robots.txt ---
  let scheme = 'https';
  let host   = domain;
  try {
    const u = new URL(tryUrl);
    scheme = u.protocol.replace(':', '');
    host   = u.hostname;
  } catch { /* use defaults */ }

  const robotRules = await withHostQueue(host, () => getRobotRules(host, scheme));

  if (isRobotsDisallowed(robotRules, '/')) {
    return {
      verdict:        'skip',
      reason:         'robots-disallow',
      http_status:    null,
      final_url:      tryUrl,
      https:          'none — http only',
      cert_expires:   null,
      viewport_meta:  null,
      wayback_first:  'none',
      server:         null,
      generator_hint: null,
    };
  }

  // --- Probe 2: HTTP reachability ---
  let probeResult;
  try {
    probeResult = await withHostQueue(host, () => probe(tryUrl));
  } catch (e) {
    return skip('probe-error', tryUrl);
  }

  const { status, finalUrl, redirectChain, headers, body8k, certExpires, certValid, error } = probeResult;

  // DNS failure / connection refused / timeout
  if (error && !status) {
    log(`[qualify]   skip ${domain}: ${error}`);
    return skip('dead-host', tryUrl);
  }

  // status >= 400
  if (status !== null && status >= 400) {
    log(`[qualify]   skip ${domain}: HTTP ${status}`);
    return skip('http-error', finalUrl || tryUrl);
  }

  // Redirect to a rejected domain
  const finalReg = finalUrl ? registrable(finalUrl) : null;
  if (finalReg && REJECT_DOMAINS.has(finalReg)) {
    log(`[qualify]   skip ${domain}: redirected to ${finalReg}`);
    return {
      verdict:        'skip',
      reason:         `redirected-to-${finalReg}`,
      http_status:    status,
      final_url:      finalUrl,
      https:          finalUrl?.startsWith('https') ? certStatus(certValid, certExpires) : 'none — http only',
      cert_expires:   certExpires || null,
      viewport_meta:  null,
      wayback_first:  'none',
      server:         headers['server'] || null,
      generator_hint: null,
    };
  }

  // --- TLS ---
  const usesHttps   = finalUrl?.startsWith('https') || tryUrl.startsWith('https');
  const httpsField  = usesHttps ? certStatus(certValid, certExpires) : 'none — http only';
  // Expired cert is NOT a skip — it is a high-value finding. Continue.

  // --- Probe 3: Parked-page detection ---
  const bodyLen = body8k ? body8k.length : 0;
  if (body8k && isParked(body8k, bodyLen)) {
    log(`[qualify]   skip ${domain}: parked`);
    return {
      verdict:        'skip',
      reason:         'parked',
      http_status:    status,
      final_url:      finalUrl,
      https:          httpsField,
      cert_expires:   certExpires || null,
      viewport_meta:  null,
      wayback_first:  'none',
      server:         headers['server'] || null,
      generator_hint: null,
    };
  }

  // --- Probe 4 (in parallel with viewport): Wayback CDX ---
  // --- Viewport meta (from body already in hand) ---
  const viewportMeta = body8k
    ? /<meta[^>]+name\s*=\s*["']?viewport["']?/i.test(body8k)
    : null;

  const wayback = await waybackYears(domain);

  // Generator hint from meta tag in body8k
  let generatorHint = null;
  if (body8k) {
    const gm = body8k.match(/<meta[^>]+name\s*=\s*["']?generator["']?[^>]+content\s*=\s*["']([^"']+)["']/i)
            || body8k.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+name\s*=\s*["']?generator["']?/i);
    if (gm) generatorHint = gm[1];
  }

  return {
    verdict:        'audit',
    reason:         null,
    http_status:    status,
    final_url:      finalUrl,
    https:          httpsField,
    cert_expires:   certExpires || null,
    viewport_meta:  viewportMeta,
    wayback_first:  wayback.first,
    server:         headers['server'] || null,
    generator_hint: generatorHint,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function skip(reason, url) {
  return {
    verdict:        'skip',
    reason,
    http_status:    null,
    final_url:      url,
    https:          'none — http only',
    cert_expires:   null,
    viewport_meta:  null,
    wayback_first:  'none',
    server:         null,
    generator_hint: null,
  };
}

function pct(num, den) {
  if (!den) return 0;
  return Math.round((num / den) * 100);
}

function getFlag(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return null;
  return argv[idx + 1];
}

module.exports = { run };

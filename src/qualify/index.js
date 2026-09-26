'use strict';

/**
 * qualify/index.js — Stage 2
 *
 * Cheap probes (robots, HEAD/GET, TLS, parked-page) over every domain that
 * discover left at `status IS NULL`, writing the verdict back onto every row
 * that shares the domain. No browser, no file.
 *
 * ## One probe per domain, not per row
 *
 * Several `companies` rows can share one website — two showrooms, a company and
 * its brand. Capture already runs once per `(city, domain)`, so qualify does
 * too: the work list is `GROUP BY domain` and the `UPDATE` matches on the
 * domain, not on a company id.
 *
 * ## Re-running replaces --resume
 *
 * The work list is `status IS NULL`, which a finished probe clears. Running
 * qualify twice therefore probes only what is still unqualified, which is what
 * `--resume` used to approximate by reading back its own output file.
 *
 * ## Sibling inheritance
 *
 * A later discover can find a new place ID for a website that is already
 * captured. Probing it again would be harmless; *capturing* it again would not,
 * and the row would sit at `status = 0` forever if capture skipped the domain as
 * already done. So a new row whose domain already has a qualified sibling copies
 * that sibling's qualify, capture and extract columns and its links, and is not
 * probed at all.
 *
 * CLI contract: module.exports = { run: async (argv, ctx) => {} }
 * where ctx = { root, config, log }
 */

const http    = require('http');
const https   = require('https');
const { URL } = require('url');

const { registrable } = require('../discover/provider');
const { readCity }    = require('../../lib-keys');
const { db, tx, close } = require('../db/mysql');

// ---------------------------------------------------------------------------
// Domains that are never leads (the families discover rejects), checked again
// here against the post-redirect host so a site forwarding to Facebook is skipped
// ---------------------------------------------------------------------------
const REJECT_DOMAINS = new Set([
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com',
  'youtube.com', 'justdial.com', 'sulekha.com', 'indiamart.com',
  'tradeindia.com', 'urbanpro.com', 'wa.me', 'api.whatsapp.com',
  'linktr.ee', 'bit.ly', 'goo.gl', 'maps.app.goo.gl', 'sites.google.com',
  'business.site', 'wixsite.com', 'weebly.com', 'blogspot.com',
  'wordpress.com', 'jimdosite.com',
]);

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
 * HTTP HEAD (or GET range on 405) returning
 * { status, finalUrl, redirectChain, headers, body8k, certExpires, certValid }
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

        // Success — we need the body for the parked-page check.
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
// TLS status → the enum docs/SCHEMA.md stores
// ---------------------------------------------------------------------------
/**
 * `https_status` is an ENUM('ok','expired','none') and `cert_expires` is a DATE.
 * The old free-text `"expired 2024-03"` carried the month in the same string as
 * the verdict, which made "every expired certificate" a `LIKE` query.
 *
 * @param {boolean} certValid
 * @param {?string} certExpires  the certificate's `valid_to`
 * @returns {'ok'|'expired'|'none'}
 */
function certStatus(certValid, certExpires) {
  if (!certExpires) return 'none';
  return certValid ? 'ok' : 'expired';
}

/** A certificate's `valid_to` → `YYYY-MM-DD`, or null when it cannot be read. */
function certDate(certExpires) {
  if (!certExpires) return null;
  const d = new Date(certExpires);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// The columns a sibling row hands down
// ---------------------------------------------------------------------------
const INHERITED = [
  'status', 'skip_reason', 'final_url', 'http_status', 'https_status',
  'cert_expires', 'qualified_at', 'capture_error', 'captured_at',
  'extract_status', 'extracted_at', 'email',
];

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------
/**
 * @param {string[]} argv
 * @param {object}  ctx   { root, config, log }
 */
async function run(argv, ctx) {
  const { root, log } = ctx;

  const verticalSlug   = argv.find(a => !a.startsWith('--')) || null;
  const concurrencyArg = getFlag(argv, '--concurrency');
  const concurrency    = concurrencyArg ? parseInt(concurrencyArg, 10) : 8;
  if (argv.includes('--resume')) {
    log('[qualify] --resume is implied now: the work list is every row still unqualified');
  }

  const city = readCity(root).slug;
  const conn = db();

  let verticalId = null;
  if (verticalSlug) {
    const [rows] = await conn.query('SELECT vertical_id FROM verticals WHERE slug = ?', [verticalSlug]);
    if (!rows.length) throw new Error(`No vertical found: ${verticalSlug}`);
    verticalId = rows[0].vertical_id;
  }

  const [work] = await conn.query(
    'SELECT domain, MIN(website_raw) AS website_raw FROM companies' +
    '  WHERE city = ? AND status IS NULL AND domain IS NOT NULL' +
    (verticalId === null ? '' : ' AND vertical_id = ?') +
    '  GROUP BY domain',
    verticalId === null ? [city] : [city, verticalId]);

  log(`[qualify] vertical=${verticalSlug || 'all'} to_probe=${work.length} concurrency=${concurrency}`);

  let probed = 0, inherited = 0, errors = 0;
  let qi = 0;

  async function worker() {
    while (qi < work.length) {
      const item = work[qi++];
      try {
        const copied = await inheritFromSibling(city, item.domain, log);
        if (copied) { inherited++; continue; }

        // Through the exports object, not directly: `scripts/test-db.js` swaps
        // this out to test the column mapping without making a network request.
        const verdict = await module.exports.qualifyOne(item, log);
        await writeVerdict(city, item.domain, verdict);
        probed++;
      } catch (e) {
        // A probe that throws leaves the row unqualified; the next run retries it.
        errors++;
        log(`[qualify] ERROR ${item.domain}: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  log(`[qualify] probed ${probed}, inherited ${inherited}, errors ${errors}`);
  await printSummary(conn, city, verticalId, log);

  return { ok: probed + inherited, err: errors };
}

/**
 * Copy a qualified sibling's columns and links onto every still-unqualified row
 * with this domain. Returns true when it did.
 */
async function inheritFromSibling(city, domain, log) {
  return tx(async (conn) => {
    const [siblings] = await conn.query(
      `SELECT company_id, ${INHERITED.join(', ')} FROM companies` +
      '  WHERE city = ? AND domain = ? AND status IS NOT NULL' +
      '  ORDER BY company_id LIMIT 1',
      [city, domain]);
    if (!siblings.length) return false;
    const src = siblings[0];

    const [targets] = await conn.query(
      'SELECT company_id FROM companies WHERE city = ? AND domain = ? AND status IS NULL FOR UPDATE',
      [city, domain]);
    if (!targets.length) return true;   // another worker got there first

    await conn.query(
      `UPDATE companies SET ${INHERITED.filter(c => c !== 'status').map(c => c + ' = ?').join(', ')},` +
      '  status = ? WHERE city = ? AND domain = ? AND status IS NULL',
      [...INHERITED.filter(c => c !== 'status').map(c => src[c]), src.status, city, domain]);

    const [srcLinks] = await conn.query(
      'SELECT url, target_domain, kind, region, text FROM links WHERE company_id = ? ORDER BY link_id',
      [src.company_id]);
    if (srcLinks.length) {
      const ids = targets.map(t => t.company_id);
      await conn.query(
        `DELETE FROM links WHERE company_id IN (${ids.map(() => '?').join(',')})`, ids);
      const values = [];
      const params = [];
      for (const id of ids) {
        for (const l of srcLinks) {
          values.push('(?, ?, ?, ?, ?, ?)');
          params.push(id, l.url, l.target_domain, l.kind, l.region, l.text);
        }
      }
      await conn.query(
        'INSERT INTO links (company_id, url, target_domain, kind, region, text) VALUES ' +
        values.join(', '), params);
    }

    log(`[qualify]   ${domain}: inherited from a sibling (status ${src.status})`);
    return true;
  });
}

/** Write one probe's verdict onto every row with this domain that is still open. */
async function writeVerdict(city, domain, v) {
  const conn = db();
  await conn.query(
    'UPDATE companies SET skip_reason = ?, final_url = ?, http_status = ?,' +
    '  https_status = ?, cert_expires = ?, qualified_at = UTC_TIMESTAMP(), status = ?' +
    '  WHERE city = ? AND domain = ? AND status IS NULL',
    [v.reason, v.final_url, v.http_status, v.https_status, v.cert_expires,
     v.eligible ? 0 : -1, city, domain]);
}

async function printSummary(conn, city, verticalId, log) {
  const [rows] = await conn.query(
    'SELECT status, skip_reason, COUNT(*) AS n FROM companies WHERE city = ?' +
    (verticalId === null ? '' : ' AND vertical_id = ?') +
    '  GROUP BY status, skip_reason ORDER BY n DESC',
    verticalId === null ? [city] : [city, verticalId]);

  const total   = rows.reduce((a, r) => a + Number(r.n), 0);
  const pending = rows.filter(r => r.status === 0).reduce((a, r) => a + Number(r.n), 0);
  const skipped = rows.filter(r => r.status === -1).reduce((a, r) => a + Number(r.n), 0);

  log('');
  log(`rows            ${total}`);
  log(`pending capture ${pending}`);
  log(`skipped         ${skipped}`);
  for (const r of rows) {
    if (r.status !== -1) continue;
    log(`    ${String(r.skip_reason || 'unknown').padEnd(26)} ${r.n}`);
  }
  log('');
}

// ---------------------------------------------------------------------------
// Qualify a single domain
// ---------------------------------------------------------------------------
/**
 * @param {{domain: string, website_raw: ?string}} b
 * @returns {Promise<{eligible, reason, http_status, final_url, https_status, cert_expires}>}
 */
async function qualifyOne(b, log = () => {}) {
  const domain   = b.domain;
  const startUrl = b.website_raw || `https://${domain}/`;
  const tryUrl   = startUrl.startsWith('http') ? startUrl : `https://${domain}/`;

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
    return skip('robots-disallow', tryUrl);
  }

  // --- Probe 2: HTTP reachability ---
  let probeResult;
  try {
    probeResult = await withHostQueue(host, () => probe(tryUrl));
  } catch {
    return skip('probe-error', tryUrl);
  }

  const { status, finalUrl, body8k, certExpires, certValid, error } = probeResult;

  // DNS failure / connection refused / timeout
  if (error && !status) {
    log(`[qualify]   skip ${domain}: ${error}`);
    return skip('dead-host', tryUrl);
  }

  if (status !== null && status >= 400) {
    log(`[qualify]   skip ${domain}: HTTP ${status}`);
    return { ...skip('http-error', finalUrl || tryUrl), http_status: status };
  }

  // Redirect to a rejected domain
  const finalReg = finalUrl ? registrable(finalUrl) : null;
  if (finalReg && REJECT_DOMAINS.has(finalReg)) {
    log(`[qualify]   skip ${domain}: redirected to ${finalReg}`);
    return {
      eligible:     false,
      reason:       `redirected-to-${finalReg}`.slice(0, 64),
      http_status:  status,
      final_url:    finalUrl,
      https_status: (finalUrl || '').startsWith('https') ? certStatus(certValid, certExpires) : 'none',
      cert_expires: certDate(certExpires),
    };
  }

  // --- TLS. An expired certificate is NOT a skip — it is a high-value finding.
  const usesHttps = (finalUrl || '').startsWith('https') || tryUrl.startsWith('https');
  const httpsStatus = usesHttps ? certStatus(certValid, certExpires) : 'none';

  // --- Probe 3: parked pages ---
  const bodyLen = body8k ? body8k.length : 0;
  if (body8k && isParked(body8k, bodyLen)) {
    log(`[qualify]   skip ${domain}: parked`);
    return {
      eligible:     false,
      reason:       'parked',
      http_status:  status,
      final_url:    finalUrl,
      https_status: httpsStatus,
      cert_expires: certDate(certExpires),
    };
  }

  return {
    eligible:     true,
    reason:       null,
    http_status:  status,
    final_url:    finalUrl,
    https_status: httpsStatus,
    cert_expires: certDate(certExpires),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function skip(reason, url) {
  return {
    eligible:     false,
    reason,
    http_status:  null,
    final_url:    url,
    https_status: 'none',
    cert_expires: null,
  };
}

function getFlag(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return null;
  return argv[idx + 1];
}

/** The CLI closes nothing for us; a stage that leaves the pool open hangs. */
async function runAndClose(argv, ctx) {
  try { return await run(argv, ctx); }
  finally { await close(); }
}

module.exports = {
  run: runAndClose,
  _run: run, qualifyOne, certStatus, certDate, isParked,
};

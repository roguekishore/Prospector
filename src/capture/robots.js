'use strict';

/**
 * robots.txt fetcher, parser, and per-run cache.
 * MASTER.md §8: parse once per host, cache for the run.
 */

const https = require('https');
const http = require('http');

// Map of host → parsed rules: { allow: string[], disallow: string[] }
// for the most-specific matching agent group.
const cache = new Map();

/**
 * Fetch and parse robots.txt for a host. Returns the cached result on
 * subsequent calls. On any network error returns an empty ruleset
 * (treat as "all allowed" — fail-open so a robots.txt timeout does not
 * kill the run).
 *
 * @param {string} baseUrl  e.g. "https://blitzglobe.com"
 * @returns {Promise<{ allow: string[], disallow: string[] }>}
 */
async function fetchRobots(baseUrl) {
  const url = new URL('/robots.txt', baseUrl).href;
  const host = new URL(baseUrl).host;

  if (cache.has(host)) return cache.get(host);

  const rules = await _fetch(url);
  cache.set(host, rules);
  return rules;
}

/**
 * Check whether our bot is allowed to fetch a given URL.
 *
 * @param {string} baseUrl   Origin, e.g. "https://blitzglobe.com"
 * @param {string} pathname  e.g. "/"
 * @returns {Promise<boolean>}
 */
async function isAllowed(baseUrl, pathname) {
  const rules = await fetchRobots(baseUrl);
  const path = pathname || '/';

  // Check disallow rules first (most specific path wins; longer prefix beats shorter)
  const sortByLength = (a, b) => b.length - a.length;

  const matchingAllows = rules.allow.filter(p => path.startsWith(p)).sort(sortByLength);
  const matchingDisallows = rules.disallow.filter(p => path.startsWith(p)).sort(sortByLength);

  if (matchingAllows.length === 0 && matchingDisallows.length === 0) return true;

  const bestAllow = matchingAllows[0] || '';
  const bestDisallow = matchingDisallows[0] || '';

  // Longer match wins; if same length, Allow wins (RFC standard).
  if (bestAllow.length >= bestDisallow.length) return true;
  return false;
}

/** Clear the cache (for testing). */
function clearCache() {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _fetch(url) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 5000 }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ allow: [], disallow: [] });
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(_parse(body)));
    });
    req.on('error', () => resolve({ allow: [], disallow: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ allow: [], disallow: [] }); });
  });
}

/**
 * Parse robots.txt text.
 * Finds the most-specific group that matches "ProspectorBot" or "*".
 * Returns { allow: string[], disallow: string[] } path prefix arrays.
 */
function _parse(text) {
  const lines = text.split(/\r?\n/);

  // Groups: array of { agents: string[], allow: string[], disallow: string[] }
  const groups = [];
  let current  = null;
  let seenRule = false;   // a rule line has appeared since the last user-agent line

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;              // blank lines are ignored, NOT group separators

    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      // RFC 9309: consecutive user-agent lines share one group, but a
      // user-agent line FOLLOWING a rule line starts a new one. Relying on a
      // blank line to end a group is wrong — plenty of real robots.txt files
      // list per-bot blocks back-to-back with no blank line between them, and
      // merging those into the wildcard group applies every other bot's
      // "Disallow: /" to us and refuses a site that in fact allows crawling.
      if (!current || seenRule) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
        seenRule = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (field === 'disallow' && current) {
      seenRule = true;
      if (value) current.disallow.push(value);   // empty Disallow = allow all
    } else if (field === 'allow' && current) {
      seenRule = true;
      if (value) current.allow.push(value);
    } else if (field === 'crawl-delay' && current) {
      seenRule = true;
    }
    // Any other field (Sitemap, Host, ...) is a non-group directive: ignore it
    // without ending the current group.
  }

  // Merge every group that applies to us: an exact agent match wins outright,
  // otherwise every wildcard group.
  const pick   = name => groups.filter(g => g.agents.includes(name));
  const mine   = pick('prospectorbot');
  const chosen = mine.length ? mine : pick('*');
  if (!chosen.length) return { allow: [], disallow: [] };

  return {
    allow:    chosen.flatMap(g => g.allow),
    disallow: chosen.flatMap(g => g.disallow),
  };
}

module.exports = { fetchRobots, isAllowed, clearCache };

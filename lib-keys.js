'use strict';

/**
 * Canonical key segments — one spelling of a city, one spelling of a domain.
 *
 * Three places have to agree on these strings byte for byte:
 *
 *   * the S3 key             (`src/capture/s3.js`)
 *   * the local directory     (`data/<city>/companies/<domain>/`)
 *   * `companies.domain` and `cities.slug` in MySQL
 *
 * If they ever drift, `--resume` stops recognising finished work and the next
 * run re-captures the entire estate — silently, and at full cost, because a
 * re-capture is indistinguishable from a first capture. That failure is why
 * these live in one module instead of being spelled out at each call site.
 *
 * **These functions normalise; they do not decide.** The producer of a domain is
 * `registrable()` (`src/discover/provider.js:29`), which runs the URL through
 * `tldts.getDomain()` and so already returns a lowercased registrable domain
 * with every subdomain — `www` included — removed. `canonicalDomain` re-applies
 * the same invariants so the key is correct even when a raw hostname reaches it
 * from a fixture, a hand-edited `qualified.json`, or a future provider. It is
 * idempotent: applying it twice changes nothing.
 */

/** A city slug is an S3 prefix and a MySQL key. Keep it boring. */
const CITY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * A domain that is safe as both an S3 key segment and a directory name.
 * No slash, no space, no uppercase, at least one dot.
 */
const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;

/**
 * Slug for a city name. `config/city.json` holds the display name
 * ("Coimbatore"); this is what goes in a key.
 */
function canonicalCity(name) {
  const slug = String(name || '').toLowerCase().trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  if (!CITY_RE.test(slug)) throw new Error(`unusable city slug: ${JSON.stringify(name)}`);
  return slug;
}

/**
 * Canonical domain for keys and directory names.
 *
 * Lowercased, scheme and path discarded, port and trailing dot removed, a
 * leading `www.` stripped. Throws rather than returning something
 * path-unsafe — a bad key is worse than a loud failure, because it lands in the
 * bucket and nothing notices until ingest cannot find it.
 */
function canonicalDomain(domain) {
  let d = String(domain || '').trim().toLowerCase();
  if (!d) throw new Error('domain is required');

  // Tolerate a full URL reaching this by accident.
  if (d.includes('://')) {
    try { d = new URL(d).hostname.toLowerCase(); } catch { /* fall through to validation */ }
  }
  d = d.split('/')[0];        // drop any path
  d = d.split('@').pop();     // drop userinfo
  d = d.split(':')[0];        // drop port
  d = d.replace(/\.$/, '');   // drop the FQDN root dot
  d = d.replace(/^www\./, '');

  if (!DOMAIN_RE.test(d)) throw new Error(`unusable domain for a key: ${JSON.stringify(domain)}`);
  return d;
}

/**
 * `{ name, slug }` for the configured city.
 *
 * `config/city.json` is already the single source of the bbox, the grid and the
 * display name stamped into every business (`src/discover/index.js:307`). A
 * second city means a second file, not a schema change.
 */
function readCity(root) {
  const fs   = require('fs');
  const path = require('path');
  const cfg  = JSON.parse(fs.readFileSync(path.join(root, 'config', 'city.json'), 'utf8'));
  if (!cfg.city) throw new Error('config/city.json has no "city"');
  return { name: cfg.city, slug: canonicalCity(cfg.city) };
}

/**
 * Local folder for one company's capture and extract output.
 *
 * The mirror of `companyPrefix` in `src/capture/s3.js`: same two segments, same
 * spelling, so a folder synced up from the box lands on the key the Lambda would
 * have written. Every local path to capture output is built here — a second
 * `path.join(DATA, ...)` anywhere else is how the two layouts drift apart.
 */
function companyDir(root, city, domain) {
  const path = require('path');
  return path.join(root, 'data', canonicalCity(city), 'companies', canonicalDomain(domain));
}

module.exports = { canonicalCity, canonicalDomain, companyDir, readCity, CITY_RE, DOMAIN_RE };

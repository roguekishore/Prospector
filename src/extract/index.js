/* src/extract/index.js
   Stage: extract
   Reads <company>/rendered.html → writes <company>/extract.json.

   Two callers, one function. `capture` runs `extractDir` in the same worker slot
   right after the capture, and the Lambda runs it in the same container; this
   stage exists only to re-run extract over captures that are already on disk,
   after a bug fix. Nothing here spends a request or re-fetches a page. */
'use strict';

const fs      = require('fs');
const path    = require('path');
const cheerio = require('cheerio');

const { extractLinks } = require('./links.js');
const { firstEmail }   = require('./email.js');
const { isComplete }   = require('../capture/capture-domain.js');
const { companyDir, canonicalDomain, readCity } = require('../../lib-keys');

const ROOT = path.join(__dirname, '..', '..');

/**
 * Read `<dir>/rendered.html`, write `<dir>/extract.json`. No network.
 *
 * Deterministic by construction: the output carries no run id and no timestamp,
 * so two runs over the same `rendered.html` produce byte-identical files and a
 * re-extract after a fix can be diffed against the old one.
 *
 * Synchronous. Once the dead-link probe is gone there is nothing to await, and a
 * synchronous call is what lets the Lambda run it inside the per-domain
 * try/catch without a second await point.
 *
 * @param {{ dir: string, domain: string, finalUrl?: string }} opts
 * @returns {{ domain: string, email: ?string, links: object[] }} the object written
 * @throws if `rendered.html` is missing or empty — the caller decides what that means
 */
function extractDir({ dir, domain, finalUrl }) {
  const htmlPath = path.join(dir, 'rendered.html');
  let html;
  try { html = fs.readFileSync(htmlPath, 'utf8'); }
  catch { throw new Error(`rendered.html missing: ${htmlPath}`); }
  if (!html.trim()) throw new Error(`rendered.html is empty: ${htmlPath}`);

  const base = finalUrl || `https://${domain}/`;
  const $ = cheerio.load(html);

  // Key order is part of the contract (docs/SCHEMA.md "extract.json"): ingest
  // reads it as a straight copy, and a stable order keeps the file diffable.
  const doc = {
    domain,
    email: firstEmail($),
    links: extractLinks($, base, domain),
  };

  const dest = path.join(dir, 'extract.json');
  const tmp  = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, dest);

  return doc;
}

// ---------------------------------------------------------------------------
// Stage entry point — re-run extract over captures already on disk
// ---------------------------------------------------------------------------

/**
 * node src/cli extract [<vertical>] [--resume] [--only <domain>] [--dry-run]
 *
 * The CLI hands each stage a raw argv array, so flags are parsed here the same
 * way `capture` parses them. Reading `argv['--resume']` off an array, as this
 * used to, silently made every flag a no-op.
 */
async function run(argv, ctx) {
  const { root = ROOT, log = console } = ctx || {};
  const args       = _parseArgs(argv);
  const resume     = !!args.resume;
  const onlyDomain = args.only || null;
  const dryRun     = !!args['dry-run'];
  const vertical   = args._[0] || null;

  const city  = readCity(root).slug;
  const slugs = vertical
    ? [vertical]
    : JSON.parse(fs.readFileSync(path.join(root, 'config', 'verticals.json'), 'utf8'))
        .map(v => v.slug);

  // One domain, one folder — a domain listed in two verticals is extracted once.
  const targets = new Map();
  for (const slug of slugs) {
    const qualPath = path.join(root, 'data', slug, 'qualified.json');
    let qualified;
    try { qualified = JSON.parse(fs.readFileSync(qualPath, 'utf8')); }
    catch { continue; }

    for (const biz of (qualified.businesses || [])) {
      if (!biz.domain) continue;
      if (!biz.qualify || biz.qualify.verdict !== 'audit') continue;
      let domain;
      try { domain = canonicalDomain(biz.domain); } catch { continue; }
      if (onlyDomain && domain !== canonicalDomain(onlyDomain)) continue;
      if (targets.has(domain)) continue;
      targets.set(domain, biz.qualify.final_url || null);
    }
  }

  if (!targets.size) {
    log.warn('extract: nothing marked for capture — run qualify first.');
    return { ok: 0, err: 0, skipped: 0 };
  }

  let ok = 0, err = 0, skipped = 0;

  for (const [domain, finalUrl] of targets) {
    const dir = companyDir(root, city, domain);

    // A capture that never completed has no DOM to read. That is not an extract
    // failure; it is work for `capture`.
    if (!isComplete(dir)) { skipped++; continue; }
    if (resume && fs.existsSync(path.join(dir, 'extract.json'))) { skipped++; continue; }

    if (dryRun) { log.info(`[dry-run] extract ${domain}`); ok++; continue; }

    try {
      extractDir({ dir, domain, finalUrl });
      ok++;
    } catch (e) {
      // No error.json: that file belongs to capture and says the capture failed.
      // An extract failure over a good capture is a code bug — it is logged, the
      // domain keeps whatever extract.json it had, and the next run retries it.
      err++;
      log.error(`extract error [${domain}]: ${e.message}`);
    }
  }

  log.info(`extract: ${ok} ok  ${err} errors  ${skipped} skipped`);
  return { ok, err, skipped };
}

// ---------------------------------------------------------------------------
// Minimal argv parser (no external dep) — same shape as src/capture/index.js
// ---------------------------------------------------------------------------
function _parseArgs(argv) {
  const out = { _: [] };
  const arr = (argv || []).slice();
  while (arr.length) {
    const a = arr.shift();
    if (a.startsWith('--')) {
      const key  = a.slice(2);
      const next = arr[0];
      out[key] = (!next || next.startsWith('--')) ? true : arr.shift();
    } else {
      out._.push(a);
    }
  }
  return out;
}

module.exports = { run, extractDir };

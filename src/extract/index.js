/* src/extract/index.js
   Stage: extract
   Reads raw/ per domain → writes signals.json, links.json, contacts.json
   W3-extract-score.md §1 */
'use strict';

const fs     = require('fs');
const path   = require('path');
const cheerio= require('cheerio');

const signals  = require('./signals/index.js');
const { extractLinks } = require('./links.js');
const { extractContacts } = require('./contacts.js');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function loadConfig() {
  const tfSlugs   = loadJson(path.join(ROOT, 'config', 'themeforest-slugs.json')) || {};
  const verticals = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'verticals.json'), 'utf8'));
  return { tfSlugs, verticals };
}

// Name the capture that is actually on disk — a compressed tree holds .webp
// where a fresh capture holds .png. Bare filename, relative to the domain dir,
// matching the historical shape of signals.json. Falls back to .png so a
// missing shot still reports under its expected name.
function _shotFile(domainDir, shot) {
  for (const ext of ['.png', '.webp']) {
    try { if (fs.statSync(path.join(domainDir, shot + ext)).isFile()) return shot + ext; }
    catch { /* try next ext */ }
  }
  return shot + '.png';
}

async function extractDomain(vertical, domain, qualified, runId, refYear, opts) {
  const { probe = true, verbose = false } = opts;

  const domainDir = path.join(DATA, vertical, domain);
  const rawDir    = path.join(domainDir, 'raw');

  // Check raw/ exists
  if (!fs.existsSync(rawDir)) {
    throw new Error(`raw/ directory missing: ${rawDir}`);
  }

  const homeHtmlPath     = path.join(rawDir, 'home.html');
  const renderedHtmlPath = path.join(rawDir, 'rendered.html');
  const headersJsonPath  = path.join(rawDir, 'headers.json');

  const homeHtml     = fs.existsSync(homeHtmlPath)     ? fs.readFileSync(homeHtmlPath, 'utf8')     : '';
  const renderedHtml = fs.existsSync(renderedHtmlPath) ? fs.readFileSync(renderedHtmlPath, 'utf8') : homeHtml;
  const headers      = loadJson(headersJsonPath) || {};

  if (!homeHtml && !renderedHtml) {
    throw new Error(`No HTML found in raw/ for ${domain}`);
  }

  const $home     = cheerio.load(homeHtml);
  const $rendered = cheerio.load(renderedHtml);

  const { tfSlugs } = loadConfig();

  // -- build measured signals -- //
  // Partial intermediate for redesigned heuristic
  const copyrightYear = signals.copyright($rendered, refYear);

  const measured = {
    copyright:    copyrightYear,
    jquery:       signals.jquery($home),
    bootstrap:    signals.bootstrap($home),
    slider:       signals.slider($home),
    wayback:      signals.wayback(qualified),
    redesigned:   signals.redesigned({ copyright: copyrightYear }, qualified),
    generator:    signals.generator($home, headers),
    theme:        signals.theme($home, tfSlugs),
    domainAge:    signals.domainAge(qualified, refYear),
    viewport:     signals.viewport(headers, $home),
    overflow:     signals.overflow(headers),
    tapTargets:   signals.tapTargets(headers),
    lcp:          signals.lcp(headers),
    pageWeight:   signals.pageWeight(headers),
    heroVideo:    signals.heroVideo($rendered, headers),
    https:        signals.https(qualified, headers),
    mixedContent: signals.mixedContent($rendered, headers?.final_url || `https://${domain}/`),
    brokenImages: signals.brokenImages(headers, $rendered),
    whatsapp:     signals.whatsapp($rendered),
    quoteForm:    signals.quoteForm($rendered, headers),
    blog:         signals.blog($rendered, refYear),
  };

  const flagged = signals.buildFlagged(measured, refYear);

  // Capture metadata from headers (or defaults)
  const finalUrl    = headers?.final_url || qualified?.qualify?.final_url || `https://${domain}/`;
  const capturedAt  = headers?.captured_at || '2026-09-18T09:34:02Z';

  // Use run ID embedded in headers.json by W2 (deterministic over same raw/).
  // This is what makes a re-run produce byte-identical output — the run field
  // in signals.json / score.json comes from the input bytes, not the clock.
  const effectiveRunId = headers?.run || runId;

  const vpNote = measured.viewport === 'missing'
    ? 'no meta viewport — 980px legacy layout'
    : 'responsive';

  const signalsJson = {
    run:         effectiveRunId,
    domain,
    final_url:   finalUrl,
    captured_at: capturedAt,
    measured,
    flagged,
    captures: {
      mobile:  { file:_shotFile(domainDir,'mobile'),  viewport:'390x844',   note:vpNote },
      desktop: { file:_shotFile(domainDir,'desktop'), viewport:'1440x900' },
      full:    { file:_shotFile(domainDir,'full'),    viewport:'1440xfull' },
    },
    raw: { html:'raw/home.html', headers:'raw/headers.json' },
  };

  // -- links --
  const { counts, links, agency_credit } = await extractLinks(
    $rendered, finalUrl, domain, { probe });

  const linksJson = { run:effectiveRunId, domain, counts, agency_credit };
  // W3 §7: only counts in index.json, not the full links array
  // But links.json on disk keeps the full array for diagnostic use
  linksJson.links = links;

  // -- contacts --
  const { address, contacts } = extractContacts($rendered, qualified, domain);

  const contactsJson = {
    run:     effectiveRunId,
    domain,
    address: address || 'none',
    contacts,
    source:  'business own contact page + footer',
  };

  // Atomic writes: write .tmp then rename
  function atomicWrite(dest, obj) {
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, dest);
  }

  atomicWrite(path.join(domainDir, 'signals.json'), signalsJson);
  atomicWrite(path.join(domainDir, 'links.json'),   linksJson);
  atomicWrite(path.join(domainDir, 'contacts.json'), contactsJson);

  if (verbose) console.log(`  extract ok: ${domain} flags=[${flagged.join(',')}]`);

  return { domain, flagged, measured };
}

// ---- stage entry point ----
async function run(argv, ctx) {
  const { root = ROOT, config = {}, log = console } = ctx;

  const refYear   = config.refYear || 2026;
  const runId     = config.runId   || `run-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}Z`;
  const probe     = argv['no-probe'] ? false : true;
  const resume    = argv['resume']   || false;
  const verbose   = argv['verbose']  || false;
  const onlyDomain= argv['only']     || null;
  const dryRun    = argv['dry-run']  || false;

  // Discover all leads from vertical directories
  const configVerticals = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'config', 'verticals.json'), 'utf8'));

  const leads = [];

  for (const v of configVerticals) {
    const vertDir = path.join(DATA, v.slug);
    if (!fs.existsSync(vertDir)) continue;

    const qualifiedPath = path.join(vertDir, 'qualified.json');
    const qualified     = loadJson(qualifiedPath) || {};
    const businesses    = qualified.businesses || [];
    const bizMap        = Object.fromEntries(businesses.map(b => [b.domain, b]));

    // Enumerate domain folders
    const entries = fs.readdirSync(vertDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('_'))
      .map(e => e.name);

    for (const domain of entries) {
      if (onlyDomain && domain !== onlyDomain) continue;
      leads.push({ vertical: v.slug, domain, qualified: bizMap[domain] || null });
    }
  }

  if (!leads.length) {
    log.warn('extract: no leads found');
    return { ok: 0, err: 0, skipped: 0 };
  }

  let ok = 0, err = 0, skipped = 0;

  const started_at = new Date().toISOString();

  for (const { vertical, domain, qualified } of leads) {
    const domainDir   = path.join(DATA, vertical, domain);
    const signalsPath = path.join(domainDir, 'signals.json');
    const errPath     = path.join(domainDir, 'error.json');

    if (resume && fs.existsSync(signalsPath)) {
      skipped++;
      continue;
    }

    if (dryRun) {
      log.info(`[dry-run] extract ${vertical}/${domain}`);
      ok++;
      continue;
    }

    try {
      await extractDomain(vertical, domain, qualified, runId, refYear,
        { probe, verbose });
      ok++;
      // Remove stale error.json if extraction now succeeds
      if (fs.existsSync(errPath)) fs.unlinkSync(errPath);
    } catch (e) {
      err++;
      const errObj = { run: runId, domain, stage: 'extract',
        error: e.message, stack: e.stack, at: new Date().toISOString() };
      fs.writeFileSync(errPath, JSON.stringify(errObj, null, 2) + '\n', 'utf8');
      log.error(`extract error [${domain}]: ${e.message}`);
    }
  }

  const finished_at = new Date().toISOString();
  log.info(`extract: ${ok} ok  ${err} errors  ${skipped} skipped  (${finished_at})`);

  // Append to run.json
  appendRunLog({ stage:'extract', started_at, finished_at, ok, err, skipped, runId, config });

  return { ok, err, skipped };
}

function appendRunLog(entry) {
  const p = path.join(DATA, 'run.json');
  let log = [];
  try { log = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { log = []; }
  if (!Array.isArray(log)) log = [log]; // legacy: was an object
  log.push(entry);
  fs.writeFileSync(p, JSON.stringify(log, null, 2) + '\n', 'utf8');
}

module.exports = { run, extractDomain };

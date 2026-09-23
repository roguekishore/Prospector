/* src/score/index.js
   Stage: score
   Reads signals.json + links.json + contacts.json + qualified.json
   Writes score.json per domain.
   Wires lib-scoring.js — never reimplements it. W3 §2. */
'use strict';

const fs   = require('fs');
const path = require('path');

const { score: libScore, WEIGHTS } = require('../../lib-scoring.js');
const { selectAngle }              = require('./angle.js');
const { configHash }               = require('../db/index.js');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function atomicWrite(dest, obj) {
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, dest);
}

function scoreDomain(vertical, domain, runId, refYear, config) {
  const domainDir = path.join(DATA, vertical, domain);

  const signalsJson  = loadJson(path.join(domainDir, 'signals.json'));
  const linksJson    = loadJson(path.join(domainDir, 'links.json'));
  const contactsJson = loadJson(path.join(domainDir, 'contacts.json'));

  if (!signalsJson)  throw new Error(`signals.json missing for ${domain}`);
  if (!linksJson)    throw new Error(`links.json missing for ${domain}`);
  if (!contactsJson) throw new Error(`contacts.json missing for ${domain}`);

  // Load business data from qualified.json (provides rating + review_count)
  const qualifiedPath = path.join(DATA, vertical, 'qualified.json');
  const qualified     = loadJson(qualifiedPath) || {};
  const biz = (qualified.businesses || []).find(b => b.domain === domain);

  // Guard: missing review_count is a loud fail (MASTER.md §2, W3 §2)
  if (!biz) {
    throw new Error(
      `${domain} not found in qualified.json — rating/review_count unavailable. ` +
      `Cannot score without ability-to-pay axis.`
    );
  }
  if (biz.review_count === undefined || biz.review_count === null) {
    throw new Error(
      `${domain}: review_count is undefined in qualified.json. ` +
      `Silently missing ability-to-pay axis would produce meaningless tiers.`
    );
  }

  // Use the run ID already stamped in signals.json (comes from headers.json → W2).
  // This makes score.json byte-identical across re-runs over unchanged raw/.
  const effectiveRunId = signalsJson.run || runId;

  const sc = libScore({
    signals:  signalsJson.measured,
    links:    linksJson.counts,
    contacts: contactsJson.contacts,
    rating:   biz.rating,
    reviews:  biz.review_count,
    agency:   !!linksJson.agency_credit,
    refYear,
  });

  const flaws = signalsJson.flagged || [];

  const { pitch_angle, angle_template, reasons } = selectAngle(
    flaws, signalsJson.measured, sc.gate);

  const scoreJson = {
    run:    effectiveRunId,
    domain,
    ...sc,
    flaws,
    pitch_angle,
    angle_template,
  };

  atomicWrite(path.join(domainDir, 'score.json'), scoreJson);

  return { domain, tier: sc.tier, score: sc.score, angle_template };
}

// ---- stage entry point ----
function run(argv, ctx) {
  const { root = ROOT, config = {}, log = console } = ctx;

  const refYear    = config.refYear    || (argv['ref-year'] ? +argv['ref-year'] : 2026);
  const runId      = config.runId      || `run-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}Z`;
  const resume     = argv['resume']    || false;
  const verbose    = argv['verbose']   || false;
  const onlyDomain = argv['only']      || null;
  const dryRun     = argv['dry-run']   || false;

  const configVerticals = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'config', 'verticals.json'), 'utf8'));

  const leads = [];

  for (const v of configVerticals) {
    const vertDir = path.join(DATA, v.slug);
    if (!fs.existsSync(vertDir)) continue;

    const entries = fs.readdirSync(vertDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('_'))
      .map(e => e.name);

    for (const domain of entries) {
      if (onlyDomain && domain !== onlyDomain) continue;
      leads.push({ vertical: v.slug, domain });
    }
  }

  let ok = 0, err = 0, skipped = 0;
  const started_at = new Date().toISOString();

  for (const { vertical, domain } of leads) {
    const scorePath = path.join(DATA, vertical, domain, 'score.json');
    const errPath   = path.join(DATA, vertical, domain, 'error.json');

    if (resume && fs.existsSync(scorePath)) { skipped++; continue; }

    if (dryRun) {
      log.info(`[dry-run] score ${vertical}/${domain}`);
      ok++;
      continue;
    }

    try {
      const result = scoreDomain(vertical, domain, runId, refYear, config);
      ok++;
      if (fs.existsSync(errPath)) fs.unlinkSync(errPath);
      if (verbose) log.info(`  score ok: ${domain} → ${result.tier} ${result.score}`);
    } catch (e) {
      err++;
      const errObj = { run: runId, domain, stage: 'score',
        error: e.message, at: new Date().toISOString() };
      fs.writeFileSync(errPath, JSON.stringify(errObj, null, 2) + '\n', 'utf8');
      log.error(`score error [${domain}]: ${e.message}`);
    }
  }

  const finished_at = new Date().toISOString();
  log.info(`score: ${ok} ok  ${err} errors  ${skipped} skipped`);

  appendRunLog({ stage:'score', started_at, finished_at, ok, err, skipped, runId,
    refYear, config_hash: configHash(config, WEIGHTS) });

  return { ok, err, skipped };
}

function appendRunLog(entry) {
  const p = path.join(DATA, 'run.json');
  let log = [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    log = Array.isArray(raw) ? raw : [raw];
  } catch { log = []; }
  log.push(entry);
  fs.writeFileSync(p, JSON.stringify(log, null, 2) + '\n', 'utf8');
}

module.exports = { run, scoreDomain };

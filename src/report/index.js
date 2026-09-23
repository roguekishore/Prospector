/* src/report/index.js
   Stage: report
   Three jobs that cannot be done per-domain:
   1. Finalise contact ownership (cross-site frequency rule)
   2. Build agency table (with optional pricing/portfolio fetch)
   3. Emit index.json + leads.csv + pitch.csv + agencies.csv
   W3 §3–§8, MASTER.md §4.7 */
'use strict';

const fs   = require('fs');
const path = require('path');

const { buildAgencyTable } = require('./agency.js');
const { normalisePhone, normaliseEmail } = require('../extract/contacts.js');
const { selectAngle } = require('../score/angle.js');
const { open: openDb } = require('../db/index.js');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
// Compressed captures may still live in a parallel tree; the server resolves
// both under /data/, so one URL shape covers either layout.
const DATA_WEBP = path.join(ROOT, 'data-webp');

// Emit the capture that is actually on disk, preferring compressed WebP, so
// index.json never advertises a file that has been converted away.
function shotRef(vertical, domain, shot) {
  const rel = `${vertical}/${domain}/${shot}`;
  for (const ext of ['.webp', '.png']) {
    for (const base of [DATA, DATA_WEBP]) {
      if (fs.existsSync(path.join(base, rel + ext))) return `data/${rel}${ext}`;
    }
  }
  return `data/${rel}.png`;   // no capture yet — keep the historical shape
}

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function atomicWrite(dest, content) {
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, dest);
}

function atomicWriteJson(dest, obj) {
  atomicWrite(dest, JSON.stringify(obj, null, 2) + '\n');
}

// ---------- contact ownership (cross-site frequency rule) ----------
// MASTER.md §7.3, W3 §5
// IMPORTANT: owner is provisional in contacts.json at extract time.
// This second pass finalises it. The ordering (extract then report) is
// the reason report exists as a separate stage.
function finaliseContactOwnership(allLeads) {
  // Build value → Set<domain>, normalising before comparison
  const seen = new Map(); // normalised → Set<domain>

  for (const lead of allLeads) {
    for (const c of (lead.contacts || [])) {
      if (c.kind !== 'phone' && c.kind !== 'email') continue;
      const key = c.kind === 'phone'
        ? normalisePhone(c.value)
        : normaliseEmail(c.value);
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key).add(lead.domain);
    }
  }

  // Helpers for nearCreditText check
  function nearCreditText(lead, rawValue, windowChars = 200) {
    if (!lead.rawCreditText) return false;
    const idx = lead.rawCreditText.indexOf(rawValue);
    return idx !== -1;
  }

  // Second pass: assign owners
  for (const lead of allLeads) {
    for (const c of (lead.contacts || [])) {
      if (c.kind !== 'phone' && c.kind !== 'email') continue;
      const key = c.kind === 'phone'
        ? normalisePhone(c.value)
        : normaliseEmail(c.value);

      const domains = seen.get(key);
      if (domains && domains.size > 1) {
        c.owner = 'agency';
        continue;
      }
      if (nearCreditText(lead, c.value, 200)) {
        c.owner = 'agency';
        continue;
      }
      c.owner = 'business';
    }
  }
}

// ---------- load all lead data ----------
function loadAllLeads() {
  const configVerticals = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'config', 'verticals.json'), 'utf8'));

  const leads = [];

  for (const v of configVerticals) {
    const vertDir = path.join(DATA, v.slug);
    if (!fs.existsSync(vertDir)) continue;

    const qualifiedPath = path.join(vertDir, 'qualified.json');
    const qualified     = loadJson(qualifiedPath) || {};
    const bizMap        = Object.fromEntries(
      (qualified.businesses || []).map(b => [b.domain, b]));

    const entries = fs.readdirSync(vertDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('_'))
      .map(e => e.name);

    for (const domain of entries) {
      const domainDir  = path.join(vertDir, domain);
      const signalsJ   = loadJson(path.join(domainDir, 'signals.json'));
      const linksJ     = loadJson(path.join(domainDir, 'links.json'));
      const contactsJ  = loadJson(path.join(domainDir, 'contacts.json'));
      const scoreJ     = loadJson(path.join(domainDir, 'score.json'));

      // Skip incomplete leads (no score yet)
      if (!signalsJ || !scoreJ) continue;

      const biz = bizMap[domain] || {};

      leads.push({
        vertical:      v.slug,
        domain,
        name:          biz.name || domain,
        rating:        biz.rating || 0,
        reviews:       biz.review_count || 0,
        address:       contactsJ?.address || biz.address || 'none',
        score:         scoreJ.score,
        tier:          scoreJ.tier,
        gate:          scoreJ.gate || null,
        signals:       signalsJ.measured || {},
        flagged:       signalsJ.flagged  || [],
        flaws:         scoreJ.flaws      || [],
        pitch_angle:   scoreJ.pitch_angle || '',
        angle_template:scoreJ.angle_template || '',
        contacts:      contactsJ?.contacts || [],
        agency_credit: linksJ?.agency_credit || null,
        links_counts:  linksJ?.counts || {},
        rawCreditText: linksJ?.agency_credit?.raw_text || '',
        domainDir,
      });
    }
  }

  return leads;
}

// ---------- build reasons for index.json ----------
function buildReasons(flagged) {
  const { loadReasons } = require('../score/angle.js');
  const reasonTemplates = loadReasons();
  return flagged.slice(0, 5).map(k => reasonTemplates[k]).filter(Boolean);
}

// ---------- CSV helpers ----------
const BOM  = '﻿';
const CRLF = '\r\n';
const q    = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';

function buildLeadsCsv(leads) {
  const header = ['tier','score','vertical','domain','business','address',
    'phone','email','rating','reviews','built_by','pitch_angle'].map(q).join(',');

  const rows = leads.map(l => {
    const ph = (l.contacts || []).find(c => c.kind === 'phone' && c.owner === 'business');
    const em = (l.contacts || []).find(c => c.kind === 'email' && c.owner === 'business');
    return [
      l.tier, l.score, l.vertical, l.domain, l.name, l.address,
      ph ? ph.value : '', em ? em.value : '',
      l.rating, l.reviews,
      l.agency_credit ? l.agency_credit.name : '',
      l.pitch_angle,
    ].map(q).join(',');
  });

  return BOM + [header, ...rows].join(CRLF) + CRLF;
}

function buildPitchCsv(reviews, leads) {
  const header = ['tier','score','vertical','domain','business','address',
    'phone','email','rating','reviews','built_by','pitch_angle',
    'your_tier','note'].map(q).join(',');

  const pitchLeads = leads.filter(l => {
    const r = reviews[l.domain];
    return r && r.pitch;
  });

  const rows = pitchLeads.map(l => {
    const r = reviews[l.domain] || {};
    const ph = (l.contacts || []).find(c => c.kind === 'phone' && c.owner === 'business');
    const em = (l.contacts || []).find(c => c.kind === 'email' && c.owner === 'business');
    return [
      l.tier, l.score, l.vertical, l.domain, l.name, l.address,
      ph ? ph.value : '', em ? em.value : '',
      l.rating, l.reviews,
      l.agency_credit ? l.agency_credit.name : '',
      l.pitch_angle,
      r.human_tier || '',
      r.note || '',
    ].map(q).join(',');
  });

  return BOM + [header, ...rows].join(CRLF) + CRLF;
}

function buildAgenciesCsv(agencies) {
  const header = ['agency','domain','built_in_run','portfolio_clients',
    'published_pricing','note'].map(q).join(',');

  const rows = agencies.map(a => [
    a.name, a.domain, a.builtInRun, a.portfolioClients,
    a.pricing.map(p => `${p.tier} ${p.price}`).join(' | '),
    a.note || '',
  ].map(q).join(','));

  return BOM + [header, ...rows].join(CRLF) + CRLF;
}

// ---------- build index.json ----------
function buildIndexJson(leads, agencies, runId, synthetic = false) {
  const configVerticals = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'config', 'verticals.json'), 'utf8'));

  // Aggregate vertical stats
  const vertStats = {};
  for (const v of configVerticals) {
    const vertDir = path.join(DATA, v.slug);
    const qualified = loadJson(path.join(vertDir, 'qualified.json')) || {};
    const biz = qualified.businesses || [];
    vertStats[v.slug] = {
      discovered:  qualified.raw_results || biz.length,
      withDomain:  biz.filter(b => b.domain).length,
      audited:     biz.filter(b => b.qualify?.verdict === 'audit').length,
    };
  }

  const verticals = configVerticals.map(v => ({
    slug:       v.slug,
    label:      v.label,
    city:       'Coimbatore',
    keywords:   v.keywords || [],
    discovered: vertStats[v.slug]?.discovered || 0,
    withDomain: vertStats[v.slug]?.withDomain  || 0,
    audited:    vertStats[v.slug]?.audited      || 0,
  }));

  // Sort leads: descending score, then ascending domain for stability
  const sorted = [...leads].sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.domain.localeCompare(b.domain));

  const indexLeads = sorted.map(l => {
    const reasons = buildReasons(l.flaws);

    return {
      vertical:  l.vertical,
      domain:    l.domain,
      name:      l.name,
      rating:    l.rating,
      reviews:   l.reviews,
      address:   l.address,
      score:     l.score,
      tier:      l.tier,
      gate:      l.gate,
      signals:   l.signals,
      flaws:     l.flaws,
      reasons,
      angle:     l.pitch_angle,
      contacts:  (l.contacts || []).filter(c => c.owner === 'business'),
      agency:    l.agency_credit ? {
        name:   l.agency_credit.name,
        domain: l.agency_credit.domain,
        credit: l.agency_credit.raw_text,
      } : null,
      links:     l.links_counts,
      shots: {
        mobile:  shotRef(l.vertical, l.domain, 'mobile'),
        desktop: shotRef(l.vertical, l.domain, 'desktop'),
        full:    shotRef(l.vertical, l.domain, 'full'),
      },
    };
  });

  return {
    run:          runId,
    generated_at: new Date().toISOString(),
    synthetic,
    city:         'Coimbatore',
    verticals,
    leads:        indexLeads,
    agencies,
  };
}

// ---------- upsert SQLite ----------
function upsertToDb(leads, agencies, runId) {
  try {
    const db = openDb();

    // verticals
    const vsInsert = db.prepare(`
      INSERT OR REPLACE INTO verticals (slug, label, city, keywords, discovered, with_domain, audited)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);

    const configVerticals = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'config', 'verticals.json'), 'utf8'));

    const vsRun = db.transaction(() => {
      for (const v of configVerticals) {
        const vertDir   = path.join(DATA, v.slug);
        const qualified = loadJson(path.join(vertDir, 'qualified.json')) || {};
        const biz       = qualified.businesses || [];
        vsInsert.run(
          v.slug, v.label, 'Coimbatore', JSON.stringify(v.keywords || []),
          qualified.raw_results || biz.length,
          biz.filter(b => b.domain).length,
          biz.filter(b => b.qualify?.verdict === 'audit').length,
        );
      }
    });
    vsRun();

    // businesses
    const bizInsert = db.prepare(`
      INSERT OR IGNORE INTO businesses
        (domain, vertical, name, places_id, rating, review_count, address, phone,
         lat, lng, business_status, source, first_seen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    const bizRun = db.transaction(() => {
      for (const lead of leads) {
        const ph = (lead.contacts || []).find(c => c.kind === 'phone');
        bizInsert.run(
          lead.domain, lead.vertical, lead.name, null,
          lead.rating, lead.reviews, lead.address,
          ph ? ph.value : null,
          null, null, 'OPERATIONAL',
          'places-new', new Date().toISOString(),
        );
      }
    });
    bizRun();

    // scores (rewrite for this run — never touch reviews)
    const scoreInsert = db.prepare(`
      INSERT OR REPLACE INTO scores
        (domain, run_id, tier, score, pain, pay, reach, gate, angle_template, flaws)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);

    const scoreRun = db.transaction(() => {
      for (const lead of leads) {
        const sc = loadJson(path.join(DATA, lead.vertical, lead.domain, 'score.json'));
        if (!sc) continue;
        scoreInsert.run(
          lead.domain, runId, sc.tier, sc.score,
          sc.pain, sc.pay, sc.reach, sc.gate || null,
          sc.angle_template || null,
          JSON.stringify(sc.flaws || []),
        );
      }
    });
    scoreRun();

    // contacts
    const contactInsert = db.prepare(`
      INSERT OR REPLACE INTO contacts (domain, kind, value, owner)
      VALUES (?,?,?,?)`);
    const contactRun = db.transaction(() => {
      for (const lead of leads) {
        for (const c of (lead.contacts || [])) {
          contactInsert.run(lead.domain, c.kind, c.value, c.owner);
        }
      }
    });
    contactRun();

    // agencies
    const agencyInsert = db.prepare(`
      INSERT OR REPLACE INTO agencies (domain, name, pricing, portfolio_clients, note)
      VALUES (?,?,?,?,?)`);
    const agencyRun = db.transaction(() => {
      for (const a of agencies) {
        agencyInsert.run(
          a.domain, a.name, JSON.stringify(a.pricing),
          a.portfolioClients, a.note || null);
      }
    });
    agencyRun();

    // agency_clients
    const acInsert = db.prepare(`
      INSERT OR IGNORE INTO agency_clients (agency_domain, domain, confidence)
      VALUES (?,?,?)`);
    const acRun = db.transaction(() => {
      for (const lead of leads) {
        if (lead.agency_credit?.domain) {
          acInsert.run(lead.agency_credit.domain, lead.domain, 1.0);
        }
      }
    });
    acRun();

  } catch (e) {
    // DB errors never abort the report stage — warn but continue
    console.warn(`SQLite upsert warning: ${e.message}`);
  }
}

// ---------- stage entry point ----------
async function run(argv, ctx) {
  const { root = ROOT, config = {}, log = console } = ctx;

  const runId        = config.runId    || `run-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}Z`;
  const noAgencyFetch= !!argv['no-agency-fetch'];
  const dryRun       = !!argv['dry-run'];
  const verbose      = !!argv['verbose'];

  const started_at = new Date().toISOString();

  // 1. Load all leads
  const allLeads = loadAllLeads();
  if (!allLeads.length) {
    log.warn('report: no scored leads found');
    return { ok: 0 };
  }

  // 2. Finalise contact ownership
  finaliseContactOwnership(allLeads);

  // Rewrite contacts.json files with finalised ownership
  for (const lead of allLeads) {
    const contactsPath = path.join(lead.domainDir, 'contacts.json');
    const existing = loadJson(contactsPath);
    if (existing) {
      existing.contacts = lead.contacts;
      atomicWriteJson(contactsPath, existing);
    }
  }

  // 3. Build agency table
  const agencies = await buildAgencyTable(allLeads.map(l => ({
    domain: l.domain,
    agency_credit: l.agency_credit,
  })), { fetchData: !noAgencyFetch });

  if (dryRun) {
    log.info(`[dry-run] report: would write index.json, CSVs for ${allLeads.length} leads, ${agencies.length} agencies`);
    return { ok: allLeads.length };
  }

  // 4. Build index.json
  // Load reviews from DB for pitch.csv
  let reviews = {};
  try {
    const db = openDb();
    const rows = db.prepare('SELECT domain, human_tier, pitch, note FROM reviews').all();
    for (const r of rows) {
      reviews[r.domain] = { human_tier: r.human_tier, pitch: !!r.pitch, note: r.note };
    }
  } catch {}

  const indexJson = buildIndexJson(allLeads, agencies, runId, false);

  // 5. Write outputs
  atomicWriteJson(path.join(DATA, 'index.json'), indexJson);
  atomicWrite(path.join(DATA, 'leads.csv'),   buildLeadsCsv(allLeads));
  atomicWrite(path.join(DATA, 'pitch.csv'),   buildPitchCsv(reviews, allLeads));
  atomicWrite(path.join(DATA, 'agencies.csv'),buildAgenciesCsv(agencies));

  // 6. Upsert to SQLite
  upsertToDb(allLeads, agencies, runId);

  const finished_at = new Date().toISOString();
  log.info(`report: ${allLeads.length} leads, ${agencies.length} agencies → index.json (${finished_at})`);

  // Append to run.json
  appendRunLog({ stage:'report', started_at, finished_at,
    leads: allLeads.length, agencies: agencies.length, runId });

  return { ok: allLeads.length };
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

// Exposed for server's POST /api/export/pitch
function regeneratePitchCsv() {
  const allLeads = loadAllLeads();
  let reviews = {};
  try {
    const db = openDb();
    const rows = db.prepare('SELECT domain, human_tier, pitch, note FROM reviews').all();
    for (const r of rows) {
      reviews[r.domain] = { human_tier: r.human_tier, pitch: !!r.pitch, note: r.note };
    }
  } catch {}
  const csv = buildPitchCsv(reviews, allLeads);
  const p   = path.join(DATA, 'pitch.csv');
  atomicWrite(p, csv);
  return { path: p, rows: allLeads.filter(l => reviews[l.domain]?.pitch).length };
}

module.exports = { run, regeneratePitchCsv, buildIndexJson, finaliseContactOwnership };

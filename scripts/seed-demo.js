'use strict';

/**
 * Dev-only demo data for the two web UIs.
 *
 *     DATABASE_URL=mysql://root:pw@127.0.0.1:13306/prospector_test node scripts/seed-demo.js
 *
 * Fills the scratch database with enough shape to exercise every view: several
 * verticals, a few hundred leads with different review counts, HTTPS states,
 * emails and links, rows with no website, failed captures, and rows still
 * pending — so the deck's grid pages, its filters have something to bite on,
 * and the control panel's bars are not all one colour.
 *
 * Screenshots come from whatever `npm run test:run` left under
 * `data/coimbatore/companies/`: several rows share each captured domain (rows
 * can share a website — that is the identity rule), so the grid shows real
 * shots without another capture. Rows on other domains show the deck's
 * "no capture" placeholder, which is also worth seeing.
 *
 * Goes through `scripts/test-db-helper.js`, so it refuses any database whose
 * name does not end in `_test`, and writes only columns in `docs/SCHEMA.md`.
 * `npm run test:deck` truncates the tables when it finishes; run this again
 * afterwards.
 */

const fs   = require('fs');
const path = require('path');

const { ROOT, requireTestDatabase, resetTestDatabase, seedVerticals } = require('./test-db-helper');
const { db, close } = require('../src/db/mysql');

const CITY = 'coimbatore';

const VERTICALS = [
  { slug: 'interior-design', label: 'Interior Design',      priority: 1, keywords: ['interior designer', 'false ceiling', 'modular kitchen'], leads: 140, noSite: 22, failed: 6, pending: 9 },
  { slug: 'dental',          label: 'Dental Clinics',       priority: 2, keywords: ['dentist', 'dental clinic'],                              leads: 75,  noSite: 40, failed: 3, pending: 0 },
  { slug: 'builders',        label: 'Builders & Promoters', priority: 3, keywords: ['builders', 'promoters', 'villa projects'],               leads: 48,  noSite: 5,  failed: 2, pending: 31 },
  { slug: 'boutiques',       label: 'Boutiques',            priority: 4, keywords: ['boutique', 'designer wear'],                             leads: 12,  noSite: 3,  failed: 0, pending: 0 },
  { slug: 'veterinary',      label: 'Veterinary Clinics',   priority: 5, keywords: ['veterinary clinic', 'pet hospital'],                    leads: 0,   noSite: 0,  failed: 0, pending: 0 },
];

const AREAS = ['RS Puram', 'Saibaba Colony', 'Peelamedu', 'Gandhipuram', 'Saravanampatti', 'Race Course', 'Singanallur', 'Vadavalli', 'Ganapathy', 'Ramanathapuram'];
const WORDS = ['Aura', 'Nest', 'Studio', 'Habitat', 'Vibe', 'Casa', 'Urban', 'Sri', 'Royal', 'Elite', 'Prime', 'Green', 'Lotus', 'Kovai', 'Meridian', 'Vista', 'Orchid', 'Anand', 'Shree', 'Blue'];
const SUFFIX = {
  'interior-design': ['Interiors', 'Designs', 'Decor', 'Living', 'Spaces'],
  dental:     ['Dental Care', 'Dental Clinic', 'Smile Studio', 'Dentistry', 'Oral Care'],
  builders:   ['Builders', 'Promoters', 'Constructions', 'Developers', 'Homes'],
  boutiques:  ['Boutique', 'Couture', 'Designs', 'Studio', 'Fashion'],
  veterinary: ['Pet Clinic', 'Veterinary Hospital'],
};
const TYPES = {
  'interior-design': 'interior_designer', dental: 'dentist', builders: 'general_contractor', boutiques: 'clothing_store', veterinary: 'veterinary_care',
};
const SOCIAL = ['instagram.com', 'facebook.com', 'youtube.com', 'linkedin.com', 'x.com'];
const OTHER  = ['justdial.com', 'sulekha.com', 'wa.me', 'goo.gl', 'houzz.in', 'practo.com'];

/** Deterministic pseudo-random, so the demo looks the same on every run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function capturedDomains() {
  const dir = path.join(ROOT, 'data', CITY, 'companies');
  try {
    return fs.readdirSync(dir).filter(d => fs.existsSync(path.join(dir, d, 'mobile.webp')));
  } catch { return []; }
}

async function main() {
  requireTestDatabase();
  await resetTestDatabase();
  const ids = await seedVerticals(VERTICALS.map(v => ({ slug: v.slug, label: v.label, enabled: true, priority: v.priority, keywords: v.keywords })));
  const conn = db();
  const shots = capturedDomains();
  console.log(`[seed] ${shots.length} captured domain(s) on disk: ${shots.join(', ') || 'none — run npm run test:run for real screenshots'}`);

  const rand = rng(20260927);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  let n = 0;
  const linkRows = [];

  for (const v of VERTICALS) {
    const vid = ids[v.slug];
    const mk = (i) => `${pick(WORDS)} ${pick(WORDS)} ${pick(SUFFIX[v.slug])}`.replace(/(\w+) \1/, '$1') + (i % 7 === 0 ? ` ${pick(AREAS)}` : '');

    // captured leads
    for (let i = 0; i < v.leads; i++) {
      const name = mk(i);
      // Two thirds of leads sit on a captured domain (shared, like the real
      // estate), the rest on a domain that has rows but no shots here.
      const domain = shots.length && rand() < 0.66
        ? pick(shots)
        : `${name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 18)}${i}.${pick(['com', 'in', 'co.in'])}`;
      const reviews = Math.floor(Math.pow(rand(), 2.2) * 900);
      const rating  = reviews ? (3.4 + rand() * 1.6).toFixed(1) : null;
      const r = rand();
      const https = r < 0.14 ? 'none' : r < 0.22 ? 'expired' : 'ok';
      const cert = https === 'ok' ? `2027-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}`
                 : https === 'expired' ? `2025-0${1 + Math.floor(rand() * 9)}-0${1 + Math.floor(rand() * 9)}` : null;
      const email = rand() < 0.42 ? `info@${domain}` : null;
      const reviewed = rand() < 0.35;
      const tier = reviewed ? pick(['A', 'B', 'B', 'C', 'C', 'X']) : null;
      const pitch = reviewed && (tier === 'A' || (tier === 'B' && rand() < 0.5));
      const note = reviewed && rand() < 0.4 ? pick(['Call after 11am', 'Owner is the designer — pitch the portfolio angle', 'Site is a template, images broken on mobile', 'Already spoke, follow up in October']) : null;
      const [res] = await conn.query(
        'INSERT INTO companies (place_id, city, vertical_id, name, website_raw, domain, rating, review_count, address, phone,' +
        '  business_status, primary_type, discovered_run, discovered_at, status, extract_status, final_url, http_status,' +
        '  https_status, cert_expires, qualified_at, captured_at, extracted_at, email, tier, pitch, note, reviewed_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), 1, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?, ?, ?, ?, ?)',
        [`demo-${v.slug}-${i}`, CITY, vid, name, `http${https === 'none' ? '' : 's'}://www.${domain}/`, domain, rating, reviews,
         `${10 + Math.floor(rand() * 900)}, ${pick(AREAS)}, Coimbatore 6410${Math.floor(rand() * 40).toString().padStart(2, '0')}`,
         `+91 ${90000 + Math.floor(rand() * 9999)} ${10000 + Math.floor(rand() * 89999)}`,
         rand() < 0.94 ? 'OPERATIONAL' : 'CLOSED_TEMPORARILY', TYPES[v.slug], 'demo-run',
         rand() < 0.9 ? 1 : -2, `http${https === 'none' ? '' : 's'}://${domain}/`, pick([200, 200, 200, 301, 403]),
         https, cert, email, tier, pitch, note, reviewed ? new Date(Date.now() - Math.floor(rand() * 20 * 86400e3)) : null]);
      n++;
      if (rand() < 0.7) {
        const k = 1 + Math.floor(rand() * 3);
        for (let j = 0; j < k; j++) {
          const soc = rand() < 0.65;
          const host = soc ? pick(SOCIAL) : pick(OTHER);
          linkRows.push([res.insertId, `https://${host}/${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}`, host, soc ? 'social' : 'external', pick(['footer', 'header', 'main']), soc ? host.split('.')[0] : pick(['Find us on Justdial', 'Chat on WhatsApp', 'Reviews', ''])]);
        }
      }
    }
    // failed captures (never leads)
    for (let i = 0; i < v.failed; i++) {
      await conn.query(
        'INSERT INTO companies (place_id, city, vertical_id, name, domain, review_count, discovered_run, discovered_at, status, capture_error, https_status)' +
        " VALUES (?, ?, ?, ?, ?, ?, 'demo-run', UTC_TIMESTAMP(), -2, ?, 'ok')",
        [`demo-${v.slug}-fail-${i}`, CITY, vid, mk(i), `failed${i}-${v.slug}.com`, Math.floor(rand() * 50), pick(['nav-timeout', 'nav-timeout', 'dns', 'blank-page'])]);
      n++;
    }
    // pending captures
    for (let i = 0; i < v.pending; i++) {
      await conn.query(
        'INSERT INTO companies (place_id, city, vertical_id, name, domain, review_count, discovered_run, discovered_at, status, https_status)' +
        " VALUES (?, ?, ?, ?, ?, ?, 'demo-run', UTC_TIMESTAMP(), 0, 'ok')",
        [`demo-${v.slug}-pend-${i}`, CITY, vid, mk(i), `pending${i}-${v.slug}.in`, Math.floor(rand() * 200)]);
      n++;
    }
    // no website
    for (let i = 0; i < v.noSite; i++) {
      const reviews = Math.floor(Math.pow(rand(), 1.6) * 4700);
      const reviewed = rand() < 0.2;
      await conn.query(
        'INSERT INTO companies (place_id, city, vertical_id, name, domain, review_count, rating, phone, address, primary_type,' +
        "  discovered_run, discovered_at, status, skip_reason, tier, pitch, reviewed_at)" +
        " VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'demo-run', UTC_TIMESTAMP(), -1, 'no-website', ?, ?, ?)",
        [`demo-${v.slug}-nosite-${i}`, CITY, vid, mk(i), reviews, reviews ? (3.5 + rand() * 1.5).toFixed(1) : null,
         rand() < 0.8 ? `+91 ${90000 + Math.floor(rand() * 9999)} ${10000 + Math.floor(rand() * 89999)}` : null,
         `${pick(AREAS)}, Coimbatore`, TYPES[v.slug],
         reviewed ? pick(['A', 'B', 'C']) : null, reviewed && rand() < 0.5, reviewed ? new Date() : null]);
      n++;
    }
    // one dead host, for the control panel's numbers
    await conn.query(
      'INSERT INTO companies (place_id, city, vertical_id, name, domain, review_count, discovered_run, discovered_at, status, skip_reason)' +
      " VALUES (?, ?, ?, ?, ?, 3, 'demo-run', UTC_TIMESTAMP(), -1, 'dead-host')",
      [`demo-${v.slug}-dead`, CITY, vid, mk(99), `dead-${v.slug}.com`]);
    n++;
  }

  // Names that would break a careless renderer.
  const [[iid]] = await conn.query("SELECT vertical_id FROM verticals WHERE slug = 'interior-design'");
  await conn.query(
    'INSERT INTO companies (place_id, city, vertical_id, name, domain, review_count, rating, address, discovered_run, discovered_at, status, extract_status, https_status, email)' +
    " VALUES ('demo-xss', ?, ?, ?, ?, 12, 4.0, '<b>Bold Street</b>', 'demo-run', UTC_TIMESTAMP(), 1, 1, 'ok', '\"quoted\"@example.com')",
    [CITY, iid.vertical_id, '<script>alert("Décor & Co")</script> \'Quoted\' Designs', shots[0] || 'escape-test.com']);
  n++;

  if (linkRows.length) {
    await conn.query('INSERT INTO links (company_id, url, target_domain, kind, region, text) VALUES ?', [linkRows]);
  }

  const [[c]] = await conn.query('SELECT COUNT(*) AS n FROM companies');
  console.log(`[seed] ${n} rows written, ${Number(c.n)} in companies, ${linkRows.length} links, ${VERTICALS.length} verticals`);
  await close();
}

main().catch(async (e) => { console.error('[seed] failed:', e.message); await close().catch(() => {}); process.exit(1); });

'use strict';

/**
 * discover/index.js — Stage 1
 *
 * Grid-tiles the city bounding box, runs every keyword against every tile
 * via the selected provider, deduplicates by registrable domain, rejects
 * aggregators/socials, and writes data/<vertical>/discovered.json.
 *
 * CLI contract: module.exports = { run: async (argv, ctx) => {} }
 * where ctx = { root, config, log }
 */

const fs   = require('fs');
const path = require('path');
const { registrable } = require('./provider');

// ---------------------------------------------------------------------------
// Domains that are never valid leads (§2.6 of W1 spec)
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
// GREENFIELD — vertical-specific lead portals.
//
// A business whose only "website" is one of these is NOT worthless: it pays a
// portal every month for leads it does not own. That is a first-website pitch,
// not a redesign. Kept with domain:null and skip_reason "aggregator-profile-only"
// so it is distinguishable from a social-only listing, which signals no budget.
//
// These must NEVER merge in dedup (see dedupe()): forty brokers all listing a
// 99acres profile share one registrable domain and would collapse to one row.
// ---------------------------------------------------------------------------
const GREENFIELD_DOMAINS = new Set([
  // property
  '99acres.com', 'magicbricks.com', 'housing.com', 'nobroker.in',
  'commonfloor.com', 'squareyards.com', 'proptiger.com', 'olx.in', 'olx.com',
  // health
  'practo.com', 'lybrate.com', 'credihealth.com', '1mg.com', 'tata1mg.com',
  // hospitality
  'makemytrip.com', 'booking.com', 'agoda.com', 'goibibo.com',
  'tripadvisor.in', 'tripadvisor.com', 'oyorooms.com', 'airbnb.co.in',
  // weddings
  'wedmegood.com', 'shaadisaga.com', 'weddingwire.in', 'weddingz.in',
  // services
  'urbancompany.com', 'urbanclap.com', 'cult.fit', 'zomato.com', 'swiggy.com',
]);

/** True when this URL's registrable domain is a lead portal, not a real site. */
function isGreenfieldDomain(url) {
  const reg = registrable(url);
  return !!(reg && GREENFIELD_DOMAINS.has(reg));
}

// Pattern-based rejects (webnode.* etc.)
const REJECT_PATTERNS = [
  /^webnode\./,
];

/**
 * Returns true if this URL's registrable domain should be rejected.
 * @param {?string} url
 * @returns {boolean}
 */
function isRejectedDomain(url) {
  if (!url) return false;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const reg = registrable(url);
  if (reg && REJECT_DOMAINS.has(reg)) return true;
  for (const pat of REJECT_PATTERNS) {
    if (pat.test(host)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Grid tiling
// ---------------------------------------------------------------------------
/**
 * Split a bbox into rows×cols sub-rectangles.
 * Each tile gets a 0-based _index for fixture filename generation.
 *
 * @param {object} bbox   { south, west, north, east }
 * @param {object} grid   { rows, cols }
 * @returns {Array<{south, west, north, east, _index}>}
 */
function makeTiles(bbox, grid) {
  const latStep = (bbox.north - bbox.south) / grid.rows;
  const lngStep = (bbox.east  - bbox.west)  / grid.cols;
  const tiles = [];
  let idx = 0;
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      tiles.push({
        south: bbox.south + r * latStep,
        north: bbox.south + (r + 1) * latStep,
        west:  bbox.west  + c * lngStep,
        east:  bbox.west  + (c + 1) * lngStep,
        _index: idx++,
      });
    }
  }
  return tiles;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------
/**
 * Deduplicate a flat list of RawBusiness objects.
 *
 * Pass 1: collapse by provider_id (adjacent-tile duplicates).
 * Pass 2: collapse by registrable domain — keep higher review_count,
 *         union phone/address, accumulate also_seen_as.
 *
 * @param {object[]} raw
 * @returns {object[]}
 */
function deduplicate(raw) {
  // Pass 1 — by provider_id
  const byId = new Map();
  for (const b of raw) {
    if (!b.provider_id) continue;
    if (!byId.has(b.provider_id)) {
      byId.set(b.provider_id, { ...b, also_seen_as: [] });
    }
  }
  const uniqById = Array.from(byId.values());

  // Pass 2 — by registrable domain
  const byDomain = new Map();   // domain → merged entry
  const noDomain = [];          // entries with no domain stay separate

  for (const b of uniqById) {
    const dom = registrable(b.website_raw);
    if (!dom) {
      noDomain.push(b);
      continue;
    }
    // A portal domain is shared by many unrelated businesses. Merging on it
    // would silently discard every broker but one. Keep them all separate.
    if (GREENFIELD_DOMAINS.has(dom) || REJECT_DOMAINS.has(dom)) {
      noDomain.push(b);
      continue;
    }
    if (!byDomain.has(dom)) {
      byDomain.set(dom, { ...b, _domain_tmp: dom, also_seen_as: [] });
    } else {
      const existing = byDomain.get(dom);
      // Keep the entry with higher review_count
      const keep   = (b.review_count || 0) > (existing.review_count || 0) ? b : existing;
      const discard = keep === b ? existing : b;

      const merged = {
        ...keep,
        _domain_tmp: dom,
        // Union contacts
        phone:   keep.phone   || discard.phone   || null,
        address: keep.address || discard.address || null,
        also_seen_as: [
          ...(keep.also_seen_as    || []),
          ...(discard.also_seen_as || []),
          discard.provider_id,
        ].filter(Boolean),
      };
      byDomain.set(dom, merged);
    }
  }

  return [...byDomain.values(), ...noDomain];
}

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------
/**
 * Write JSON atomically: write to .tmp, then rename.
 * @param {string} filepath
 * @param {object} data
 */
function writeAtomic(filepath, data) {
  const dir = path.dirname(filepath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filepath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filepath);
}

// ---------------------------------------------------------------------------
// Main run function
// ---------------------------------------------------------------------------
/**
 * @param {string[]} argv   CLI arguments after "discover"
 * @param {object}  ctx    { root, config, log }
 */
async function run(argv, ctx) {
  const { root, log } = ctx;

  // Parse argv
  const verticalSlug = argv[0];
  if (!verticalSlug) {
    throw new Error('Usage: discover <vertical> [--source places-new|brave|fixture] [--limit N] [--dry-run]');
  }

  const sourceArg  = getFlag(argv, '--source')  || 'places-new';
  const limitArg   = getFlag(argv, '--limit');
  const limit      = limitArg ? parseInt(limitArg, 10) : Infinity;
  const dryRun     = argv.includes('--dry-run');

  // Load configs
  const cityConfig     = JSON.parse(fs.readFileSync(path.join(root, 'config', 'city.json'), 'utf8'));
  const verticalsConfig = JSON.parse(fs.readFileSync(path.join(root, 'config', 'verticals.json'), 'utf8'));

  const vertical = verticalsConfig.find(v => v.slug === verticalSlug);
  if (!vertical) throw new Error(`Unknown vertical: ${verticalSlug}`);

  // Load provider adapter
  let adapter;
  if (sourceArg === 'places-new') {
    adapter = require('./places');
    const key = process.env.GOOGLE_PLACES_KEY;
    if (!key) throw new Error('GOOGLE_PLACES_KEY is required for --source places-new. Set it in .env');
    adapter._key = key;
  } else if (sourceArg === 'brave') {
    adapter = require('./brave');
    const key = process.env.BRAVE_KEY;
    if (!key) throw new Error('BRAVE_KEY is required for --source brave. Set it in .env');
    adapter._key = key;
  } else if (sourceArg === 'fixture') {
    adapter = require('./fixture');
    adapter._key = null;
  } else {
    throw new Error(`Unknown source: ${sourceArg}. Use places-new, brave, or fixture`);
  }

  const tiles    = makeTiles(cityConfig.bbox, cityConfig.grid);
  const keywords = vertical.keywords;

  // --dry-run: print request list and exit
  if (dryRun) {
    log(`Dry run — ${tiles.length} tiles × ${keywords.length} keywords = ${tiles.length * keywords.length} requests (up to 3 pages each = ${tiles.length * keywords.length * 3} max requests)`);
    log('');
    log('Tiles:');
    for (const t of tiles) {
      log(`  tile${t._index}: lat [${t.south.toFixed(4)}, ${t.north.toFixed(4)}] lng [${t.west.toFixed(4)}, ${t.east.toFixed(4)}]`);
    }
    log('');
    log('Keywords:');
    for (const kw of keywords) {
      log(`  "${kw} ${cityConfig.city}"`);
    }
    return;
  }

  const runId     = makeRunId();
  const queriedAt = new Date().toISOString();

  log(`[discover] vertical=${verticalSlug} source=${sourceArg} tiles=${tiles.length} keywords=${keywords.length}`);

  // Collect all raw results
  const allRaw = [];
  let rawResultsCount = 0;

  for (const tile of tiles) {
    for (const keyword of keywords) {
      const callArgs = {
        keyword,
        tile,
        apiKey:   adapter._key,
        vertical: verticalSlug,
        city:     cityConfig.city,
      };

      let results;
      try {
        results = await adapter.search(callArgs);
      } catch (err) {
        log(`[discover] WARN tile${tile._index} kw="${keyword}" error: ${err.message}`);
        results = [];
      }

      rawResultsCount += results.length;
      allRaw.push(...results);
      log(`[discover] tile${tile._index} kw="${keyword}" → ${results.length} results`);
    }
  }

  // Deduplicate
  const deduped = deduplicate(allRaw);
  log(`[discover] deduped: ${allRaw.length} raw → ${deduped.length} unique by provider_id+domain`);

  // Build final business list
  const businesses = [];

  for (const b of deduped) {
    if (businesses.length >= limit) break;

    const domRaw = registrable(b.website_raw);

    // Lead-portal profile → greenfield bucket, kept for a first-website pitch
    if (isGreenfieldDomain(b.website_raw)) {
      businesses.push(toBusinessEntry(b, domRaw, null, 'aggregator-profile-only'));
      continue;
    }

    // Reject aggregators/socials
    if (isRejectedDomain(b.website_raw)) {
      businesses.push(toBusinessEntry(b, domRaw, null, 'aggregator-or-social-only'));
      continue;
    }

    businesses.push(toBusinessEntry(b, domRaw, b.provider_id, null));
  }

  const withDomain = businesses.filter(b => b.domain !== null).length;
  const greenfield = businesses.filter(b => b.skip_reason === 'aggregator-profile-only').length;
  log(`[discover] total=${businesses.length} with_domain=${withDomain} greenfield=${greenfield}`);

  // Build output
  const output = {
    run:         runId,
    vertical:    verticalSlug,
    source:      sourceArg,
    queried_at:  queriedAt,
    tiles:       tiles.length,
    keywords:    keywords.length,
    raw_results: rawResultsCount,
    businesses,
  };

  const outDir = path.join(root, 'data', verticalSlug);
  const outFile = path.join(outDir, 'discovered.json');
  writeAtomic(outFile, output);
  log(`[discover] wrote ${outFile}`);
}

// ---------------------------------------------------------------------------
// Helper: build one business entry for the output array
// ---------------------------------------------------------------------------
function toBusinessEntry(b, domain, placesId, skipReason) {
  const entry = {
    places_id:       placesId || b.provider_id || null,
    name:            b.name || '',
    domain:          skipReason ? null : domain,
    website_raw:     b.website_raw || null,
    rating:          b.rating    ?? null,
    review_count:    b.review_count ?? null,
    address:         b.address   || null,
    phone:           b.phone     || null,
    lat:             b.lat       ?? null,
    lng:             b.lng       ?? null,
    business_status: b.business_status || null,
    primary_type:    b.primary_type    || null,
  };

  if (skipReason) entry.skip_reason = skipReason;
  if (b.also_seen_as && b.also_seen_as.length > 0) entry.also_seen_as = b.also_seen_as;

  return entry;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function makeRunId() {
  const now = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, 'Z');
  return `run-${now}`;
}

function getFlag(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return null;
  return argv[idx + 1];
}

module.exports = { run };

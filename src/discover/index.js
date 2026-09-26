'use strict';

/**
 * discover/index.js — Stage 1
 *
 * Grid-tiles the city bounding box, runs every keyword against every tile via
 * the selected provider, and inserts one `companies` row per place ID.
 *
 * ## One row per place ID, and no merging
 *
 * `place_id` is unique and that is the only identity rule (docs/SCHEMA.md).
 * Discover does not merge listings that share a website, in a run or across
 * runs: forty brokers all listing the same portal profile are forty businesses,
 * and two showrooms on one company website are two listings the operator may
 * want to call separately. The old `deduplicate()` pass collapsed both cases and
 * `also_seen_as` was the scar it left.
 *
 * ## Insert per query, not once at the end
 *
 * The insert happens straight after each tile × keyword `search`, so killing a
 * run part-way keeps every row already written (R4.6) and re-running it inserts
 * only place IDs that are new. `ON DUPLICATE KEY UPDATE company_id = company_id`
 * is a deliberate no-op — first write wins, including the vertical — and unlike
 * `INSERT IGNORE` it does not also swallow a truncation or a bad foreign key.
 *
 * CLI contract: module.exports = { run: async (argv, ctx) => {} }
 * where ctx = { root, config, log }
 */

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { registrable } = require('./provider');
const { canonicalDomain, readCity } = require('../../lib-keys');
const { db, close } = require('../db/mysql');

// ---------------------------------------------------------------------------
// Domains that are never valid leads: social profiles, directories, link
// shorteners and free site builders. A business whose only website is one of
// these is kept with domain NULL and skip_reason 'aggregator-or-social-only'.
// ---------------------------------------------------------------------------
const REJECT_DOMAINS = new Set([
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com',
  'youtube.com', 'justdial.com', 'sulekha.com', 'indiamart.com',
  'tradeindia.com', 'urbanpro.com', 'wa.me', 'api.whatsapp.com',
  'linktr.ee', 'bit.ly', 'goo.gl', 'maps.app.goo.gl', 'sites.google.com',
  'business.site', 'wixsite.com', 'weebly.com', 'blogspot.com',
  'wordpress.com', 'jimdosite.com',
  'vercel.app', 'ueniweb.com', 'bolt.host', 'mypixieset.com', 'sleek.fitness',
]);

// ---------------------------------------------------------------------------
// GREENFIELD — vertical-specific lead portals.
//
// A business whose only "website" is one of these is NOT worthless: it pays a
// portal every month for leads it does not own. That is a first-website pitch,
// not a redesign. Kept with domain NULL and skip_reason "aggregator-profile-only"
// so it is distinguishable from a social-only listing, which indicates no budget.
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
 * Short SHA of the deployed checkout, stamped into every run.
 *
 * Run 1 truncated because the box ran older code than the repo and nothing said
 * so — the only trace was a stale file name in a log path. One line here makes
 * that visible at the top of every run instead of two days later.
 * @returns {string} short SHA, or 'unknown' outside a git checkout
 */
function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'],
      { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return 'unknown'; }
}

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
// Mapping one provider result onto a companies row
// ---------------------------------------------------------------------------
/**
 * The row a raw provider result becomes, or null when it cannot be one.
 *
 * `status` is NULL for anything qualify should probe and -1 for anything it
 * never will, with `skip_reason` saying which kind of nothing it is. That
 * distinction is the pitch: a social-only listing indicates no budget, a portal
 * profile indicates a monthly bill for leads the business does not own, and no
 * website at all indicates a first-website conversation.
 *
 * @returns {?object} { place_id, name, website_raw, domain, status, skip_reason, … }
 */
function toRow(b) {
  if (!b || !b.provider_id) return null;

  const raw = b.website_raw || null;
  let domain = null;
  let status = null;
  let skipReason = null;

  if (!raw) {
    status = -1; skipReason = 'no-website';
  } else if (isGreenfieldDomain(raw)) {
    status = -1; skipReason = 'aggregator-profile-only';
  } else if (isRejectedDomain(raw)) {
    status = -1; skipReason = 'aggregator-or-social-only';
  } else {
    const reg = registrable(raw);
    if (!reg) {
      status = -1; skipReason = 'unusable-website';
    } else {
      try { domain = canonicalDomain(reg); }
      catch { domain = null; status = -1; skipReason = 'unusable-website'; }
    }
  }

  return {
    place_id:        String(b.provider_id),
    name:            String(b.name || '').slice(0, 255),
    website_raw:     raw ? String(raw).slice(0, 2048) : null,
    domain,
    rating:          b.rating ?? null,
    review_count:    b.review_count ?? null,
    address:         b.address ? String(b.address).slice(0, 512) : null,
    phone:           b.phone ? String(b.phone).slice(0, 32) : null,
    lat:             b.lat ?? null,
    lng:             b.lng ?? null,
    business_status: b.business_status ? String(b.business_status).slice(0, 32) : null,
    primary_type:    b.primary_type ? String(b.primary_type).slice(0, 64) : null,
    status,
    skip_reason:     skipReason,
  };
}

const INSERT_COLUMNS = [
  'place_id', 'city', 'vertical_id', 'name', 'website_raw', 'domain',
  'rating', 'review_count', 'address', 'phone', 'lat', 'lng',
  'business_status', 'primary_type', 'discovered_run', 'discovered_at',
  'status', 'skip_reason',
];

/**
 * Insert one query's results. Returns how many rows were new.
 *
 * The count comes from asking which place IDs are already there, not from
 * `affectedRows`. mysql2 connects with `CLIENT_FOUND_ROWS`, under which a
 * duplicate whose `ON DUPLICATE KEY UPDATE` changed nothing still reports one
 * row, so `affectedRows` equals the batch size whatever happened and every
 * tile reads as entirely new. Duplicates *within* one batch are collapsed
 * first — adjacent tiles routinely return the same listing twice.
 */
async function insertRows(conn, rows, { city, verticalId, runId, discoveredAt }) {
  if (!rows.length) return 0;

  const byId = new Map();
  for (const r of rows) if (!byId.has(r.place_id)) byId.set(r.place_id, r);
  const unique = [...byId.values()];

  const [known] = await conn.query(
    'SELECT place_id FROM companies WHERE place_id IN (?)',
    [unique.map(r => r.place_id)]);

  const params = [];
  for (const r of unique) {
    params.push(
      r.place_id, city, verticalId, r.name, r.website_raw, r.domain,
      r.rating, r.review_count, r.address, r.phone, r.lat, r.lng,
      r.business_status, r.primary_type, runId, discoveredAt,
      r.status, r.skip_reason);
  }
  const placeholders = unique
    .map(() => `(${INSERT_COLUMNS.map(() => '?').join(', ')})`)
    .join(', ');

  await conn.query(
    `INSERT INTO companies (${INSERT_COLUMNS.join(', ')}) VALUES ${placeholders}` +
    ' ON DUPLICATE KEY UPDATE company_id = company_id',
    params);
  return unique.length - known.length;
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

  const verticalSlug = argv[0];
  if (!verticalSlug) {
    throw new Error('Usage: discover <vertical> [--source places-new|brave|fixture] [--dry-run]');
  }

  const sourceArg = getFlag(argv, '--source') || 'places-new';
  const dryRun    = argv.includes('--dry-run');

  const cityConfig = JSON.parse(fs.readFileSync(path.join(root, 'config', 'city.json'), 'utf8'));
  const city       = readCity(root).slug;

  const conn = db();
  const [verticals] = await conn.query(
    'SELECT vertical_id, slug, label, keywords FROM verticals WHERE slug = ? AND enabled = TRUE',
    [verticalSlug]);
  if (!verticals.length) throw new Error(`Unknown vertical: ${verticalSlug}`);
  const vertical = verticals[0];
  // `keywords` is a JSON column; mysql2 parses it, but a driver that hands back
  // the raw string would otherwise iterate it character by character.
  const keywords = typeof vertical.keywords === 'string'
    ? JSON.parse(vertical.keywords) : vertical.keywords;
  if (!Array.isArray(keywords) || !keywords.length) {
    throw new Error(`Vertical ${verticalSlug} has no keywords`);
  }

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

  const tiles = makeTiles(cityConfig.bbox, cityConfig.grid);

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
    return { ok: 0, err: 0 };
  }

  const runId        = makeRunId();
  const discoveredAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

  log(`[discover] commit=${gitCommit()} vertical=${verticalSlug} source=${sourceArg} tiles=${tiles.length} keywords=${keywords.length}`);

  // Request accounting. `requestsIssued` is what Places actually bills;
  // `paginatedQueries` is the direct proof the nextPageToken field mask is live
  // on this box — without it every query returns one page and this stays 0.
  let rawResultsCount   = 0;
  let requestsIssued    = 0;
  let paginatedQueries  = 0;
  let ceilingQueries    = 0;   // hit 60 = 3 pages: pagination cannot reach deeper
  let inserted          = 0;
  let seen              = 0;
  let searchErrors      = 0;

  for (const tile of tiles) {
    for (const keyword of keywords) {
      const callArgs = {
        keyword,
        tile,
        apiKey:   adapter._key,
        vertical: verticalSlug,   // fixture.js resolves its file from this
        city:     cityConfig.city,
        log,
      };

      let results;
      try {
        results = await adapter.search(callArgs);
      } catch (err) {
        // Rows already inserted stay (R4.6); this query is simply lost.
        searchErrors++;
        log(`[discover] WARN tile${tile._index} kw="${keyword}" error: ${err.message}`);
        results = [];
      }

      const pages = results._pages ?? 1;
      requestsIssued += results._requests ?? 1;
      if (pages > 1)             paginatedQueries++;
      if (results.length >= 60)  ceilingQueries++;
      rawResultsCount += results.length;

      const rows = [];
      for (const b of results) {
        const row = toRow(b);
        if (!row) { log(`[discover] WARN tile${tile._index} kw="${keyword}": a result had no place id`); continue; }
        rows.push(row);
      }

      const n = await insertRows(conn, rows, {
        city, verticalId: vertical.vertical_id, runId, discoveredAt });
      inserted += n;
      seen     += rows.length - n;

      log(`[discover] tile${tile._index} kw="${keyword}" → ${results.length} results (${pages}p)  ${n} new  ${rows.length - n} seen`);
    }
  }

  const queries = tiles.length * keywords.length;
  log(`[discover] ${verticalSlug}: ${inserted} new rows, ${seen} already known, ` +
      `${rawResultsCount} raw results`);
  log(`[discover] ${verticalSlug}: ${requestsIssued} requests, ` +
      `${paginatedQueries}/${queries} queries paginated`);
  // Only `places-new` paginates; brave and fixture return one page by design,
  // so warning there would cry wolf on every smoke run.
  if (paginatedQueries === 0 && sourceArg === 'places-new') {
    log(`[discover] WARN ${verticalSlug}: nothing paginated — check that ` +
        `'nextPageToken' is in the field mask on THIS box (places.js:17)`);
  }
  if (ceilingQueries > 0) {
    log(`[discover] ${verticalSlug}: ${ceilingQueries} queries hit the 60-result ` +
        `ceiling — still truncated there, only a finer grid reaches deeper`);
  }

  return { ok: inserted + seen, err: searchErrors };
}

/** The CLI closes nothing for us; a stage that leaves the pool open hangs. */
async function runAndClose(argv, ctx) {
  try { return await run(argv, ctx); }
  finally { await close(); }
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

module.exports = {
  run: runAndClose,
  _run: run, toRow, makeTiles, isGreenfieldDomain, isRejectedDomain,
};

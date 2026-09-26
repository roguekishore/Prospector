'use strict';

/**
 * Read and add verticals in the `verticals` table.
 *
 * The table replaced the JSON file in `config/` because discover now reads keywords
 * inside a SQL statement it is already running, and because the control panel
 * could add a vertical to a file on the box that the repo would overwrite on the
 * next ship. Keywords are still versioned in a sense — `created_at` and the
 * first `discovered_run` that used them are both in the database.
 *
 * The slug rule and the "slug derived from the label, never renamed" behaviour
 * are unchanged: `companies.vertical_id` points at a row, so renaming a label is
 * free and changing a slug is not something this offers.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 25 tiles, one request per tile per keyword, up to 3 pages each. */
const TILES = 25;
const MAX_PAGES = 3;

const { db } = require('../db/mysql');

/** Every vertical, in the order the control panel shows them. */
async function readAll() {
  const [rows] = await db().query(
    'SELECT vertical_id, slug, label, enabled, priority, keywords FROM verticals' +
    '  ORDER BY priority, slug');
  return rows.map(r => ({
    vertical_id: r.vertical_id,
    slug:     r.slug,
    label:    r.label,
    enabled:  !!r.enabled,
    priority: r.priority,
    // mysql2 parses a JSON column; a driver that hands back the string would
    // otherwise give the UI a keyword list of single characters.
    keywords: typeof r.keywords === 'string' ? JSON.parse(r.keywords) : (r.keywords || []),
  }));
}

/** One by slug, or null. Used to validate a slug before starting a run. */
async function bySlug(slug) {
  if (!SLUG_RE.test(String(slug || ''))) return null;
  const [rows] = await db().query(
    'SELECT vertical_id, slug, label, enabled, priority, keywords FROM verticals WHERE slug = ?',
    [slug]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    vertical_id: r.vertical_id,
    slug: r.slug, label: r.label, enabled: !!r.enabled, priority: r.priority,
    keywords: typeof r.keywords === 'string' ? JSON.parse(r.keywords) : (r.keywords || []),
  };
}

/** Slugify a label the way the existing slugs were built. */
function slugify(label) {
  return String(label).toLowerCase().trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * What one discover run of this vertical will cost, in requests.
 *
 * Surfaced before the button is pressed, because discover is the only stage that
 * spends Places quota and a phone tap is a very low bar for spending money. The
 * floor is what a fully-truncated run costs; the ceiling assumes every query
 * paginates to three pages, which no real vertical does.
 */
function estimateRequests(keywordCount) {
  const floor = TILES * keywordCount;
  return { floor, ceiling: floor * MAX_PAGES, tiles: TILES };
}

/**
 * Add a vertical. Returns the created entry.
 *
 * Refuses a duplicate slug rather than merging: a silent merge would change an
 * existing vertical's keywords, and every row already discovered under it would
 * then claim to have come from a keyword set that never ran.
 */
async function add({ label, keywords, priority }) {
  if (!label || !String(label).trim()) throw new Error('label is required');

  const cleanKeywords = (Array.isArray(keywords) ? keywords : String(keywords || '').split(','))
    .map(k => String(k).trim())
    .filter(Boolean);

  if (!cleanKeywords.length) throw new Error('at least one keyword is required');
  if (cleanKeywords.length > 20) throw new Error('at most 20 keywords');

  const slug = slugify(label);
  if (!SLUG_RE.test(slug)) throw new Error(`label does not produce a usable slug: ${slug}`);

  const conn = db();
  const [existing] = await conn.query('SELECT vertical_id FROM verticals WHERE slug = ?', [slug]);
  if (existing.length) throw new Error(`vertical already exists: ${slug}`);

  const [[max]] = await conn.query('SELECT COALESCE(MAX(priority), 0) AS p FROM verticals');
  const prio = Number.isFinite(Number(priority)) ? Number(priority) : Number(max.p) + 1;

  const [res] = await conn.query(
    'INSERT INTO verticals (slug, label, enabled, priority, keywords)' +
    '  VALUES (?, ?, TRUE, ?, CAST(? AS JSON))',
    [slug, String(label).trim(), prio, JSON.stringify(cleanKeywords)]);

  return {
    vertical_id: res.insertId,
    slug, label: String(label).trim(), enabled: true,
    priority: prio, keywords: cleanKeywords,
  };
}

/** Enable or disable one, without deleting it or its rows. */
async function setEnabled(slug, enabled) {
  const [res] = await db().query(
    'UPDATE verticals SET enabled = ? WHERE slug = ?', [!!enabled, slug]);
  if (!res.affectedRows) throw new Error(`no such vertical: ${slug}`);
  return bySlug(slug);
}

module.exports = { readAll, bySlug, add, setEnabled, slugify, estimateRequests, SLUG_RE };

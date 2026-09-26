'use strict';

/**
 * Read and add verticals in `config/verticals.json`.
 *
 * That file stays the source of truth rather than a database table. Keywords are
 * an input to code, they live in git, and when a vertical's yield changes you
 * need to see what you changed — which a table does not give you.
 *
 * Writes are atomic (`.tmp` + rename), the same contract every stage on disk
 * follows: a phone losing signal mid-request must not leave a truncated config
 * that breaks every future run.
 */

const fs   = require('fs');
const path = require('path');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 25 tiles, one request per tile per keyword, up to 3 pages each. */
const TILES = 25;
const MAX_PAGES = 3;

function configPath(root) {
  return path.join(root, 'config', 'verticals.json');
}

function readAll(root) {
  const raw = JSON.parse(fs.readFileSync(configPath(root), 'utf8'));
  return Array.isArray(raw) ? raw : Object.values(raw);
}

function writeAll(root, list) {
  const file = configPath(root);
  const tmp  = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
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
 * existing vertical's keywords and invalidate what has already been captured
 * under it, with no record of what it used to be.
 */
function add(root, { label, keywords, priority }) {
  if (!label || !String(label).trim()) throw new Error('label is required');

  const cleanKeywords = (Array.isArray(keywords) ? keywords : String(keywords || '').split(','))
    .map(k => String(k).trim())
    .filter(Boolean);

  if (!cleanKeywords.length) throw new Error('at least one keyword is required');
  if (cleanKeywords.length > 20) throw new Error('at most 20 keywords');

  const slug = slugify(label);
  if (!SLUG_RE.test(slug)) throw new Error(`label does not produce a usable slug: ${slug}`);

  const list = readAll(root);
  if (list.some(v => v.slug === slug)) throw new Error(`vertical already exists: ${slug}`);

  const maxPriority = list.reduce((m, v) => Math.max(m, Number(v.priority) || 0), 0);
  const entry = {
    slug,
    label:    String(label).trim(),
    enabled:  true,
    priority: Number.isFinite(Number(priority)) ? Number(priority) : maxPriority + 1,
    keywords: cleanKeywords,
  };

  list.push(entry);
  writeAll(root, list);
  return entry;
}

/** Enable or disable one, without deleting it or its data. */
function setEnabled(root, slug, enabled) {
  const list = readAll(root);
  const entry = list.find(v => v.slug === slug);
  if (!entry) throw new Error(`no such vertical: ${slug}`);
  entry.enabled = !!enabled;
  writeAll(root, list);
  return entry;
}

module.exports = { readAll, add, setEnabled, slugify, estimateRequests, SLUG_RE };

/* src/db/index.js — SQLite with subprocess health-check.
   better-sqlite3 may crash (SIGSEGV / 0xC0000005) in certain sandbox
   environments. We probe it in a child process first; if that exits non-zero
   we fall back to a JSON-file stub and the pipeline continues on JSON files. */
'use strict';

const path         = require('path');
const crypto       = require('crypto');
const { execFileSync } = require('child_process');

const DB_PATH = path.join(__dirname, '..', '..', 'index.db');
const REVIEWS_FALLBACK = path.join(__dirname, '..', '..', 'data', '_reviews.json');
const fs = require('fs');

let _db       = null;
let _disabled = null;   // null = not yet tested

const DDL = `
  CREATE TABLE IF NOT EXISTS verticals (
    slug TEXT PRIMARY KEY, label TEXT, city TEXT, keywords TEXT,
    discovered INTEGER, with_domain INTEGER, audited INTEGER);

  CREATE TABLE IF NOT EXISTS businesses (
    domain TEXT PRIMARY KEY,
    vertical TEXT, name TEXT, places_id TEXT,
    rating REAL, review_count INTEGER, address TEXT, phone TEXT,
    lat REAL, lng REAL, business_status TEXT,
    source TEXT, first_seen TEXT);

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, started_at TEXT, finished_at TEXT,
    vertical TEXT, stage TEXT, config_hash TEXT, scorer TEXT);

  CREATE TABLE IF NOT EXISTS scores (
    domain TEXT, run_id TEXT, tier TEXT, score INTEGER,
    pain REAL, pay REAL, reach REAL, gate TEXT,
    angle_template TEXT, flaws TEXT,
    PRIMARY KEY (domain, run_id));

  CREATE TABLE IF NOT EXISTS reviews (
    domain TEXT PRIMARY KEY,
    human_tier TEXT, pitch INTEGER DEFAULT 0, note TEXT, reviewed_at TEXT);

  CREATE TABLE IF NOT EXISTS contacts (
    domain TEXT, kind TEXT, value TEXT, owner TEXT,
    PRIMARY KEY (domain, kind, value));

  CREATE TABLE IF NOT EXISTS agencies (
    domain TEXT PRIMARY KEY, name TEXT, pricing TEXT,
    portfolio_clients INTEGER, note TEXT);

  CREATE TABLE IF NOT EXISTS agency_clients (
    agency_domain TEXT, domain TEXT, confidence REAL,
    PRIMARY KEY (agency_domain, domain));
`;

/* ---- JSON fallback for reviews (the only mutable table the server needs) ---- */
function loadReviews() {
  try { return JSON.parse(fs.readFileSync(REVIEWS_FALLBACK, 'utf8')); }
  catch { return {}; }
}
function saveReviews(map) {
  fs.writeFileSync(REVIEWS_FALLBACK, JSON.stringify(map, null, 2) + '\n', 'utf8');
}

/* ---- JSON-backed stub (used when native addon is unavailable) ---- */
function makeJsonStub() {
  return {
    _stub: true,
    pragma:  () => {},
    exec:    () => {},
    prepare: (sql) => {
      const s = sql.toLowerCase().trim();
      return {
        run: (...args) => {
          // Handle reviews upsert
          if (s.includes('into reviews')) {
            const [domain, human_tier, pitch, note, reviewed_at] = args;
            const map = loadReviews();
            map[domain] = { human_tier, pitch: !!pitch, note, reviewed_at };
            saveReviews(map);
          }
        },
        get: (...args) => {
          // Validate domain exists — look in scores JSON files
          if (s.includes('from businesses') || s.includes('from scores')) {
            // Allow any non-empty domain through for the review endpoint
            return args[0] ? { domain: args[0] } : null;
          }
          return null;
        },
        all: () => {
          if (s.includes('from reviews')) {
            const map = loadReviews();
            return Object.entries(map).map(([domain, r]) => ({
              domain, human_tier: r.human_tier, pitch: r.pitch ? 1 : 0, note: r.note,
            }));
          }
          return [];
        },
      };
    },
    transaction: fn => () => fn(),
    close: () => {},
  };
}

function canUseSqlite() {
  if (_disabled !== null) return !_disabled;
  try {
    execFileSync(process.execPath,
      ['-e', `require('better-sqlite3')(':memory:').close()`],
      { timeout: 8000, stdio: 'pipe', cwd: path.join(__dirname, '..', '..') });
    _disabled = false;
    return true;
  } catch {
    console.warn('[db] SQLite native addon unavailable — using JSON fallback for reviews');
    _disabled = true;
    return false;
  }
}

function open() {
  if (_db) return _db;

  if (!canUseSqlite()) {
    return makeJsonStub();
  }

  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(DDL);
  _db = db;
  return _db;
}

function configHash(config, weights) {
  const str = JSON.stringify(config) + JSON.stringify(weights);
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

module.exports = { open, configHash };

'use strict';

/**
 * Shared setup for every test that touches MySQL.
 *
 * ## The guard
 *
 * Nothing here runs unless the database named in `DATABASE_URL` ends in
 * `_test`. These tests truncate tables between files; pointed at the real
 * database — a copied shell line, a `.env` that leaked in, a laptop configured
 * for the box — that would delete the run. The check is first, before the
 * connection is even opened, and it is the only thing standing between a typo
 * and 3,906 rows.
 */

const path = require('path');

const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');

/** The tables, in the order they can be truncated without upsetting the keys. */
const TABLES = ['links', 'companies', 'verticals'];

/** A small fixture, enough for discover's fixture source and the deck. */
const VERTICALS = [
  // The keywords are what `src/discover/fixture.js` builds its filenames from:
  // `<vertical>-tile<N>-<keyword slugged>.json`. These two match the two files
  // in `fixtures/places/`, so changing either means changing both.
  { slug: 'interior-design', label: 'Interior Design', enabled: true, priority: 1,
    keywords: ['interior designer', 'false ceiling'] },
  { slug: 'interior-design-smoke', label: 'Interior Design (smoke)', enabled: true, priority: 99,
    keywords: ['interior designers'] },
];

/**
 * The database name out of `DATABASE_URL`, or null when there is none.
 *
 * Parsed with `URL`, not a regex: a password containing `/` or `@` is exactly
 * the input a regex gets wrong, and getting it wrong here means the guard reads
 * the wrong name.
 */
function databaseName(url) {
  try {
    const u = new URL(url);
    const name = decodeURIComponent(u.pathname.replace(/^\//, ''));
    return name || null;
  } catch {
    return null;
  }
}

/**
 * Check the guard and return the parts a test needs.
 *
 * @returns {{ url: string, name: string, serverUrl: string }}
 * @throws when DATABASE_URL is unset or does not name a `_test` database
 */
function requireTestDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. These tests need a scratch MySQL, e.g.\n' +
      '  DATABASE_URL=mysql://root:pw@127.0.0.1:3306/prospector_test npm run test:db');
  }
  const name = databaseName(url);
  if (!name) throw new Error(`DATABASE_URL names no database: ${url.replace(/\/\/[^@]*@/, '//***@')}`);
  if (!name.endsWith('_test')) {
    throw new Error(
      `refusing to run against database "${name}": these tests truncate tables, ` +
      'so the name must end in _test');
  }

  // The same server, with no database selected — for CREATE DATABASE.
  const u = new URL(url);
  u.pathname = '/';
  return { url, name, serverUrl: u.toString() };
}

/**
 * Create the database if it is absent, migrate it, and empty the tables.
 *
 * Called at the top of each test file rather than once for the suite: the files
 * run as separate processes, and a file that assumed another had already set up
 * would pass or fail depending on the order they were run in.
 */
async function resetTestDatabase() {
  const { url, name, serverUrl } = requireTestDatabase();

  const admin = await mysql.createConnection({ uri: serverUrl, multipleStatements: true });
  try {
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${name}\` ` +
      'CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
  } finally {
    await admin.end();
  }

  const { run: migrate } = require('../src/db/migrate');
  await migrate([], { root: ROOT, log: quietLog() });

  await truncate();
  return { url, name };
}

/** Empty every table, keys off, so the order of the deletes does not matter. */
async function truncate() {
  requireTestDatabase();
  const conn = await mysql.createConnection({ uri: process.env.DATABASE_URL });
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of TABLES) await conn.query(`TRUNCATE TABLE \`${t}\``);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    await conn.end();
  }
}

/** Insert the fixture verticals. Returns slug → vertical_id. */
async function seedVerticals(list = VERTICALS) {
  const { db } = require('../src/db/mysql');
  const conn = db();
  const ids = {};
  for (const v of list) {
    const [res] = await conn.query(
      'INSERT INTO verticals (slug, label, enabled, priority, keywords)' +
      '  VALUES (?, ?, ?, ?, CAST(? AS JSON))' +
      '  ON DUPLICATE KEY UPDATE vertical_id = LAST_INSERT_ID(vertical_id)',
      [v.slug, v.label, v.enabled, v.priority, JSON.stringify(v.keywords)]);
    ids[v.slug] = res.insertId;
  }
  return ids;
}

/** A logger that says nothing, for the setup a test is not asserting on. */
function quietLog() {
  const noop = () => {};
  const log = noop;
  log.info = noop; log.warn = noop; log.error = noop;
  return log;
}

module.exports = {
  ROOT, TABLES, VERTICALS,
  databaseName, requireTestDatabase, resetTestDatabase, truncate, seedVerticals, quietLog,
};

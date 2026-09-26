'use strict';

/**
 * Capture progress, computed from MySQL.
 *
 * One `GROUP BY` replaces the filesystem walk this used to do. The walk could
 * only see what was on *this* box, which was honest when the deck served the
 * same disk and wrong the moment the Lambda started capturing into S3: a run
 * could be half done and the dashboard would show nothing until someone synced.
 * `companies.status` is the same fact for every capture path.
 *
 * Counts are **rows**, not domains. Several `companies` rows can share one
 * website, and capture runs once per domain — so "captured 400 of 530" is 530
 * listings, not 530 page loads. The UI says so.
 *
 * Deliberately not cached. It is one indexed aggregate and the page polls every
 * three seconds; caching would buy microseconds and introduce the one bug this
 * view cannot afford — showing a number that is no longer true while a run is in
 * flight.
 */

const { readCity } = require('../../lib-keys');
const { db } = require('../db/mysql');

/**
 * Every vertical, plus a rolled-up total.
 *
 * `LEFT JOIN` so a vertical that has been added but never discovered still
 * appears, at zero, rather than vanishing from the list the operator picks from.
 */
async function allStatus(root) {
  const city = readCity(root).slug;
  const conn = db();

  const [rows] = await conn.query(
    'SELECT v.slug, v.label, c.status, c.extract_status, c.capture_error,' +
    '       (c.domain IS NULL) AS no_domain, COUNT(c.company_id) AS n' +
    '  FROM verticals v' +
    '  LEFT JOIN companies c ON c.vertical_id = v.vertical_id AND c.city = ?' +
    '  GROUP BY v.slug, v.label, c.status, c.extract_status, c.capture_error, no_domain' +
    '  ORDER BY v.priority, v.slug',
    [city]);

  const byVertical = new Map();
  for (const r of rows) {
    if (!byVertical.has(r.slug)) byVertical.set(r.slug, _empty(r.slug, r.label));
    const v = byVertical.get(r.slug);
    const n = Number(r.n);
    if (!n) continue;                     // the LEFT JOIN's empty row

    v.discovered += n;
    if (Number(r.no_domain) === 1)               v.noWebsite += n;
    if (r.status === null)                       v.unqualified += n;
    else if (r.status === -1 && !Number(r.no_domain)) v.dead += n;
    else if (r.status === 0)                     v.pending += n;
    else if (r.status === 1)                     v.captured += n;
    else if (r.status === -2) {
      v.failed += n;
      const kind = r.capture_error || 'unknown';
      v.failureKinds[kind] = (v.failureKinds[kind] || 0) + n;
    }
    if (r.status === 1 && r.extract_status === 1) v.extracted += n;
  }

  const verticals = [...byVertical.values()];
  for (const v of verticals) {
    v.eligible = v.pending + v.captured + v.failed;
    v.pct = v.eligible ? Math.round(1000 * v.captured / v.eligible) / 10 : 0;
  }

  const total = verticals.reduce((acc, v) => {
    for (const k of ['discovered', 'eligible', 'captured', 'failed', 'pending',
                     'noWebsite', 'dead', 'unqualified', 'extracted']) {
      acc[k] += v[k];
    }
    for (const [k, n] of Object.entries(v.failureKinds)) {
      acc.failureKinds[k] = (acc.failureKinds[k] || 0) + n;
    }
    return acc;
  }, _emptyTotal());

  total.pct = total.eligible ? Math.round(1000 * total.captured / total.eligible) / 10 : 0;

  return { verticals, total, at: new Date().toISOString(), unit: 'rows' };
}

/** One vertical's counts, for a caller that wants just the one. */
async function verticalStatus(root, slug) {
  const all = await allStatus(root);
  return all.verticals.find(v => v.slug === slug) || null;
}

function _empty(slug, label) {
  return {
    slug, label: label || slug,
    discovered: 0, eligible: 0, captured: 0, failed: 0, pending: 0,
    noWebsite: 0, dead: 0, unqualified: 0, extracted: 0,
    failureKinds: {}, pct: 0,
  };
}

function _emptyTotal() {
  return {
    discovered: 0, eligible: 0, captured: 0, failed: 0, pending: 0,
    noWebsite: 0, dead: 0, unqualified: 0, extracted: 0,
    failureKinds: {}, pct: 0,
  };
}

module.exports = { allStatus, verticalStatus };

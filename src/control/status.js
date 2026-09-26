'use strict';

/**
 * Capture progress, computed from disk.
 *
 * No database and no AWS call. The filesystem already holds every fact this
 * needs: `qualified.json` says what should be captured, `isComplete()` says what
 * was, and `error.json` says what failed and why. That is the same triple
 * `--resume` has always used, read for display instead of for skipping.
 *
 * Deliberately not cached. A vertical is a few hundred `statSync` calls and the
 * page polls every two seconds; caching would buy microseconds and introduce the
 * one bug this view cannot afford — showing a number that is no longer true while
 * a run is in flight.
 */

const fs   = require('fs');
const path = require('path');

const { isComplete } = require('../capture/capture-domain');

/** Verdicts other than this never reach capture, so they are not "pending". */
const AUDIT_VERDICT = 'audit';

function _readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * One vertical's counts.
 *
 * `failed` is only counted for a domain that is *not* complete: a capture that
 * errored, was retried and succeeded leaves `error.json` behind on purpose
 * (`src/score/index.js` no longer deletes it), and counting that as a failure
 * would permanently overstate the damage.
 */
function verticalStatus(dataDir, slug) {
  const dir       = path.join(dataDir, slug);
  const qualified = _readJson(path.join(dir, 'qualified.json'));
  if (!qualified) return null;

  const businesses = qualified.businesses || [];
  const eligible   = businesses.filter(
    b => b.domain && b.qualify && b.qualify.verdict === AUDIT_VERDICT);

  let captured = 0, failed = 0;
  const failureKinds = {};
  const pendingDomains = [];

  for (const biz of eligible) {
    const outDir = path.join(dir, biz.domain);
    if (isComplete(outDir)) { captured++; continue; }

    const err = _readJson(path.join(outDir, 'error.json'));
    if (err) {
      failed++;
      const kind = err.kind || 'unknown';
      failureKinds[kind] = (failureKinds[kind] || 0) + 1;
    } else {
      pendingDomains.push(biz.domain);
    }
  }

  const discovered = businesses.length;
  const noWebsite  = businesses.filter(b => !b.domain).length;
  const dead       = businesses.filter(
    b => b.domain && b.qualify && b.qualify.verdict !== AUDIT_VERDICT).length;

  return {
    slug,
    label:      qualified.vertical || slug,
    discovered,
    eligible:   eligible.length,
    captured,
    failed,
    pending:    pendingDomains.length,
    noWebsite,
    dead,
    failureKinds,
    pendingDomains,
    pct: eligible.length ? Math.round(1000 * captured / eligible.length) / 10 : 0,
  };
}

/**
 * Every vertical, plus a rolled-up total.
 *
 * `pendingDomains` is dropped from the wire payload — at ~9,600 domains that is
 * a megabyte of strings the dashboard never renders. The count is what it shows;
 * the list stays server-side for the runner to slice a `--limit` from.
 */
function allStatus(root) {
  const dataDir = path.join(root, 'data');
  if (!fs.existsSync(dataDir)) return { verticals: [], total: _emptyTotal() };

  const slugs = fs.readdirSync(dataDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  const verticals = [];
  for (const slug of slugs) {
    const st = verticalStatus(dataDir, slug);
    if (st) verticals.push(st);
  }

  const total = verticals.reduce((acc, v) => {
    acc.discovered += v.discovered;
    acc.eligible   += v.eligible;
    acc.captured   += v.captured;
    acc.failed     += v.failed;
    acc.pending    += v.pending;
    acc.noWebsite  += v.noWebsite;
    acc.dead       += v.dead;
    for (const [k, n] of Object.entries(v.failureKinds)) {
      acc.failureKinds[k] = (acc.failureKinds[k] || 0) + n;
    }
    return acc;
  }, _emptyTotal());

  total.pct = total.eligible ? Math.round(1000 * total.captured / total.eligible) / 10 : 0;

  return {
    verticals: verticals.map(({ pendingDomains, ...rest }) => rest),
    total,
    at: new Date().toISOString(),
  };
}

function _emptyTotal() {
  return {
    discovered: 0, eligible: 0, captured: 0, failed: 0,
    pending: 0, noWebsite: 0, dead: 0, failureKinds: {}, pct: 0,
  };
}

/** Domains still awaiting capture, for slicing a bounded run out of. */
function pendingFor(root, slug) {
  const st = verticalStatus(path.join(root, 'data'), slug);
  return st ? st.pendingDomains : [];
}

module.exports = { allStatus, verticalStatus, pendingFor };

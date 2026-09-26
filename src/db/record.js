'use strict';

/**
 * `recordDomain` — the one place capture and extract results become rows.
 *
 * Three callers reach it: `ingest` (S3 → MySQL), local `capture` (which never
 * uploads, so nothing else would record it) and standalone `extract`. They must
 * agree column for column, or a domain captured locally and a domain captured by
 * the Lambda would end up describable by different queries — and the deck would
 * show one and not the other.
 *
 * It never writes a decision column (`tier`, `pitch`, `note`, `reviewed_at`) and
 * never a discover or qualify column (R7.7). It writes `status` last, so a row
 * that is `status = 1` already has its `captured_at` and its links.
 *
 * ## Why it reads before it writes
 *
 * A second `ingest` over an unchanged bucket must make zero writes (R7.5). The
 * cheap way to get that is to compare the row it would write against the row
 * that is there — under `FOR UPDATE`, so a concurrent ingest of the same domain
 * waits rather than interleaving.
 */

/** The `extract.json` shape ingest is allowed to load (docs/SCHEMA.md). */
const LINK_KINDS   = new Set(['social', 'external']);
const LINK_REGIONS = new Set(['header', 'nav', 'main', 'aside', 'footer']);
const MAX_URL      = 2048;
const MAX_EMAIL    = 320;

/**
 * Is this a well-formed `extract.json`?
 *
 * A bad file is a bug in extract, not a reason to abandon the domain: the caller
 * records `extract_status = -2` and the standalone `extract` stage retries it.
 *
 * @returns {?string} what is wrong, or null when it is usable
 */
function validateExtract(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'not an object';
  if (doc.email != null) {
    if (typeof doc.email !== 'string') return 'email is not a string';
    if (doc.email.length > MAX_EMAIL)  return 'email is too long';
  }
  if (doc.links != null && !Array.isArray(doc.links)) return 'links is not an array';
  for (const l of (doc.links || [])) {
    if (!l || typeof l !== 'object')         return 'a link is not an object';
    if (typeof l.url !== 'string' || !l.url) return 'a link has no url';
    if (l.url.length > MAX_URL)              return 'a link url is too long';
    if (typeof l.target_domain !== 'string' || !l.target_domain) return 'a link has no target_domain';
    if (l.target_domain.length > 253)        return 'a link target_domain is too long';
    if (!LINK_KINDS.has(l.kind))             return 'a link has an unknown kind';
    if (!LINK_REGIONS.has(l.region))         return 'a link has an unknown region';
    if (l.text != null && typeof l.text !== 'string') return 'a link text is not a string';
  }
  return null;
}

/** A Date or an ISO string → `2026-09-26 11:22:33`, which is what DATETIME takes. */
function toMysqlDatetime(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Record one domain's capture and extract state on every row that shares it.
 *
 * @param {object} conn   a connection inside `tx()`
 * @param {object} state
 * @param {string} state.city
 * @param {string} state.domain
 * @param {boolean} state.complete       desktop + mobile + rendered.html all present
 * @param {?string} state.errorKind      `error.json`'s `kind`, when there is one
 * @param {?(Date|string)} state.capturedAt
 * @param {?object} state.extract        the parsed `extract.json`
 * @param {?(Date|string)} state.extractedAt
 * @param {object} [log]
 * @returns {Promise<boolean>} whether anything was written
 */
async function recordDomain(conn, state, log = console) {
  const { city, domain, complete = false, errorKind = null, extract = null } = state;
  if (!city || !domain) throw new Error('recordDomain needs a city and a domain');

  const [rows] = await conn.query(
    'SELECT company_id, status, capture_error, captured_at, extract_status, extracted_at, email' +
    '  FROM companies WHERE city = ? AND domain = ? FOR UPDATE',
    [city, domain]);
  if (!rows.length) return false;

  // ---- what the columns should become -------------------------------------
  //
  // `undefined` means "leave this column alone". Nothing has landed for a domain
  // that is neither complete nor failed, and overwriting a `status` of 1 because
  // a listing was momentarily short is how a captured domain gets captured again.
  const target = {};
  if (complete) {
    target.status        = 1;
    target.capture_error = null;
    target.captured_at   = toMysqlDatetime(state.capturedAt);
  } else if (errorKind) {
    target.status        = -2;
    target.capture_error = String(errorKind).slice(0, 64);
  }

  let badExtract = null;
  if (extract) {
    badExtract = validateExtract(extract);
    if (badExtract) {
      if (log && log.warn) log.warn(`record ${domain}: ignoring extract.json (${badExtract})`);
      target.extract_status = -2;
    } else {
      target.email          = extract.email ? String(extract.email).slice(0, MAX_EMAIL) : null;
      target.extract_status = 1;
      target.extracted_at   = toMysqlDatetime(state.extractedAt) || toMysqlDatetime(new Date());
    }
  } else if (complete) {
    target.extract_status = -2;
  }

  const usableExtract = !!extract && !badExtract;

  // ---- is anything actually different? ------------------------------------
  const columns = Object.entries(target).filter(([, v]) => v !== undefined);
  const changed = rows.some(r => columns.some(([col, want]) => {
    const have = r[col];
    if (want === null) return have !== null;
    return String(have === null || have === undefined ? '' : have) !== String(want);
  }));

  // Links are compared too, or a re-extract that found a new link would be a
  // no-op because every scalar column already matched.
  let linksChanged = false;
  const ids = rows.map(r => r.company_id);
  if (usableExtract) {
    const [have] = await conn.query(
      'SELECT company_id, url, target_domain, kind, region, text FROM links' +
      ` WHERE company_id IN (${ids.map(() => '?').join(',')}) ORDER BY company_id, link_id`,
      ids);
    linksChanged = !_sameLinks(have, ids, extract.links || []);
  }

  if (!changed && !linksChanged) return false;

  // ---- write ---------------------------------------------------------------
  if (usableExtract && linksChanged) {
    await conn.query(
      `DELETE FROM links WHERE company_id IN (${ids.map(() => '?').join(',')})`, ids);

    const values = [];
    const params = [];
    for (const id of ids) {
      for (const l of (extract.links || [])) {
        values.push('(?, ?, ?, ?, ?, ?)');
        params.push(id, l.url, l.target_domain, l.kind, l.region,
          l.text == null ? null : String(l.text).slice(0, 120));
      }
    }
    if (values.length) {
      await conn.query(
        'INSERT INTO links (company_id, url, target_domain, kind, region, text) VALUES ' +
        values.join(', '), params);
    }
  }

  if (columns.length) {
    // `status` last (docs/SCHEMA.md): every other column is in place before the
    // one that says the row is done.
    const ordered = [
      ...columns.filter(([c]) => c !== 'status'),
      ...columns.filter(([c]) => c === 'status'),
    ];
    await conn.query(
      `UPDATE companies SET ${ordered.map(([c]) => c + ' = ?').join(', ')}` +
      '  WHERE city = ? AND domain = ?',
      [...ordered.map(([, v]) => v), city, domain]);
  }

  return true;
}

/** True when the stored links already equal `want`, under every company id. */
function _sameLinks(have, ids, want) {
  if (have.length !== ids.length * want.length) return false;
  const byCompany = new Map(ids.map(id => [String(id), []]));
  for (const row of have) {
    const bucket = byCompany.get(String(row.company_id));
    if (!bucket) return false;
    bucket.push(row);
  }
  for (const id of ids) {
    const rows = byCompany.get(String(id));
    if (rows.length !== want.length) return false;
    for (let i = 0; i < want.length; i++) {
      const a = rows[i];
      const b = want[i];
      const bText = b.text == null ? null : String(b.text).slice(0, 120);
      if (a.url !== b.url || a.target_domain !== b.target_domain ||
          a.kind !== b.kind || a.region !== b.region ||
          (a.text == null ? null : a.text) !== bText) return false;
    }
  }
  return true;
}

module.exports = { recordDomain, validateExtract, toMysqlDatetime };

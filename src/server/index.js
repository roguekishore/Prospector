'use strict';

/**
 * The deck — `node src/cli serve [--port 7777]`.
 *
 * What the operator reads to decide. A lead is a `companies` row at
 * `status = 1`: the two screenshots, what Places knows, what qualify measured,
 * the first email and the outside links extract found — and the operator's own
 * tier, pitch flag and note, which are the only things this writes.
 *
 * **Nothing here computes a judgement.** No score, tier, gate, angle, flaw,
 * signal or agency: not in a column, not in a filter, not in the export. The
 * operator looks at the shots and decides; this server's whole job is to put the
 * evidence in front of them and store the answer.
 *
 * ## 127.0.0.1 only
 *
 * Hard-coded, like control's. Caddy holds the certificate and the `basic_auth`
 * for `leads.themaverick.tech`, and it is the only public listener. A deck bound
 * to 0.0.0.0 would serve every lead, and every decision, to anything that could
 * reach the box's port 7777 directly.
 *
 * ## One page at a time
 *
 * Every list endpoint pages, `limit` capped at 60. At ~530 leads a vertical the
 * whole set would be a megabyte of JSON and a browser laying out 530 screenshots
 * at once; more to the point, a review deck is read one screen at a time, so
 * there is no endpoint that returns them all (R9.6).
 */

const fs   = require('fs');
const path = require('path');

const { companyDir, readCity, DOMAIN_RE } = require('../../lib-keys');
const { db, close } = require('../db/mysql');

const ROOT = path.join(__dirname, '..', '..');

/** `preview/` is a fixed set of files, so it is an allow-list, not a directory walk. */
const STATIC = {
  '':           { file: 'index.html', type: 'text/html; charset=utf-8' },
  'index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  'app.css':    { file: 'app.css',    type: 'text/css; charset=utf-8' },
  'app.js':     { file: 'app.js',     type: 'application/javascript; charset=utf-8' },
};

/** The only two files a screenshot URL may name. */
const SHOTS = new Set(['desktop.webp', 'mobile.webp']);

/**
 * The filter chips, as SQL fragments.
 *
 * A fixed map, looked up by key and never interpolated from the request: this is
 * the one place the deck builds SQL by concatenation, and an unknown key is a
 * 400 rather than an empty fragment, so a typo in the UI fails loudly instead of
 * quietly widening the result set.
 */
const FILTERS = {
  http:       "c.https_status = 'none'",
  expired:    "c.https_status = 'expired'",
  email:      'c.email IS NOT NULL',
  unreviewed: 'c.reviewed_at IS NULL',
  pitch:      'c.pitch = TRUE',
  'tier:A':   "c.tier = 'A'",
  'tier:B':   "c.tier = 'B'",
  'tier:C':   "c.tier = 'C'",
  'tier:X':   "c.tier = 'X'",
};

/** What a card and the detail pane read. No column here is a judgement. */
const ROW_COLUMNS = `
  c.company_id, c.name, c.domain, c.address, c.phone, c.rating, c.review_count,
  c.primary_type, c.https_status, c.cert_expires, c.email,
  c.tier, c.pitch, c.note, c.reviewed_at`;

const MAX_LIMIT = 60;
const MAX_NOTE  = 4000;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** `filter=http,email` → the fragments, or a thrown 400-worthy error. */
function filterClauses(raw) {
  if (!raw) return [];
  const keys = String(raw).split(',').map(k => k.trim()).filter(Boolean);
  const out = [];
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(FILTERS, k)) {
      const err = new Error(`unknown filter: ${k}`);
      err.statusCode = 400;
      throw err;
    }
    out.push(FILTERS[k]);
  }
  return out;
}

/**
 * CSV a spreadsheet will open without reinterpreting anything.
 *
 * BOM so Excel reads it as UTF-8, CRLF because that is what a CSV is, every
 * field quoted, `"` doubled — and a leading `=`, `+`, `-` or `@` prefixed with
 * an apostrophe, because a business called `=cmd` in a spreadsheet is a formula
 * and not a name.
 */
function csv(rows, columns) {
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [columns.map(cell).join(',')];
  for (const r of rows) lines.push(r.map(cell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/**
 * Every route, on a Fastify instance that is not listening yet.
 *
 * Separate from `run` so `scripts/test-deck.js` can drive the real routes with
 * `inject()` — no port, no socket, and no second copy of the routing to drift
 * away from this one.
 */
function build(ctx = {}) {
  const { root = ROOT, log = console } = ctx;

  const city = readCity(root).slug;
  const conn = ctx.conn || db();

  const Fastify = require('fastify');
  const app = Fastify({ logger: false });

  app.addContentTypeParser('application/json', { parseAs: 'string' },
    (req, body, done) => {
      try { done(null, body ? JSON.parse(body) : {}); } catch (e) { done(e); }
    });
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => done(null, {}));

  /** One generic message to the client, the detail to the journal. */
  function fail(reply, err, where) {
    const code = err.statusCode || 500;
    if (code >= 500) log.error(`${where}: ${err.stack || err.message}`);
    return reply.code(code).send({ error: code >= 500 ? 'server error' : err.message });
  }

  // ---- static ------------------------------------------------------------
  function sendStatic(reply, name) {
    const entry = STATIC[name];
    if (!entry) return reply.code(404).send({ error: 'Not found' });
    const buf = fs.readFileSync(path.join(root, 'preview', entry.file));
    reply.header('Content-Type', entry.type);
    return reply.send(buf);
  }

  app.get('/', async (req, reply) => sendStatic(reply, ''));
  app.get('/:file', async (req, reply) => {
    if (req.params.file.startsWith('api')) return reply.code(404).send({ error: 'Not found' });
    return sendStatic(reply, req.params.file);
  });

  // ---- verticals ---------------------------------------------------------
  app.get('/api/verticals', async (req, reply) => {
    try {
      const [rows] = await conn.query(
        'SELECT v.slug, v.label,' +
        '  SUM(c.status = 1) AS leads,' +
        '  SUM(c.domain IS NULL) AS no_website,' +
        '  SUM(c.status = 1 AND c.reviewed_at IS NOT NULL) AS reviewed,' +
        '  SUM(c.pitch = TRUE) AS pitch' +
        '  FROM verticals v' +
        '  LEFT JOIN companies c ON c.vertical_id = v.vertical_id AND c.city = ?' +
        '  GROUP BY v.slug, v.label ORDER BY v.priority, v.slug',
        [city]);
      return reply.send(rows.map(r => ({
        slug: r.slug, label: r.label,
        leads:      Number(r.leads      || 0),
        no_website: Number(r.no_website || 0),
        reviewed:   Number(r.reviewed   || 0),
        pitch:      Number(r.pitch      || 0),
      })));
    } catch (e) { return fail(reply, e, 'GET /api/verticals'); }
  });

  // ---- one page of leads -------------------------------------------------
  app.get('/api/leads', async (req, reply) => {
    try {
      const q      = req.query || {};
      const view   = q.view === 'no-website' ? 'no-website' : 'leads';
      const limit  = clampInt(q.limit, MAX_LIMIT, 1, MAX_LIMIT);
      const offset = clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);

      const where  = ['c.city = ?'];
      const params = [city];

      if (q.vertical) {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(q.vertical)) {
          return reply.code(400).send({ error: 'Invalid vertical' });
        }
        where.push('v.slug = ?');
        params.push(q.vertical);
      }

      // A "no website" row is one Places listed with nothing usable. It never
      // reaches capture, so it has no status of its own to filter on — but the
      // operator still decides about it, which is why it is a view and not a
      // separate table.
      if (view === 'no-website') where.push('c.domain IS NULL');
      else                       where.push('c.status = 1');

      for (const clause of filterClauses(q.filter)) where.push(clause);

      const from = ' FROM companies c JOIN verticals v ON v.vertical_id = c.vertical_id' +
                   ` WHERE ${where.join(' AND ')}`;

      const [[count]] = await conn.query(`SELECT COUNT(*) AS n${from}`, params);
      const [rows] = await conn.query(
        `SELECT ${ROW_COLUMNS}, v.slug AS vertical${from}` +
        '  ORDER BY c.review_count DESC, c.name ASC, c.company_id ASC' +
        '  LIMIT ? OFFSET ?',
        [...params, limit, offset]);

      return reply.send({ total: Number(count.n), rows: rows.map(shape) });
    } catch (e) { return fail(reply, e, 'GET /api/leads'); }
  });

  // ---- one lead ----------------------------------------------------------
  app.get('/api/leads/:id', async (req, reply) => {
    try {
      const id = clampInt(req.params.id, -1, 0, Number.MAX_SAFE_INTEGER);
      if (id < 0) return reply.code(400).send({ error: 'Invalid id' });

      const [rows] = await conn.query(
        `SELECT ${ROW_COLUMNS}, c.website_raw, c.final_url, c.http_status,` +
        '  c.business_status, c.captured_at, c.status, v.slug AS vertical, v.label AS vertical_label' +
        '  FROM companies c JOIN verticals v ON v.vertical_id = c.vertical_id' +
        '  WHERE c.company_id = ? AND c.city = ?',
        [id, city]);
      if (!rows.length) return reply.code(404).send({ error: 'Not found' });

      const [links] = await conn.query(
        'SELECT url, target_domain, kind, region, text FROM links' +
        '  WHERE company_id = ? ORDER BY kind, target_domain, link_id',
        [id]);

      const row = shape(rows[0]);
      row.website_raw     = rows[0].website_raw;
      row.final_url       = rows[0].final_url;
      row.http_status     = rows[0].http_status;
      row.business_status = rows[0].business_status;
      row.captured_at     = rows[0].captured_at;
      row.vertical_label  = rows[0].vertical_label;
      row.links = {
        social: links.filter(l => l.kind === 'social'),
        other:  links.filter(l => l.kind !== 'social'),
      };
      return reply.send(row);
    } catch (e) { return fail(reply, e, 'GET /api/leads/:id'); }
  });

  // ---- the decision ------------------------------------------------------
  app.put('/api/leads/:id/decision', async (req, reply) => {
    try {
      const id = clampInt(req.params.id, -1, 0, Number.MAX_SAFE_INTEGER);
      if (id < 0) return reply.code(400).send({ error: 'Invalid id' });

      const body = req.body || {};
      const tier = body.tier === undefined ? null : body.tier;
      if (tier !== null && !['A', 'B', 'C', 'X'].includes(tier)) {
        return reply.code(400).send({ error: 'tier must be A, B, C, X or null' });
      }
      if (body.pitch !== undefined && typeof body.pitch !== 'boolean') {
        return reply.code(400).send({ error: 'pitch must be a boolean' });
      }
      const note = body.note === undefined || body.note === null ? null : String(body.note);
      if (note !== null && note.length > MAX_NOTE) {
        return reply.code(400).send({ error: `note must be at most ${MAX_NOTE} characters` });
      }
      const pitch = !!body.pitch;

      // `reviewed_at` is derived, never sent: it says the operator has looked,
      // and a row whose tier and pitch have both been cleared has effectively
      // not been.
      const reviewed = (tier !== null || pitch) ? new Date() : null;

      const [res] = await conn.query(
        'UPDATE companies SET tier = ?, pitch = ?, note = ?, reviewed_at = ?' +
        '  WHERE company_id = ? AND city = ?',
        [tier, pitch, note, reviewed, id, city]);

      // `affectedRows` counts matched rows even when nothing changed, so a
      // repeat of the same decision is a 204 and an unknown id is a 404.
      if (!res.affectedRows) return reply.code(404).send({ error: 'Not found' });
      return reply.code(204).send();
    } catch (e) { return fail(reply, e, 'PUT /api/leads/:id/decision'); }
  });

  // ---- the pitch list ----------------------------------------------------
  app.get('/api/export/pitch.csv', async (req, reply) => {
    try {
      const [rows] = await conn.query(
        'SELECT c.name, v.slug AS vertical, c.domain, c.phone, c.email, c.address,' +
        '  c.rating, c.review_count, c.tier, c.note' +
        '  FROM companies c JOIN verticals v ON v.vertical_id = c.vertical_id' +
        '  WHERE c.city = ? AND c.pitch = TRUE' +
        '  ORDER BY v.priority, c.review_count DESC, c.name ASC',
        [city]);

      const body = csv(
        rows.map(r => [r.name, r.vertical, r.domain, r.phone, r.email, r.address,
                       r.rating, r.review_count, r.tier, r.note]),
        ['name', 'vertical', 'domain', 'phone', 'email', 'address',
         'rating', 'review_count', 'tier', 'note']);

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', 'attachment; filename="pitch.csv"');
      return reply.send(body);
    } catch (e) { return fail(reply, e, 'GET /api/export/pitch.csv'); }
  });

  // ---- screenshots -------------------------------------------------------
  app.get('/shots/:domain/:file', async (req, reply) => {
    const { domain, file } = req.params;
    // Both validated before either touches a path: `companyDir` would throw on a
    // bad domain anyway, but a 400 here is the difference between a rejected
    // request and a 500 with a stack trace in it.
    if (!DOMAIN_RE.test(domain)) return reply.code(400).send({ error: 'Invalid domain' });
    if (!SHOTS.has(file))        return reply.code(400).send({ error: 'Invalid file' });

    let filePath;
    try { filePath = path.join(companyDir(root, city, domain), file); }
    catch { return reply.code(400).send({ error: 'Invalid domain' }); }

    let buf;
    try { buf = fs.readFileSync(filePath); }
    catch { return reply.code(404).send({ error: 'Not found' }); }

    reply.header('Content-Type', 'image/webp');
    // A capture is written once and never rewritten, so the only way this goes
    // stale is a re-capture, which changes nothing the browser can see anyway.
    reply.header('Cache-Control', 'private, max-age=604800');
    return reply.send(buf);
  });

  return app;
}

async function run(argv, ctx) {
  const { log = console } = ctx || {};
  const args = _parseArgs(argv);
  const port = args.port ? Number(args.port) : 7777;

  const app = build(ctx);
  await app.listen({ port, host: '127.0.0.1' });
  log.info(`deck → http://127.0.0.1:${port}`);
  log.info('bound to loopback; Caddy holds the certificate and the password');

  // The CLI calls process.exit(0) the moment a stage resolves, so a server stage
  // must never return. Same contract src/control/index.js follows.
  return new Promise(() => {});
}

/** The wire shape of one row: booleans as booleans, no column the deck cannot show. */
function shape(r) {
  return {
    company_id:   Number(r.company_id),
    name:         r.name,
    domain:       r.domain,
    vertical:     r.vertical,
    address:      r.address,
    phone:        r.phone,
    rating:       r.rating === null ? null : Number(r.rating),
    review_count: r.review_count === null ? null : Number(r.review_count),
    primary_type: r.primary_type,
    https_status: r.https_status,
    cert_expires: r.cert_expires,
    email:        r.email,
    tier:         r.tier,
    pitch:        !!r.pitch,
    note:         r.note,
    reviewed_at:  r.reviewed_at,
  };
}

function _parseArgs(argv) {
  const out = { _: [] };
  const arr = (argv || []).slice();
  while (arr.length) {
    const a = arr.shift();
    if (a.startsWith('--')) {
      out[a.slice(2)] = arr.length && !arr[0].startsWith('--') ? arr.shift() : true;
    } else out._.push(a);
  }
  return out;
}

module.exports = { run, build, csv, FILTERS, close };

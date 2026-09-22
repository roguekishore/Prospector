/* src/server/index.js
   Fastify server on 127.0.0.1:7777 only.
   Serves preview/ and data/ statically + 5 JSON endpoints.
   No @fastify/static dependency — uses built-in fs streams.
   W3 §10. */
'use strict';

const path = require('path');
const fs   = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
// Compressed captures live in a parallel tree until they are swapped into
// data/ — /data/* falls back to here so one URL shape covers both layouts.
const DATA_WEBP = path.join(ROOT, 'data-webp');

const DOMAIN_RE = /^[a-z0-9][a-z0-9.\-]*[a-z0-9]$/i;

// Simple MIME map (enough for preview/ assets)
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
};

function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

function sendFile(reply, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return reply.code(404).send({ error: 'Not found' });
  }
  const buf = fs.readFileSync(filePath);
  reply.header('Content-Type', mimeFor(filePath));
  reply.header('Content-Length', buf.length);
  return reply.send(buf);
}

async function run(argv, ctx) {
  const { log = console } = ctx;
  const port = argv['port'] ? +argv['port'] : 7777;

  const Fastify = require('fastify');
  const { open: openDb } = require('../db/index.js');
  const { regeneratePitchCsv } = require('../report/index.js');

  const app = Fastify({ logger: false });

  // Parse JSON bodies (built-in to Fastify)
  app.addContentTypeParser('application/json', { parseAs: 'string' },
    (req, body, done) => {
      try { done(null, JSON.parse(body)); }
      catch (e) { done(e); }
    });

  // Accept POST requests with no body (Content-Type may be absent)
  app.addContentTypeParser('*', { parseAs: 'buffer' },
    (req, body, done) => { done(null, body); });

  // ---- GET /api/index.json ----
  app.get('/api/index.json', async (req, reply) => {
    const p = path.join(DATA, 'index.json');
    if (!fs.existsSync(p)) return reply.code(404).send({ error: 'Not found' });
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Type', 'application/json; charset=utf-8');
    return reply.send(fs.readFileSync(p, 'utf8'));
  });

  // ---- GET /api/reviews ----
  app.get('/api/reviews', async (req, reply) => {
    try {
      const db   = openDb();
      const rows = db.prepare('SELECT domain, human_tier, pitch, note FROM reviews').all();
      const out  = {};
      for (const r of rows) {
        out[r.domain] = {
          human_tier: r.human_tier,
          pitch:      !!r.pitch,
          note:       r.note,
        };
      }
      return reply.send(out);
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ---- PUT /api/review/:domain ----
  app.put('/api/review/:domain', async (req, reply) => {
    const { domain } = req.params;

    // Validate domain — used only as SQL param, never joined to filesystem path
    if (!DOMAIN_RE.test(domain)) {
      return reply.code(400).send({ error: 'Invalid domain' });
    }

    const body = req.body || {};
    const { human_tier, pitch, note } = body;

    // Validate values
    if (human_tier !== undefined && human_tier !== null &&
        !['A','B','C','X'].includes(human_tier)) {
      return reply.code(400).send({ error: 'human_tier must be A|B|C|X|null' });
    }
    if (pitch !== undefined && typeof pitch !== 'boolean') {
      return reply.code(400).send({ error: 'pitch must be boolean' });
    }

    try {
      const db = openDb();

      // Verify domain exists (check scores or businesses table)
      const biz  = db.prepare('SELECT domain FROM businesses WHERE domain = ?').get(domain);
      const sc   = biz ? null : db.prepare('SELECT domain FROM scores WHERE domain = ?').get(domain);
      if (!biz && !sc) {
        // Fall back to checking JSON files on disk
        const found = checkDomainExists(domain);
        if (!found) return reply.code(404).send({ error: 'Unknown domain' });
      }

      db.prepare(`
        INSERT INTO reviews (domain, human_tier, pitch, note, reviewed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(domain) DO UPDATE SET
          human_tier  = excluded.human_tier,
          pitch       = excluded.pitch,
          note        = excluded.note,
          reviewed_at = excluded.reviewed_at
      `).run(
        domain,
        human_tier !== undefined ? human_tier : null,
        pitch ? 1 : 0,
        note || null,
        new Date().toISOString(),
      );

      return reply.code(204).send();
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ---- POST /api/export/pitch ----
  app.post('/api/export/pitch', async (req, reply) => {
    try {
      const result = regeneratePitchCsv();
      return reply.send(result);
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ---- GET /data/* — static captures and JSON ----
  // Resolved against data/ first, then data-webp/, so a compressed capture is
  // reachable at the same URL whether or not it has been swapped into data/.
  app.get('/data/*', async (req, reply) => {
    const reqPath = req.params['*'];
    const candidates = [];
    for (const base of [DATA, DATA_WEBP]) {
      // Security: reject any path that tries to escape the base directory
      const resolved = path.resolve(base, reqPath);
      if (!resolved.startsWith(base + path.sep) && resolved !== base) {
        return reply.code(403).send({ error: 'Forbidden' });
      }
      candidates.push(resolved);
    }
    for (const p of candidates) {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return sendFile(reply, p);
    }
    // Nothing matched — let sendFile produce the usual 404 against data/.
    return sendFile(reply, candidates[0]);
  });

  // ---- GET /* — serve preview/ statically ----
  app.get('/', async (req, reply) => {
    return sendFile(reply, path.join(ROOT, 'preview', 'index.html'));
  });

  app.get('/*', async (req, reply) => {
    const reqPath = req.params['*'];
    // Only serve from preview/ — never allow path traversal
    const resolved = path.resolve(path.join(ROOT, 'preview'), reqPath);
    const previewBase = path.join(ROOT, 'preview') + path.sep;
    if (!resolved.startsWith(previewBase)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    return sendFile(reply, resolved);
  });

  await app.listen({ port, host: '127.0.0.1' });
  log.info(`server: http://127.0.0.1:${port}`);

  // Keep running
  return new Promise(() => {});
}

// Check if a domain folder exists under data/ — used as fallback when DB unavailable
function checkDomainExists(domain) {
  const configVerticals = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'config', 'verticals.json'), 'utf8'));
  for (const v of configVerticals) {
    const p = path.join(DATA, v.slug, domain, 'score.json');
    if (fs.existsSync(p)) return true;
  }
  return false;
}

module.exports = { run };

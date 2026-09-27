'use strict';

/**
 * Serve one built front end — `web/dist/lead/` for the deck, `web/dist/prospect/`
 * for control — from a directory, safely.
 *
 * Both servers used to serve a fixed allow-list of three files. A Vite build has
 * content-hashed names (`assets/index-CQM6mq8d.js`) that change on every build,
 * so the allow-list is now the directory itself, and the safety moves from "is
 * the name on the list" to "does the resolved path stay inside the directory".
 *
 * Rules, all of which `scripts/test-deck.js` asserts:
 *
 * - Nothing outside the directory is reachable. The request path is decoded,
 *   normalised, checked for `..` and NUL, resolved against the directory, and
 *   then `realpath`ed so a symlink planted inside the build cannot point out.
 * - Only files whose extension has a known `Content-Type` are served; anything
 *   else is a 404, never `application/octet-stream`.
 * - `assets/*` is `Cache-Control: public, max-age=31536000, immutable`, because
 *   the hash in the name is the cache key. Everything else — `index.html`, the
 *   favicon — is `no-cache`, so a new release is picked up on the next load.
 * - `/` and a trailing slash serve `index.html`. There is no history-routing
 *   fallback: both apps use hash routes, so an unknown path is a 404.
 * - `GET` and `HEAD` only.
 *
 * No dependency: `@fastify/static` would land in the root `dependencies` and so
 * in the Lambda image, for a job that is forty lines.
 */

const fs   = require('fs');
const path = require('path');

const TYPES = {
  '.html':        'text/html; charset=utf-8',
  '.js':          'text/javascript; charset=utf-8',
  '.mjs':         'text/javascript; charset=utf-8',
  '.css':         'text/css; charset=utf-8',
  '.json':        'application/json; charset=utf-8',
  '.map':         'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt':         'text/plain; charset=utf-8',
  '.svg':         'image/svg+xml',
  '.png':         'image/png',
  '.webp':        'image/webp',
  '.ico':         'image/x-icon',
  '.woff2':       'font/woff2',
  '.woff':        'font/woff',
};

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE  = 'no-cache';

/**
 * A resolver for one directory.
 *
 * @param {string} dir  absolute path of the build output
 * @returns {{ dir: string, resolve(urlPath: string): null | { file: string, type: string, cache: string, size: number } }}
 */
function staticDir(dir) {
  const root = path.resolve(dir);

  function resolve(urlPath) {
    let decoded;
    try { decoded = decodeURIComponent(String(urlPath).split('?')[0]); }
    catch { return null; }                                  // malformed %xx
    if (decoded.includes('\0') || decoded.includes('\\')) return null;

    // `posix.normalize` collapses `a/../b`; whatever `..` survives it is trying
    // to leave the directory and is refused outright rather than clamped.
    let rel = path.posix.normalize('/' + decoded).slice(1);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    if (rel.split('/').some(seg => seg === '..' || seg === '')) return null;

    const ext = path.extname(rel).toLowerCase();
    const type = TYPES[ext];
    if (!type) return null;

    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;

    let real, realRoot, stat;
    try {
      real     = fs.realpathSync(abs);
      realRoot = fs.realpathSync(root);
      stat     = fs.statSync(real);
    } catch { return null; }                                // missing, or unreadable
    if (!stat.isFile()) return null;
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;

    return {
      file:  real,
      type,
      cache: rel.startsWith('assets/') ? IMMUTABLE : NO_CACHE,
      size:  stat.size,
    };
  }

  return { dir: root, resolve };
}

/**
 * Mount the directory on a Fastify app as `GET /` and `GET /*`.
 *
 * `reserved` prefixes (`/api/`, `/shots/`) are answered with a JSON 404 here so
 * a typo in an API path never falls through to a file lookup, and never to
 * `index.html`.
 *
 * A missing `index.html` is a 503 with a one-line explanation rather than a
 * 404: it means `npm run build:web` has not been run, and "Not found" would send
 * whoever is reading the log to the wrong place.
 */
function mount(app, dir, { reserved = ['/api/', '/shots/'] } = {}) {
  const site = staticDir(dir);

  async function handler(req, reply) {
    const urlPath = req.raw.url.split('?')[0];
    if (reserved.some(p => urlPath === p.slice(0, -1) || urlPath.startsWith(p))) {
      return reply.code(404).send({ error: 'Not found' });
    }
    const hit = site.resolve(urlPath);
    if (!hit) {
      if (urlPath === '/' && !fs.existsSync(path.join(site.dir, 'index.html'))) {
        reply.header('Content-Type', 'text/html; charset=utf-8');
        reply.header('Cache-Control', NO_CACHE);
        return reply.code(503).send(
          '<!doctype html><meta charset="utf-8"><title>Not built</title>' +
          '<p style="font:14px system-ui;margin:2em">The front end has not been built. ' +
          'Run <code>npm run build:web</code> and reload.</p>');
      }
      return reply.code(404).send({ error: 'Not found' });
    }
    reply.header('Content-Type', hit.type);
    reply.header('Cache-Control', hit.cache);
    reply.header('Content-Length', String(hit.size));
    if (req.method === 'HEAD') return reply.send();
    return reply.send(fs.createReadStream(hit.file));
  }

  app.route({ method: ['GET', 'HEAD'], url: '/',  handler });
  app.route({ method: ['GET', 'HEAD'], url: '/*', handler });
  return site;
}

module.exports = { staticDir, mount, TYPES, IMMUTABLE, NO_CACHE };

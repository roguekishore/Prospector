'use strict';

/**
 * Control — capture progress and run control, in a browser.
 *
 *     node src/cli control [--port 7778]
 *
 * Two execution modes, one view:
 *
 * * **local** — `cli capture` on this box. Slow (2 vCPU, concurrency 1-2) but free
 *   and unattended: start it at night, read it in the morning.
 * * **lambda** — `scripts/dispatch.js` fans batches out. Fast, bounded by the
 *   account's concurrency limit, and costs free-tier GB-s.
 *
 * Progress comes from disk in both modes, not from the runner: a Lambda capture
 * lands in S3 and only appears locally once synced, so the dashboard reports what
 * is actually on this box either way. That is the honest number for the deck,
 * which serves from the same disk.
 *
 * Live updates are Server-Sent Events, not websockets. The traffic is one-way
 * (server to page), SSE needs no dependency and reconnects by itself, and Fastify
 * exposes the raw socket which is all it takes.
 */

const fs   = require('fs');
const path = require('path');

const { allStatus } = require('./status');
const { Runner }    = require('./runner');
const verticals     = require('./verticals');

const STATUS_PUSH_MS = 3_000;

/**
 * Shared-secret gate.
 *
 * This server starts runs, spends Places quota and edits `config/`. Reachable
 * from a phone means reachable from the internet if the box has a public IP, so
 * it does not run unauthenticated: set `CONTROL_TOKEN` or it binds to loopback
 * only and says so.
 *
 * A shared token is the floor, not the ceiling. Put Caddy in front with
 * `basicauth` and TLS before this answers on a public address — see
 * `docs/ARCHITECTURE.md` ("Two hostnames, one Caddy").
 */
const TOKEN = process.env.CONTROL_TOKEN || null;

function authorised(req) {
  if (!TOKEN) return true;                       // loopback-only mode
  const header = req.headers['authorization'] || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const given  = bearer || req.headers['x-control-token'] || (req.query && req.query.token);
  return typeof given === 'string' && given.length === TOKEN.length && given === TOKEN;
}

/** A slug is a directory name under data/ — never let one reach the filesystem unchecked. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function _int(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** The CLI hands each stage the raw argv array; every stage parses its own. */
function _flags(argv) {
  const out = {};
  const arr = (argv || []).slice();
  while (arr.length) {
    const a = arr.shift();
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    out[key] = arr.length && !arr[0].startsWith('--') ? arr.shift() : true;
  }
  return out;
}

async function run(argv, ctx) {
  const { root, log } = ctx;
  const flags = _flags(argv);
  const port = flags.port ? Number(flags.port) : 7778;

  const Fastify = require('fastify');
  const app = Fastify({ logger: false });

  app.addContentTypeParser('application/json', { parseAs: 'string' },
    (req, body, done) => {
      try { done(null, body ? JSON.parse(body) : {}); } catch (e) { done(e); }
    });
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => done(null, {}));

  const runner  = new Runner(root);
  const clients = new Set();

  // Every route but the page itself is gated. The page is public so a phone can
  // load it and prompt for the token; it renders nothing without one.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/' || req.url.startsWith('/?')) return;
    if (authorised(req)) return;
    return reply.code(401).send({ error: 'Unauthorized' });
  });

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
  }

  runner.on('line', entry => broadcast('line', entry));
  runner.on('start', state => broadcast('run', { running: true, state }));
  runner.on('exit',  exit  => {
    broadcast('run', { running: false, lastExit: exit });
    // Disk has just changed; do not make the page wait for its next tick.
    broadcast('status', allStatus(root));
  });

  // Status is pushed on a timer rather than computed per client: one filesystem
  // walk serves every open tab, and an idle dashboard costs one walk every 3s.
  const timer = setInterval(() => {
    if (clients.size) broadcast('status', allStatus(root));
  }, STATUS_PUSH_MS);
  timer.unref();

  // ---- UI ----
  app.get('/', async (req, reply) => {
    const html = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return reply.send(html);
  });

  // ---- status ----
  app.get('/api/status', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.send(allStatus(root));
  });

  app.get('/api/run', async (req, reply) => reply.send(runner.snapshot()));

  // ---- live stream ----
  app.get('/api/events', (req, reply) => {
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      // Node buffers small writes; an event stream that arrives in 8 KB chunks
      // looks like a hung run for the first few minutes.
      'X-Accel-Buffering': 'no',
    });
    clients.add(res);

    res.write(`event: status\ndata: ${JSON.stringify(allStatus(root))}\n\n`);
    res.write(`event: snapshot\ndata: ${JSON.stringify(runner.snapshot())}\n\n`);

    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 25_000);
    ping.unref();

    req.raw.on('close', () => { clearInterval(ping); clients.delete(res); });
  });

  // ---- start a run ----
  app.post('/api/run/start', async (req, reply) => {
    const body = req.body || {};
    const mode = body.mode === 'lambda' ? 'lambda' : 'local';

    let slug = body.vertical || null;
    if (slug !== null) {
      if (!SLUG_RE.test(slug)) return reply.code(400).send({ error: 'Invalid vertical' });
      if (!fs.existsSync(path.join(root, 'data', slug))) {
        return reply.code(404).send({ error: `No such vertical: ${slug}` });
      }
    }

    try {
      let started;
      if (mode === 'local') {
        const concurrency = _int(body.concurrency, 2, 1, 16);
        const deadline    = _int(body.deadline, 60_000, 10_000, 600_000);
        const argv = [
          'capture',
          ...(slug ? [slug] : []),
          '--resume',
          '--concurrency', String(concurrency),
          '--deadline', String(deadline),
        ];
        started = runner.start({
          mode, argv, script: path.join('src', 'cli', 'index.js'),
          label: `local capture · ${slug || 'all verticals'} · concurrency ${concurrency}`,
        });
      } else {
        const batch = _int(body.batch, 10, 1, 15);
        const argv = [
          ...(slug ? [slug] : []),
          '--batch', String(batch),
          ...(body.dryRun ? ['--dry-run'] : []),
        ];
        started = runner.start({
          mode, argv, script: path.join('scripts', 'dispatch.js'),
          label: `lambda dispatch · ${slug || 'all verticals'} · batch ${batch}` +
                 (body.dryRun ? ' · dry run' : ''),
        });
      }
      return reply.send({ ok: true, state: started });
    } catch (err) {
      return reply.code(409).send({ error: err.message });
    }
  });

  // ---- verticals ----
  app.get('/api/verticals', async (req, reply) => {
    const list = verticals.readAll(root).map(v => ({
      slug: v.slug, label: v.label, enabled: v.enabled !== false,
      priority: v.priority, keywords: v.keywords || [],
      estimate: verticals.estimateRequests((v.keywords || []).length),
    }));
    return reply.send(list);
  });

  app.post('/api/verticals', async (req, reply) => {
    try {
      const entry = verticals.add(root, req.body || {});
      broadcast('verticals', { added: entry.slug });
      return reply.send({
        ok: true, vertical: entry,
        estimate: verticals.estimateRequests(entry.keywords.length),
      });
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ---- full pipeline for one vertical ----
  // discover -> qualify -> capture, run back to back. This is the only path that
  // spends Places quota, so it takes an explicit vertical and never an "all".
  app.post('/api/pipeline/start', async (req, reply) => {
    const body = req.body || {};
    const slug = body.vertical;
    if (!slug || !SLUG_RE.test(slug)) {
      return reply.code(400).send({ error: 'A valid vertical is required' });
    }

    const known = verticals.readAll(root).find(v => v.slug === slug);
    if (!known) return reply.code(404).send({ error: `No such vertical: ${slug}` });

    const cli    = path.join('src', 'cli', 'index.js');
    const mode   = body.captureMode === 'lambda' ? 'lambda'
                 : body.captureMode === 'none'   ? 'none'
                 : 'local';
    const conc   = _int(body.concurrency, 2, 1, 16);
    const batch  = _int(body.batch, 10, 1, 15);

    const steps = [
      { script: cli, label: 'discover', argv: ['discover', slug, '--source', 'places-new'] },
      { script: cli, label: 'qualify',  argv: ['qualify', slug] },
      // 'none' skips capture entirely — box-discover-qualify R6.1, for running
      // discover + qualify alone while the capture Lambda is still just staged.
      mode === 'none'
        ? { script: path.join('scripts', 'backup-places.js'), label: 'backup', argv: [slug] }
        : mode === 'lambda'
        ? { script: path.join('scripts', 'dispatch.js'), label: 'dispatch to lambda',
            argv: [slug, '--batch', String(batch)] }
        : { script: cli, label: 'capture',
            argv: ['capture', slug, '--resume', '--concurrency', String(conc)] },
    ];

    try {
      const started = runner.startSequence(steps,
        `pipeline · ${slug} · ${mode} capture`);
      return reply.send({ ok: true, state: started });
    } catch (err) {
      return reply.code(409).send({ error: err.message });
    }
  });

  app.post('/api/run/stop', async (req, reply) => {
    const stopped = runner.stop();
    return reply.send({ ok: stopped, message: stopped ? 'stopping' : 'nothing running' });
  });

  // No token means no remote access. Binding 0.0.0.0 unauthenticated would expose
  // run control and Places spend to anything that can reach the box.
  const host = TOKEN ? '0.0.0.0' : '127.0.0.1';
  await app.listen({ port, host });

  log.info(`control  → http://localhost:${port}`);
  if (TOKEN) {
    log.info(`reachable on the network; append ?token=… (CONTROL_TOKEN is set)`);
  } else {
    log.warn('CONTROL_TOKEN is not set — bound to 127.0.0.1 only, no phone access');
  }
  log.info('progress is read from disk; a lambda run only shows here once S3 is synced');

  // The CLI calls process.exit(0) the moment a stage resolves, so a server stage
  // must never return. Same contract src/server/index.js follows.
  return new Promise(() => {});
}

module.exports = { run };

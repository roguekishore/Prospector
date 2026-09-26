'use strict';

/**
 * `node src/cli ingest [<vertical>] [--with-html]` — S3 into MySQL and onto disk.
 *
 * The Lambda captures into `s3://<bucket>/<city>/companies/<domain>/` and reports
 * nothing back (async invoke). This is what closes that loop: it lists the
 * bucket, pulls down what the deck needs, and records the outcome on every
 * `companies` row that shares the domain.
 *
 * Never part of `all` (R7.1). `all` is discover → qualify → capture, and a local
 * capture records itself; ingest exists for the Lambda path, where the bytes
 * arrive somewhere else.
 *
 * ## One listing, not a HEAD per domain
 *
 * `ListObjectsV2` over `<city>/companies/`, paginated, no delimiter: about five
 * keys per domain, so ~50 requests for 9,600 domains. The alternative — a HEAD
 * per completion file per pending domain — is 30,000 requests to learn the same
 * thing, and it asks the bucket a question the listing already answered.
 *
 * ## Crash safety
 *
 * Every file is renamed into place before the transaction opens, and `complete`
 * requires both screenshots to be on local disk as well as in the listing. A
 * crash before the commit leaves the row exactly as it was and the next run
 * redoes the domain; a crash after it leaves a row at `status = 1` whose
 * screenshots the deck can actually serve (R7.5).
 */

const fs   = require('fs');
const path = require('path');

const { companyDir, canonicalDomain, readCity } = require('../../lib-keys');
const { COMPLETION } = require('../capture/s3');

/** What ingest pulls down. `rendered.html` only with `--with-html` (R7.3). */
const WANTED      = ['desktop.webp', 'mobile.webp', 'extract.json', 'error.json'];
const SCREENSHOTS = ['desktop.webp', 'mobile.webp'];

/** Eight at a time: small objects, and the box has two vCPUs. */
const CONCURRENCY = 8;

/**
 * Every key under `<city>/companies/`, grouped by domain.
 *
 * @returns {Promise<Map<string, Map<string, {LastModified: Date, Size: number}>>>}
 */
async function listCompanies(s3, bucket, city, log) {
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const prefix = `${city}/companies/`;
  const byDomain = new Map();

  let token;
  let requests = 0;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    requests++;
    for (const obj of (res.Contents || [])) {
      const rest = obj.Key.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) continue;                       // a key directly under companies/
      const domain = rest.slice(0, slash);
      const name   = rest.slice(slash + 1);
      if (!name || name.includes('/')) continue;      // the folder is flat by contract
      if (!byDomain.has(domain)) byDomain.set(domain, new Map());
      byDomain.get(domain).set(name, { LastModified: obj.LastModified, Size: obj.Size });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  log.info(`ingest: listed ${byDomain.size} domain(s) in ${requests} request(s)`);
  return byDomain;
}

/**
 * Download one object unless the local copy already matches.
 *
 * "Matches" is size plus an mtime not older than S3's — the mtime is set to
 * `LastModified` after every write here, so an unchanged object is skipped on
 * every later run and a replaced one is not.
 *
 * @returns {Promise<boolean>} whether bytes were written
 */
async function downloadIfStale(s3, bucket, key, dest, meta) {
  try {
    const st = fs.statSync(dest);
    if (st.size === meta.Size && meta.LastModified &&
        st.mtime.getTime() >= new Date(meta.LastModified).getTime()) {
      return false;
    }
  } catch { /* not on disk */ }

  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const res  = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await toBuffer(res.Body);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, dest);
  if (meta.LastModified) {
    const when = new Date(meta.LastModified);
    try { fs.utimesSync(dest, when, when); } catch { /* not fatal */ }
  }
  return true;
}

async function toBuffer(stream) {
  if (Buffer.isBuffer(stream)) return stream;
  if (stream && typeof stream.transformToByteArray === 'function') {
    return Buffer.from(await stream.transformToByteArray());
  }
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function flags(argv) {
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

/**
 * @param {string[]} argv
 * @param {object} ctx  { root, config, log }
 * @param {object} [deps]  { s3 } — the tests hand in a stub client
 */
async function run(argv, ctx, deps = {}) {
  const { db, tx } = require('../db/mysql');
  const { recordDomain } = require('../db/record');

  const { root, log } = ctx;
  const args     = flags(argv);
  const vertical = args._[0] || null;
  const withHtml = !!args['with-html'];

  const bucket = process.env.CAPTURE_BUCKET;
  if (!bucket) throw new Error('CAPTURE_BUCKET is not set');
  const city = readCity(root).slug;

  let s3 = deps.s3;
  if (!s3) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
  }

  const conn = db();
  let verticalId = null;
  if (vertical) {
    const [rows] = await conn.query('SELECT vertical_id FROM verticals WHERE slug = ?', [vertical]);
    if (!rows.length) throw new Error(`No such vertical: ${vertical}`);
    verticalId = rows[0].vertical_id;
  }

  const listing = await listCompanies(s3, bucket, city, log);

  const [work] = await conn.query(
    'SELECT DISTINCT domain FROM companies' +
    '  WHERE city = ? AND domain IS NOT NULL' +
    '    AND (status IN (0, -2) OR (status = 1 AND extract_status = -2))' +
    (verticalId === null ? '' : ' AND vertical_id = ?'),
    verticalId === null ? [city] : [city, verticalId]);

  const todo = [];
  for (const row of work) {
    let domain;
    try { domain = canonicalDomain(row.domain); } catch { continue; }
    if (listing.has(domain)) todo.push(domain);
  }

  log.info(`ingest: ${work.length} domain(s) in the work set, ${todo.length} of them in S3`);

  const names = withHtml ? [...WANTED, 'rendered.html'] : WANTED;

  let downloaded = 0, changed = 0, unchanged = 0, failed = 0;
  let i = 0;

  async function worker() {
    while (i < todo.length) {
      const domain = todo[i++];
      const keys   = listing.get(domain);
      const dir    = companyDir(root, city, domain);

      try {
        for (const name of names) {
          const meta = keys.get(name);
          if (!meta) continue;
          const key = `${city}/companies/${domain}/${name}`;
          if (await downloadIfStale(s3, bucket, key, path.join(dir, name), meta)) downloaded++;
        }

        // Complete means complete in the bucket *and* both shots on this disk:
        // the deck serves the shots off disk, so a row at `status = 1` whose
        // screenshots are not here is a broken card.
        const inBucket = COMPLETION.every(n => keys.has(n));
        const onDisk   = SCREENSHOTS.every(n => fs.existsSync(path.join(dir, n)));
        const complete = inBucket && onDisk;

        const err     = keys.has('error.json') ? readJson(path.join(dir, 'error.json')) : null;
        const extract = keys.has('extract.json') ? readJson(path.join(dir, 'extract.json')) : null;
        const rendered = keys.get('rendered.html');

        const wrote = await tx(c => recordDomain(c, {
          city, domain,
          complete,
          errorKind:   complete ? null : (err && err.kind ? err.kind : null),
          capturedAt:  rendered ? rendered.LastModified : null,
          extract,
          extractedAt: keys.get('extract.json')?.LastModified || null,
        }, log));

        if (wrote) changed++; else unchanged++;
        log.info(`ingest ${domain}: ${complete ? 'captured' : (err ? 'failed' : 'incomplete')}` +
                 `${extract ? ' + extract' : ''}${wrote ? '' : ' (no change)'}`);
      } catch (e) {
        failed++;
        log.error(`ingest ${domain}: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  log.info(`ingest: listed ${listing.size}, in work set ${todo.length}, ` +
           `downloaded ${downloaded} file(s), changed ${changed}, unchanged ${unchanged}, failed ${failed}`);

  return { ok: changed + unchanged, err: failed };
}

/** The CLI closes nothing for us; a stage that leaves the pool open hangs. */
async function runAndClose(argv, ctx) {
  try { return await run(argv, ctx); }
  finally { await require('../db/mysql').close(); }
}

module.exports = { run: runAndClose, _run: run, listCompanies };

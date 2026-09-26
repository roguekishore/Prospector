/* src/capture/extract/index.js
   Part of the capture stage, not a stage of its own.
   Reads <company>/rendered.html → writes <company>/extract.json.

   `capture` runs `extractDir` in the same worker slot right after the shots land,
   and the Lambda runs it in the same container. `capture --extract-only` calls
   `reextract` to re-read rendered.html for domains whose extract failed, after a
   bug fix. Nothing here loads a page or spends a request. */
'use strict';

const fs      = require('fs');
const path    = require('path');
const cheerio = require('cheerio');

const { extractLinks } = require('./links.js');
const { firstEmail }   = require('./email.js');
const { isComplete }   = require('../capture-domain.js');
const { companyDir, canonicalDomain, readCity } = require('../../../lib-keys');

const ROOT = path.join(__dirname, '..', '..', '..');

// `src/capture/lambda.js` requires this module for `extractDir` alone, inside a
// container that has no database and no reason to pay for mysql2 at cold start.
// The database is therefore required where `reextract` runs, not at load.

/**
 * Read `<dir>/rendered.html`, write `<dir>/extract.json`. No network.
 *
 * Deterministic by construction: the output carries no run id and no timestamp,
 * so two runs over the same `rendered.html` produce byte-identical files and a
 * re-extract after a fix can be diffed against the old one.
 *
 * Synchronous. Once the dead-link probe is gone there is nothing to await, and a
 * synchronous call is what lets the Lambda run it inside the per-domain
 * try/catch without a second await point.
 *
 * @param {{ dir: string, domain: string, finalUrl?: string }} opts
 * @returns {{ domain: string, email: ?string, links: object[] }} the object written
 * @throws if `rendered.html` is missing or empty — the caller decides what that means
 */
function extractDir({ dir, domain, finalUrl }) {
  const htmlPath = path.join(dir, 'rendered.html');
  let html;
  try { html = fs.readFileSync(htmlPath, 'utf8'); }
  catch { throw new Error(`rendered.html missing: ${htmlPath}`); }
  if (!html.trim()) throw new Error(`rendered.html is empty: ${htmlPath}`);

  const base = finalUrl || `https://${domain}/`;
  const $ = cheerio.load(html);

  // Key order is part of the contract (docs/SCHEMA.md "extract.json"): ingest
  // reads it as a straight copy, and a stable order keeps the file diffable.
  const doc = {
    domain,
    email: firstEmail($),
    links: extractLinks($, base, domain),
  };

  const dest = path.join(dir, 'extract.json');
  const tmp  = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, dest);

  return doc;
}

// ---------------------------------------------------------------------------
// capture --extract-only — re-run extract over captures that are already done
// ---------------------------------------------------------------------------

/**
 * node src/cli capture --extract-only [<vertical>] [--only <domain>] [--dry-run]
 *
 * `args` is capture's already-parsed argv; capture closes the pool.
 *
 * The work list is `status = 1 AND extract_status = -2`: captured, and extract
 * either never ran or produced something unusable. When `rendered.html` is not on
 * this machine — the usual case, since the Lambda captured it — it is downloaded
 * from S3 first, and the fresh `extract.json` is uploaded back so the next
 * `ingest` sees it.
 */
async function reextract(args, ctx) {
  const { db, tx } = require('../../db/mysql');
  const { recordDomain } = require('../../db/record');

  const { root = ROOT, log = console } = ctx || {};
  const onlyDomain = args.only || null;
  const dryRun     = !!args['dry-run'];
  const vertical   = args._[0] || null;
  if (args.resume) log.warn('--resume is gone: the work list is extract_status = -2');

  const city   = readCity(root).slug;
  const bucket = process.env.CAPTURE_BUCKET || null;
  const conn   = db();

  let verticalId = null;
  if (vertical) {
    const [rows] = await conn.query('SELECT vertical_id FROM verticals WHERE slug = ?', [vertical]);
    if (!rows.length) { log.error(`No such vertical: ${vertical}`); return { ok: 0, err: 1, skipped: 0 }; }
    verticalId = rows[0].vertical_id;
  }

  const [work] = await conn.query(
    'SELECT DISTINCT domain, MIN(final_url) AS final_url FROM companies' +
    '  WHERE city = ? AND domain IS NOT NULL AND status = 1 AND extract_status = -2' +
    (verticalId === null ? '' : ' AND vertical_id = ?') +
    '  GROUP BY domain ORDER BY MIN(company_id)',
    verticalId === null ? [city] : [city, verticalId]);

  const targets = work.filter(r => {
    if (!onlyDomain) return true;
    try { return canonicalDomain(r.domain) === canonicalDomain(onlyDomain); } catch { return false; }
  });

  if (!targets.length) {
    log.warn('capture --extract-only: nothing to re-extract (no row is status 1 with extract_status -2).');
    return { ok: 0, err: 0, skipped: 0 };
  }

  let s3 = null;
  if (bucket && !dryRun) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
  }

  let ok = 0, err = 0, skipped = 0;

  for (const row of targets) {
    let domain;
    try { domain = canonicalDomain(row.domain); } catch { skipped++; continue; }
    const dir = companyDir(root, city, domain);

    if (dryRun) { log.info(`[dry-run] extract ${domain}`); ok++; continue; }

    try {
      if (!fs.existsSync(path.join(dir, 'rendered.html'))) {
        if (!s3) {
          // Without the bucket there is no way to get the DOM; that is a missing
          // environment variable, not a failed extract.
          log.warn(`extract ${domain}: no rendered.html locally and CAPTURE_BUCKET is not set`);
          skipped++;
          continue;
        }
        await _downloadRendered(s3, bucket, city, domain, dir);
      }

      const doc = extractDir({ dir, domain, finalUrl: row.final_url });

      if (s3) await _uploadExtract(s3, bucket, city, domain, dir);

      await tx(conn2 => recordDomain(conn2, {
        city, domain,
        complete:    isComplete(dir),
        errorKind:   null,
        capturedAt:  _mtime(path.join(dir, 'rendered.html')),
        extract:     doc,
        extractedAt: new Date(),
      }, log));

      ok++;
      log.info(`extract ${domain}: email=${doc.email || 'none'} links=${doc.links.length}`);
    } catch (e) {
      // No error.json: that file belongs to capture and says the capture failed.
      // An extract failure over a good capture is a code bug — it is logged, the
      // row keeps `extract_status = -2`, and the next run retries it.
      err++;
      log.error(`extract error [${domain}]: ${e.message}`);
    }
  }

  log.info(`capture --extract-only: ${ok} ok  ${err} errors  ${skipped} skipped`);
  return { ok, err, skipped };
}

async function _downloadRendered(s3, bucket, city, domain, dir) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { companyKey } = require('../s3');
  const res = await s3.send(new GetObjectCommand({
    Bucket: bucket, Key: companyKey(city, domain, 'rendered.html') }));
  const body = await _toBuffer(res.Body);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'rendered.html');
  fs.writeFileSync(dest + '.tmp', body);
  fs.renameSync(dest + '.tmp', dest);
}

async function _uploadExtract(s3, bucket, city, domain, dir) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const { companyKey } = require('../s3');
  await s3.send(new PutObjectCommand({
    Bucket:      bucket,
    Key:         companyKey(city, domain, 'extract.json'),
    Body:        fs.readFileSync(path.join(dir, 'extract.json')),
    ContentType: 'application/json',
  }));
}

async function _toBuffer(stream) {
  if (Buffer.isBuffer(stream)) return stream;
  if (typeof stream.transformToByteArray === 'function') {
    return Buffer.from(await stream.transformToByteArray());
  }
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

function _mtime(p) {
  try { return fs.statSync(p).mtime; } catch { return null; }
}

module.exports = { extractDir, reextract };

'use strict';

/**
 * S3 keys and uploads for the capture stage.
 *
 * ## The layout
 *
 *     <city>/captures/<domain>/desktop.webp
 *                              mobile.webp
 *                              rendered.html    <- post-JS DOM; link extraction reads this
 *                              home.html        <- raw response body; fallback
 *                              headers.json
 *                              error.json       <- present only when the capture failed
 *     <city>/places/<vertical>/discovered.json
 *                             /qualified.json
 *     <city>/places-raw/<vertical>/<query-sha>.json
 *
 * Every segment is lowercase and comes from `lib-keys.js`, which is the only
 * place a city or a domain is spelled.
 *
 * ## City first
 *
 * A city is a whole campaign: one keyword set, one bbox, one billing story, one
 * decision to archive. Putting it at the top means a second city adds a prefix
 * and touches no existing key, and a city can later be split into its own bucket
 * by moving one prefix. The same domain appearing in two cities is stored twice;
 * at ~34 KB a capture, that is not worth a dedup table.
 *
 * ## No vertical in the capture key
 *
 * Vertical is a classification, and classifications get corrected. Domain is a
 * fact. A key built from the vertical breaks the moment a company is
 * recategorised — the bytes are still good but nothing can find them — and it
 * stores two copies when one website backs two `place_id`s in different
 * verticals.
 *
 * Nothing needs it. `ingest` works from MySQL rows, the deck queries MySQL, and
 * no code lists the bucket by vertical. A flat high-cardinality prefix is also
 * kinder to S3's request-rate partitioning than eighteen fat ones.
 *
 * ## No date and no run id either
 *
 * The key must be computable from columns that exist, because no column stores a
 * path — so a date or a run id would have to be persisted to be recoverable. A
 * 16-hour sweep also crosses midnight, which splits one run across two date
 * prefixes.
 *
 * **Bucket versioning covers re-capture instead.** A re-capture overwrites the
 * key while the previous bytes stay retrievable as a prior version: history with
 * no date in the path and no schema. Enabling versioning is therefore
 * load-bearing, not optional — without it a re-capture is destructive.
 *
 * There is deliberately **no noncurrent-version lifecycle rule**: a domain is
 * captured once, never on a schedule, so versions accumulate only from a
 * deliberate re-capture. Revisit if a periodic refresh is ever introduced — that
 * is the point at which unbounded version growth turns into invisible cost.
 *
 * ## S3 holds bytes; MySQL holds state
 *
 * "What is left to capture" is answered by `companies.status` (0 pending,
 * 1 done, -1 no website, -2 failed) in one indexed query. The bucket is never
 * consulted for it: that would cost a HEAD per pending domain per dispatch and
 * introduce a second opinion that can disagree with the first. `captureComplete` below
 * exists for `--verify`, a repair mode that reconciles the database against the
 * bucket on demand.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { canonicalDomain, canonicalCity } = require('../../lib-keys');

const CONTENT_TYPES = {
  '.webp': 'image/webp',
  '.png':  'image/png',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
};

/**
 * The files that make a capture complete.
 *
 * Mirrors `completionFiles()` at `capture-domain.js:127` — both shots plus
 * headers. They must stay in step: a capture that is complete on disk and
 * incomplete in the bucket, or the reverse, makes resume unreliable in exactly
 * the situation resume exists for.
 */
const COMPLETION = ['desktop.webp', 'mobile.webp', 'headers.json'];

/** Key prefix for one domain's capture output. */
function capturePrefix(city, domain) {
  return `${canonicalCity(city)}/captures/${canonicalDomain(domain)}`;
}

/** Key for one file within a domain's capture. `name` may contain a slash. */
function captureKey(city, domain, name) {
  return `${capturePrefix(city, domain)}/${name}`;
}

/** Key for a discover/qualify artifact. */
function placesKey(city, vertical, filename) {
  return `${canonicalCity(city)}/places/${vertical}/${filename}`;
}

/**
 * Key for one raw Places response body.
 *
 * Archived because those responses cost money, cannot be reproduced, and are the
 * only record of what Google actually returned on the night. The truncation bug
 * stayed invisible for a year for want of exactly this. The name is a SHA of the
 * request, so the same query overwrites its own archive rather than accumulating
 * near-duplicates, and versioning keeps the earlier bodies.
 */
function placesRawKey(city, vertical, requestDescriptor) {
  const sha = crypto.createHash('sha256')
    .update(typeof requestDescriptor === 'string'
      ? requestDescriptor
      : JSON.stringify(requestDescriptor))
    .digest('hex')
    .slice(0, 16);
  return `${canonicalCity(city)}/places-raw/${vertical}/${sha}.json`;
}

function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * Every file under `dir`, relative to it, with forward slashes.
 * `raw/headers.json` is flattened to `headers.json` — the local tree nests it
 * under `raw/` for tidiness, but in S3 one domain is already one prefix.
 */
function _walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(..._walk(full, base)); continue; }
    if (entry.name.endsWith('.tmp')) continue;      // never ship a half-written file
    const rel = path.relative(base, full).split(path.sep).join('/');
    out.push({ full, rel: rel.replace(/^raw\//, '') });
  }
  return out;
}

/**
 * Upload every file in `dir` under one domain's prefix.
 *
 * Sequential on purpose. These are five small objects against a Lambda already
 * running a browser; parallel uploads buy milliseconds and cost memory that
 * `_forceImageDecode` has better uses for.
 *
 * @param {import('@aws-sdk/client-s3').S3Client} s3
 * @returns {Promise<string[]>} keys written
 */
async function uploadCaptureDir(s3, { bucket, city, domain, dir }) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const written = [];
  for (const file of _walk(dir)) {
    const key = captureKey(city, domain, file.rel);
    await s3.send(new PutObjectCommand({
      Bucket:      bucket,
      Key:         key,
      Body:        fs.readFileSync(file.full),
      ContentType: contentTypeFor(file.full),
    }));
    written.push(key);
  }
  return written;
}

/** Upload one JSON document to an explicit key. */
async function putJson(s3, { bucket, key, body }) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await s3.send(new PutObjectCommand({
    Bucket:      bucket,
    Key:         key,
    Body:        typeof body === 'string' ? body : JSON.stringify(body),
    ContentType: 'application/json',
  }));
  return key;
}

async function _exists(s3, bucket, key) {
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (err && (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404)) return false;
    throw err;   // 403 or a network fault is not "absent" — never silently re-capture on it
  }
}

/**
 * True when this domain's capture is complete in the bucket.
 *
 * Checks all three completion files, not just the desktop shot. A capture that
 * hit its deadline keeps whatever shots it managed (`capture-domain.js:75`), so
 * `desktop.webp` alone proves nothing — treating it as complete would abandon a
 * half-captured domain forever.
 */
async function captureComplete(s3, { bucket, city, domain }) {
  for (const name of COMPLETION) {
    if (!(await _exists(s3, bucket, captureKey(city, domain, name)))) return false;
  }
  return true;
}

module.exports = {
  captureKey, capturePrefix, placesKey, placesRawKey,
  contentTypeFor, uploadCaptureDir, putJson, captureComplete,
  COMPLETION,
};

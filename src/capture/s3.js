'use strict';

/**
 * S3 keys and uploads for the capture stage.
 *
 * ## The layout
 *
 *     <city>/companies/<domain>/desktop.webp
 *                               mobile.webp
 *                               rendered.html   <- post-JS DOM; extract reads this
 *                               extract.json    <- first email + outside links
 *                               error.json      <- present only when the capture failed
 *     <city>/places/<vertical>/discovered.json
 *                             /qualified.json
 *
 * Flat: one domain is one prefix and nothing nests under it. `src/capture/s3.js`
 * and `companyDir` in `lib-keys.js` are the only two places that spell it, and
 * `data/<city>/companies/<domain>/` on disk holds exactly the same five names,
 * so a folder synced up from the box lands on the key the Lambda would have
 * written.
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
 * A domain is captured once and never re-captured — `captureComplete` below and
 * `--resume` both skip one that is already there — so a key is written once and
 * bucket versioning has nothing to protect. It is `Suspended`
 * (`terraform/persist/main.tf`).
 *
 * ## S3 holds bytes; MySQL holds state
 *
 * "What is left to capture" is answered by `companies.status` (0 pending,
 * 1 done, -1 no website, -2 failed) in one indexed query. The bucket is never
 * consulted for it: that would cost a HEAD per pending domain per dispatch and
 * introduce a second opinion that can disagree with the first. `captureComplete`
 * below exists for the Lambda's skip check and for `--verify`, a repair mode
 * that reconciles the database against the bucket on demand.
 */

const fs   = require('fs');
const path = require('path');

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
 * Mirrors `completionFiles()` in `capture-domain.js` — both shots plus
 * `rendered.html`, which capture writes last for exactly this reason. They must
 * stay in step: a capture that is complete on disk and incomplete in the bucket,
 * or the reverse, makes resume unreliable in exactly the situation resume exists
 * for.
 *
 * `extract.json` is deliberately not here. Extract is cheap, offline and
 * re-runnable; a capture is neither. A domain missing only `extract.json` must
 * be extracted, not captured again.
 */
const COMPLETION = ['desktop.webp', 'mobile.webp', 'rendered.html'];

/** Key prefix for one company's capture and extract output. */
function companyPrefix(city, domain) {
  return `${canonicalCity(city)}/companies/${canonicalDomain(domain)}`;
}

/** Key for one file within a company's folder. */
function companyKey(city, domain, name) {
  return `${companyPrefix(city, domain)}/${name}`;
}

/** Key for a discover/qualify artifact. */
function placesKey(city, vertical, filename) {
  return `${canonicalCity(city)}/places/${vertical}/${filename}`;
}

function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * Every file under `dir`, relative to it, with forward slashes.
 *
 * The folder is flat by contract (`capture-domain.js` writes no subdirectory),
 * but the walk recurses anyway so a stray nested file is uploaded rather than
 * silently dropped.
 */
function _walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(..._walk(full, base)); continue; }
    if (entry.name.endsWith('.tmp')) continue;      // never ship a half-written file
    out.push({ full, rel: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

/**
 * Upload every file in `dir` under one company's prefix.
 *
 * Sequential on purpose. These are four small objects against a Lambda already
 * running a browser; parallel uploads buy milliseconds and cost memory that
 * `_forceImageDecode` has better uses for.
 *
 * @param {import('@aws-sdk/client-s3').S3Client} s3
 * @returns {Promise<string[]>} keys written
 */
async function uploadCompanyDir(s3, { bucket, city, domain, dir }) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const written = [];
  for (const file of _walk(dir)) {
    const key = companyKey(city, domain, file.rel);
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
 * hit its deadline keeps whatever shots it managed (`capture-domain.js`), so
 * `desktop.webp` alone proves nothing — treating it as complete would abandon a
 * half-captured domain forever.
 *
 * The caller's role needs `s3:GetObject` on the key *and* `s3:ListBucket` on the
 * bucket: without the latter S3 answers a missing key with 403 rather than 404,
 * and `_exists` throws on 403 by design (`terraform/stack/lambda.tf`).
 */
async function captureComplete(s3, { bucket, city, domain }) {
  for (const name of COMPLETION) {
    if (!(await _exists(s3, bucket, companyKey(city, domain, name)))) return false;
  }
  return true;
}

module.exports = {
  companyKey, companyPrefix, placesKey,
  contentTypeFor, uploadCompanyDir, putJson, captureComplete,
  COMPLETION,
};

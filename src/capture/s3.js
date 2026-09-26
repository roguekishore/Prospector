'use strict';

/**
 * S3 keys and uploads for the capture stage.
 *
 * ## The key layout, and why it has no date in it
 *
 *     places/<vertical>/discovered.json
 *     places/<vertical>/qualified.json
 *     captures/<vertical>/<domain>/desktop.webp
 *                                 /mobile.webp
 *                                 /home.html
 *                                 /rendered.html
 *                                 /headers.json
 *                                 /error.json        (only when the capture failed)
 *
 * Three constraints had to hold at once (`docs/ARCHITECTURE.md`):
 *
 * 1. **Deterministic from columns that exist.** Nothing in MySQL stores an S3
 *    path, so the key must be computable from `vertical` and `domain` alone. A
 *    date or run id in the path would have to be stored to be recoverable —
 *    and storing paths was explicitly rejected.
 * 2. **Re-capturing must never destroy the previous capture.**
 * 3. **`ingest` must find finished work cheaply.**
 *
 * A dated path satisfies (2) but breaks (1), and a run id breaks it worse: a
 * 16-hour sweep crosses midnight, so even a date splits one run across two
 * prefixes.
 *
 * **S3 object versioning resolves all three.** Enable versioning on the bucket
 * and a re-capture overwrites the same key while the old bytes stay retrievable
 * as a prior version — history for free, no date in the path, no schema. (1)
 * holds because the key is `vertical` + `domain`. (3) becomes a HEAD on the
 * expected key per pending row — O(pending), no bucket listing at all, and the
 * same "does the object exist" test `--resume` already uses against local disk.
 *
 * **Enabling versioning on the bucket is therefore load-bearing, not optional.**
 * Without it a re-capture is destructive and constraint (2) silently fails.
 */

const fs   = require('fs');
const path = require('path');

const CONTENT_TYPES = {
  '.webp': 'image/webp',
  '.png':  'image/png',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
};

/** Key prefix for one domain's capture output. */
function capturePrefix(vertical, domain) {
  return `captures/${vertical}/${domain}`;
}

/** Key for one file within a domain's capture. `name` may contain a slash. */
function captureKey(vertical, domain, name) {
  return `${capturePrefix(vertical, domain)}/${name}`;
}

/** Key for a discover/qualify artifact. */
function placesKey(vertical, filename) {
  return `places/${vertical}/${filename}`;
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
 * Sequential on purpose. These are 5 small objects against a Lambda already
 * running a browser; parallel uploads buy milliseconds and cost memory that
 * `_forceImageDecode` has better uses for.
 *
 * @param {import('@aws-sdk/client-s3').S3Client} s3
 * @returns {Promise<string[]>} keys written
 */
async function uploadCaptureDir(s3, { bucket, vertical, domain, dir }) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const written = [];
  for (const file of _walk(dir)) {
    const key = captureKey(vertical, domain, file.rel);
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

/** True when this domain's desktop shot is already in the bucket. */
async function captureExists(s3, { bucket, vertical, domain }) {
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  try {
    await s3.send(new HeadObjectCommand({
      Bucket: bucket,
      Key:    captureKey(vertical, domain, 'desktop.webp'),
    }));
    return true;
  } catch (err) {
    if (err && (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404)) return false;
    throw err;   // 403 or a network fault is not "absent" — never silently re-capture on it
  }
}

module.exports = {
  captureKey, capturePrefix, placesKey, contentTypeFor, uploadCaptureDir, captureExists,
};

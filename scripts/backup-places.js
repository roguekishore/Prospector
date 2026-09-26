'use strict';

/**
 * Back up discover/qualify artifacts to the capture bucket.
 *
 *     node scripts/backup-places.js [<vertical>]
 *
 * Walks each vertical's `discovered.json` and `qualified.json` and puts each one
 * at the FIXED key `placesKey` (`src/capture/s3.js`) computes for it — city
 * first, same spelling the capture side already uses.
 *
 * A no-op, exit 0, when `CAPTURE_BUCKET` is unset — this script runs
 * unconditionally from the control pipeline and from a 15-minute timer, on a
 * box that may not have a bucket configured yet.
 *
 * ## Skip-if-unchanged
 *
 * Single-part PUT with SSE-S3 (the bucket's default, no KMS) makes the ETag
 * equal the hex MD5 of the body, so a HeadObject is enough to know whether the
 * bytes on disk already match what's in the bucket — no need to read the
 * object back. This is what makes the 15-minute timer cheap to run forever:
 * everything already backed up costs one HEAD, not one PUT.
 *
 * The exact bytes on disk are uploaded, not a re-serialization of the parsed
 * JSON — re-serializing risks different whitespace producing a different MD5
 * on every run even when nothing changed.
 *
 * ## Never fails discover or qualify
 *
 * This script exits non-zero on a real failure so the systemd timer's own
 * retry (and `journalctl`) sees it, but it is always the *last* step of a
 * pipeline run — discover and qualify have already written their files to
 * disk by the time this runs, so a backup failure here never undoes them.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

const { readCity } = require('../lib-keys');
const { placesKey } = require('../src/capture/s3');

function verticalDirs(dataDir, only) {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && (!only || d.name === only))
    .map(d => ({ slug: d.name, dir: path.join(dataDir, d.name) }));
}

function md5Hex(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

/**
 * PUT `file` at `key` unless the bucket already holds these exact bytes.
 * @returns {Promise<'uploaded'|'skipped'|'failed'>}
 */
async function backupOne(s3, bucket, file, key) {
  const { HeadObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
  const bytes = fs.readFileSync(file);
  const local = md5Hex(bytes);

  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const etag = (head.ETag || '').replace(/"/g, '');
    // A quoted ETag without a trailing "-N" is a single-part MD5. A multipart
    // ETag can never equal a plain hex MD5, so it always falls through to PUT
    // — which is correct, since nothing here ever multipart-uploads.
    if (etag === local) return 'skipped';
  } catch (err) {
    if (!(err && (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404))) {
      console.error(`  HEAD failed for ${key}: ${err.message}`);
      return 'failed';
    }
    // NotFound — fall through to PUT.
  }

  try {
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: bytes, ContentType: 'application/json',
    }));
    return 'uploaded';
  } catch (err) {
    console.error(`  PUT failed for ${key}: ${err.message}`);
    return 'failed';
  }
}

async function main() {
  const only   = process.argv[2] || null;
  const bucket = process.env.CAPTURE_BUCKET;
  const region = process.env.AWS_REGION || 'ap-south-1';

  if (!bucket) {
    console.log('[backup] CAPTURE_BUCKET not set — nothing to do');
    return;
  }

  const city = readCity(ROOT);
  const dirs = verticalDirs(path.join(ROOT, 'data'), only);
  if (!dirs.length) {
    console.log('[backup] no verticals under data/ — nothing to do');
    return;
  }

  const { S3Client } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({ region });

  let uploaded = 0, skipped = 0, failed = 0;

  for (const { slug, dir } of dirs) {
    for (const filename of ['discovered.json', 'qualified.json']) {
      const file = path.join(dir, filename);
      if (!fs.existsSync(file)) continue;
      const key = placesKey(city.name, slug, filename);
      const result = await backupOne(s3, bucket, file, key);
      if (result === 'uploaded') uploaded++; else if (result === 'skipped') skipped++; else failed++;
      console.log(`  ${result} ${slug}/${filename}`);
    }
  }

  console.log(`\n[backup] uploaded=${uploaded} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('[backup] fatal:', err.message); process.exit(1); });

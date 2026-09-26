'use strict';

/**
 * Lambda handler — capture a batch of domains, write them to S3.
 *
 * Capture only. It does **not** parse links or write MySQL: Lambda runs outside
 * any VPC and cannot reach mavdb (`docs/ARCHITECTURE.md`), and `ingest` on the
 * box does that afterwards from S3.
 *
 * `captureDomain` already takes `outDir` as a parameter, so nothing about the
 * capture itself changes here. It writes to `/tmp`, this uploads, `/tmp` is
 * cleared. That is the whole adaptation.
 *
 * Event shape, from `scripts/dispatch.js`:
 *
 *     { runId, vertical, businesses: [ <qualified.json businesses[] entry>, ... ] }
 *
 * Three things this gets deliberately right:
 *
 * * **One browser per invocation, not per domain.** Chromium launch is 1-2s; at
 *   10 domains a batch that is 10-20s of pure waste otherwise.
 * * **Fail-soft per domain.** A thrown capture is caught, recorded, and the
 *   batch continues — the same contract `spec/MASTER.md` §2.2 sets for disk.
 * * **`/tmp` is cleared after every domain.** It persists across warm
 *   invocations, so a batch that does not clean up will eventually fill it and
 *   fail in a way that looks like a capture bug.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { chromium } = require('playwright');

const { captureDomain } = require('./capture-domain');
const { uploadCaptureDir, captureExists } = require('./s3');

const BUCKET   = process.env.CAPTURE_BUCKET;
const REGION   = process.env.AWS_REGION || 'ap-south-1';
const TMP_ROOT = path.join(os.tmpdir(), 'prospector');

/**
 * Per-capture ceiling. Lower than the CLI's 60s default on purpose: the batch
 * must fit Lambda's 900s wall, and 10 x 60s = 600s only leaves headroom if
 * nothing else goes long. Tune with `CAPTURE_DEADLINE_MS`.
 */
const DEADLINE_MS = Number(process.env.CAPTURE_DEADLINE_MS) || 60_000;

let _browser = null;   // survives warm invocations

async function _getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      // Lambda gives every process the same small /dev/shm. Chromium's default
      // shared-memory use overruns it and dies as an opaque tab crash.
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });
  return _browser;
}

function _rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * @param {object} event  { runId, vertical, businesses }
 * @returns {Promise<{runId, vertical, ok, failed, skipped, results}>}
 */
async function handler(event) {
  if (!BUCKET) throw new Error('CAPTURE_BUCKET is not set');

  const { runId = 'unknown-run', vertical, businesses = [] } = event || {};
  if (!vertical)           throw new Error('event.vertical is required');
  if (!businesses.length)  return { runId, vertical, ok: 0, failed: 0, skipped: 0, results: [] };

  const { S3Client } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: REGION });

  const browser = await _getBrowser();
  const results = [];
  let ok = 0, failed = 0, skipped = 0;

  for (const biz of businesses) {
    const domain = biz && biz.domain;
    if (!domain) { failed++; continue; }

    const outDir = path.join(TMP_ROOT, domain);
    try {
      // Resume is "does the object exist", the same test --resume uses on disk.
      // A re-invoke after a partial batch must not re-capture what landed.
      if (await captureExists(s3, { bucket: BUCKET, vertical, domain })) {
        skipped++;
        results.push({ domain, status: 'skipped' });
        continue;
      }

      _rmrf(outDir);
      fs.mkdirSync(outDir, { recursive: true });

      const result = await captureDomain({
        browser,
        business: { ...biz, run: runId },
        outDir,
        timeout:  30_000,
        deadline: DEADLINE_MS,
        log:      console,
      });

      // Uploaded either way: a failed capture still wrote error.json, and a
      // deadline kill still wrote whatever shots landed. Both are worth keeping.
      const keys = await uploadCaptureDir(s3, { bucket: BUCKET, vertical, domain, dir: outDir });

      if (result.ok) { ok++;     results.push({ domain, status: 'ok', keys: keys.length }); }
      else           { failed++; results.push({ domain, status: 'failed', kind: result.kind }); }
    } catch (err) {
      // Never let one domain end the batch — the other nine are still worth having.
      failed++;
      results.push({ domain, status: 'error', message: err.message });
      console.error(`[lambda] ${domain}: ${err.message}`);
    } finally {
      _rmrf(outDir);
    }
  }

  console.log(`[lambda] ${vertical}: ${ok} ok, ${failed} failed, ${skipped} skipped ` +
              `of ${businesses.length}`);
  return { runId, vertical, ok, failed, skipped, results };
}

module.exports = { handler };

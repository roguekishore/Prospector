'use strict';

/**
 * Lambda handler — capture and extract a batch of domains, write them to S3.
 *
 * It does **not** touch MySQL: Lambda runs outside any VPC and cannot reach
 * mavdb (`docs/ARCHITECTURE.md`), and `ingest` on the box loads the files
 * afterwards from S3. Extract is fair game here because it is cheerio over one
 * local file with no network of its own — the same `extractDir` the `capture`
 * stage runs, in the same container as the capture that produced its input.
 *
 * `captureDomain` already takes `outDir` as a parameter, so nothing about the
 * capture itself changes here. It writes to `/tmp`, this uploads, `/tmp` is
 * cleared. That is the whole adaptation.
 *
 * Event shape, from `scripts/dispatch.js`:
 *
 *     { runId, city, vertical, businesses: [ { domain, qualify: { final_url } }, ... ] }
 *
 * Four things this gets deliberately right:
 *
 * * **One browser per invocation, not per domain.** Chromium launch is 1-2s; at
 *   10 domains a batch that is 10-20s of pure waste otherwise.
 * * **Fail-soft per domain.** A thrown capture is caught, recorded, and the
 *   batch continues — the same contract every stage keeps on disk
 *   (`docs/ARCHITECTURE.md`, "Stage contract").
 * * **The upload happens either way.** A failed extract never withholds or
 *   undoes a capture upload: the capture is the expensive half and extract can be
 *   re-run from the uploaded `rendered.html` at no cost.
 * * **`/tmp` is cleared after every domain.** It persists across warm
 *   invocations, so a batch that does not clean up will eventually fill it and
 *   fail in a way that looks like a capture bug.
 *
 * `runBatch` takes its S3 client, browser and bucket as arguments so
 * `scripts/test-lambda.js` can drive the whole per-domain flow against a stub S3
 * client with no AWS account in sight.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { chromium } = require('playwright');

const { captureDomain } = require('./capture-domain');
const { uploadCompanyDir, captureComplete } = require('./s3');
const { extractDir } = require('./extract');
const { canonicalDomain } = require('../../lib-keys');

const BUCKET   = process.env.CAPTURE_BUCKET;
const REGION   = process.env.AWS_REGION || 'ap-south-1';
const TMP_ROOT = path.join(os.tmpdir(), 'prospector');

/**
 * Per-capture ceiling. Lower than the CLI's 60s default on purpose: the batch
 * must fit Lambda's 900s wall, and 10 x 60s = 600s only leaves headroom if
 * nothing else goes long. Extract is not inside this deadline — it is a local
 * parse, measured in milliseconds. Tune with `CAPTURE_DEADLINE_MS`.
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
 * Emit batch counters as CloudWatch Embedded Metric Format.
 *
 * A structured log line, not an API call: CloudWatch extracts the metrics from
 * the log itself, so this costs nothing per invocation and needs no permission
 * beyond the logging the function already does. `PutMetricData` would be a
 * billed call on a path that runs 960 times a run.
 *
 * Lambda's own Invocations/Errors/Duration cannot answer the question that
 * matters — those count *batches*, and a batch of 10 that captured 3 and failed
 * 7 is a successful invocation. Only these say how many pages were actually
 * taken.
 *
 * The `Captures*` and `BatchDurationMs` names are unchanged; warden's
 * `adapters/capture.py` reads them. `ExtractOk` / `ExtractFailed` are new, and
 * split out rather than folded into `CapturesFailed` because they fail for
 * different reasons: a capture fails at someone else's website, an extract fails
 * at our own parser.
 *
 * The two dimension sets give both per-vertical and estate-wide aggregates from
 * one emission; `[]` is the aggregate.
 */
function _emitMetrics({ vertical, ok, failed, skipped, extractOk, extractFailed, durationMs }) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'Prospector/Capture',
        Dimensions: [['Vertical'], []],
        Metrics: [
          { Name: 'CapturesOk',      Unit: 'Count' },
          { Name: 'CapturesFailed',  Unit: 'Count' },
          { Name: 'CapturesSkipped', Unit: 'Count' },
          { Name: 'ExtractOk',       Unit: 'Count' },
          { Name: 'ExtractFailed',   Unit: 'Count' },
          { Name: 'BatchDurationMs', Unit: 'Milliseconds' },
        ],
      }],
    },
    Vertical:        vertical,
    CapturesOk:      ok,
    CapturesFailed:  failed,
    CapturesSkipped: skipped,
    ExtractOk:       extractOk,
    ExtractFailed:   extractFailed,
    BatchDurationMs: durationMs,
  }));
}

/**
 * Capture and extract every business in the event, uploading each domain's
 * folder to `<city>/companies/<domain>/`.
 *
 * `city` is part of the S3 key, so the dispatcher sends it rather than letting
 * the function default one — a Lambda that guessed the city would write a whole
 * batch under the wrong prefix and report success.
 *
 * @param {object} event  { runId, city, vertical, businesses }
 * @param {object} deps   { s3, browser, bucket }
 * @returns {Promise<{runId, city, vertical, ok, failed, skipped, results}>}
 */
async function runBatch(event, { s3, browser, bucket }) {
  const { runId = 'unknown-run', city, vertical, businesses = [] } = event || {};
  if (!city)     throw new Error('event.city is required');
  if (!vertical) throw new Error('event.vertical is required');
  if (!businesses.length) {
    return { runId, city, vertical, ok: 0, failed: 0, skipped: 0,
             extractOk: 0, extractFailed: 0, durationMs: 0, results: [] };
  }

  const startedAt = Date.now();
  const results = [];
  let ok = 0, failed = 0, skipped = 0, extractOk = 0, extractFailed = 0;

  for (const biz of businesses) {
    // Normalise once, here: the same string then names the /tmp directory and
    // every S3 key, so a stray `www.` cannot split one domain across two prefixes.
    let domain;
    try { domain = canonicalDomain(biz && biz.domain); }
    catch {
      failed++;
      results.push({ domain: biz && biz.domain, status: 'error', message: 'unusable domain' });
      continue;
    }

    const outDir = path.join(TMP_ROOT, domain);
    try {
      // A re-invoke after a partial batch must not re-capture what landed. This
      // checks all three completion files, so a deadline-truncated domain is
      // correctly seen as unfinished and gets another attempt.
      if (await captureComplete(s3, { bucket, city, domain })) {
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

      const row = { domain, status: result.ok ? 'ok' : 'failed' };
      if (!result.ok) row.kind = result.kind;

      if (result.ok) {
        try {
          extractDir({ dir: outDir, domain, finalUrl: result.finalUrl });
          extractOk++;
        } catch (err) {
          extractFailed++;
          row.extract      = 'failed';
          row.extractError = err.message;
          console.error(`[lambda] ${domain}: extract failed: ${err.message}`);
        }
      }

      // Uploaded either way: a failed capture still wrote error.json, a deadline
      // kill still wrote whatever shots landed, and a failed extract must not
      // cost us the capture.
      const keys = await uploadCompanyDir(s3, { bucket, city, domain, dir: outDir });
      row.keys = keys.length;

      if (result.ok) ok++; else failed++;
      results.push(row);
    } catch (err) {
      // Never let one domain end the batch — the other nine are still worth having.
      failed++;
      results.push({ domain, status: 'error', message: err.message });
      console.error(`[lambda] ${domain}: ${err.message}`);
    } finally {
      _rmrf(outDir);
    }
  }

  const durationMs = Date.now() - startedAt;
  _emitMetrics({ vertical, ok, failed, skipped, extractOk, extractFailed, durationMs });
  console.log(`[lambda] ${vertical}: ${ok} ok, ${failed} failed, ${skipped} skipped, ` +
              `${extractFailed} extract failed ` +
              `of ${businesses.length} in ${(durationMs / 1000).toFixed(1)}s`);
  return { runId, city, vertical, ok, failed, skipped, extractOk, extractFailed,
           durationMs, results };
}

async function handler(event) {
  if (!BUCKET) throw new Error('CAPTURE_BUCKET is not set');
  const { S3Client } = require('@aws-sdk/client-s3');
  return runBatch(event, {
    s3:      new S3Client({ region: REGION }),
    browser: await _getBrowser(),
    bucket:  BUCKET,
  });
}

module.exports = { handler, runBatch };

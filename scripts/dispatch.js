'use strict';

/**
 * Dispatch capture-and-extract batches to Lambda.
 *
 *     node scripts/dispatch.js [<vertical>] [--batch 10] [--dry-run]
 *                              [--retry-failed]
 *                              [--function prospector-capture] [--region ap-south-1]
 *
 * Takes every domain at `status = 0` (plus `-2` with `--retry-failed`) and fires
 * one async invoke per batch of 10. The function captures and extracts each
 * domain into `s3://<bucket>/<city>/companies/<domain>/`; `ingest` is what turns
 * that back into rows.
 *
 * ## Why async invoke
 *
 * `InvocationType: Event` lets this exit immediately; Lambda's own queue holds
 * the backlog and drains it at the account's concurrency limit. 9,600 domains is
 * 960 invokes — a couple of minutes of API calls, not a long-running job that
 * has to survive an SSH disconnect.
 *
 * The cost is that **failures are invisible here**. Async invoke retries twice
 * on its own and then drops the event. Point a failure destination or DLQ at the
 * function, or a domain that fails three times is simply absent with nothing
 * logged. Re-running this script is the cheap recovery: `captureComplete` makes
 * every batch idempotent, so a second pass only picks up what is missing.
 *
 * ## Batch size
 *
 * 10, pinned by arithmetic rather than taste:
 *
 *     10 x 60s deadline = 600s worst case  <  900s ceiling   ok
 *     15 x 60s deadline = 900s worst case  =  900s ceiling   fails
 *
 * Larger batches amortize the cold start better and lose everything in flight
 * when one times out. The per-capture deadline is what makes any of this
 * bounded — without it the worst case is unbounded and no batch size is safe.
 *
 * ## --dry-run needs the database but no AWS credentials
 *
 * The plan it prints is the work list, which only MySQL knows. Nothing is
 * invoked and the Lambda client is never constructed, so it runs on a laptop
 * with no keys — which is what makes it safe to leave in the allowlist.
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');

const { readCity, canonicalDomain } = require('../lib-keys');
const { db, close } = require('../src/db/mysql');

function parseArgs(argv) {
  const out = { _: [] };
  const arr = argv.slice();
  while (arr.length) {
    const a = arr.shift();
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'dry-run')      { out.dryRun = true; continue; }
      if (key === 'retry-failed') { out.retryFailed = true; continue; }
      out[key] = arr.length && !arr[0].startsWith('--') ? arr.shift() : true;
    } else out._.push(a);
  }
  return out;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function main() {
  const args    = parseArgs(process.argv.slice(2));
  const only    = args._[0] || null;
  const batchSz = Math.max(1, Number(args.batch) || 10);
  const fnName  = args.function || process.env.CAPTURE_FUNCTION || 'prospector-capture';
  const region  = args.region   || process.env.AWS_REGION       || 'ap-south-1';
  const dryRun  = !!args.dryRun;

  // The city is the top S3 prefix, so it is sent in the event rather than
  // defaulted inside the function. config/city.json is already the single source
  // of the bbox and the display name.
  const city = readCity(ROOT);
  const conn = db();

  const statuses = args.retryFailed ? [0, -2] : [0];

  // Per vertical, so one invoke's payload carries one `vertical` — the field the
  // function logs against. A domain listed in two verticals is dispatched once:
  // the S3 folder is keyed by domain alone, and the second capture would be paid
  // for and thrown away.
  const [rows] = await conn.query(
    'SELECT v.slug, c.domain, MIN(c.final_url) AS final_url, MIN(c.company_id) AS ord' +
    '  FROM companies c JOIN verticals v ON v.vertical_id = c.vertical_id' +
    '  WHERE c.city = ? AND c.domain IS NOT NULL' +
    `    AND c.status IN (${statuses.map(() => '?').join(',')})` +
    (only ? ' AND v.slug = ?' : '') +
    '  GROUP BY v.slug, c.domain ORDER BY v.priority, ord',
    only ? [city.slug, ...statuses, only] : [city.slug, ...statuses]);

  if (only) {
    const [known] = await conn.query('SELECT slug FROM verticals WHERE slug = ?', [only]);
    if (!known.length) {
      console.error(`No such vertical: ${only}`);
      process.exitCode = 1;
      return;
    }
  }

  const dispatched = new Set();
  const perVertical = new Map();
  for (const r of rows) {
    let domain;
    try { domain = canonicalDomain(r.domain); } catch { continue; }
    if (dispatched.has(domain)) continue;
    dispatched.add(domain);
    if (!perVertical.has(r.slug)) perVertical.set(r.slug, []);
    perVertical.get(r.slug).push({ domain, qualify: { final_url: r.final_url } });
  }

  let totalDomains = 0, totalBatches = 0;
  const plan = [];
  for (const [slug, businesses] of perVertical) {
    const batches = chunk(businesses, batchSz);
    plan.push({ slug, batches });
    totalDomains += businesses.length;
    totalBatches += batches.length;
    console.log(`  ${slug}: ${businesses.length} domains → ${batches.length} invokes`);
  }

  if (!totalDomains) {
    console.log('Nothing pending capture.');
    return;
  }

  const runId = `dispatch-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}Z`;
  console.log(`\nTotal: ${totalDomains} domains, ${totalBatches} invokes ` +
              `(city=${city.slug}, batch=${batchSz}, fn=${fnName}, region=${region})`);

  if (dryRun) { console.log('\nDry run — nothing invoked.'); return; }

  const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
  const lambda = new LambdaClient({ region });

  let sent = 0, errors = 0;
  for (const { slug, batches } of plan) {
    for (const businesses of batches) {
      const payload = { runId, city: city.slug, vertical: slug, businesses };
      try {
        await lambda.send(new InvokeCommand({
          FunctionName:   fnName,
          InvocationType: 'Event',          // fire and forget; Lambda queues the backlog
          Payload:        Buffer.from(JSON.stringify(payload)),
        }));
        sent++;
        if (sent % 50 === 0) console.log(`  dispatched ${sent}/${totalBatches}`);
      } catch (err) {
        errors++;
        console.error(`  invoke failed (${slug}): ${err.message}`);
      }
    }
  }

  console.log(`\nDispatched ${sent}/${totalBatches} invokes, ${errors} failed.`);
  console.log('Async invoke reports nothing back — run `node src/cli ingest` (or wait for ' +
              'its timer) to see what landed, and re-run this to pick up anything missing.');
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => close());

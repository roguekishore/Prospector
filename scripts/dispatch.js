'use strict';

/**
 * Dispatch capture-and-extract batches to Lambda.
 *
 *     node scripts/dispatch.js [<vertical>] [--batch 10] [--dry-run]
 *                              [--function prospector-capture] [--region ap-south-1]
 *
 * Reads `data/<vertical>/qualified.json`, takes every business with
 * `verdict === "audit"`, and fires one async invoke per batch of 10. The function
 * captures and extracts each domain and writes both to
 * `s3://<bucket>/<city>/companies/<domain>/`.
 *
 * **No database involved.** The work list comes from the qualify artifact, so
 * capture can run before MySQL exists — which is the point of the S3 handoff in
 * `docs/ARCHITECTURE.md`. `ingest` catches up afterwards.
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
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const { readCity, canonicalDomain } = require('../lib-keys');

function parseArgs(argv) {
  const out = { _: [] };
  const arr = argv.slice();
  while (arr.length) {
    const a = arr.shift();
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'dry-run') { out.dryRun = true; continue; }
      out[key] = arr.length && !arr[0].startsWith('--') ? arr.shift() : true;
    } else out._.push(a);
  }
  return out;
}

function verticalDirs(dataDir, only) {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && (!only || d.name === only))
    .map(d => ({ slug: d.name, dir: path.join(dataDir, d.name) }));
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function main() {
  const args     = parseArgs(process.argv.slice(2));
  const only     = args._[0] || null;
  const batchSz  = Math.max(1, Number(args.batch) || 10);
  const fnName   = args.function || process.env.CAPTURE_FUNCTION || 'prospector-capture';
  const region   = args.region   || process.env.AWS_REGION       || 'ap-south-1';
  const dryRun   = !!args.dryRun;

  // The city is the top S3 prefix, so it is sent in the event rather than
  // defaulted inside the function. config/city.json is already the single source
  // of the bbox and the display name.
  const city = readCity(ROOT);

  const dirs = verticalDirs(path.join(ROOT, 'data'), only);
  if (!dirs.length) {
    console.error('No verticals under data/. Run qualify first.');
    process.exit(1);
  }

  let totalDomains = 0, totalBatches = 0;
  const plan = [];

  // One S3 folder per domain, so one invoke per domain. A website listed in two
  // verticals would otherwise be captured twice into the same prefix — the second
  // capture paid for and thrown away. First vertical encountered wins.
  const dispatched = new Set();

  for (const { slug, dir } of dirs) {
    const qualPath = path.join(dir, 'qualified.json');
    if (!fs.existsSync(qualPath)) { console.warn(`  skip ${slug}: no qualified.json`); continue; }

    const qualified = JSON.parse(fs.readFileSync(qualPath, 'utf8'));
    const runId     = qualified.run || 'unknown-run';
    const eligible  = [];
    for (const b of (qualified.businesses || [])) {
      if (!b.domain || !b.qualify || b.qualify.verdict !== 'audit') continue;
      let domain;
      try { domain = canonicalDomain(b.domain); } catch { continue; }
      if (dispatched.has(domain)) continue;
      dispatched.add(domain);
      eligible.push(b);
    }

    if (!eligible.length) { console.warn(`  skip ${slug}: nothing new marked audit`); continue; }

    const batches = chunk(eligible, batchSz);
    plan.push({ slug, runId, batches });
    totalDomains += eligible.length;
    totalBatches += batches.length;
    console.log(`  ${slug}: ${eligible.length} domains → ${batches.length} invokes`);
  }

  console.log(`\nTotal: ${totalDomains} domains, ${totalBatches} invokes ` +
              `(city=${city.slug}, batch=${batchSz}, fn=${fnName}, region=${region})`);

  if (dryRun) { console.log('\nDry run — nothing invoked.'); return; }
  if (!totalBatches) return;

  const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
  const lambda = new LambdaClient({ region });

  let sent = 0, errors = 0;
  for (const { slug, runId, batches } of plan) {
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
  console.log('Async invoke reports nothing back — watch CloudWatch Logs, or re-run ' +
              'this script once it settles to pick up anything missing.');
}

main().catch(err => { console.error(err); process.exit(1); });

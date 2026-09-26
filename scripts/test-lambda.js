/* scripts/test-lambda.js
   Drives the Lambda's per-domain flow with a stub S3 client.

   Needs Chromium and network — it takes two real captures — but no AWS account,
   no bucket and no credentials: `runBatch` takes its S3 client as an argument
   precisely so this can hand it one that records instead of uploading.

   What it proves: every file lands under <city>/companies/<domain>/, extract
   ran inside the same container, the skip check is consulted, and /tmp is left
   clean. What it cannot prove is the IAM policy behind the real client — a stub
   answers HeadObject however we tell it to. That is spec C's first real batch.

   Run: npm run test:lambda */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { chromium } = require('playwright');

const { runBatch } = require('../src/capture/lambda.js');

const ROOT = path.join(__dirname, '..');
const CITY = 'coimbatore';
const TMP_ROOT = path.join(os.tmpdir(), 'prospector');

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`); failed++; failures.push(name); }
}

/**
 * Minimal S3 stub.
 *
 * `HeadObjectCommand` answers with a 404-shaped error, because that is what the
 * real client throws for an absent key and `_exists` in `s3.js` distinguishes it
 * from a 403 on purpose. Getting that shape wrong would make every domain look
 * already-captured and the test would pass having captured nothing.
 */
function stubS3() {
  const puts  = [];
  const heads = [];
  return {
    puts,
    heads,
    async send(cmd) {
      const name  = cmd.constructor.name;
      const input = cmd.input || {};
      if (name === 'HeadObjectCommand') {
        heads.push(input.Key);
        const err = new Error('NotFound');
        err.name = 'NotFound';
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      if (name === 'PutObjectCommand') {
        puts.push({ key: input.Key, contentType: input.ContentType, bytes: input.Body.length });
        return { ETag: '"stub"' };
      }
      throw new Error(`stub S3 got an unexpected command: ${name}`);
    },
  };
}

async function main() {
  console.log('=== lambda batch test (stub S3, real captures) ===');

  // The same five domains the smoke run uses, shaped the way dispatch builds an
  // event business: `{ domain, qualify: { final_url } }` and nothing else, which
  // is the whole contract between scripts/dispatch.js and the handler.
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'smoke-companies.json'), 'utf8'));
  const businesses = seed.slice(0, 2)
    .map(b => ({ domain: b.domain, qualify: { final_url: b.final_url } }));
  console.log(`  domains: ${businesses.map(b => b.domain).join(', ')}`);

  const s3 = stubS3();
  let browser;
  try {
    browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const out = await runBatch(
      { runId: 'test-lambda', city: CITY, vertical: 'interior-design-smoke', businesses },
      { s3, browser, bucket: 'stub-bucket' });

    assert('the skip check ran for every domain',
      businesses.every(b => s3.heads.some(k => k.includes(b.domain))),
      s3.heads.join(' '));

    assert('every domain is accounted for',
      out.ok + out.failed + out.skipped === businesses.length,
      JSON.stringify(out.results));
    assert('nothing was skipped (the stub says absent)', out.skipped === 0);

    // A capture depends on someone else's website being up, so a failure here is
    // reported rather than asserted away — but the keys of whatever succeeded
    // must be right, and at least one must have succeeded for that to mean
    // anything.
    assert('at least one domain captured', out.ok >= 1, JSON.stringify(out.results));
    if (out.failed) {
      console.log(`  note: ${out.failed} domain(s) failed to capture — ` +
                  JSON.stringify(out.results.filter(r => r.status !== 'ok')));
    }

    for (const row of out.results.filter(r => r.status === 'ok')) {
      const prefix = `${CITY}/companies/${row.domain}/`;
      for (const name of ['desktop.webp', 'mobile.webp', 'rendered.html', 'extract.json']) {
        const put = s3.puts.find(p => p.key === prefix + name);
        assert(`${row.domain}: PutObject ${prefix}${name}`, !!put,
          s3.puts.map(p => p.key).join(' '));
        if (put) assert(`${row.domain}: ${name} is not empty`, put.bytes > 0);
      }
      assert(`${row.domain}: extract ran in the same container`, row.extract !== 'failed',
        row.extractError || '');
    }

    assert('no key was written outside <city>/companies/',
      s3.puts.every(p => p.key.startsWith(`${CITY}/companies/`)),
      s3.puts.map(p => p.key).join(' '));
    assert('content types are set per extension',
      s3.puts.every(p =>
        (p.key.endsWith('.webp') && p.contentType === 'image/webp') ||
        (p.key.endsWith('.html') && p.contentType === 'text/html; charset=utf-8') ||
        (p.key.endsWith('.json') && p.contentType === 'application/json')),
      s3.puts.map(p => `${p.key}=${p.contentType}`).join(' '));
    assert('no .tmp uploaded', !s3.puts.some(p => p.key.endsWith('.tmp')));

    for (const b of businesses) {
      assert(`/tmp/prospector/${b.domain} removed`,
        !fs.existsSync(path.join(TMP_ROOT, b.domain)));
    }

    assert('ExtractOk counted for every captured domain',
      out.extractOk + out.extractFailed === out.ok,
      `${out.extractOk}+${out.extractFailed} vs ${out.ok}`);
  } catch (e) {
    console.error('\nUnexpected error during test:', e);
    failed++;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failures.length) console.log('Failed:', failures.join(', '));
  process.exit(failed > 0 ? 1 : 0);
}

main();

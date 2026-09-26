/* scripts/test-extract.js
   Acceptance tests for extract (R4.1–R4.7). Offline: no browser, no network,
   no Places key. Builds rendered.html strings in a temp dir and asserts on the
   extract.json that comes back.
   Run: npm run test:extract */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { extractDir }  = require('../src/extract/index.js');
const { registrable } = require('../src/extract/links.js');

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`); failed++; failures.push(name); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-extract-'));

/**
 * Write one rendered.html into its own folder and extract it. Every case gets a
 * fresh folder so a leftover extract.json can never make the next case pass.
 */
function extract(name, html, { domain = 'antaryaconcepts.com', finalUrl } = {}) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rendered.html'), html, 'utf8');
  const doc = extractDir({ dir, domain, finalUrl });
  return { dir, doc, raw: fs.readFileSync(path.join(dir, 'extract.json'), 'utf8') };
}

const has   = (doc, url) => doc.links.some(l => l.url === url);
const find  = (doc, frag) => doc.links.find(l => l.url.includes(frag));
const page  = body => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

// ---------------------------------------------------------------------------
// R4.5 — registrable() returns the registrable domain, not the suffix doubled
// ---------------------------------------------------------------------------
function testRegistrable() {
  console.log('\n--- R4.5: registrable() ---');
  assert('www.antaryaconcepts.com/x → antaryaconcepts.com',
    registrable('https://www.antaryaconcepts.com/x') === 'antaryaconcepts.com',
    registrable('https://www.antaryaconcepts.com/x'));
  assert('foo.co.in → foo.co.in (two-label suffix kept once)',
    registrable('https://foo.co.in/') === 'foo.co.in',
    registrable('https://foo.co.in/'));
  assert('api.whatsapp.com → whatsapp.com',
    registrable('https://api.whatsapp.com/send?phone=91') === 'whatsapp.com');
  assert('not-a-url → null', registrable('not-a-url') === null);
}

// ---------------------------------------------------------------------------
// R4.3 / R4.4 — own domain and non-http schemes never reach links[]
// ---------------------------------------------------------------------------
function testOwnDomain() {
  console.log('\n--- R4.3/R4.4: own domain and schemes excluded ---');
  const { doc } = extract('own', page(`
    <a href="/about">About</a>
    <a href="https://www.antaryaconcepts.com/x">WWW</a>
    <a href="https://shop.antaryaconcepts.com/">Shop</a>
    <a href="https://antaryaconcepts.net/moved">Redirect target</a>
    <a href="tel:+914221234567">Call</a>
    <a href="mailto:hi@antaryaconcepts.com">Mail</a>
    <a href="#top">Top</a>
    <a href="javascript:void(0)">JS</a>
    <a href="https://wa.me/919876543210">WhatsApp</a>
    <a href="https://api.whatsapp.com/send?phone=919876543210">WhatsApp API</a>
    <a href="https://www.instagram.com/antarya_concepts">Instagram</a>
  `), { finalUrl: 'https://antaryaconcepts.net/' });

  assert('relative /about absent',            !find(doc, '/about'));
  assert('www.<domain> absent',               !find(doc, 'www.antaryaconcepts.com'));
  assert('shop.<domain> absent',              !find(doc, 'shop.antaryaconcepts.com'));
  assert('finalUrl registrable domain absent', !find(doc, 'antaryaconcepts.net'));
  assert('tel: absent',                       !doc.links.some(l => l.url.startsWith('tel:')));
  assert('mailto: absent',                    !doc.links.some(l => l.url.startsWith('mailto:')));
  assert('#top absent',                       !find(doc, '#top'));
  assert('javascript: absent',                !doc.links.some(l => l.url.startsWith('javascript:')));
  assert('wa.me absent',                      !find(doc, 'wa.me'));
  assert('api.whatsapp.com absent',           !find(doc, 'whatsapp.com'));
  assert('the one outside link survives',     doc.links.length === 1, JSON.stringify(doc.links));
  assert('no link carries the own domain',
    !doc.links.some(l => l.target_domain === registrable(`https://${doc.domain}/`)));
}

// ---------------------------------------------------------------------------
// R4.3 — kind, region, text, dedupe
// ---------------------------------------------------------------------------
function testClassification() {
  console.log('\n--- R4.3: kind, region, dedupe ---');
  const { doc } = extract('kinds', page(`
    <nav><a href="https://www.instagram.com/antarya_concepts">Instagram</a></nav>
    <main>
      <a href="https://youtu.be/abc123">Watch</a>
      <a href="https://www.houzz.in/pro/antarya">  Houzz \n profile  </a>
      <a href="https://www.houzz.in/pro/antarya?utm_source=footer">Houzz again</a>
      <a href="https://www.houzz.in/pro/antarya#reviews">Houzz reviews</a>
    </main>
    <footer><a href="https://www.facebook.com/antarya">Facebook</a></footer>
  `));

  assert('instagram → social', find(doc, 'instagram.com').kind === 'social');
  assert('youtu.be → social',  find(doc, 'youtu.be').kind === 'social');
  assert('facebook → social',  find(doc, 'facebook.com').kind === 'social');
  assert('houzz.in → external', find(doc, 'houzz.in').kind === 'external');
  assert('footer link → region footer', find(doc, 'facebook.com').region === 'footer');
  assert('nav link → region nav',       find(doc, 'instagram.com').region === 'nav');
  assert('text is whitespace-collapsed and trimmed',
    find(doc, 'houzz.in').text === 'Houzz profile', JSON.stringify(find(doc, 'houzz.in').text));
  assert('utm_source and #hash variants collapse to one row',
    doc.links.filter(l => l.target_domain === 'houzz.in').length === 1,
    JSON.stringify(doc.links.filter(l => l.target_domain === 'houzz.in')));
  assert('document order preserved',
    doc.links.map(l => l.target_domain).join(',') === 'instagram.com,youtu.be,houzz.in,facebook.com',
    doc.links.map(l => l.target_domain).join(','));
}

// ---------------------------------------------------------------------------
// R4.2 — email
// ---------------------------------------------------------------------------
function testEmail() {
  console.log('\n--- R4.2: first email ---');
  const a = extract('email-mailto', page(`
    <p>write to sales@antaryaconcepts.net</p>
    <a href="mailto:noreply@antaryaconcepts.net">no</a>
    <a href="mailto:ContactUs@Antaryaconcepts.NET?subject=hi">yes</a>
  `)).doc;
  assert('first accepted mailto wins over page text',
    a.email === 'contactus@antaryaconcepts.net', String(a.email));

  const b = extract('email-text', page(`
    <script>Sentry.init({dsn:'https://abc@sentry.io/123'})</script>
    <p>Reach us at Studio@antaryaconcepts.NET for quotes.</p>
  `)).doc;
  assert('text scan skips <script> and lowercases',
    b.email === 'studio@antaryaconcepts.net', String(b.email));

  const c = extract('email-reject', page(`
    <p>abc@sentry.io</p><p>noreply@antaryaconcepts.net</p>
  `)).doc;
  assert('rejected domains and noreply@ give null', c.email === null, String(c.email));

  const e = extract('email-minified', page(
    '<p>info@antaryaconcepts.net</p><p>Call us</p>')).doc;
  assert('adjacent blocks are not glued into a fabricated domain',
    e.email === 'info@antaryaconcepts.net', String(e.email));

  const d = extract('email-none', page('<p>no address here</p>')).doc;
  assert('no email → null', d.email === null, String(d.email));
}

// ---------------------------------------------------------------------------
// R4.1 / R4.7 — shape, and byte-identical on a second run
// ---------------------------------------------------------------------------
function testShapeAndDeterminism() {
  console.log('\n--- R4.1/R4.7: shape and determinism ---');
  const html = page('<footer><a href="https://www.instagram.com/x">IG</a></footer>');
  const first = extract('determinism', html);

  assert('top-level keys are exactly domain, email, links',
    JSON.stringify(Object.keys(first.doc)) === '["domain","email","links"]',
    JSON.stringify(Object.keys(first.doc)));
  assert('link keys are exactly url, target_domain, kind, region, text',
    JSON.stringify(Object.keys(first.doc.links[0])) ===
      '["url","target_domain","kind","region","text"]',
    JSON.stringify(Object.keys(first.doc.links[0])));
  assert('file ends with a newline', first.raw.endsWith('}\n'));

  extractDir({ dir: first.dir, domain: 'antaryaconcepts.com' });
  const second = fs.readFileSync(path.join(first.dir, 'extract.json'), 'utf8');
  assert('two runs over the same rendered.html are byte-identical',
    second === first.raw);

  // R4.1: no leftover .tmp
  assert('no .tmp left behind',
    !fs.readdirSync(first.dir).some(f => f.endsWith('.tmp')),
    fs.readdirSync(first.dir).join(','));
}

// ---------------------------------------------------------------------------
// Missing or empty rendered.html throws, so callers can decide
// ---------------------------------------------------------------------------
function testMissingInput() {
  console.log('\n--- extractDir throws on unusable input ---');
  const dir = path.join(TMP, 'missing');
  fs.mkdirSync(dir, { recursive: true });
  let threw = false;
  try { extractDir({ dir, domain: 'example.com' }); } catch { threw = true; }
  assert('missing rendered.html throws', threw);

  fs.writeFileSync(path.join(dir, 'rendered.html'), '   \n', 'utf8');
  threw = false;
  try { extractDir({ dir, domain: 'example.com' }); } catch { threw = true; }
  assert('empty rendered.html throws', threw);
  assert('nothing written on a throw', !fs.existsSync(path.join(dir, 'extract.json')));
}

function main() {
  console.log('=== extract acceptance tests ===');
  try {
    testRegistrable();
    testOwnDomain();
    testClassification();
    testEmail();
    testShapeAndDeterminism();
    testMissingInput();
  } catch (e) {
    console.error('\nUnexpected error during tests:', e);
    failed++;
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failures.length) console.log('Failed:', failures.join(', '));
  process.exit(failed > 0 ? 1 : 0);
}

main();

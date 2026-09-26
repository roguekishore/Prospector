/* src/extract/email.js
   The first email address on the page. One address, not a list:
   docs/SCHEMA.md gives `companies.email` one column, and the operator writes to
   whichever address the site puts first. */
'use strict';

/**
 * Domains that appear in page source as infrastructure, never as a way to reach
 * the business. A Sentry DSN and a schema.org URL both parse as an email under a
 * permissive regex.
 */
const REJECT_EMAIL_DOMAINS = new Set([
  'example.com', 'sentry.io', 'wixpress.com', 'cloudflare.com',
  'schema.org', 'w3.org', 'google.com', 'googleapis.com',
]);

const EMAIL_RE = /[\w.+\-]+@[\w\-]+\.[\w.]{2,}/g;

/**
 * Elements whose text may be glued to its neighbours' — a `<b>` inside a
 * sentence is part of that sentence. Everything else gets a newline between it
 * and the next element.
 */
const INLINE = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'em', 'i', 'kbd',
  'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time',
  'u', 'var', 'wbr',
]);

/**
 * Page text with a newline at every block boundary, `<script>` and `<style>`
 * dropped.
 *
 * `$('body').text()` concatenates text nodes with nothing between them, so a
 * minified `<p>info@foo.com</p><p>Call us</p>` scans as `info@foo.comCall`,
 * whose domain reads as `foo.comcall` — an address that looks valid, passes every
 * reject rule, and is wrong. The separator is the whole point of walking this by
 * hand instead.
 */
function _blockText(node) {
  const parts = [];
  const walk = n => {
    if (n.type === 'text') { parts.push(n.data || ''); return; }
    const tag = (n.name || '').toLowerCase();
    if (tag === 'script' || tag === 'style') return;
    for (const child of (n.children || [])) walk(child);
    if (!INLINE.has(tag)) parts.push('\n');
  };
  walk(node);
  return parts.join('');
}

/** An address worth writing to, or null. */
function _accept(value) {
  const low = String(value || '').toLowerCase().trim();
  if (!low) return null;
  const domainPart = low.split('@')[1] || '';
  if (!domainPart) return null;
  if (REJECT_EMAIL_DOMAINS.has(domainPart)) return null;
  // `logo@2x.png`-style filenames and image sprites match the regex.
  if (/\.(png|jpg|jpeg|gif|webp|svg)$/.test(domainPart)) return null;
  if (/^(noreply|no-reply|donotreply)@/.test(low)) return null;
  return low;
}

/**
 * The first valid email on the page, lowercase, or null.
 *
 * `mailto:` hrefs in document order first — a site that publishes an address as
 * a link means that one — then a text scan with `<script>` removed, which is
 * where analytics and JSON-LD blobs hide the addresses that are not contactable.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string|null}
 */
function firstEmail($) {
  let found = null;

  $('a[href^="mailto:"]').each((_, el) => {
    if (found) return false;
    const href = $(el).attr('href') || '';
    found = _accept(href.replace(/^mailto:/i, '').split('?')[0].trim());
    return found ? false : undefined;
  });
  if (found) return found;

  const body = $('body').get(0);
  const text = body ? _blockText(body) : '';

  EMAIL_RE.lastIndex = 0;
  let m;
  while ((m = EMAIL_RE.exec(text))) {
    const accepted = _accept(m[0]);
    if (accepted) return accepted;
  }
  return null;
}

module.exports = { firstEmail, REJECT_EMAIL_DOMAINS };

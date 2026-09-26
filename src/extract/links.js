/* src/extract/links.js
   Outside links from rendered.html — social profiles and other domains.
   No network: this reads the DOM cheerio already parsed and nothing else. */
'use strict';

const { parse: parseDomain } = require('tldts');

/**
 * Hosts whose presence the operator reads as "this business has a profile
 * there". Matched on the registrable domain, so `m.facebook.com` and
 * `www.instagram.com` both land here.
 */
const SOCIAL_HOSTS = new Set([
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com',
  'youtu.be', 'linkedin.com', 'pinterest.com', 'tiktok.com', 't.me',
  'snapchat.com',
]);

/**
 * WhatsApp is a phone number wearing a URL. Places already gives the phone, and
 * a `wa.me` link in `links[]` would read as an outside profile it is not.
 * `api.whatsapp.com` needs no entry — its registrable domain is `whatsapp.com`.
 */
const WHATSAPP_HOSTS = new Set(['wa.me', 'whatsapp.com']);

/** Longer than this is a data: URI or a tracking blob, not a link worth keeping. */
const MAX_URL = 2048;

/**
 * The registrable domain of a URL — `antaryaconcepts.com`, `foo.co.in`.
 *
 * `tldts.parse().domain` is already suffix-aware and already includes it; the
 * previous version appended `publicSuffix` again and produced
 * `antaryaconcepts.com.com`, which matched nothing and so let every own-domain
 * link through as `external`.
 */
function registrable(url) {
  try {
    const r = parseDomain(url);
    return r.domain ? r.domain.toLowerCase() : null;
  } catch { return null; }
}

/** Nearest landmark ancestor — where on the page the operator would find it. */
function region($, el) {
  let node = el;
  while (node) {
    const tag = node.name;
    if (tag === 'nav')    return 'nav';
    if (tag === 'header') return 'header';
    if (tag === 'footer') return 'footer';
    if (tag === 'main')   return 'main';
    if (tag === 'aside')  return 'aside';
    node = node.parent;
  }
  return 'main';
}

/**
 * Absolute URL with the hash and the usual tracking parameters dropped, so the
 * same destination linked twice with different campaign tags dedupes to one.
 */
function normaliseHref(href, baseURI) {
  try {
    const abs = new URL(href, baseURI);
    abs.hash = '';
    const tracking = ['utm_source','utm_medium','utm_campaign','utm_term',
      'utm_content','gclid','fbclid','mc_cid','mc_eid'];
    for (const p of tracking) abs.searchParams.delete(p);
    return abs.href;
  } catch { return null; }
}

/**
 * Every outside link on the page, in document order.
 *
 * "Outside" means the registrable domain differs from the site's own. The site's
 * own is two domains, not one: the domain the business is filed under, and the
 * registrable domain of `finalUrl` — a site that redirects `example.com` to
 * `example.net` must not list itself as an external link.
 *
 * @param {import('cheerio').CheerioAPI} $   rendered.html, already loaded
 * @param {string} finalUrl  the URL the DOM belongs to; relative hrefs resolve against it
 * @param {string} domain    the business's own domain
 * @returns {Array<{url,target_domain,kind,region,text}>}
 */
function extractLinks($, finalUrl, domain) {
  const own = new Set(
    [registrable(`https://${domain}/`), registrable(finalUrl)].filter(Boolean));

  const seen  = new Set();
  const links = [];

  $('a[href], area[href]').each((_, el) => {
    const raw = ($(el).attr('href') || '').trim();
    if (!raw || raw.startsWith('#')) return;

    const abs = normaliseHref(raw, finalUrl);
    if (!abs) return;
    // `mailto:`, `tel:`, `javascript:` and every other scheme resolve fine and
    // are rejected here, after resolution, so a protocol-relative `//host/x`
    // still counts as the http(s) link it is.
    if (!/^https?:$/.test(new URL(abs).protocol)) return;
    if (abs.length > MAX_URL) return;

    const target = registrable(abs);
    if (!target) return;
    if (own.has(target)) return;
    if (WHATSAPP_HOSTS.has(target)) return;

    if (seen.has(abs)) return;
    seen.add(abs);

    links.push({
      url:           abs,
      target_domain: target,
      kind:          SOCIAL_HOSTS.has(target) ? 'social' : 'external',
      region:        region($, el),
      text:          $(el).text().replace(/\s+/g, ' ').trim().slice(0, 120),
    });
  });

  return links;
}

module.exports = { extractLinks, registrable, SOCIAL_HOSTS, WHATSAPP_HOSTS };

/* src/extract/links.js
   Extract links from rendered.html. W3 §1.3.
   Dead-link probing is optional (--no-probe). */
'use strict';

const http  = require('http');
const https = require('https');
const { parse: parseDomain } = require('tldts');

const SOCIAL_HOSTS = new Set([
  'facebook.com','instagram.com','twitter.com','x.com','youtube.com',
  'linkedin.com','pinterest.com','wa.me','api.whatsapp.com','tiktok.com',
  't.me','snapchat.com',
]);

function registrable(url) {
  try {
    const r = parseDomain(url);
    return r.domain && r.publicSuffix
      ? `${r.domain}.${r.publicSuffix}`.toLowerCase()
      : null;
  } catch { return null; }
}

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

function classifyKind(absHref, scheme, leadDomain) {
  if (scheme === 'mailto:') return 'mailto';
  if (scheme === 'tel:')    return 'tel';
  if (scheme === '#')       return 'anchor';
  try {
    const rd = registrable(absHref);
    if (!rd) return 'external';
    if (SOCIAL_HOSTS.has(rd)) return 'social';
    if (rd === leadDomain)    return 'internal';
    return 'external';
  } catch { return 'external'; }
}

async function probeUrl(url) {
  return new Promise(resolve => {
    const proto = url.startsWith('https') ? https : http;
    try {
      const req = proto.request(url, { method: 'HEAD', timeout: 5000 }, res => {
        resolve(res.statusCode);
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch { resolve(null); }
  });
}

async function extractLinks($rendered, finalUrl, leadDomain, { probe = true } = {}) {
  const seen   = new Set();
  const links  = [];
  const counts = { total:0, internal:0, external:0, nav:0, footer:0, dead:0, socials:0 };

  $rendered('a[href], area[href]').each((_, el) => {
    const $el  = $rendered(el);
    const raw  = $el.attr('href') || '';
    if (!raw || raw.startsWith('javascript:')) return;

    const scheme = raw.match(/^([a-z]+:)/i)?.[1]?.toLowerCase() || '';
    const abs    = normaliseHref(raw, finalUrl);
    if (!abs) return;
    if (seen.has(abs)) return;
    seen.add(abs);

    const kind   = classifyKind(abs, scheme, leadDomain);
    const reg    = region($rendered, el);
    const text   = $el.text().trim().slice(0, 120);
    const relAttr= $el.attr('rel') || '';

    links.push({ href:abs, text, region:reg, kind, rel:relAttr, visible:true });

    counts.total++;
    if (kind === 'internal')  counts.internal++;
    if (kind === 'external')  counts.external++;
    if (kind === 'social')    counts.socials++;
    if (reg  === 'nav')       counts.nav++;
    if (reg  === 'footer')    counts.footer++;
  });

  // Agency credit
  let agency_credit = null;
  const creditRe = [
    /(?:designed|developed|created|maintained|powered|crafted|built)\s*(?:&|and)?\s*(?:designed|developed|maintained)?\s*by\s*[:\-]?\s*(.{2,60})/i,
    /website\s+by\s+(.{2,60})/i,
    /a\s+unit\s+of\s+(.{2,60})/i,
  ];

  $rendered('footer, [class*="footer"], [id*="footer"]').each((_, el) => {
    if (agency_credit) return false;
    const text = $rendered(el).text();
    for (const re of creditRe) {
      const m = re.exec(text);
      if (!m) continue;
      let raw_text = m[0].trim();
      let name = m[1].trim()
        .replace(/[.,;!]+$/, '')
        .replace(/\s+/g, ' ');

      // Try to find a link near the credit text
      let creditDomain = null;
      $rendered(el).find('a[href]').each((__, link) => {
        const href = $rendered(link).attr('href') || '';
        const rd = registrable(href);
        if (rd && rd !== leadDomain && !SOCIAL_HOSTS.has(rd)) {
          creditDomain = rd;
          return false;
        }
      });

      agency_credit = {
        name,
        domain: creditDomain,
        raw_text,
        region: 'footer',
      };
      break;
    }
  });

  // Dead link probing (internal links only, cap 40, concurrency 4)
  if (probe) {
    const toProbe = links.filter(l => l.kind === 'internal').slice(0, 40);
    const queue   = [...toProbe];
    const workers = 4;
    let i = 0;

    const results = await Promise.all(
      Array.from({ length: Math.min(workers, queue.length) }, async () => {
        while (i < queue.length) {
          const link = queue[i++];
          link.status = await probeUrl(link.href);
        }
      })
    );

    counts.dead = links.filter(l => l.status != null && l.status >= 400).length;
  }

  return { counts, links, agency_credit };
}

module.exports = { extractLinks, registrable, SOCIAL_HOSTS };

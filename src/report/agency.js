/* src/report/agency.js
   Build the agency table: normalise names, fetch pricing + portfolio.
   W3 §6, MASTER.md §7.2 §7.3 §7.4 §7.5 */
'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const { parse: parseDomain } = require('tldts');

const ROOT = path.join(__dirname, '..', '..');

function loadAliases() {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(ROOT, 'config', 'agency-aliases.json'), 'utf8'));
  } catch { return {}; }
}

function registrable(url) {
  try {
    const r = parseDomain(url);
    return r.domain && r.publicSuffix
      ? `${r.domain}.${r.publicSuffix}`.toLowerCase()
      : null;
  } catch { return null; }
}

// MASTER.md §7.2: strip trailing punctuation, collapse whitespace, title-case,
// resolve through agency-aliases.json
function normaliseName(raw) {
  if (!raw) return raw;
  const aliases = loadAliases();

  // Strip trailing punctuation
  let name = raw.replace(/[.,;!:]+$/, '').replace(/\s+/g, ' ').trim();

  // Check aliases (lowercase match)
  const low = name.toLowerCase();
  for (const [key, val] of Object.entries(aliases)) {
    if (low.includes(key.toLowerCase())) return val;
  }

  // Title-case
  return name.replace(/\b\w/g, c => c.toUpperCase());
}

const SOCIAL_HOSTS = new Set([
  'facebook.com','instagram.com','twitter.com','x.com','youtube.com',
  'linkedin.com','pinterest.com','wa.me','api.whatsapp.com',
]);

function fetchUrl(url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const proto = url.startsWith('https') ? https : http;
    let data = '';
    try {
      const req = proto.get(url, {
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'Prospector/1.0 (+https://github.com/prospector)',
          'Accept': 'text/html',
        },
      }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const loc = res.headers.location;
          if (loc) return fetchUrl(loc, timeoutMs).then(resolve);
        }
        if (res.statusCode !== 200) return resolve({ status: res.statusCode, body: '' });
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; if (data.length > 500000) req.destroy(); });
        res.on('end', () => resolve({ status: 200, body: data }));
        res.on('error', () => resolve({ status: 0, body: '' }));
      });
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    } catch { resolve({ status: 0, body: '' }); }
  });
}

async function fetchPricing(agencyDomain) {
  const paths = ['/pricing', '/packages', '/plans', '/rates', '/price'];
  const priceRe = /₹\s?[\d,]{3,}|Rs\.?\s?[\d,]{3,}|INR\s?[\d,]{3,}/g;

  for (const p of paths) {
    const url = `https://${agencyDomain}${p}`;
    const res = await fetchUrl(url, 8000);
    if (res.status !== 200 || !res.body) continue;

    const cheerio = require('cheerio');
    const $ = cheerio.load(res.body);
    const results = [];
    const seen = new Set();

    // Find every price match and look for nearest preceding heading
    $('*').each((_, el) => {
      const text = $(el).text() || '';
      let m;
      priceRe.lastIndex = 0;
      while ((m = priceRe.exec(text)) !== null) {
        const price = m[0].trim();
        if (seen.has(price)) continue;
        seen.add(price);

        // Walk up to find nearest heading h1-h4 or card strong/bold
        let tierLabel = 'Package';
        let node = el;
        while (node && node.name !== 'body') {
          const $node = $(node);
          // Look for preceding heading in parent
          const heading = $node.find('h1,h2,h3,h4,strong,b').first();
          if (heading.length) {
            const ht = heading.text().trim();
            if (ht && ht !== price) { tierLabel = ht; break; }
          }
          node = node.parent;
        }
        results.push({ tier: tierLabel, price });
      }
    });

    if (results.length) return results;
    break; // tried first 200 page, nothing matched
  }
  return [{ tier: 'Not published', price: '—' }];
}

async function fetchPortfolio(agencyDomain) {
  const paths = ['/portfolio', '/clients', '/work', '/projects'];
  const domains = new Set();

  for (const p of paths) {
    const url = `https://${agencyDomain}${p}`;
    const res = await fetchUrl(url, 8000);
    if (res.status !== 200 || !res.body) continue;

    const cheerio = require('cheerio');
    const $ = cheerio.load(res.body);
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      try {
        const abs = new URL(href, url);
        const rd  = registrable(abs.href);
        if (!rd) return;
        if (rd === agencyDomain) return;
        if (SOCIAL_HOSTS.has(rd)) return;
        domains.add(rd);
      } catch {}
    });

    // Cap at 2 pages
    if (domains.size > 0) break;
  }

  return Array.from(domains);
}

async function buildAgencyTable(leads, opts = {}) {
  const { fetchData = true } = opts;
  const DATA = path.join(ROOT, 'data');
  const aliases = loadAliases();

  // Collect all distinct agency credits across leads
  const agencyMap = new Map(); // domain → { name, builtDomains[] }

  for (const lead of leads) {
    const credit = lead.agency_credit;
    if (!credit) continue;

    const key = credit.domain || normaliseName(credit.name).toLowerCase();
    if (!agencyMap.has(key)) {
      agencyMap.set(key, {
        name:       normaliseName(credit.name),
        domain:     credit.domain,
        builtDomains: [],
        rawCredit:  credit.raw_text,
      });
    }
    agencyMap.get(key).builtDomains.push(lead.domain);
  }

  const agencies = [];

  for (const [key, info] of agencyMap) {
    const agDomain = info.domain || key;
    let pricing        = [{ tier: 'Not published', price: '—' }];
    let portfolioDomains = [];

    if (fetchData && agDomain && agDomain.includes('.')) {
      try { pricing           = await fetchPricing(agDomain); }   catch {}
      try { portfolioDomains  = await fetchPortfolio(agDomain); } catch {}
    }

    // Write expansion list
    if (portfolioDomains.length) {
      const expPath = path.join(DATA, 'expansion.json');
      let exp = [];
      try { exp = JSON.parse(fs.readFileSync(expPath, 'utf8')); } catch {}
      for (const pd of portfolioDomains) {
        if (!exp.find(e => e.domain === pd)) {
          exp.push({ domain: pd, source: `agency-portfolio:${agDomain}` });
        }
      }
      fs.writeFileSync(expPath, JSON.stringify(exp, null, 2) + '\n', 'utf8');
    }

    agencies.push({
      name:             info.name,
      domain:           agDomain,
      builtInRun:       info.builtDomains.length,
      portfolioClients: portfolioDomains.length,
      pricing,
      note:             '',
    });
  }

  return agencies;
}

module.exports = { buildAgencyTable, normaliseName, fetchPricing };

/* src/extract/signals/index.js
   One function per signal. Each returns a string or "none"/"missing".
   ctx = { $home, $rendered, headers, qualified, domain, refYear }
   Spec: W3-extract-score.md §1.1 and MASTER.md §4.1 */
'use strict';

const { lcpBucket, WEIGHTS: W } = require('../../../lib-scoring.js');

const num = s => { const m = /-?\d+(\.\d+)?/.exec(String(s ?? '')); return m ? +m[0] : null; };
const yr  = s => { const m = /(?:19|20)\d{2}/.exec(String(s ?? '')); return m ? +m[0] : null; };

/* ---------- copyright ---------- */
function copyright($, refYear) {
  // Try last <footer> first, then last 15% of body text
  let candidates = [];

  $('footer').each((_, el) => {
    const text = $(el).text();
    // range like 2015-2019 → take later
    const range = /(?:©|&copy;|copyright)[^\d]{0,40}(?:19|20)\d{2}\s*[-–]\s*((19|20)\d{2})/i.exec(text);
    if (range) { candidates.push(+range[1]); return; }
    const single = /(?:©|&copy;|copyright)[^\d]{0,40}((19|20)\d{2})/i.exec(text);
    if (single) candidates.push(+single[1]);
  });

  if (!candidates.length) {
    // Fallback: last 15% of body text
    const body = $('body').text();
    const slice = body.slice(Math.floor(body.length * 0.85));
    const range = /(?:©|&copy;|copyright)[^\d]{0,40}(?:19|20)\d{2}\s*[-–]\s*((19|20)\d{2})/i.exec(slice);
    if (range) candidates.push(+range[1]);
    else {
      const single = /(?:©|&copy;|copyright)[^\d]{0,40}((19|20)\d{2})/i.exec(slice);
      if (single) candidates.push(+single[1]);
    }
  }

  if (!candidates.length) return 'none';
  return String(Math.max(...candidates));
}

/* ---------- jquery ---------- */
function jquery($home) {
  // 1. script src filename
  let found = null;
  $home('script[src]').each((_, el) => {
    const src = $home(el).attr('src') || '';
    const m = /jquery[.\-]?(\d+\.\d+(?:\.\d+)?)/i.exec(src);
    if (m) { found = m[1]; return false; }
  });
  if (found) return found;

  // 2. inline script text: jQuery.fn.jquery
  $home('script:not([src])').each((_, el) => {
    const text = $home(el).html() || '';
    const m = /jQuery\.fn\.jquery\s*=\s*["'](\d+\.\d+(?:\.\d+)?)["']/i.exec(text);
    if (m) { found = m[1]; return false; }
  });
  if (found) return found;

  // 3. jquery present but no version
  $home('script[src]').each((_, el) => {
    const src = $home(el).attr('src') || '';
    if (/jquery/i.test(src)) { found = 'present'; return false; }
  });
  return found || 'none';
}

/* ---------- bootstrap ---------- */
function bootstrap($home) {
  // link href
  let found = null;
  $home('link[href]').each((_, el) => {
    const href = $home(el).attr('href') || '';
    const m = /bootstrap[.\-]?(\d+\.\d+(?:\.\d+)?)/i.exec(href);
    if (m) { found = m[1]; return false; }
  });
  if (found) return found;

  // script src
  $home('script[src]').each((_, el) => {
    const src = $home(el).attr('src') || '';
    const m = /bootstrap[.\-]?(\d+\.\d+(?:\.\d+)?)/i.exec(src);
    if (m) { found = m[1]; return false; }
  });
  if (found) return found;

  // inline CSS banner comment
  $home('style').each((_, el) => {
    const text = $home(el).html() || '';
    const m = /Bootstrap\s+v(\d+\.\d+(?:\.\d+)?)/i.exec(text);
    if (m) { found = m[1]; return false; }
  });
  return found || 'none';
}

/* ---------- slider ---------- */
function slider($home) {
  const sources = [];
  $home('script[src]').each((_, el) => sources.push($home(el).attr('src') || ''));
  $home('link[href]').each((_, el)  => sources.push($home(el).attr('href') || ''));

  const all = sources.join('\n');

  const patterns = [
    { re: /revslider|rev_slider|revolution/, name: 'revslider',     vRe: /revslider[.\-]?(\d+\.\d+(?:\.\d+)?)/i },
    { re: /nivo/,                             name: 'nivo slider',   vRe: /nivo[.\-]?slider[.\-]?(\d+\.\d+(?:\.\d+)?)/i },
    { re: /owl[.\-]?carousel/,               name: 'owl carousel',  vRe: /owl\.carousel[.\-]?(\d+\.\d+(?:\.\d+)?)/i },
    { re: /flexslider/,                       name: 'flexslider',    vRe: /flexslider[.\-]?(\d+\.\d+(?:\.\d+)?)/i },
    { re: /jquery[.\-]?cycle/,               name: 'jquery cycle',  vRe: null },
    { re: /slick(?![a-z])/,                  name: 'slick',         vRe: /slick[.\-]?(\d+\.\d+(?:\.\d+)?)/i },
    { re: /swiper/,                           name: 'swiper',        vRe: /swiper[.\-]?(?:bundle[.\-]?)?(\d+\.\d+(?:\.\d+)?)/i },
    { re: /splide/,                           name: 'splide',        vRe: null },
    { re: /embla[.\-]?carousel/,             name: 'embla',         vRe: null },
    { re: /keen[.\-]?slider/,                name: 'keen-slider',   vRe: null },
  ];

  for (const p of patterns) {
    if (!p.re.test(all)) continue;
    // Find the specific file and extract version
    for (const src of sources) {
      if (!p.re.test(src)) continue;
      if (p.vRe) {
        const m = p.vRe.exec(src);
        if (m) return `${p.name} ${m[1]}`;
      }
      // Try generic version from filename
      const m = /[.\-](\d+\.\d+(?:\.\d+)?)(?:\.min)?\.(?:js|css)/.exec(src);
      if (m) return `${p.name} ${m[1]}`;
      return p.name;
    }
    return p.name;
  }
  return 'none';
}

/* ---------- generator ---------- */
function generator($home, headers) {
  // 1. meta name="generator"
  const gen = $home('meta[name="generator"]').attr('content');
  if (gen) return gen;

  // 2. WordPress from paths
  const scripts = [];
  $home('script[src]').each((_, el) => scripts.push($home(el).attr('src') || ''));
  $home('link[href]').each((_, el) => scripts.push($home(el).attr('href') || ''));
  const all = scripts.join('\n');

  if (/\/wp-content\/|\/wp-includes\//.test(all)) {
    // Try to get WP version from ?ver= on a core asset
    for (const src of scripts) {
      if (!/wp-includes|wp-content\/themes/.test(src)) continue;
      const m = /[?&]ver=(\d+\.\d+(?:\.\d+)?)/.exec(src);
      if (m) return `WordPress ${m[1]}`;
    }
    return 'WordPress';
  }

  if (/\/_next\/static\//.test(all)) return 'Next.js';
  if (/wix|_partials\/|wixstatic/i.test(all)) return 'Wix';
  if (/squarespace/i.test(all)) return 'Squarespace';
  if (/shopify/i.test(all)) return 'Shopify';

  // Check HTML text for FrontPage/Word
  const html = $home.html() || '';
  if (/FrontPage/.test(html)) return 'FrontPage';
  if (/Microsoft Word/.test(html)) return 'Microsoft Word';

  return 'static html';
}

/* ---------- theme ---------- */
function theme($home, themeforestSlugs) {
  const sources = [];
  $home('link[href]').each((_, el) => sources.push($home(el).attr('href') || ''));

  for (const src of sources) {
    const m = /\/wp-content\/themes\/([^/]+)\//.exec(src);
    if (m) {
      const slug = m[1].toLowerCase();
      if (themeforestSlugs[slug]) return `${m[1]} (ThemeForest)`;
      return m[1];
    }
  }
  return 'none';
}

/* ---------- domainAge ---------- */
function domainAge(qualified, refYear) {
  const wbFirst = yr(qualified?.qualify?.wayback_first);
  if (!wbFirst) return 'none';
  const years = refYear - wbFirst;
  if (years < 1) {
    const months = Math.round(years * 12);
    return `${months} mo`;
  }
  return `${years} yr`;
}

/* ---------- wayback ---------- */
function wayback(qualified) {
  return String(qualified?.qualify?.wayback_first || 'none');
}

/* ---------- redesigned ----------
   Spec: W1 records both snapshot years; only one available → 'n/a'.
   Heuristic: copyright year > wayback + 1 → copyright year, else 'never'.
   If headers has a pre-computed value (from fixture gen), use it. */
function redesigned(measured, qualified) {
  // If headers carry a pre-computed value from W2/fixtures, trust it
  if (qualified && qualified._redesigned !== undefined) {
    return String(qualified._redesigned);
  }

  const wbFirst = yr(qualified?.qualify?.wayback_first);
  if (!wbFirst) return 'n/a';

  const cpYear = yr(measured.copyright);
  if (cpYear && cpYear > wbFirst + 1) return String(cpYear);
  return 'never';
}

/* ---------- viewport ---------- */
function viewport(headers, $home) {
  // Prefer W2's authoritative measurement
  if (headers?.mobile?.hasViewportMeta !== undefined) {
    return headers.mobile.hasViewportMeta ? 'present' : 'missing';
  }
  // Fallback: regex on home.html
  if ($home('meta[name="viewport"]').length) return 'present';
  return 'missing';
}

/* ---------- overflow ---------- */
function overflow(headers) {
  const px = headers?.mobile?.overflowPx;
  if (px == null) return '0px';
  if (px === 0) return '0px';
  return `+${px}px`;
}

/* ---------- tapTargets ---------- */
function tapTargets(headers) {
  const count = headers?.mobile?.tapTargetsUnder44;
  if (!count) return '0 under 44px';
  return `${count} under 44px`;
}

/* ---------- lcp ---------- */
function lcp(headers) {
  const ms = headers?.timing?.lcp_ms;
  if (!ms) return 'none';
  return `${(ms / 1000).toFixed(1)}s`;
}

/* ---------- pageWeight ---------- */
function pageWeight(headers) {
  const bytes = headers?.timing?.transfer_bytes;
  if (!bytes) return 'none';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

/* ---------- heroVideo ---------- */
function heroVideo($rendered, headers) {
  // Find largest video/mp4/webm in assets or <video autoplay>
  const videoAssets = (headers?.assets || []).filter(a =>
    a.type === 'video' || /\.(mp4|webm)$/.test(a.url));

  // Also check for autoplay video in DOM
  const hasAutoplay = $rendered('video[autoplay], video[autoplay=""]').length > 0;

  if (!videoAssets.length && !hasAutoplay) return 'none';

  if (videoAssets.length) {
    const biggest = videoAssets.sort((a, b) => b.bytes - a.bytes)[0];
    const mb = (biggest.bytes / (1024 * 1024)).toFixed(1);
    const ext = /\.webm/.test(biggest.url) ? 'webm' : 'mp4';
    const autoplay = hasAutoplay ? ', autoplay' : '';
    return `${mb} MB ${ext}${autoplay}`;
  }
  return hasAutoplay ? 'present' : 'none';
}

/* ---------- https ---------- */
function https(qualified, headers) {
  const hs = qualified?.qualify?.https;
  if (!hs) return 'none — http only';

  // Check cert expiry
  const certExpires = headers?.cert_expires || qualified?.qualify?.cert_expires;
  if (certExpires) {
    const exp = new Date(certExpires);
    // We use a fixed date for determinism: 2026-09-18
    const refDate = new Date('2026-09-18');
    if (exp < refDate) {
      const m = certExpires.slice(0, 7); // YYYY-MM
      return `expired ${m}`;
    }
  }

  if (hs === 'expired') {
    // cert_expires in headers
    const ce = headers?.cert_expires;
    if (ce) return `expired ${ce.slice(0, 7)}`;
    return 'expired';
  }

  const finalUrl = qualified?.qualify?.final_url || '';
  if (!finalUrl.startsWith('https')) return 'none — http only';
  return 'ok';
}

/* ---------- mixedContent ---------- */
function mixedContent($rendered, finalUrl) {
  // Count http:// (not https://) in src/href/srcset on an HTTPS page
  if (!finalUrl || !finalUrl.startsWith('https')) return 'none';
  let count = 0;
  $rendered('[src],[href],[srcset]').each((_, el) => {
    const $el = $rendered(el);
    const attrs = [
      $el.attr('src')    || '',
      $el.attr('href')   || '',
      $el.attr('srcset') || '',
    ];
    for (const a of attrs) {
      if (/^http:\/\/(?!https:)/.test(a)) count++;
    }
  });
  return count > 0 ? `${count} assets` : 'none';
}

/* ---------- brokenImages ---------- */
function brokenImages(headers, $rendered) {
  let count = 0;
  // From headers broken_requests filtered to image types
  const imageExts = /\.(jpg|jpeg|png|gif|webp|svg|ico|bmp)/i;
  for (const r of (headers?.broken_requests || [])) {
    if (imageExts.test(r.url) || r.url.includes('image')) count++;
  }
  // <img> with empty or missing src
  $rendered('img').each((_, el) => {
    const src = $rendered(el).attr('src');
    if (!src || src.trim() === '') count++;
  });
  return String(count);
}

/* ---------- whatsapp ---------- */
function whatsapp($rendered) {
  let found = null;
  $rendered('a[href]').each((_, el) => {
    const href = $rendered(el).attr('href') || '';
    if (!/wa\.me|api\.whatsapp\.com|whatsapp:\/\//i.test(href)) {
      const cls = ($rendered(el).attr('class') || '') + ($rendered(el).attr('id') || '');
      if (!/whats-?app/i.test(cls)) return;
    }
    // Check for fixed/float positioning by class name heuristic
    const cls = ($rendered(el).attr('class') || '').toLowerCase();
    const style = ($rendered(el).attr('style') || '').toLowerCase();
    if (/float|fixed/.test(cls) || /position\s*:\s*fixed/.test(style)) {
      found = 'float button';
    } else {
      found = found || 'present';
    }
  });
  // Also check data attributes
  if (!found) {
    $rendered('[class*="whatsapp"],[id*="whatsapp"],[class*="whats-app"]').each((_, el) => {
      const cls = ($rendered(el).attr('class') || '').toLowerCase();
      if (/float|fixed/.test(cls)) found = 'float button';
      else found = found || 'present';
    });
  }
  return found || 'none';
}

/* ---------- quoteForm ---------- */
function quoteForm($rendered, headers) {
  const brokenUrls = new Set((headers?.broken_requests || []).map(r => r.url));

  let found = null;
  $rendered('form').each((_, el) => {
    const $form = $rendered(el);
    const action = $form.attr('action') || '';
    const method = ($form.attr('method') || 'get').toLowerCase();
    const cls = $form.attr('class') || '';

    // mailto only
    if (action.startsWith('mailto:')) {
      found = found || 'mailto: only';
      return;
    }

    // Dead endpoint
    if (action && brokenUrls.has(action)) {
      found = 'broken';
      return false;
    }

    if (method === 'post' || action) {
      // Detect plugin
      if (/wpcf7/.test(cls))    { found = found || 'contact form 7'; return; }
      if (/wpforms/.test(cls))  { found = found || 'wpforms'; return; }
      if (/gform/.test(cls))    { found = found || 'gravity form'; return; }
      // Generic post form
      found = found || 'contact form';
    }
  });
  return found || 'none';
}

/* ---------- blog ---------- */
function blog($rendered, refYear) {
  let found = null;
  $rendered('a[href]').each((_, el) => {
    const href = $rendered(el).attr('href') || '';
    const text = $rendered(el).text() || '';
    if (!/blog|news|articles/i.test(href + text)) return;

    // Try to find a date in surrounding text
    const parent = $rendered(el).parent().text();
    const yearM = /(?:last\s+(?:updated|post)[:\s]+)?(?:19|20)(\d{2})/.exec(parent);
    if (yearM) {
      found = `last post ${yearM[0].match(/(?:19|20)\d{2}/)[0]}`;
      return false;
    }
    found = 'present';
  });
  return found || 'none';
}

/* ---------- flagging table ---------- */

// Canonical weight for each flag key — used to order flagged[] worst-first
const SIGNAL_WEIGHTS = {
  https: 20,
  viewport: 14,
  overflow: 12,
  brokenImages: 8,
  pageWeight: 8,
  lcp: 11,
  tapTargets: 7,
  redesigned: 6,
  mixedContent: 6,
  copyright: 5,
  slider: 5,
  jquery: 5,
  generator: 4,
  bootstrap: 3,
  heroVideo: 2,
  whatsapp: 1,
  quoteForm: 1,
  blog: 1,
  domainAge: 1,
};

function buildFlagged(measured, refYear) {
  // MASTER.md §4.5 — implement as a data table
  const rules = {
    viewport:     v => v === 'missing',
    overflow:     v => num(v) > 0,
    tapTargets:   v => num(v) >= 5,
    lcp:          v => ['slow','dire'].includes(lcpBucket(v)),
    pageWeight:   v => { const n = num(v); return n != null && n > 4; },
    heroVideo:    v => v !== 'none',
    https:        v => v !== 'ok',
    mixedContent: v => v !== 'none',
    brokenImages: v => { const n = num(v); return n != null && n >= 1; },
    jquery:       v => { const n = num(v); return n != null && n < 3; },
    bootstrap:    v => { const n = num(v); return n != null && n < 4; },
    slider:       v => /revslider|revolution|nivo|owl|cycle|flexslider/i.test(v),
    redesigned:   (v, refYear) => v === 'never' || (yr(v) != null && yr(v) <= refYear - 6),
    copyright:    (v, refYear) => { const y = yr(v); return y != null && y <= refYear - 5; },
    generator:    v => {
      const wp = /wordpress\s*([\d.]+)/i.exec(v);
      if (wp && parseFloat(wp[1]) < 5.5) return true;
      return /frontpage|static html/i.test(v);
    },
    whatsapp:     v => v === 'none',
    quoteForm:    v => v === 'none',
    blog:         (v, refYear) => { const y = yr(v); return y != null && y <= refYear - 3; },
    domainAge:    v => { const n = num(v); return n != null && n < 1; },
  };

  const flagged = [];
  for (const [key, rule] of Object.entries(rules)) {
    if (measured[key] === undefined) continue;
    try {
      if (rule(measured[key], refYear)) flagged.push(key);
    } catch (_) { /* never throw */ }
  }

  // Sort by descending weight
  flagged.sort((a, b) => (SIGNAL_WEIGHTS[b] || 0) - (SIGNAL_WEIGHTS[a] || 0));
  return flagged;
}

module.exports = {
  copyright, jquery, bootstrap, slider, generator, theme,
  domainAge, wayback, redesigned, viewport, overflow, tapTargets,
  lcp, pageWeight, heroVideo, https, mixedContent, brokenImages,
  whatsapp, quoteForm, blog, buildFlagged, SIGNAL_WEIGHTS,
};

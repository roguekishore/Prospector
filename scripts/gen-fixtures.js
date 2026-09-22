/* scripts/gen-fixtures.js
   Generates synthetic raw/ directories for all 18 fixture leads and
   _qualified.json for each vertical.  Run once before testing:
     node scripts/gen-fixtures.js
   The HTML is structured so src/extract reads it back to the same
   measured values that preview/data.js declares. */

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

// Load the fixture leads from preview/data.js
const src = fs.readFileSync(path.join(ROOT, 'preview', 'data.js'), 'utf8');
const { LEADS, AGENCIES, VERTICALS } =
  vm.runInNewContext(src + '\n;({ LEADS, AGENCIES, VERTICALS });');

const w = (p, content) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
};
const wj = (p, obj) => w(p, JSON.stringify(obj, null, 2) + '\n');

/* ---------- build per-lead raw/headers.json ---------- */
function buildHeaders(lead) {
  const s = lead.signals;
  const numVal = str => { const m = /-?\d+(\.\d+)?/.exec(String(str ?? '')); return m ? +m[0] : 0; };

  const lcp_ms = parseFloat(s.lcp) * 1000 || 3000;
  const xferMB = parseFloat(s.pageWeight) || 2;
  const xferBytes = Math.round(xferMB * 1024 * 1024);
  const videoMB = s.heroVideo && s.heroVideo !== 'none'
    ? parseFloat(s.heroVideo) || 0 : 0;
  const videoBytes = Math.round(videoMB * 1024 * 1024);
  const imageMB = Math.max(0, xferMB - videoMB - 0.5);
  const imageBytes = Math.round(imageMB * 1024 * 1024);

  const overflowPx = numVal(s.overflow);
  const tapCount   = numVal(s.tapTargets);
  const hasVP      = s.viewport !== 'missing';

  // Build assets list: script/link tags for known libraries
  const assets = [];
  if (s.jquery && s.jquery !== 'none') {
    assets.push({ url:`https://${lead.domain}/wp-includes/js/jquery/jquery-${s.jquery}.min.js`,
      type:'script', bytes:90000, last_modified:'2016-01-01T00:00:00Z' });
  }
  if (s.bootstrap && s.bootstrap !== 'none') {
    assets.push({ url:`https://${lead.domain}/wp-content/themes/main/css/bootstrap-${s.bootstrap}.min.css`,
      type:'stylesheet', bytes:30000, last_modified:'2016-01-01T00:00:00Z' });
  }
  if (s.slider && s.slider !== 'none') {
    const sliderName = s.slider.replace(/\s.+/, '').replace(' ', '-');
    const sliderVer  = s.slider.replace(/^[^\d]+/, '').trim() || '';
    assets.push({ url:`https://${lead.domain}/wp-content/plugins/${sliderName}/${sliderName}${sliderVer ? '-' + sliderVer : ''}.js`,
      type:'script', bytes:200000, last_modified:'2017-01-01T00:00:00Z' });
  }
  if (s.heroVideo && s.heroVideo !== 'none') {
    const ext = s.heroVideo.includes('webm') ? 'webm' : 'mp4';
    assets.push({ url:`https://${lead.domain}/wp-content/uploads/hero.${ext}`,
      type:'video', bytes:videoBytes, last_modified:'2019-01-01T00:00:00Z' });
  }

  // Broken requests (images): brokenImages count
  const brokenImgCount = parseInt(s.brokenImages, 10) || 0;
  const broken_requests = [];
  for (let i = 0; i < brokenImgCount; i++) {
    broken_requests.push({ url:`https://${lead.domain}/wp-content/uploads/missing-${i+1}.jpg`, status:404 });
  }

  // redirect chain
  const httpOk = s.https === 'ok';
  const redirect_chain = httpOk
    ? [`http://${lead.domain}/`, `https://${lead.domain}/`]
    : [`http://${lead.domain}/`];

  // cert_expires
  let cert_expires = '2027-01-01';
  if (typeof s.https === 'string' && s.https.startsWith('expired')) {
    const m = /expired (\d{4}-\d{2})/.exec(s.https);
    if (m) cert_expires = m[1] + '-01'; // set to past date
  }

  return {
    run: 'run-2026-09-18T09-20-11Z',   // W2 stamps the run; re-runs over same raw/ produce same output
    domain: lead.domain,
    final_url: `https://${lead.domain}/`,
    status: 200,
    redirect_chain,
    headers: {
      server: 'Apache',
      'content-type': 'text/html; charset=UTF-8',
    },
    timing: {
      lcp_ms,
      cls: 0.14,
      transfer_bytes: xferBytes,
      requests: 60,
      image_bytes: imageBytes,
      video_bytes: videoBytes,
    },
    mobile: {
      hasViewportMeta: hasVP,
      overflowPx,
      tapTargetsUnder44: tapCount,
    },
    assets,
    console_errors: 0,
    broken_requests,
    cert_expires,
  };
}

/* ---------- build per-lead raw/home.html ---------- */
function buildHtml(lead) {
  const s = lead.signals;

  const viewportMeta = s.viewport !== 'missing'
    ? '<meta name="viewport" content="width=device-width, initial-scale=1">'
    : '<!-- no viewport -->';

  const generatorMeta = s.generator && s.generator !== 'none' && s.generator !== 'static html'
    ? `<meta name="generator" content="${s.generator}">`
    : '';

  const themeSlug = (() => {
    if (!s.theme || s.theme === 'none') return null;
    const m = /^(\S+)/.exec(s.theme);
    return m ? m[1].toLowerCase() : null;
  })();

  const wpThemePath = themeSlug && (s.generator || '').toLowerCase().includes('wordpress')
    ? `<link rel="stylesheet" href="/wp-content/themes/${themeSlug}/style.css">`
    : '';

  const jqScript = s.jquery && s.jquery !== 'none'
    ? `<script src="/wp-includes/js/jquery/jquery-${s.jquery}.min.js"></script>`
    : '';

  const bsLink = s.bootstrap && s.bootstrap !== 'none'
    ? `<link rel="stylesheet" href="/wp-content/themes/main/css/bootstrap-${s.bootstrap}.min.css">`
    : '';

  const sliderScript = (() => {
    if (!s.slider || s.slider === 'none') return '';
    const name = s.slider.toLowerCase();
    const ver  = s.slider.replace(/^[^\d]+/, '').trim();
    if (/revslider|rev_slider|revolution/.test(name)) {
      const v = ver || '5';
      return `<script src="/wp-content/plugins/revslider/revslider-${v}.js"></script>`;
    }
    if (/nivo/.test(name)) return `<script src="/js/jquery-nivo-slider.pack.js"></script>`;
    if (/owl/.test(name)) {
      const v = ver || '2';
      return `<script src="/js/owl.carousel-${v}.min.js"></script>`;
    }
    if (/flexslider/.test(name)) return `<script src="/js/jquery.flexslider-min.js"></script>`;
    if (/jquery[.-]?cycle|cycle/.test(name)) return `<script src="/js/jquery.cycle.all.min.js"></script>`;
    if (/slick/.test(name)) return `<script src="/js/slick.min.js"></script>`;
    if (/swiper/.test(name)) {
      const v = ver || '6';
      return `<script src="/js/swiper-bundle-${v}.min.js"></script>`;
    }
    if (/splide/.test(name)) return `<script src="/js/splide.min.js"></script>`;
    if (/embla/.test(name)) return `<script src="/js/embla-carousel.umd.js"></script>`;
    return '';
  })();

  const mixedAssets = (() => {
    const count = parseInt(s.mixedContent, 10) || 0;
    const lines = [];
    for (let i = 0; i < count; i++) {
      lines.push(`<img src="http://${lead.domain}/images/photo-${i+1}.jpg">`);
    }
    return lines.join('\n');
  })();

  const whatsappHtml = (() => {
    if (!s.whatsapp || s.whatsapp === 'none') return '';
    if (s.whatsapp.includes('float')) {
      return `<a href="https://wa.me/919876543210" class="whatsapp-float" style="position:fixed;bottom:20px;right:20px">WhatsApp</a>`;
    }
    return `<a href="https://wa.me/919876543210">Chat on WhatsApp</a>`;
  })();

  const quoteFormHtml = (() => {
    if (!s.quoteForm || s.quoteForm === 'none') return '';
    if (s.quoteForm === 'mailto: only') {
      return `<form action="mailto:contact@${lead.domain}" method="post"><input type="text" name="name"><button>Send</button></form>`;
    }
    if (s.quoteForm === 'broken') {
      return `<form action="/wp-admin/admin-post.php" method="post" class="wpcf7-form"><input name="name"><button>Submit</button></form>`;
    }
    if (s.quoteForm.includes('wpcf7') || s.quoteForm.includes('contact form 7')) {
      return `<form action="/" method="post" class="wpcf7-form"><input name="name"><button>Submit</button></form>`;
    }
    if (s.quoteForm.includes('wpforms')) {
      return `<form action="/" method="post" class="wpforms-form"><input name="name"><button>Submit</button></form>`;
    }
    if (s.quoteForm.includes('gform') || s.quoteForm.includes('gravity')) {
      return `<form action="/" method="post" class="gform_wrapper"><input name="name"><button>Submit</button></form>`;
    }
    return `<form action="/contact" method="post"><input name="name"><button>Submit</button></form>`;
  })();

  const blogHtml = (() => {
    if (!s.blog || s.blog === 'none') return '';
    const yearM = /(\d{4})/.exec(s.blog);
    const year = yearM ? yearM[1] : '';
    if (s.blog === 'active') {
      return `<a href="/blog">Blog</a>`;
    }
    return `<a href="/blog">Blog</a> <span>Last updated: ${year}</span>`;
  })();

  const videoHtml = (() => {
    if (!s.heroVideo || s.heroVideo === 'none') return '';
    const ext = s.heroVideo.includes('webm') ? 'webm' : 'mp4';
    return `<video autoplay muted loop><source src="/wp-content/uploads/hero.${ext}" type="video/${ext}"></video>`;
  })();

  // Agency credit in footer
  const agencyCreditHtml = lead.agency
    ? `<p>${lead.agency.credit} <a href="https://${lead.agency.domain}">${lead.agency.name}</a></p>`
    : '';

  // Copyright in footer
  const copyrightHtml = s.copyright && s.copyright !== 'none'
    ? `<p>&copy; ${s.copyright} ${lead.name}. All Rights Reserved.</p>`
    : '';

  // Contact info
  const contactsHtml = lead.contacts.map(c => {
    if (c.kind === 'phone') return `<a href="tel:${c.value.replace(/\s/g,'')}"><span>${c.value}</span></a>`;
    if (c.kind === 'email') return `<a href="mailto:${c.value}">${c.value}</a>`;
    if (c.kind === 'instagram') return `<a href="https://instagram.com/${c.value.replace('@','')}">${c.value}</a>`;
    return '';
  }).join('\n');

  // Nav links
  const navLinks = ['Home','About','Services','Gallery','Contact','Projects','Portfolio']
    .slice(0, 7)
    .map(l => `<a href="/${l.toLowerCase()}">${l}</a>`)
    .join('\n');

  // Footer links (many)
  const footerLinks = ['Home','About','Services','Gallery','Contact','Blog','Terms','Privacy','Sitemap',
    'Projects','Portfolio','Testimonials','FAQ','Location','Careers','Awards','Press','Partners']
    .map(l => `<a href="/${l.toLowerCase()}">${l}</a>`)
    .join('\n');

  // Address
  const addressHtml = lead.address && lead.address !== 'Not published'
    ? `<address>${lead.address}</address>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${viewportMeta}
${generatorMeta}
${wpThemePath}
${bsLink}
<title>${lead.name}</title>
</head>
<body>
<header>
<nav>
${navLinks}
</nav>
</header>
<main>
${videoHtml}
${mixedAssets}
${whatsappHtml}
${quoteFormHtml}
${blogHtml}
${addressHtml}
${contactsHtml}
<h1>${lead.name}</h1>
<p>${lead.name} is a professional interior design firm in Coimbatore.</p>
</main>
<aside>
</aside>
<footer>
${footerLinks}
${copyrightHtml}
${agencyCreditHtml}
${addressHtml}
${contactsHtml}
</footer>
${jqScript}
${sliderScript}
</body>
</html>`;
}

/* ---------- build _qualified.json per vertical ---------- */
function buildQualified(vertical, leads) {
  const businesses = leads.map(l => ({
    places_id: `ChIJ${l.domain.replace(/[^a-zA-Z]/g, '').slice(0,8).toUpperCase()}`,
    name: l.name,
    domain: l.domain,
    website_raw: `https://${l.domain}/`,
    rating: l.rating,
    review_count: l.reviews,
    address: l.address || '',
    phone: (l.contacts.find(c => c.kind === 'phone') || {}).value || null,
    lat: 11.0168 + (Math.random() * 0.1 - 0.05),
    lng: 76.9558 + (Math.random() * 0.1 - 0.05),
    business_status: 'OPERATIONAL',
    primary_type: vertical.slug.replace('-', '_'),
    qualify: {
      verdict: 'audit',
      reason: null,
      http_status: 200,
      final_url: `https://${l.domain}/`,
      https: l.signals.https === 'ok' ? 'ok' : 'expired',
      cert_expires: '2027-01-14',
      viewport_meta: l.signals.viewport === 'present',
      wayback_first: l.signals.wayback !== 'none' ? l.signals.wayback : null,
      server: 'Apache',
      generator_hint: l.signals.generator || null,
    },
    // _redesigned is pre-computed by W1 (wayback first+last snapshots).
    // W3's redesigned() reads this directly so the heuristic is bypassed
    // and the extractor reproduces the fixture value exactly.
    _redesigned: l.signals.redesigned,
  }));

  return {
    run: 'run-2026-09-18T09-20-11Z',
    vertical: vertical.slug,
    source: 'places-new',
    queried_at: '2026-09-18T09:02:00Z',
    tiles: 9, keywords: 5, raw_results: 412,
    businesses,
  };
}

/* ---------- main ---------- */

// Group leads by vertical
const byVertical = {};
for (const l of LEADS) {
  (byVertical[l.vertical] = byVertical[l.vertical] || []).push(l);
}

let rawCount = 0;
for (const l of LEADS) {
  const dir = path.join(DATA, l.vertical, l.domain, 'raw');
  fs.mkdirSync(dir, { recursive: true });
  w(path.join(dir, 'home.html'), buildHtml(l));
  wj(path.join(dir, 'headers.json'), buildHeaders(l));
  rawCount++;
}

// Write _qualified.json per vertical
for (const v of VERTICALS) {
  const leads = byVertical[v.slug] || [];
  if (!leads.length) continue;
  const qpath = path.join(DATA, v.slug, '_qualified.json');
  wj(qpath, buildQualified(v, leads));
}

console.log(`Wrote raw/ for ${rawCount} leads + _qualified.json per vertical`);

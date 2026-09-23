/* ============================================================
   PROSPECTOR — dashboard, review deck, exports.

   Views:  home → grid → deck            (vertical → leads → review)
           agencies                      (who built these, what they charge)
           pitch                         (what you marked, outreach-ready)
           disagree                      (your tier ≠ machine tier — audits the weights)

   Verdicts come from lib-scoring.js (rules@1) and are immutable here.
   Your marks live in localStorage, separate, so the two can be compared.
   ============================================================ */

const GLYPH = { A:'■', B:'▣', C:'□', X:'·' };
const TIERS = ['A','B','C','X'];
const STORE = 'prospector.reviews.v1';
const SHOTS = ['mobile','desktop','full'];

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

/* ---------------- data (populated by boot) ---------------- */

let VERTICALS = [];
let LEADS     = [];
let AGENCIES  = [];
let SYNTHETIC = false;

/* ---------------- state ---------------- */

let state = {
  view: 'home',
  vertical: null,
  filter: 'all',
  idx: 0,
  shot: 'mobile',
};

let reviews = {};

/* ---------------- boot: three-source resolution ---------------- */
/* 1. GET /api/index.json   — review API is serving
   2. GET ../data/index.json — a real run exists on disk
   3. data.js globals        — synthetic fixture, dev only            */

async function boot(){
  let data = null;

  // Source 1: review server
  if(!data){
    try{
      const r = await fetch('/api/index.json', {cache:'no-store'});
      if(r.ok) data = await r.json();
    } catch(e){}
  }

  // Source 2: real run on disk
  if(!data){
    try{
      const r = await fetch('../data/index.json', {cache:'no-store'});
      if(r.ok) data = await r.json();
    } catch(e){}
  }

  // Source 3: synthetic fixture — inject data.js as a <script> then read globals
  if(!data){
    await injectDataJs();
    if(typeof window.LEADS !== 'undefined'){
      data = {
        synthetic: true,
        verticals: window.VERTICALS || [],
        leads:     window.LEADS     || [],
        agencies:  window.AGENCIES  || [],
      };
    }
  }

  if(data){
    VERTICALS = data.verticals || [];
    LEADS     = data.leads     || [];
    AGENCIES  = data.agencies  || [];
    SYNTHETIC = !!(data.synthetic);
  }

  reviews = loadReviews();
  render();
}

function injectDataJs(){
  return new Promise(resolve => {
    if(typeof window.LEADS !== 'undefined') return resolve();
    const s = document.createElement('script');
    s.src = 'data.js';
    s.onload  = resolve;
    s.onerror = resolve; // resolve anyway; boot handles zero-data state
    document.head.appendChild(s);
  });
}

/* ---------------- reviews persistence ---------------- */

function loadReviews(){
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || '{}'); }
  catch(e){ saved = {}; }

  // Seed from index.json's own values on first run, then let localStorage win.
  const out = {};
  for(const l of LEADS){
    out[l.domain] = Object.assign(
      { tier:null, pitch:false, note:'' },
      l.review || {},
      saved[l.domain] || {}
    );
  }
  return out;
}

function saveReviews(){
  try { localStorage.setItem(STORE, JSON.stringify(reviews)); }
  catch(e){ /* private mode — deck still renders without storage */ }
}

function rv(domain){
  if(!reviews[domain]) reviews[domain] = { tier:null, pitch:false, note:'' };
  return reviews[domain];
}

/* PUT /api/review/:domain opportunistically; fail silently so a network error
   never loses a mark. localStorage is the primary store; the API is a bonus. */
function fireReviewApi(domain){
  const r = rv(domain);
  fetch('/api/review/' + encodeURIComponent(domain), {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ human_tier: r.tier, pitch: r.pitch, note: r.note }),
  }).catch(() => {});
}

/* ---------------- selectors ---------------- */

function leadsIn(slug){
  return LEADS.filter(l => l.vertical === slug).sort((a,b) => (b.review_count||0) - (a.review_count||0));
}

function filtered(slug, filter){
  const all = leadsIn(slug);
  if(filter === 'all')       return all;
  if(filter === 'unreviewed')return all.filter(l => !rv(l.domain).tier);
  if(filter === 'pitch')     return all.filter(l => rv(l.domain).pitch);
  return all.filter(l => l.tier === filter);
}

function counts(slug){
  const all = leadsIn(slug);
  const c = { A:0,B:0,C:0,X:0, total:all.length, reviewed:0, pitch:0 };
  for(const l of all){
    c[l.tier]++;
    const r = rv(l.domain);
    if(r.tier)  c.reviewed++;
    if(r.pitch) c.pitch++;
  }
  return c;
}

function pitchList(){
  return LEADS.filter(l => rv(l.domain).pitch).sort((a,b) => b.score - a.score);
}

function disagreeList(){
  return LEADS.filter(l => {
    const r = rv(l.domain);
    return r.tier && r.tier !== l.tier;
  }).sort((a,b) => b.score - a.score);
}

function agreementRate(){
  const judged = LEADS.filter(l => rv(l.domain).tier);
  if(!judged.length) return null;
  const same = judged.filter(l => rv(l.domain).tier === l.tier).length;
  return { pct: Math.round(same / judged.length * 100), n: judged.length };
}

function vertOf(slug){ return VERTICALS.find(v => v.slug === slug); }

/* ---------------- helpers ---------------- */

const esc = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

function tierTag(t, score){
  const g = GLYPH[t] || '·';
  return `<span class="tier" data-tier="${t}"><span class="g">${g}</span>${t}${
    score != null ? ' <span class="o3">'+score+'</span>' : ''}</span>`;
}

let toastTimer;
function toast(msg){
  toastEl.textContent = msg;
  toastEl.dataset.on = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.dataset.on = '0'; }, 1400);
}

function go(patch){
  Object.assign(state, patch);
  render();
}

/* ---------------- stage painting ----------------
   Every [data-stage] is measured, then filled with either the real
   capture (data/<vertical>/<domain>/<shot>.{webp,png}) or the CSS rebuild.
   Real captures win automatically once the pipeline writes them.    */

const shotCache = new Map();

/* Compressed WebP is preferred; the PNG is tried next so a tree that has not
   been converted yet still renders. Both are served under /data/. */
function shotCandidates(lead, shot){
  const stem = `../data/${lead.vertical}/${lead.domain}/${shot}`;
  return [stem + '.webp', stem + '.png'];
}

function loadable(url){
  return new Promise(resolve => {
    const img = new Image();
    img.onload  = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

/* Resolves to the URL that actually decoded, or null when there is no capture.
   Callers render that exact URL, so the probe and the <img> can never disagree
   about which format won. */
function probeShot(lead, shot){
  const key = lead.domain + '/' + shot;
  if(shotCache.has(key)) return shotCache.get(key);
  const p = (async () => {
    for(const url of shotCandidates(lead, shot)){
      if(await loadable(url)) return url;
    }
    return null;
  })();
  shotCache.set(key, p);
  return p;
}

function paintStages(root){
  root.querySelectorAll('[data-stage]').forEach(box => {
    const lead = LEADS.find(l => l.domain === box.dataset.stage);
    if(!lead) return;

    const shot = box.dataset.shot || 'mobile';
    const mode = box.dataset.mode || 'contain';

    const cs = getComputedStyle(box);
    const w = box.clientWidth  - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = box.clientHeight - parseFloat(cs.paddingTop)  - parseFloat(cs.paddingBottom);
    if(!(w > 0) || !(h > 0)) return;

    // renderMock may not be available once mocks.js is removed; guard gracefully.
    if(typeof renderMock === 'function'){
      box.innerHTML = renderMock(lead, shot, w, h, mode);
    }
    box.classList.add('crossfade');

    probeShot(lead, shot).then(url => {
      if(!url) return;
      // Guard: the box may have been repainted for another lead or view meanwhile.
      if(box.dataset.stage !== lead.domain || (box.dataset.shot || 'mobile') !== shot) return;

      // Ratios hold for the compressed captures too — downscaling is proportional.
      const ar = shot === 'mobile' ? 390/844 : shot === 'full' ? 1440/2600 : 1440/900;
      const sw = mode === 'cover' ? w : Math.min(w, h * ar);
      const sh = mode === 'cover' ? w / ar : Math.min(h, w / ar);

      box.innerHTML = `<div class="stage" style="width:${sw}px;height:${sh}px">
        <img src="${url}" alt="${esc(lead.domain)} ${esc(shot)} capture">
      </div>`;
    });
  });
}

function preloadAround(list, i){
  for(let k = i + 1; k <= i + 3 && k < list.length; k++){
    SHOTS.forEach(s => probeShot(list[k], s));
  }
}

/* ---------------- chrome ---------------- */

/* When SYNTHETIC is true (fixture data or data loaded from data.js globals),
   the topbar carries a permanent inverted banner so the operator never
   mistakes invented figures for real leads or quotes a fixture price. */

function topbar(crumbs, current){
  return `
  <div class="topbar">
    <span class="brand">Prospector</span>
    <div class="crumbs">${crumbs.map((c,i) =>
      (i ? '<span class="sep">/</span>' : '') +
      (c.go ? `<a href="#" data-go='${esc(JSON.stringify(c.go))}'>${esc(c.label)}</a>`
            : `<span>${esc(c.label)}</span>`)
    ).join('')}</div>
    ${SYNTHETIC ? `<div class="synth-banner" role="status">SYNTHETIC FIXTURE &mdash; NOT REAL LEADS</div>` : ''}
    <span class="spacer"></span>
    <nav class="navlinks" aria-label="main navigation">
      <a href="#" data-go='{"view":"home"}'       ${current==='home'?'aria-current="page"':''}>Verticals</a>
      <a href="#" data-go='{"view":"pitch"}'      ${current==='pitch'?'aria-current="page"':''}>Pitch&nbsp;Queue</a>
      <a href="#" data-go='{"view":"agencies"}'   ${current==='agencies'?'aria-current="page"':''}>Agencies</a>
      <a href="#" data-go='{"view":"disagree"}'   ${current==='disagree'?'aria-current="page"':''}>Disagreements</a>
    </nav>
  </div>`;
}

/* ---------------- view: verticals ---------------- */

function renderHome(){
  // Empty / error state: no data loaded at all.
  if(!VERTICALS.length && !LEADS.length){
    app.innerHTML = topbar([{label:'Coimbatore'}], 'home') + `
    <div class="scroll"><div class="wrap">
      <div class="empty">No data loaded. Start a run with <code>node src/cli serve</code>, or place <code>data/index.json</code> alongside the preview.</div>
    </div></div>`;
    return;
  }

  const totals = VERTICALS.reduce((a,v) => {
    const c = counts(v.slug);
    a.leads += c.total; a.hot += c.A; a.pitch += c.pitch;
    a.discovered += v.discovered || 0; a.audited += v.audited || 0;
    return a;
  }, {leads:0,hot:0,pitch:0,discovered:0,audited:0});

  const agree = agreementRate();

  app.innerHTML = topbar([{label:'Coimbatore'}], 'home') + `
  <div class="scroll"><div class="wrap">

    <div class="strip">
      <div><span class="n">${totals.discovered}</span><span class="k">discovered</span></div>
      <div><span class="n">${totals.audited}</span><span class="k">audited</span></div>
      <div><span class="n">${totals.leads}</span><span class="k">scored</span></div>
      <div><span class="n">${totals.hot}</span><span class="k">tier A</span></div>
      <div><span class="n">${totals.pitch}</span><span class="k">marked</span></div>
      <div><span class="n">${agree ? agree.pct+'%' : '—'}</span><span class="k">agreement</span></div>
    </div>

    <div class="shead">
      <h1 class="t-lg">Verticals</h1>
      <span class="spacer"></span>
      <span class="t-micro o3">Coimbatore &middot; phase one</span>
    </div>

    <div class="vgrid">
      ${VERTICALS.map(v => {
        const c = counts(v.slug);
        const seg = t => c.total ? (c[t]/c.total*100).toFixed(2) : 0;
        return `
        <button class="vcard" data-go='{"view":"grid","vertical":"${v.slug}","filter":"all"}'>
          <div class="vcard-top">
            <div>
              <h2>${esc(v.label)}</h2>
              <div class="sub">${esc(v.city)} &middot; ${(v.keywords||[]).length} keywords</div>
            </div>
            <span class="vcard-go o3">&#8594;</span>
          </div>

          <div class="tierbar">
            ${TIERS.map(t => `<i data-t="${t}" style="width:${seg(t)}%"></i>`).join('')}
          </div>

          <div class="counts">
            <div><span class="n">${c.A}</span><span class="k">hot</span></div>
            <div><span class="n">${c.B}</span><span class="k">warm</span></div>
            <div><span class="n">${c.C}</span><span class="k">weak</span></div>
            <div><span class="n">${c.X}</span><span class="k">skip</span></div>
          </div>

          <div class="vcard-foot">
            <span>${c.reviewed}/${c.total} reviewed</span>
            <span class="o4">&middot;</span>
            <span>${c.pitch} marked</span>
          </div>
        </button>`;
      }).join('')}
    </div>

    <p class="t-small o3" style="margin-top:32px;max-width:66ch">
      Tier and score are machine verdicts over measured signals &mdash; no screenshot is sent to any model.
      Your own marks are stored separately and never overwrite a verdict.
    </p>

  </div></div>`;
}

/* ---------------- view: lead grid ---------------- */

function renderGrid(){
  const v = vertOf(state.vertical);
  if(!v) return go({view:'home'});

  const list = filtered(state.vertical, state.filter);
  const c = counts(state.vertical);

  // Empty vertical state (zero leads audited for this vertical).
  if(c.total === 0){
    app.innerHTML = topbar(
      [{label:'Coimbatore', go:{view:'home'}}, {label:v.label}], 'grid') + `
    <div class="scroll"><div class="wrap">
      <div class="shead">
        <h1 class="t-lg">${esc(v.label)}</h1>
        <span class="spacer"></span>
      </div>
      <div class="empty">No leads scored for this vertical yet.</div>
    </div></div>`;
    return;
  }

  const chips = [
    ['all','all '+c.total], ['A','A '+c.A], ['B','B '+c.B], ['C','C '+c.C], ['X','X '+c.X],
    ['unreviewed','unreviewed '+(c.total-c.reviewed)], ['pitch','marked '+c.pitch],
  ];

  app.innerHTML = topbar(
    [{label:'Coimbatore', go:{view:'home'}}, {label:v.label}], 'grid') + `
  <div class="scroll"><div class="wrap">

    <div class="shead">
      <h1 class="t-lg">${esc(v.label)}</h1>
      <span class="o3 t-small">${v.discovered||0} discovered &rarr; ${v.withDomain||0} with domain &rarr; ${v.audited||0} audited</span>
      <span class="spacer"></span>
      <button class="t-micro" data-deck="0" style="border:1px solid var(--rule-strong);padding:6px 14px">
        Review deck &#8594;
      </button>
    </div>

    <div class="filters" role="group" aria-label="Filter leads">
      ${chips.map(([k,lab]) =>
        `<button data-filter="${k}" aria-pressed="${state.filter===k}">${esc(lab)}</button>`).join('')}
    </div>

    ${list.length ? `<div class="lgrid">
      ${list.map((l,i) => {
        const r = rv(l.domain);
        return `
        <button class="lcard" data-deck="${i}" data-done="${r.tier?1:0}">
          <div class="shot">
            <div class="shotfill" data-stage="${l.domain}" data-shot="mobile" data-mode="cover"></div>
            <span class="badge">${GLYPH[l.tier]} ${l.tier} ${l.score}</span>
            ${r.pitch ? '<span class="pin" aria-label="marked for pitch">&#9873;</span>' : ''}
          </div>
          <div class="meta">
            <span class="dom">${esc(l.domain)}</span>
            <span class="spacer" style="flex:1"></span>
            ${r.tier ? `<span class="t-small o3">you ${GLYPH[r.tier]}</span>` : ''}
          </div>
          <div class="nm">${esc(l.name)}</div>
          <div class="why">${esc(l.angle)}</div>
        </button>`;
      }).join('')}
    </div>` : `<div class="empty">Nothing matches this filter.</div>`}

  </div></div>`;

  requestAnimationFrame(() => paintStages(app));
}

/* ---------------- view: review deck ---------------- */

function renderDeck(){
  const v = vertOf(state.vertical);
  const list = filtered(state.vertical, state.filter);
  if(!list.length) return go({view:'grid'});

  state.idx = Math.max(0, Math.min(state.idx, list.length - 1));
  const l = list[state.idx];
  const r = rv(l.domain);
  const c = counts(state.vertical);

  // Guard: lead whose signals failed to capture (error state).
  const sig = l.signals || {};
  // flaws field name: index.json uses 'flaws', data.js fixture uses 'bad'.
  const bad = new Set(l.flaws || l.bad || []);

  const rows = [
    ['copyright','copyright'], ['wayback','first seen'], ['redesigned','redesign'],
    ['generator','built with'], ['theme','theme'], ['jquery','jquery'],
    ['slider','slider'], ['viewport','viewport'], ['overflow','overflow@390'],
    ['tapTargets','tap targets'], ['lcp','lcp'], ['pageWeight','weight'],
    ['heroVideo','hero video'], ['https','https'], ['mixedContent','mixed'],
    ['brokenImages','broken img'], ['whatsapp','whatsapp'], ['quoteForm','lead capture'],
    ['blog','blog'], ['domainAge','domain age'],
  ].filter(([k]) => sig[k] != null);

  app.innerHTML = topbar(
    [{label:'Coimbatore', go:{view:'home'}},
     {label:v.label, go:{view:'grid', vertical:state.vertical}},
     {label:'review'}], 'deck') + `

  <div class="deckhead">
    <span class="t-micro">${esc(v.label)}</span>
    <span class="t-small o3">${state.idx+1} / ${list.length}${
      state.filter!=='all' ? ' &middot; '+esc(state.filter) : ''}</span>
    <span class="spacer"></span>
    <span class="t-small o3">${c.reviewed}/${c.total} reviewed</span>
    <div class="progress"><i style="width:${c.total?c.reviewed/c.total*100:0}%"></i></div>
  </div>

  <div class="deck">

    <!-- left: identity + the evidence the machine reasoned over -->
    <div class="rail">
      <section class="idblock">
        <div class="dom">${esc(l.domain)}</div>
        <div class="nm">${esc(l.name)}</div>
        <div class="rat">${l.rating ? '★ '+l.rating+' · '+l.reviews+' reviews' : 'unrated'}</div>
      </section>

      ${rows.length ? `
      <section>
        <h3>Signals</h3>
        <table class="sig"><tbody>
          ${rows.map(([k,lab]) =>
            `<tr data-bad="${bad.has(k)?1:0}"><td>${esc(lab)}</td><td>${esc(sig[k])}</td></tr>`
          ).join('')}
        </tbody></table>
      </section>` : `
      <section>
        <h3>Signals</h3>
        <div class="empty" style="padding:calc(var(--u)*2) 0;text-align:left">
          ${l.error ? esc(l.error) : 'Capture failed — no signals recorded.'}
        </div>
      </section>`}

      <section>
        <h3>Links</h3>
        <table class="sig"><tbody>
          <tr><td>total</td><td>${l.links.total}</td></tr>
          <tr><td>internal</td><td>${l.links.internal}</td></tr>
          <tr><td>external</td><td>${l.links.external}</td></tr>
          <tr><td>nav</td><td>${l.links.nav}</td></tr>
          <tr><td>footer</td><td>${l.links.footer}</td></tr>
          <tr data-bad="${l.links.dead?1:0}"><td>dead</td><td>${l.links.dead}</td></tr>
          <tr><td>socials</td><td>${l.links.socials}</td></tr>
        </tbody></table>
      </section>

      <section>
        <h3>Contacts</h3>
        <div class="kvlist">
          ${(l.contacts||[]).map(k => `<span>${esc(k.value)} <span class="o4">${esc(k.kind)}</span></span>`).join('')}
          ${l.address ? `<span class="o3">${esc(l.address)}</span>` : ''}
        </div>
      </section>

      ${l.agency ? `
      <section>
        <h3>Built by</h3>
        <div class="kvlist">
          <span>${esc(l.agency.name)}</span>
          <a href="#" data-go='{"view":"agencies"}'>${esc(l.agency.domain)}</a>
          <span class="o4">&ldquo;${esc(l.agency.credit)}&rdquo;</span>
        </div>
      </section>` : ''}
    </div>

    <!-- centre: the capture, the only colour in the interface -->
    <div class="stagewrap">
      <div class="stagebox"
           data-stage="${l.domain}"
           data-shot="${state.shot}"
           data-mode="${state.shot === 'full' ? 'cover' : 'contain'}"
           data-scroll="${state.shot === 'full' ? 1 : 0}"></div>
      <div class="viewtabs">
        ${SHOTS.map(s =>
          `<button data-shot="${s}" aria-pressed="${state.shot===s}">${s}</button>`).join('')}
        <span class="dim">${state.shot==='mobile' ? '390×844' :
                            state.shot==='full' ? '1440 full page' : '1440×900'}</span>
      </div>
    </div>

    <!-- right: verdict, then your call -->
    <div class="rail right verdict">
      <section>
        <h3>Machine verdict</h3>
        <div class="tierline">
          ${tierTag(l.tier)}
          <span class="score">${l.score}</span>
        </div>
        <ul class="reasons">
          ${(l.reasons||[]).map(x => `<li>${esc(x)}</li>`).join('')}
        </ul>
      </section>

      <section>
        <div class="angle">
          <span class="lbl">Pitch angle</span>
          ${esc(l.angle)}
        </div>
      </section>

      <section>
        <h3>Your call</h3>
        <div class="tierpick" role="group" aria-label="Set your tier">
          ${TIERS.map(t =>
            `<button data-tier="${t}" aria-pressed="${r.tier===t}">${GLYPH[t]} ${t}</button>`).join('')}
        </div>
        <button class="pitchbtn" data-pitch="1" aria-pressed="${r.pitch}">
          ${r.pitch ? '✓ marked for pitch' : 'mark for pitch'}
        </button>
        <textarea class="notefield" id="note" placeholder="note…">${esc(r.note)}</textarea>
        ${r.tier ? `<div class="agree">${r.tier===l.tier ? 'agrees with machine' : 'overrides machine '+GLYPH[l.tier]+' '+l.tier}</div>` : ''}
      </section>
    </div>
  </div>

  <div class="keys" aria-label="keyboard shortcuts">
    <span><b>&larr;</b><b>&rarr;</b>move</span>
    <span><b>1</b><b>2</b><b>3</b><b>4</b>tier</span>
    <span><b>P</b>pitch</span>
    <span><b>N</b>note</span>
    <span><b>M</b><b>D</b><b>F</b>mobile / desktop / full</span>
    <span><b>O</b>open site</span>
    <span><b>U</b>next unreviewed</span>
    <span><b>Esc</b>grid</span>
  </div>`;

  requestAnimationFrame(() => paintStages(app));
  preloadAround(list, state.idx);
}

/* ---------------- view: agencies ---------------- */

function renderAgencies(){
  // Map agency domain → leads built in this run.
  const built = {};
  LEADS.forEach(l => {
    if(!l.agency) return;
    (built[l.agency.domain] = built[l.agency.domain] || []).push(l);
  });

  // Agency pricing and metadata come from index.json.agencies (AGENCIES), not a fixture.
  const agencyRows = AGENCIES.length ? AGENCIES : [];

  app.innerHTML = topbar([{label:'Coimbatore', go:{view:'home'}}, {label:'agencies'}], 'agencies') + `
  <div class="scroll"><div class="wrap">

    <div class="shead">
      <h1 class="t-lg">Agencies</h1>
      <span class="spacer"></span>
      <span class="t-small o3">${agencyRows.length} found from footer credits</span>
    </div>

    <p class="t-small o2" style="max-width:74ch;margin-bottom:28px">
      Every footer credit is an expansion list. An agency&rsquo;s own portfolio page names its
      whole client roster &mdash; each one a business with a dated site and proven willingness
      to pay. Their published pricing is the local floor you position against.
    </p>

    ${agencyRows.length ? `<table class="tbl">
      <thead><tr>
        <th>Agency</th><th class="r">In run</th><th class="r">Portfolio</th>
        <th>Published pricing</th><th>Note</th>
      </tr></thead>
      <tbody>
        ${agencyRows.map(a => `
        <tr>
          <td>
            <div>${esc(a.name)}</div>
            <div class="dim t-small">${esc(a.domain)}</div>
            <div class="t-small" style="margin-top:6px">
              ${(built[a.domain]||[]).map(l =>
                `<span class="chip" style="margin:2px 4px 0 0">${esc(l.domain)}</span>`).join('')}
            </div>
          </td>
          <td class="r num">${a.builtInRun != null ? a.builtInRun : (built[a.domain]||[]).length}</td>
          <td class="r num">${a.portfolioClients != null ? a.portfolioClients : '—'}</td>
          <td>
            ${(a.pricing||[]).map(p =>
              `<div>${esc(p.tier)} <span class="dim">${esc(p.price)}</span></div>`).join('')
              || '<span class="dim">Not published</span>'}
          </td>
          <td class="dim" style="max-width:34ch">${esc(a.note || '')}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : `<div class="empty">No agency data yet. Run the pipeline to extract footer credits.</div>`}

  </div></div>`;
}

/* ---------------- view: pitch queue ---------------- */

function renderPitch(){
  const list = pitchList();

  app.innerHTML = topbar([{label:'Coimbatore', go:{view:'home'}}, {label:'pitch queue'}], 'pitch') + `
  <div class="scroll"><div class="wrap">

    <div class="shead">
      <h1 class="t-lg">Pitch queue</h1>
      <span class="spacer"></span>
      <span class="t-small o3">${list.length} marked</span>
      <button class="t-micro" id="csv" style="border:1px solid var(--rule-strong);padding:6px 14px">
        Export CSV
      </button>
    </div>

    ${list.length ? `<table class="tbl">
      <thead><tr>
        <th>Domain</th><th>Business</th><th class="r">&#9733;</th><th class="r">Machine</th>
        <th class="r">You</th><th>Angle</th><th>Contact</th><th>Note</th>
      </tr></thead>
      <tbody>
        ${list.map(l => {
          const r = rv(l.domain);
          const ph = l.contacts.find(c => c.kind==='phone');
          const em = l.contacts.find(c => c.kind==='email');
          return `
          <tr>
            <td>${esc(l.domain)}</td>
            <td>${esc(l.name)}<div class="dim t-small">${esc(l.address)}</div></td>
            <td class="r num">${l.rating || '—'}</td>
            <td class="r">${tierTag(l.tier, l.score)}</td>
            <td class="r">${r.tier ? GLYPH[r.tier]+' '+r.tier : '<span class="dim">—</span>'}</td>
            <td style="max-width:36ch">${esc(l.angle)}</td>
            <td class="t-small">
              ${ph ? esc(ph.value)+'<br>' : ''}${em ? '<span class="dim">'+esc(em.value)+'</span>' : ''}
            </td>
            <td class="dim t-small" style="max-width:24ch">${esc(r.note)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>` : `<div class="empty">
      Nothing marked yet. Open a vertical, run the review deck, press <b>P</b> on anything worth a pitch.
    </div>`}

  </div></div>`;
}

/* ---------------- view: disagreements ---------------- */

function renderDisagree(){
  const list = disagreeList();
  const agree = agreementRate();

  app.innerHTML = topbar([{label:'Coimbatore', go:{view:'home'}}, {label:'disagreements'}], 'disagree') + `
  <div class="scroll"><div class="wrap">

    <div class="shead">
      <h1 class="t-lg">Disagreements</h1>
      <span class="spacer"></span>
      <span class="t-small o3">${agree ? agree.pct+'% agreement over '+agree.n+' reviewed' : 'nothing reviewed yet'}</span>
    </div>

    <p class="t-small o2" style="max-width:74ch;margin-bottom:28px">
      Where your tier differs from the machine&rsquo;s. Use this to identify which weights to move in
      <code>lib-scoring.js</code> (MASTER.md §5.4), and to feed your A-picks back as
      calibration examples so the next run scores closer to your taste.
    </p>

    ${list.length ? `<table class="tbl">
      <thead><tr>
        <th>Domain</th><th class="r">Machine</th><th class="r">You</th><th>Drift</th>
        <th>Machine reasoning</th><th>Your note</th>
      </tr></thead>
      <tbody>
        ${list.map(l => {
          const r = rv(l.domain);
          const dir = TIERS.indexOf(r.tier) < TIERS.indexOf(l.tier) ? 'you rated up' : 'you rated down';
          return `
          <tr>
            <td>${esc(l.domain)}<div class="dim t-small">${esc(l.name)}</div></td>
            <td class="r">${tierTag(l.tier, l.score)}</td>
            <td class="r">${GLYPH[r.tier]} ${r.tier}</td>
            <td class="t-small">${dir}</td>
            <td class="dim t-small" style="max-width:40ch">${esc((l.reasons||[])[0] || '')}</td>
            <td class="t-small" style="max-width:26ch">${esc(r.note)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>` : `<div class="empty">No disagreements yet.</div>`}

  </div></div>`;
}

/* ---------------- csv / pitch export ---------------- */

/* Try POST /api/export/pitch first (server writes pitch.csv and returns the path).
   If the server is not running or the request fails, build the CSV client-side
   with a BOM and trigger a download so the operator never loses the export. */
async function exportCsv(){
  const list = pitchList();
  if(!list.length){ toast('nothing marked'); return; }

  // Server-side: POST /api/export/pitch
  try {
    const r = await fetch('/api/export/pitch', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ domains: list.map(l => l.domain) }),
    });
    if(r.ok){
      const body = await r.json().catch(() => ({}));
      toast('exported to ' + (body.path || 'pitch.csv'));
      return;
    }
  } catch(e){}

  // Client-side fallback with BOM for Excel compat.
  const q = s => '"' + String(s == null ? '' : s).replace(/"/g,'""') + '"';
  const head = ['domain','business','vertical','address','phone','email',
                'rating','reviews','machine_tier','score','your_tier','angle','note','agency'];
  const rows = list.map(l => {
    const r = rv(l.domain);
    const ph = l.contacts.find(c => c.kind==='phone');
    const em = l.contacts.find(c => c.kind==='email');
    return [l.domain, l.name, l.vertical, l.address, ph?ph.value:'', em?em.value:'',
            l.rating, l.reviews, l.tier, l.score, r.tier||'', l.angle, r.note,
            l.agency?l.agency.name:''].map(q).join(',');
  });

  const blob = new Blob(['﻿' + [head.map(q).join(','), ...rows].join('\r\n')],
                        {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'prospector-pitch-queue.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('exported ' + list.length + ' leads (client-side)');
}

/* ---------------- render dispatch ---------------- */

function render(){
  const scroller = app.querySelector('.scroll');
  const y = scroller ? scroller.scrollTop : 0;

  if(state.view === 'grid')          renderGrid();
  else if(state.view === 'deck')     renderDeck();
  else if(state.view === 'agencies') renderAgencies();
  else if(state.view === 'pitch')    renderPitch();
  else if(state.view === 'disagree') renderDisagree();
  else                               renderHome();

  const ns = app.querySelector('.scroll');
  if(ns && state.view === 'grid') ns.scrollTop = y;
}

/* ---------------- events ---------------- */

app.addEventListener('click', e => {
  const goEl = e.target.closest('[data-go]');
  if(goEl){ e.preventDefault(); return go(JSON.parse(goEl.dataset.go)); }

  const f = e.target.closest('[data-filter]');
  if(f) return go({filter:f.dataset.filter});

  const d = e.target.closest('[data-deck]');
  if(d) return go({view:'deck', idx:+d.dataset.deck});

  const s = e.target.closest('.viewtabs [data-shot]');
  if(s) return go({shot:s.dataset.shot});

  const t = e.target.closest('.tierpick [data-tier]');
  if(t){ setTier(t.dataset.tier); return; }

  if(e.target.closest('[data-pitch]')){ togglePitch(); return; }

  if(e.target.id === 'csv'){ exportCsv(); return; }
});

app.addEventListener('input', e => {
  if(e.target.id === 'note'){
    const l = currentLead();
    if(l){
      rv(l.domain).note = e.target.value;
      saveReviews();
      fireReviewApi(l.domain);
    }
  }
});

function currentLead(){
  if(state.view !== 'deck') return null;
  const list = filtered(state.vertical, state.filter);
  return list[state.idx] || null;
}

/* A mark can drop the current lead out of an active filter
   ('unreviewed', 'pitch'). Re-anchor on the domain so the deck
   stays where you are instead of silently jumping a card. */
function reanchor(domain){
  const list = filtered(state.vertical, state.filter);
  const at = list.findIndex(x => x.domain === domain);
  state.idx = at >= 0 ? at
            : Math.min(state.idx, Math.max(0, list.length - 1));
  render();
}

function setTier(t){
  const l = currentLead(); if(!l) return;
  const r = rv(l.domain);
  r.tier = (r.tier === t) ? null : t;
  saveReviews();
  fireReviewApi(l.domain);
  toast(r.tier ? l.domain + ' → ' + r.tier : l.domain + ' cleared');
  reanchor(l.domain);
}

function togglePitch(){
  const l = currentLead(); if(!l) return;
  const r = rv(l.domain);
  r.pitch = !r.pitch;
  saveReviews();
  fireReviewApi(l.domain);
  toast(r.pitch ? 'marked ' + l.domain : 'unmarked ' + l.domain);
  reanchor(l.domain);
}

function step(n){
  const list = filtered(state.vertical, state.filter);
  const next = state.idx + n;
  if(next < 0 || next >= list.length) return toast(n>0 ? 'end of deck' : 'start of deck');
  go({idx:next});
}

function nextUnreviewed(){
  const list = filtered(state.vertical, state.filter);
  for(let k = state.idx + 1; k < list.length; k++){
    if(!rv(list[k].domain).tier) return go({idx:k});
  }
  toast('no unreviewed leads ahead');
}

document.addEventListener('keydown', e => {
  const tag = (document.activeElement.tagName || '').toLowerCase();
  const typing = tag === 'textarea' || tag === 'input';

  if(typing){
    if(e.key === 'Escape'){ document.activeElement.blur(); }
    return;
  }

  if(state.view !== 'deck'){
    if(e.key === 'Escape' && state.view !== 'home') go({view:'home'});
    return;
  }

  const k = e.key.toLowerCase();

  if(e.key === 'ArrowRight' || k === 'j'){ e.preventDefault(); return step(1); }
  if(e.key === 'ArrowLeft'  || k === 'k'){ e.preventDefault(); return step(-1); }
  if(['1','2','3','4'].includes(e.key))  { e.preventDefault(); return setTier(TIERS[+e.key - 1]); }
  if(k === 'p'){ e.preventDefault(); return togglePitch(); }
  if(k === 'n'){ e.preventDefault(); const n = document.getElementById('note'); if(n) n.focus(); return; }
  if(k === 'm'){ return go({shot:'mobile'}); }
  if(k === 'd'){ return go({shot:'desktop'}); }
  if(k === 'f'){ return go({shot:'full'}); }
  if(k === 'u'){ e.preventDefault(); return nextUnreviewed(); }
  if(k === 'o'){
    const l = currentLead();
    if(l) window.open('https://' + l.domain, '_blank', 'noopener');
    return;
  }
  if(e.key === 'Escape'){ return go({view:'grid'}); }
});

let rsz;
window.addEventListener('resize', () => {
  clearTimeout(rsz);
  rsz = setTimeout(() => paintStages(app), 120);
});

boot();

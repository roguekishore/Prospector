/* preview/app.js — the deck.
   One page, three views: overview, one vertical (leads or no-website), one lead.

   Nothing here computes a judgement, because there is nothing to compute it
   from: the pipeline stores no verdict of its own. What is on the screen is what
   Places said, what qualify measured, what extract found, the two screenshots —
   and the operator's own answer.

   No framework and no build step. The whole state is a URL hash and one page of
   rows; `app.css` (spec/MASTER.md §9) is the design contract this paints into. */
'use strict';

(() => {
  const PAGE = 60;

  const state = {
    view:     'overview',   // overview | vertical | lead
    vertical: null,
    tab:      'leads',      // leads | no-website
    filters:  new Set(),
    rows:     [],
    total:    0,
    offset:   0,
    lead:     null,
    shot:     'mobile',     // which screenshot the detail stage shows
    verticals: [],
  };

  const app   = document.getElementById('app');
  const toast = document.getElementById('toast');

  // ---- helpers -----------------------------------------------------------

  /** Everything from the server is escaped before it reaches innerHTML. */
  const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const num = (n) => (n === null || n === undefined) ? '—' : Number(n).toLocaleString('en-IN');

  let toastTimer = null;
  function say(message) {
    toast.textContent = message;
    toast.dataset.on = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.dataset.on = '0'; }, 2600);
  }

  async function api(path, options) {
    const res = await fetch(path, options);
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).error || detail; } catch { /* not json */ }
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  /** The chips, in the order they are shown. Keys match the server's FILTERS. */
  const FILTERS = [
    ['http',       'plain http'],
    ['expired',    'cert expired'],
    ['email',      'has email'],
    ['unreviewed', 'unreviewed'],
    ['pitch',      'pitch'],
    ['tier:A',     'A'],
    ['tier:B',     'B'],
    ['tier:C',     'C'],
    ['tier:X',     'X'],
  ];

  // ---- routing -----------------------------------------------------------
  //
  // The hash is the whole of the navigable state, so a reload, a back button and
  // a link shared between the operator's laptop and their phone all land in the
  // same place.

  function parseHash() {
    const raw = location.hash.replace(/^#/, '');
    const [head, query] = raw.split('?');
    const parts  = head.split('/').filter(Boolean);
    const params = new URLSearchParams(query || '');

    state.filters = new Set((params.get('filter') || '').split(',').filter(Boolean));

    if (parts[0] === 'lead' && parts[1]) {
      state.view = 'lead';
      state.lead = null;
      state.leadId = Number(parts[1]);
      return;
    }
    if (parts[0] === 'v' && parts[1]) {
      state.view     = 'vertical';
      state.vertical = parts[1];
      state.tab      = parts[2] === 'no-website' ? 'no-website' : 'leads';
      return;
    }
    state.view = 'overview';
  }

  function verticalHash(slug, tab, filters) {
    const f = [...(filters || [])].join(',');
    return `#/v/${slug}${tab === 'no-website' ? '/no-website' : ''}${f ? `?filter=${f}` : ''}`;
  }

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  // ---- chrome ------------------------------------------------------------

  function topbar(crumbs) {
    return `
      <div class="topbar">
        <span class="brand">Prospector</span>
        <nav class="crumbs">${crumbs}</nav>
        <span class="spacer"></span>
        <div class="navlinks">
          <a href="#/" ${state.view === 'overview' ? 'aria-current="page"' : ''}>Verticals</a>
          <a href="/api/export/pitch.csv" download>Pitch CSV</a>
        </div>
      </div>`;
  }

  function crumb(text, href) {
    return href ? `<a href="${esc(href)}">${esc(text)}</a>` : `<span>${esc(text)}</span>`;
  }

  const SEP = '<span class="sep">/</span>';

  // ---- overview ----------------------------------------------------------

  async function renderOverview() {
    state.verticals = await api('/api/verticals');

    const totals = state.verticals.reduce((a, v) => ({
      leads:      a.leads      + v.leads,
      no_website: a.no_website + v.no_website,
      reviewed:   a.reviewed   + v.reviewed,
      pitch:      a.pitch      + v.pitch,
    }), { leads: 0, no_website: 0, reviewed: 0, pitch: 0 });

    const cards = state.verticals.map(v => `
      <a class="vcard" href="${esc(verticalHash(v.slug, 'leads'))}">
        <div class="vcard-top">
          <div>
            <h2>${esc(v.label)}</h2>
            <div class="sub">${esc(v.slug)}</div>
          </div>
          <span class="vcard-go" aria-hidden="true">&rarr;</span>
        </div>
        <div class="counts">
          <div><span class="n">${num(v.leads)}</span><span class="k">leads</span></div>
          <div><span class="n">${num(v.reviewed)}</span><span class="k">reviewed</span></div>
          <div><span class="n">${num(v.pitch)}</span><span class="k">pitch</span></div>
          <div><span class="n">${num(v.no_website)}</span><span class="k">no site</span></div>
        </div>
        <div class="vcard-foot">
          ${v.leads ? `${Math.round(100 * v.reviewed / v.leads)}% reviewed` : 'nothing captured yet'}
        </div>
      </a>`).join('');

    app.innerHTML = `
      ${topbar(crumb('Verticals'))}
      <div class="scroll"><div class="wrap">
        <div class="strip">
          <div><span class="n">${num(totals.leads)}</span><span class="k">leads</span></div>
          <div><span class="n">${num(totals.reviewed)}</span><span class="k">reviewed</span></div>
          <div><span class="n">${num(totals.pitch)}</span><span class="k">pitch</span></div>
          <div><span class="n">${num(totals.no_website)}</span><span class="k">no website</span></div>
        </div>
        ${cards ? `<div class="vgrid">${cards}</div>`
                : '<p class="empty">No verticals yet.</p>'}
      </div></div>`;
  }

  // ---- one vertical ------------------------------------------------------

  async function loadPage(reset) {
    if (reset) { state.offset = 0; state.rows = []; }
    const params = new URLSearchParams({
      vertical: state.vertical,
      view:     state.tab,
      offset:   String(state.offset),
      limit:    String(PAGE),
    });
    const f = [...state.filters].join(',');
    if (f) params.set('filter', f);

    const page = await api(`/api/leads?${params}`);
    state.total = page.total;
    state.rows  = state.rows.concat(page.rows);
  }

  function badges(r) {
    const out = [];
    if (r.https_status === 'none')    out.push('HTTP only');
    if (r.https_status === 'expired') out.push('cert expired');
    if (r.email)                      out.push('email');
    return out;
  }

  function leadCard(r) {
    const alt = `Mobile screenshot of ${r.name}`;
    const shot = r.domain
      ? `<div class="shotfill"><img src="/shots/${encodeURIComponent(r.domain)}/mobile.webp"
             alt="${esc(alt)}" loading="lazy"></div>`
      : '';
    const flag = badges(r)[0];
    return `
      <a class="lcard" href="#/lead/${r.company_id}" data-done="${r.reviewed_at ? 1 : 0}">
        <div class="shot">
          ${shot}
          ${flag ? `<span class="badge">${esc(flag)}</span>` : ''}
          ${r.pitch ? '<span class="pin" title="pitch">&#9679;</span>' : ''}
        </div>
        <div class="meta">
          <span class="dom">${esc(r.domain || r.name)}</span>
          <span class="spacer"></span>
          ${r.tier ? `<span class="tier" data-tier="${esc(r.tier)}"><span class="g">${esc(r.tier)}</span></span>` : ''}
        </div>
        <div class="nm">${esc(r.name)}</div>
        <div class="why">${num(r.review_count)} reviews${r.rating ? ` · ${esc(r.rating)}&#9733;` : ''}</div>
      </a>`;
  }

  function noWebsiteTable(rows) {
    if (!rows.length) return '<p class="empty">Nothing here.</p>';
    const body = rows.map(r => `
      <tr data-id="${r.company_id}">
        <td>${esc(r.name)}</td>
        <td class="num r">${num(r.review_count)}</td>
        <td class="num r">${r.rating ? esc(r.rating) : '—'}</td>
        <td>${esc(r.phone || '')}</td>
        <td class="dim">${esc(r.address || '')}</td>
        <td>${tierPicker(r, 'row')}</td>
        <td><button class="pitchbtn" data-act="pitch" data-id="${r.company_id}"
              aria-pressed="${r.pitch}">pitch</button></td>
      </tr>`).join('');
    return `<table class="tbl"><thead><tr>
        <th>Name</th><th class="r">Reviews</th><th class="r">Rating</th>
        <th>Phone</th><th>Address</th><th>Tier</th><th></th>
      </tr></thead><tbody>${body}</tbody></table>`;
  }

  function tierPicker(r, scope) {
    return `<div class="tierpick" role="radiogroup" aria-label="Tier for ${esc(r.name)}">` +
      ['A', 'B', 'C', 'X'].map(t =>
        `<button role="radio" data-act="tier" data-tier="${t}" data-id="${r.company_id}"
                 data-scope="${scope}" aria-checked="${r.tier === t}"
                 aria-pressed="${r.tier === t}">${t}</button>`).join('') +
      '</div>';
  }

  async function renderVertical() {
    await loadPage(true);
    const v = (state.verticals.find(x => x.slug === state.vertical)) || { label: state.vertical };

    const chips = FILTERS.map(([key, label]) =>
      `<button data-act="filter" data-key="${esc(key)}"
               aria-pressed="${state.filters.has(key)}">${esc(label)}</button>`).join('');

    app.innerHTML = `
      ${topbar(`${crumb('Verticals', '#/')} ${SEP} ${crumb(v.label || state.vertical)}`)}
      <div class="deckhead">
        <div class="viewtabs">
          <button data-act="tab" data-tab="leads"
                  aria-pressed="${state.tab === 'leads'}">Leads</button>
          <button data-act="tab" data-tab="no-website"
                  aria-pressed="${state.tab === 'no-website'}">No website</button>
        </div>
        <span class="spacer"></span>
        <span class="t-small o2" id="count"></span>
      </div>
      <div class="scroll"><div class="wrap">
        <div class="filters">${chips}</div>
        <div id="list"></div>
        <div id="more" style="padding:24px 0;text-align:center"></div>
      </div></div>`;

    paintList();
  }

  function paintList() {
    const list = document.getElementById('list');
    const more = document.getElementById('more');
    document.getElementById('count').textContent =
      `${state.rows.length} of ${state.total}`;

    if (state.tab === 'no-website') {
      list.innerHTML = noWebsiteTable(state.rows);
    } else {
      list.innerHTML = state.rows.length
        ? `<div class="lgrid">${state.rows.map(leadCard).join('')}</div>`
        : '<p class="empty">Nothing here.</p>';
    }

    more.innerHTML = state.rows.length < state.total
      ? '<button class="pitchbtn" data-act="more" style="max-width:240px">Load more</button>'
      : '';
  }

  // ---- one lead ----------------------------------------------------------

  async function renderLead() {
    const r = await api(`/api/leads/${state.leadId}`);
    state.lead = r;

    const shots = r.domain ? `
      <div class="stagewrap">
        <div class="stagebox" data-scroll="1">
          <img class="crossfade" src="/shots/${encodeURIComponent(r.domain)}/${state.shot}.webp"
               alt="${esc(state.shot)} screenshot of ${esc(r.name)}"
               style="position:static;width:${state.shot === 'mobile' ? '390px' : '100%'};height:auto;max-width:100%">
        </div>
        <div class="viewtabs">
          <button data-act="shot" data-shot="mobile"
                  aria-pressed="${state.shot === 'mobile'}">Mobile</button>
          <button data-act="shot" data-shot="desktop"
                  aria-pressed="${state.shot === 'desktop'}">Desktop</button>
        </div>
      </div>` : '<div class="stagewrap"><p class="empty">No website, so no capture.</p></div>';

    const sigRow = (k, v, bad) =>
      `<tr${bad ? ' data-bad="1"' : ''}><td>${esc(k)}</td><td>${esc(v)}</td></tr>`;

    const linkList = (links) => links.length
      ? `<div class="kvlist">${links.map(l =>
          `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer"
              >${esc(l.target_domain)}${l.text ? ` — ${esc(l.text)}` : ''}</a>`).join('')}</div>`
      : '<div class="kvlist"><span class="o3">none</span></div>';

    app.innerHTML = `
      ${topbar(`${crumb('Verticals', '#/')} ${SEP} ` +
               `${crumb(r.vertical_label || r.vertical, verticalHash(r.vertical, 'leads'))} ${SEP} ` +
               `${crumb(r.domain || r.name)}`)}
      <div class="deck">
        <aside class="rail">
          <section class="idblock">
            <div class="dom">${esc(r.domain || r.name)}</div>
            <div class="nm">${esc(r.name)}</div>
            <div class="rat">${num(r.review_count)} reviews${r.rating ? ` · ${esc(r.rating)}&#9733;` : ''}</div>
          </section>
          <section>
            <h3>Places</h3>
            <table class="sig"><tbody>
              ${sigRow('category', r.primary_type || '—')}
              ${sigRow('phone',    r.phone || '—')}
              ${sigRow('status',   r.business_status || '—')}
            </tbody></table>
            <div class="kvlist" style="margin-top:8px"><span>${esc(r.address || '')}</span></div>
          </section>
          <section>
            <h3>Site</h3>
            <table class="sig"><tbody>
              ${sigRow('https', r.https_status || '—', r.https_status !== 'ok')}
              ${sigRow('expires', r.cert_expires || '—', r.https_status === 'expired')}
              ${sigRow('http', r.http_status === null ? '—' : r.http_status)}
              ${sigRow('email', r.email || '—')}
            </tbody></table>
          </section>
        </aside>

        ${shots}

        <aside class="rail right">
          <section>
            <h3>Outside links — social</h3>
            ${linkList(r.links.social)}
          </section>
          <section>
            <h3>Outside links — other</h3>
            ${linkList(r.links.other)}
          </section>
          <section>
            <h3>Your call</h3>
            ${tierPicker(r, 'lead')}
            <button class="pitchbtn" data-act="pitch" data-id="${r.company_id}"
                    aria-pressed="${r.pitch}">pitch</button>
            <textarea class="notefield" data-act="note" data-id="${r.company_id}"
                      aria-label="Note" placeholder="note">${esc(r.note || '')}</textarea>
            <div class="agree">${r.reviewed_at ? `reviewed ${esc(String(r.reviewed_at).slice(0, 10))}` : 'not reviewed'}</div>
          </section>
        </aside>
      </div>
      <div class="keys">
        <span><b>A</b><b>B</b><b>C</b><b>X</b> tier</span>
        <span><b>P</b> pitch</span>
        <span><b>Esc</b> back</span>
      </div>`;
  }

  // ---- decisions ---------------------------------------------------------

  /**
   * Save one row's decision.
   *
   * Optimistic: the control flips first so the deck keeps up with a fast
   * reviewer, and reverts with a toast if the PUT fails. `localStorage` is
   * deliberately not involved — a decision that only exists in one browser is a
   * decision that is lost, and the deck must never show a save that did not
   * happen (R9.7).
   */
  async function saveDecision(id, patch) {
    const row = findRow(id);
    if (!row) return;
    const before = { tier: row.tier, pitch: row.pitch, note: row.note };
    Object.assign(row, patch);
    repaintDecision(row);

    try {
      await api(`/api/leads/${id}/decision`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ tier: row.tier ?? null, pitch: !!row.pitch, note: row.note ?? null }),
      });
      row.reviewed_at = (row.tier || row.pitch) ? new Date().toISOString() : null;
    } catch (e) {
      Object.assign(row, before);
      repaintDecision(row);
      say(`not saved — ${e.message}`);
    }
  }

  function findRow(id) {
    if (state.lead && state.lead.company_id === id) return state.lead;
    return state.rows.find(r => r.company_id === id);
  }

  /** Repaint just the controls for one row, so a scroll position survives. */
  function repaintDecision(row) {
    for (const btn of document.querySelectorAll(`[data-act="tier"][data-id="${row.company_id}"]`)) {
      const on = btn.dataset.tier === row.tier;
      btn.setAttribute('aria-checked', String(on));
      btn.setAttribute('aria-pressed', String(on));
    }
    for (const btn of document.querySelectorAll(`[data-act="pitch"][data-id="${row.company_id}"]`)) {
      btn.setAttribute('aria-pressed', String(!!row.pitch));
    }
    if (state.view === 'vertical' && state.tab === 'leads') paintList();
  }

  // ---- events ------------------------------------------------------------

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;

    if (act === 'filter') {
      ev.preventDefault();
      const key = el.dataset.key;
      if (state.filters.has(key)) state.filters.delete(key); else state.filters.add(key);
      go(verticalHash(state.vertical, state.tab, state.filters));
      return;
    }
    if (act === 'tab') {
      ev.preventDefault();
      go(verticalHash(state.vertical, el.dataset.tab, state.filters));
      return;
    }
    if (act === 'more') {
      ev.preventDefault();
      state.offset += PAGE;
      loadPage(false).then(paintList).catch(e => say(e.message));
      return;
    }
    if (act === 'shot') {
      ev.preventDefault();
      state.shot = el.dataset.shot;
      renderLead().catch(e => say(e.message));
      return;
    }
    if (act === 'tier') {
      ev.preventDefault();
      const id  = Number(el.dataset.id);
      const row = findRow(id);
      // A second click on the tier already set clears it — otherwise a misclick
      // on a four-way radio group can never be taken back.
      saveDecision(id, { tier: row && row.tier === el.dataset.tier ? null : el.dataset.tier });
      return;
    }
    if (act === 'pitch') {
      ev.preventDefault();
      const id  = Number(el.dataset.id);
      const row = findRow(id);
      saveDecision(id, { pitch: !(row && row.pitch) });
    }
  });

  // Notes save on blur, not on every keystroke: a note is a sentence, and one
  // PUT per character would be a write per keypress against a shared database.
  document.addEventListener('blur', (ev) => {
    const el = ev.target;
    if (!el.dataset || el.dataset.act !== 'note') return;
    const id  = Number(el.dataset.id);
    const row = findRow(id);
    if (!row || (row.note || '') === el.value) return;
    saveDecision(id, { note: el.value || null });
  }, true);

  document.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'INPUT') return;
    if (state.view !== 'lead' || !state.lead) {
      if (ev.key === 'Escape' && state.view === 'vertical') go('#/');
      return;
    }
    const id = state.lead.company_id;
    const k  = ev.key.toUpperCase();
    if (['A', 'B', 'C', 'X'].includes(k)) {
      ev.preventDefault();
      saveDecision(id, { tier: state.lead.tier === k ? null : k });
    } else if (k === 'P') {
      ev.preventDefault();
      saveDecision(id, { pitch: !state.lead.pitch });
    } else if (ev.key === 'Escape') {
      go(verticalHash(state.lead.vertical, 'leads', state.filters));
    }
  });

  // ---- render ------------------------------------------------------------

  async function render() {
    parseHash();
    try {
      if (state.view === 'lead')          await renderLead();
      else if (state.view === 'vertical') {
        if (!state.verticals.length) state.verticals = await api('/api/verticals');
        await renderVertical();
      } else await renderOverview();
    } catch (e) {
      app.innerHTML = `${topbar(crumb('Verticals', '#/'))}
        <div class="scroll"><div class="wrap"><p class="empty">${esc(e.message)}</p></div></div>`;
    }
  }

  window.addEventListener('hashchange', render);
  render();
})();

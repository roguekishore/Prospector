/* Emit the on-disk artifacts phase one writes, from the sample dataset.
   Run: npm run sample
   Produces data/<vertical>/<domain>/{signals,links,contacts,verdict}.json
   plus leads.csv and agencies.csv at the data root. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { score } = require('../lib-scoring.js');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

// Load data.js, which has no module system. `const` declarations stay in the
// script's lexical scope rather than attaching to the context, so read them
// out through the script's completion value instead.
const src = fs.readFileSync(path.join(ROOT, 'preview', 'data.js'), 'utf8');
const { LEADS, AGENCIES, VERTICALS } =
  vm.runInNewContext(src + '\n;({ LEADS, AGENCIES, VERTICALS });');

const RUN = { id: 'run-2026-09-18T09-20-11Z', city: 'Coimbatore', phase: 'one' };

const w = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
};

let n = 0;

for (const l of LEADS) {
  const dir = path.join(DATA, l.vertical, l.domain);

  w(path.join(dir, 'signals.json'), {
    run: RUN.id,
    domain: l.domain,
    final_url: 'https://' + l.domain + '/',
    captured_at: '2026-09-18T09:34:02Z',
    measured: l.signals,
    flagged: l.bad,
    captures: {
      mobile:  { file: 'mobile.png',  viewport: '390x844',  note: l.signals.viewport === 'missing' ? 'no meta viewport — 980px legacy layout' : 'responsive' },
      desktop: { file: 'desktop.png', viewport: '1440x900' },
      full:    { file: 'full.png',    viewport: '1440xfull' },
    },
    raw: { html: 'raw/home.html', headers: 'raw/headers.json' },
  });

  w(path.join(dir, 'links.json'), {
    run: RUN.id,
    domain: l.domain,
    counts: l.links,
    agency_credit: l.agency
      ? { name: l.agency.name, domain: l.agency.domain, raw_text: l.agency.credit, region: 'footer' }
      : null,
  });

  w(path.join(dir, 'contacts.json'), {
    run: RUN.id,
    domain: l.domain,
    address: l.address,
    contacts: l.contacts,
    source: 'business own contact page + footer',
  });

  // Deterministic score, computed by the real scorer — not asserted.
  // Recomputable from signals.json + links.json + contacts.json alone.
  const sc = score({
    signals: l.signals, links: l.links, contacts: l.contacts,
    rating: l.rating, reviews: l.reviews, agency: l.agency, refYear: 2026,
  });

  w(path.join(dir, 'score.json'), {
    run: RUN.id,
    domain: l.domain,
    ...sc,
    flaws: l.bad,
    pitch_angle: l.angle,
  });

  n++;
}

/* flat exports */

const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';

const leadRows = LEADS
  .slice()
  .sort((a, b) => b.score - a.score)
  .map(l => {
    const ph = l.contacts.find(c => c.kind === 'phone');
    const em = l.contacts.find(c => c.kind === 'email');
    const sc2 = score({signals:l.signals,links:l.links,contacts:l.contacts,rating:l.rating,reviews:l.reviews,agency:l.agency,refYear:2026});
    return [sc2.tier, sc2.score, l.vertical, l.domain, l.name, l.address,
            ph ? ph.value : '', em ? em.value : '', l.rating, l.reviews,
            l.agency ? l.agency.name : '', l.angle].map(q).join(',');
  });

fs.writeFileSync(path.join(DATA, 'leads.csv'),
  '﻿' + [['tier','score','vertical','domain','business','address','phone','email',
               'rating','reviews','built_by','pitch_angle'].map(q).join(','),
              ...leadRows].join('\r\n') + '\r\n', 'utf8');

const agRows = AGENCIES.map(a => [
  a.name, a.domain, a.builtInRun, a.portfolioClients,
  a.pricing.map(p => p.tier + ' ' + p.price).join(' | '), a.note,
].map(q).join(','));

fs.writeFileSync(path.join(DATA, 'agencies.csv'),
  '﻿' + [['agency','domain','built_in_run','portfolio_clients','published_pricing','note']
               .map(q).join(','), ...agRows].join('\r\n') + '\r\n', 'utf8');

w(path.join(DATA, 'run.json'), {
  ...RUN,
  verticals: VERTICALS.map(v => ({
    slug: v.slug, discovered: v.discovered, with_domain: v.withDomain, audited: v.audited,
  })),
  judged: n,
  stages: ['discover', 'qualify', 'audit', 'extract', 'judge', 'report'],
});

console.log('wrote ' + n + ' lead folders + 3 run files under data/');

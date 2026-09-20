/* ============================================================
   PROSPECTOR — deterministic scorer.  rules@1
   Pure function: signals + business facts -> pain, pay, score, tier.
   No model, no network, no clock. Same input, same output, forever.
   Reference implementation. W3 owns this file; W4 only reads its output.
   ============================================================ */

'use strict';

/* Every weight lives here. Retuning the shortlist = editing this block. */
const W = {
  stale:  { perYear:4, maxYears:11, neverRedesigned:6,
            legacyJquery:5, legacyBootstrap:3, legacySlider:5, oldGenerator:4 },
  mobile: { noViewport:14, overflowPerPx:0.04, overflowCap:12, tapPer:0.35, tapCap:7 },
  trust:  { noHttps:18, expiredCert:20, mixedPer:0.8, mixedCap:6,
            brokenPer:1.2, brokenCap:8, deadPer:0.6, deadCap:5 },
  perf:   { lcpBucket:{ fast:0, ok:3, slow:7, dire:11 }, weightPerMb:0.7, weightCap:8 },
  pay:    { reviewsFull:120, ratingFloor:3.8, agedDomainYears:5 },

  // Pain denominator. A totally broken site lands near 115, so 150 keeps the
  // worst case under 1.0 and leaves the top of the range unsaturated — every
  // tier-A lead still orders against every other one.
  painFull: 150,
  spread:   2.25,

  cuts:   { A:62, B:42, C:24 },          // >=A hot, >=B warm, >=C weak, else X

  // A gate decides the tier, so it must also pull the score into that tier's
  // band — otherwise a gated lead reads "C" while sorting above every A.
  gateCeil: { A:100, B:61, C:43, X:23 },
};

/* ---- parsing helpers. Tolerant: unknown/absent never throws. ---- */

const num = s => { const m = /-?\d+(\.\d+)?/.exec(String(s ?? '')); return m ? +m[0] : null; };
const yr  = s => { const m = /(19|20)\d{2}/.exec(String(s ?? '')); return m ? +m[0] : null; };
const has = s => { const v = String(s ?? '').toLowerCase();
                   return !(v === '' || v === 'none' || v === 'missing' || v === 'n/a' || v === 'no'); };

/* LCP enters as a bucket, never a float — it is the one non-reproducible
   measurement, and the bucket is all the score ever used. */
function lcpBucket(v){
  const n = num(v);
  if(n == null) return 'ok';
  return n < 2.5 ? 'fast' : n < 4 ? 'ok' : n < 6 ? 'slow' : 'dire';
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const r2 = n => Math.round(n * 100) / 100;

/* ---- the four pain axes ---- */

function staleness(s, refYear){
  let p = 0;
  const built = yr(s.redesigned) || yr(s.copyright) || yr(s.wayback);
  if(built) p += clamp(refYear - built, 0, W.stale.maxYears) * W.stale.perYear;

  const first = yr(s.wayback);
  if(first && !yr(s.redesigned) && String(s.redesigned||'').toLowerCase() !== 'n/a'){
    p += W.stale.neverRedesigned;                    // never visually changed
  }
  const jq = num(s.jquery);
  if(jq != null && jq < 3)                    p += W.stale.legacyJquery;
  const bs = num(s.bootstrap);
  if(bs != null && bs < 4)                    p += W.stale.legacyBootstrap;
  if(/revslider|revolution|nivo|owl|cycle|flexslider/i.test(s.slider || ''))
                                              p += W.stale.legacySlider;
  const wp = /wordpress\s*([\d.]+)/i.exec(s.generator || '');
  if(wp && parseFloat(wp[1]) < 5.5)           p += W.stale.oldGenerator;
  if(/frontpage|static html|table/i.test(s.generator || '' ) ||
     /table/i.test(s.theme || ''))            p += W.stale.oldGenerator;
  return r2(p);
}

function mobileBroken(s){
  let p = 0;
  if(String(s.viewport).toLowerCase() === 'missing') p += W.mobile.noViewport;
  p += clamp((num(s.overflow) || 0) * W.mobile.overflowPerPx, 0, W.mobile.overflowCap);
  p += clamp((num(s.tapTargets) || 0) * W.mobile.tapPer,      0, W.mobile.tapCap);
  return r2(p);
}

function trustBroken(s, links){
  let p = 0;
  const h = String(s.https || '').toLowerCase();
  if(/none|http only|^no$/.test(h))     p += W.trust.noHttps;
  else if(/expired|invalid|self/.test(h)) p += W.trust.expiredCert;
  p += clamp((num(s.mixedContent)  || 0) * W.trust.mixedPer,  0, W.trust.mixedCap);
  p += clamp((num(s.brokenImages)  || 0) * W.trust.brokenPer, 0, W.trust.brokenCap);
  p += clamp(((links && links.dead) || 0) * W.trust.deadPer,  0, W.trust.deadCap);
  return r2(p);
}

function perfPain(s){
  let p = W.perf.lcpBucket[lcpBucket(s.lcp)];
  p += clamp((num(s.pageWeight) || 0) * W.perf.weightPerMb, 0, W.perf.weightCap);
  if(has(s.heroVideo)) p += 2;
  return r2(p);
}

/* ---- ability to pay: 0..1, multiplicative ---- */

function ability(biz, s){
  const reviews = biz.reviews || 0;
  const rating  = biz.rating  || 0;

  // Review count is the strongest size proxy available. sqrt so 200 reviews
  // is not 10x a 20-review shop — it is roughly 3x, which matches reality.
  let a = Math.sqrt(clamp(reviews, 0, W.pay.reviewsFull) / W.pay.reviewsFull);

  if(rating && rating < W.pay.ratingFloor) a *= 0.75;      // may be struggling
  if((num(s.domainAge) || 0) >= W.pay.agedDomainYears) a = a * 0.85 + 0.15;

  // Proven spend. Someone who paid an agency once will pay again; someone on a
  // free builder has never paid anyone. This is the axis the ugliest sites fail.
  if(s._agency)                                  a = a * 0.8 + 0.20;
  if(has(s.whatsapp) || has(s.quoteForm))        a = a * 0.9 + 0.10;  // buys leads

  return r2(clamp(a, 0, 1));
}

function reach(contacts){
  const k = new Set((contacts || []).map(c => c.kind));
  if(k.has('phone') && (k.has('email') || k.has('instagram'))) return 1;
  if(k.has('phone') || k.has('email'))                         return 0.8;
  return 0.4;
}

/* ---- gates: hard rules that outrank the arithmetic ---- */

function gate(s, biz, pain){
  if(/ai site builder|wix|weebly|godaddy builder|builder default/i
      .test((s.generator || '') + ' ' + (s.theme || '')))
    return { tier:'C', why:'built on a free/AI builder — never paid for a site' };

  if((num(s.domainAge) || 99) < 1 && (biz.reviews || 0) < 10)
    return { tier:'C', why:'domain under a year old with almost no reviews' };

  if(pain < 12)
    return { tier:'X', why:'no measurable pain — nothing to sell' };

  // A one-man trade with a wrecked site is maximum pain and minimum budget.
  // Without this gate the pain term alone floats them into tier A.
  if((biz.reviews || 0) < 20 && pain > 45)
    return { tier:'C', why:'maximum pain, minimum budget — fixed-price only' };

  return null;
}

/* ---- public entry point ---- */

function score(input){
  const s        = input.signals || {};
  const links    = input.links   || {};
  const contacts = input.contacts|| [];
  const biz      = { rating: input.rating, reviews: input.reviews };
  const refYear  = input.refYear || 2026;     // injected, never read from a clock

  s._agency = !!input.agency;

  const parts = {
    staleness: staleness(s, refYear),
    mobile:    mobileBroken(s),
    trust:     trustBroken(s, links),
    perf:      perfPain(s),
  };
  const pain = r2(parts.staleness + parts.mobile + parts.trust + parts.perf);
  const pay  = ability(biz, s);
  const rch  = reach(contacts);

  // Three multiplied axes, then one spread constant. A pure product compresses
  // everything toward zero, so `spread` reopens the usable range.
  const share = clamp(pain / W.painFull, 0, 1);
  let sc = Math.round(clamp(share * pay * rch * W.spread * 100, 0, 100));

  const g = gate(s, biz, pain);
  const tier = g ? g.tier
             : sc >= W.cuts.A ? 'A'
             : sc >= W.cuts.B ? 'B'
             : sc >= W.cuts.C ? 'C' : 'X';

  // Keep score inside the gated tier's band so sort order always agrees
  // with the tier letter shown next to it.
  if(g) sc = Math.min(sc, W.gateCeil[tier]);

  return { scorer:'rules@1', pain, pain_parts:parts, pay, reach:rch,
           score:sc, tier, gate:g ? g.why : null, lcp_bucket:lcpBucket(s.lcp) };
}

module.exports = { score, WEIGHTS: W, lcpBucket };

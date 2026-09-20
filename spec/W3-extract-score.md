# W3 — Extract, Score, Report

**Read `MASTER.md` first.** This is the largest workstream and owns the spine.

**Owns:** `src/extract/`, `src/score/`, `src/report/`, `src/cli/`, `src/db/`,
`src/server/`, `config/angles.json`, `config/agency-aliases.json`
**Writes:** `signals.json`, `links.json`, `contacts.json`, `score.json` per
domain; `index.json`, `_leads.csv`, `_pitch.csv`, `_agencies.csv`, `_run.json`;
`index.db`
**Reads:** `raw/home.html`, `raw/rendered.html`, `raw/headers.json` (W2),
`_qualified.json` (W1)
**Blocked by:** nothing. 18 complete fixture lead folders already exist under
`data/`, and `lib-scoring.js` is written. Develop against those.

**Never touches the network.** Every value is derived from saved bytes. If you
find yourself needing a fetch, the value belongs in W1 or W2 — with one explicit
exception: agency pricing and portfolio pages (§6), which are fetched here
because agencies are not leads and are only discovered after extraction.

---

## 1. Stage `extract`

Input: one domain's `raw/` directory. Output: `signals.json`, `links.json`,
`contacts.json`. Pure function of the input bytes.

Parse with `cheerio` (pinned). Use `rendered.html` for links, text, and contacts;
use `home.html` for generator and framework detection, because build tools often
strip `<meta name="generator">` at runtime.

### 1.1 Signal extractors — each is a small pure function

Write one function per signal in `src/extract/signals/`, each with the signature
`(ctx) => string` where `ctx = { $home, $rendered, headers, html, qualified }`.
Return `"none"` / `"missing"` when absent — never `null`, never throw.

**copyright** — search footer text for `©`, `&copy;`, `Copyright`, then the last
4-digit year 1990–refYear in that text. Prefer the **last** `<footer>`, falling
back to the last 15% of body text. Return the year as a string.

```
/(?:©|&copy;|copyright)[^\d]{0,40}((?:19|20)\d{2})/i
```

When a range appears (`2015-2019`), take the **later** year. When multiple
footers disagree, take the highest.

**jquery** — in order of reliability:
1. `<script src>` filename: `/jquery[.-]?(\d+\.\d+(\.\d+)?)/i`
2. `jQuery.fn.jquery = "1.12.4"` in inline script text
3. `/jquery/i` present but no version → return `"present"` (the scorer treats an
   unparseable version as unknown, not legacy)

**bootstrap** — same pattern against `bootstrap` in `src/`/`href`, plus the
`/*! Bootstrap v3.3.7 */` banner comment in inline CSS.

**slider** — first match wins, return `"<name> <version|''>"`:

```
revslider|rev_slider|revolution   → "revslider"
nivo                              → "nivo slider"
owl[.-]?carousel                  → "owl carousel"
flexslider                        → "flexslider"
jquery[.-]cycle                   → "jquery cycle"
slick(?![a-z])                    → "slick"
swiper                            → "swiper"
splide|embla|keen-slider          → "<name>"        ← modern, not flagged
```

Version from the same filename when present. The first five are the
"dated template" signal; `swiper`/`splide`/`embla` are modern and must not be
flagged (see `MASTER.md §4.5`).

**generator** — `<meta name="generator" content>` verbatim. Then fallbacks:
`/wp-content/` or `/wp-includes/` → `"WordPress"` with version from
`?ver=X.Y.Z` on a core asset; `/_next/static/` → `"Next.js"`;
`Wix|_partials/|wixstatic` → `"Wix"`; `squarespace` → `"Squarespace"`;
`shopify` → `"Shopify"`; `FrontPage|Microsoft Word` → that string.
No match → `"static html"`.

**theme** — from a `/wp-content/themes/<slug>/` path, return `"<slug>"`. When the
slug is in `config/themeforest-slugs.json`, append `" (ThemeForest)"`. Also read
the `Theme Name:` header from `style.css` if that URL appears in the asset list.

**domainAge** — `qualified.wayback_first` to refYear. Prefer WHOIS creation date
if W1 recorded one; Wayback first-snapshot is the fallback. Return `"11 yr"` or
`"4 mo"` when under a year.

**wayback** — `qualified.wayback_first`, or `"none"`.

**redesigned** — this one matters and needs care. `"never"` when Wayback's first
and last snapshots share the same visual structure; `"<year>"` otherwise; `"n/a"`
when Wayback has fewer than 2 snapshots. Since W3 has no network, W1 must record
both snapshot years; if only one is available, return `"n/a"`. **Do not fetch
Wayback here.** A heuristic on copyright vs. first-snapshot is acceptable:
`copyright year > wayback year + 1` → `"<copyright year>"`, else `"never"`.

**viewport** — `headers.mobile.hasViewportMeta` from W2 (authoritative, measured
in a real layout). Fall back to a regex on `home.html` only if absent.
Return `"present"` or `"missing"`.

**overflow** — `"+" + headers.mobile.overflowPx + "px"`, or `"0px"`.

**tapTargets** — `headers.mobile.tapTargetsUnder44 + " under 44px"`.

**lcp** — `(headers.timing.lcp_ms / 1000).toFixed(1) + "s"`. Raw here; the
scorer buckets it (`MASTER.md §5.2`).

**pageWeight** — `headers.timing.transfer_bytes` → `"11.2 MB"`.

**heroVideo** — the largest `video` or `.mp4`/`.webm` asset in the first 1200px
of DOM order, or any `<video autoplay>`. Return
`"6.1 MB mp4, autoplay"` / `"none"`.

**https** — from `qualified`: `"ok"`, `"none — http only"`, or
`"expired " + YYYY-MM` when the cert is past `valid_to`.

**mixedContent** — count of `http://` (not `https://`, not protocol-relative)
URLs in `src`/`href`/`srcset` on an HTTPS page → `"3 assets"` / `"none"`.

**brokenImages** — `headers.broken_requests` filtered to image types, plus
`<img>` with empty or missing `src` → count as string.

**whatsapp** — `wa.me`, `api.whatsapp.com`, `whatsapp://`, or a class/id matching
`/whats-?app/i`. Return `"float button"` when the element is
`position: fixed`-ish by class name heuristic, else `"present"`, else `"none"`.

**quoteForm** — in priority order: a `<form>` with a `method="post"` action →
`"<plugin> form"` where plugin is detected from `wpcf7`/`wpforms`/`gform`
classes; `mailto:` only → `"mailto: only"`; a form whose action is a dead
endpoint per `headers.broken_requests` → `"broken"` (this fires the highest-value
angle, `form-broken`); nothing → `"none"`.

**blog** — a nav or footer link matching `/blog|news|articles/i`; when the linked
page's date appears in text, `"last post 2021"`, else `"present"`, else `"none"`.

### 1.2 flagged

Apply `MASTER.md §4.5` exactly. Implement it as a **data table**, not a chain of
`if`s, so the thresholds stay auditable:

```js
const FLAG_RULES = {
  viewport: v => v === 'missing',
  overflow: v => num(v) > 0,
  tapTargets: v => num(v) >= 5,
  lcp: v => ['slow','dire'].includes(lcpBucket(v)),
  // ... one line per key in §4.5
};
```

Order `flagged` by descending scorer weight so the deck's inverted rows read
worst-first and angle selection (§4) sees severity order.

### 1.3 links.json

Extract from `rendered.html`. Wider than `a[href]`:

```js
$('a[href], area[href]').each(...)
```

Plus shadow DOM and iframes are **out of scope** — W2 captures no shadow content
and iframe links belong to third parties. Record `counts.socials` from the
platform list, not from iframes.

Normalise every href:

```js
const abs = new URL(href, baseURI);      // baseURI = final_url
abs.hash = '';                           // drop fragments
for (const p of ['utm_source','utm_medium','utm_campaign','utm_term',
                 'utm_content','gclid','fbclid','mc_cid','mc_eid'])
  abs.searchParams.delete(p);            // strip tracking
```

Classify `kind` by scheme and registrable-domain comparison against the lead's
own domain. `region` from the nearest ancestor `nav`/`header`/`footer`/`main`/
`aside`, else `"main"`. `visible` from `getComputedStyle` — **not available in
cheerio**, so W2 must record hidden-link count, or default `visible: true` and
document the limitation. Prefer the latter; it affects nothing downstream.

**Dead links:** probe internal links only, cap 40, `HEAD` with 5s timeout,
concurrency 4, 1500ms per-host spacing. This is the one network call `extract`
makes for a lead, and it exists because dead links are a trust signal. Make it
skippable with `--no-probe` so a pure-offline re-run is always possible.

### 1.4 contacts.json

Phones — Indian formats, and be strict or you will collect garbage:

```
/(?:\+?91[\s-]?)?(?:0)?([6-9]\d{9})\b/          mobile: starts 6-9, 10 digits
/(?:\+?91[\s-]?)?(?:0?422)[\s-]?(\d{6,7})\b/    Coimbatore landline STD 0422
```

Prefer `tel:` hrefs over body text. Normalise to `+91 XXXXX XXXXX`. Reject
anything matching a year range, a price, a PIN code (6 digits alone), or a GSTIN.

Emails — `mailto:` first, then `/[\w.+-]+@[\w-]+\.[\w.]{2,}/`. Reject
`example.com`, `sentry.io`, `wixpress.com`, `.png`/`.jpg` suffixes (CSS artifacts),
and anything inside a `<script>`.

Address — prefer `<address>`, then JSON-LD `PostalAddress`, then a text block
containing a 6-digit PIN starting `641` (Coimbatore) or `6[34]\d{4}` (Tamil Nadu).
Fall back to `qualified.address` from Places.

Socials, hours — `instagram.com/`, `facebook.com/`, and JSON-LD
`openingHours`/`openingHoursSpecification`.

**`owner` is provisional at this stage.** Set `"business"` for everything and let
`report` finalise it via the cross-site rule (§5). Document this in code; it is
the easiest thing in the system to get wrong.

---

## 2. Stage `score`

Thin. `lib-scoring.js` is written, calibrated, and frozen as `rules@1` — wire it,
do not reimplement it.

```js
const { score } = require('../../lib-scoring.js');

const sc = score({
  signals: signalsJson.measured,
  links:   linksJson.counts,
  contacts: contactsJson.contacts,
  rating:   business.rating,
  reviews:  business.review_count,      // ← ability-to-pay axis. never drop.
  agency:   !!linksJson.agency_credit,
  refYear:  config.refYear,             // 2026. never Date.now().
});
```

Write `score.json` = `sc` plus `run`, `domain`, `flaws` (copied from
`signals.flagged`), `pitch_angle` and `angle_template` (§4).

**Guard:** if `rating` or `review_count` is `undefined` for a domain that exists
in `_qualified.json`, fail that domain loudly with `error.json`. A silently
missing ability-to-pay axis produces plausible-looking but meaningless tiers,
which is the worst failure mode in the system.

`score` must complete a 200-lead vertical in under 2 seconds. It reads JSON and
does arithmetic; anything slower means something is doing I/O it should not.

---

## 3. Stage `report`

Runs last, over all domains at once. Three jobs that cannot be done per-domain.

1. Finalise contact ownership (§5).
2. Build the agency table, including pricing (§6).
3. Emit `index.json` and the CSVs.

---

## 4. Angle and reason selection

Load `config/angles.json` (`MASTER.md §6`). Walk in order; first template whose
`when` keys are **all** present in `flagged` wins. `guard`, when present, must
also substring-match the raw `measured` value of the first `when` key.

```js
function pickAngle(flagged, measured, templates) {
  for (const t of templates) {
    if (!t.when.every(k => flagged.includes(k))) continue;
    if (t.guard && !String(measured[t.when[0]] ?? '').toLowerCase()
                     .includes(t.guard)) continue;
    return t;
  }
  return templates[templates.length - 1];        // the "generic" catch-all
}
```

When `score.gate` is non-null the gate reason **overrides** the template: a
tier-X lead's angle reads `"No measurable pain. Skip."`, never a sales line.

`reasons[]` in `index.json` is generated the same way: one sentence per flagged
key from `config/reasons.json` (same shape, keyed by single signal), ordered by
descending scorer weight, capped at 5. No prose is hand-authored per lead and
none is generated by a model.

---

## 5. Contact ownership — the cross-site frequency rule

`MASTER.md §7.3`. This is the reason `report` exists as a separate stage.

```js
const seen = new Map();                        // value → Set<domain>
for (const lead of allLeads)
  for (const c of lead.contacts)
    if (c.kind === 'phone' || c.kind === 'email')
      (seen.get(c.value) ?? seen.set(c.value, new Set()).get(c.value)).add(lead.domain);

for (const lead of allLeads)
  for (const c of lead.contacts) {
    if ((seen.get(c.value)?.size ?? 1) > 1) { c.owner = 'agency'; continue; }
    if (nearCreditText(lead, c.value, 200))    { c.owner = 'agency'; continue; }
    c.owner = 'business';
  }
```

Normalise before comparing: strip spaces, dashes, and a leading `+91`/`0` from
phones; lowercase emails. Otherwise `+91 99943 11447` and `9994311447` read as
two different numbers and the rule silently never fires.

Rewrite `contacts.json` in place with final owners so the file on disk and
`index.json` agree.

---

## 6. Agency table

For every distinct `links.agency_credit`:

1. Normalise the name per `MASTER.md §7.2` through
   `config/agency-aliases.json`. Prefer the credit link's registrable domain as
   the identity key — a domain is unambiguous, a name is not.
2. Count `builtInRun` = leads in this run carrying that credit.
3. **Fetch pricing** (`MASTER.md §7.4`). Try `/pricing`, `/packages`, `/plans`,
   `/rates`, `/price`; stop at the first 200. Currency regex plus nearest
   preceding heading. No match → `[{"tier":"Not published","price":"—"}]`.
   Never infer a price.
4. **Fetch the portfolio** (`MASTER.md §7.5`). Try `/portfolio`, `/clients`,
   `/work`, `/projects`; extract outbound registrable domains excluding the
   agency's own and the §2.6 social list. Record `portfolio_clients` as a count
   and write the domains to `data/_expansion.json` as candidate leads with
   `source: "agency-portfolio:<agency domain>"`.

Max 2 pages per agency, robots.txt honoured, same politeness as `MASTER.md §8`.
There are 4–10 agencies per run, so this is seconds of work and is the
compounding feature of the whole system.

Make it skippable with `--no-agency-fetch` so `report` is offline-capable.

---

## 7. `index.json`

Exactly `MASTER.md §4.7`. One file, one fetch, no per-lead requests — W4 loads
nothing else. Include `synthetic: true` when built from fixtures (`MASTER.md
§10`); W4 renders a permanent banner on that flag.

Sort `leads` by descending `score`, then ascending `domain` for stability. An
unstable sort makes every `index.json` diff unreadable.

Keep it under ~4MB for 500 leads by **not** inlining `links[]` — only
`links.counts` goes into `index.json`. The deck reads counts; nothing in the UI
needs 64 individual hrefs.

---

## 8. CSV exports

UTF-8 **with BOM** (`﻿`), CRLF line endings, every field quoted, `"` escaped
as `""`. Without the BOM, Excel on Windows mangles `₹` and Tamil text.

```
_leads.csv     tier,score,vertical,domain,business,address,phone,email,
               rating,reviews,built_by,pitch_angle
_pitch.csv     + your_tier,note        — operator-marked rows only
_agencies.csv  agency,domain,built_in_run,portfolio_clients,
               published_pricing,note
```

---

## 9. SQLite

Schema is frozen in `MASTER.md §12`. Two rules:

- `scores` is rewritten on every `score` run. `reviews` is **never** written by
  any pipeline stage — only by the review API (§10). A re-run must not erase the
  operator's marks.
- Use `WITHOUT ROWID` where the PK is a text domain, and `PRAGMA journal_mode =
  WAL`. Wrap bulk inserts in a single transaction; 500 individual inserts
  outside one is visibly slow.

---

## 10. Review API — the contract W4 depends on

`src/server/` serves `preview/` statically plus five JSON endpoints on
`127.0.0.1:7777`. **Localhost bind only** — never `0.0.0.0`. No auth, because it
is loopback-only and single-user; do not add a login, and do not expose it.

```
GET    /api/index.json              → index.json, Cache-Control: no-store
GET    /api/reviews                 → {"<domain>": {human_tier, pitch, note}}
PUT    /api/review/:domain          body {human_tier, pitch, note} → 204
POST   /api/export/pitch            regenerates _pitch.csv → {path, rows}
GET    /data/*                      static PNGs
```

`PUT` validates `human_tier ∈ {A,B,C,X,null}` and `pitch ∈ {true,false}`,
rejects an unknown domain with 404, and upserts into `reviews`. Body limit 8KB.

`:domain` is used to build no filesystem path in this handler; it is a SQL
parameter only. If you ever do join it to a path, validate it against
`/^[a-z0-9.-]+$/` first — a domain arriving as `../..` must never escape `data/`.
Same rule for the `/data/*` static handler: resolve, then assert the result is
still inside `data/`.

**W4 must work without this server** (`file://`, localStorage fallback), so every
endpoint is an enhancement, never a requirement. The frontend detects
availability with a single `GET /api/reviews` and falls back silently.

---

## 11. CLI

```
node src/cli <stage> [<vertical>] [options]

stages:  discover qualify audit extract score report serve all
common:  --resume --concurrency N --only <domain> --dry-run --verbose
extract: --no-probe                  skip dead-link probing (fully offline)
report:  --no-agency-fetch           skip pricing/portfolio (fully offline)
score:   --ref-year 2026
serve:   --port 7777
```

`all` runs the six stages in order and stops at the first stage that produces
zero output. Exit codes: `0` success, `1` partial (some domains errored),
`2` fatal (config or I/O).

`--dry-run` on any stage prints what it would do and touches nothing.

Every stage prints a one-line summary and appends to `data/_run.json` with
`stage`, `started_at`, `finished_at`, counts, and a `config_hash` — the SHA-256 of
the merged config plus `lib-scoring.js`'s `WEIGHTS`. A changed hash explains a
changed ranking, which is the difference between a tuning decision and a mystery.

---

## 12. Acceptance criteria

1. `extract --only blitzglobe.com` over the existing fixture `raw/` reproduces
   its `signals.json` field-for-field.
2. `score` over all 18 fixtures reproduces `rules@1` output exactly, and the
   calibration check still reports 15/18 against hand labels (`MASTER.md §5.4`).
3. `extract && score && report` run twice over unchanged `raw/` produce
   **byte-identical** `signals.json`, `score.json`, and `index.json`.
   Verify with a hash comparison in a test; this is the core guarantee.
4. `--no-probe --no-agency-fetch` completes with the network physically
   unavailable.
5. A phone number appearing on two leads' sites is marked `owner: "agency"` on
   both, and the normalisation makes `+91 99943 11447` and `9994311447` the same
   value.
6. A domain missing `review_count` fails loudly with `error.json` rather than
   scoring.
7. `score` on a domain whose `signals.https` is `"expired 2024-11"` selects the
   `cert-expired` angle, not `mobile-gallery-broken`, even when both match.
8. A tier-X lead's `pitch_angle` is the gate reason, not a sales sentence.
9. Re-running `score` does not modify any row in `reviews`.
10. `PUT /api/review/blitzglobe.com` then `GET /api/reviews` round-trips, and
    `POST /api/export/pitch` writes a BOM-prefixed CSV containing that row.
11. `index.json` for 500 leads stays under 4MB.
12. `GET /data/../../../../etc/passwd` returns 403 or 404, never a file.

## 13. Do not

- Do not call a model, an LLM endpoint, or `kclaude` anywhere in this workstream.
  Tier, score, angle, reasons, credit normalisation, and contact ownership are
  all deterministic by design (`MASTER.md §1.3`).
- Do not read `Date.now()` inside scoring or flagging. `refYear` is injected.
- Do not re-fetch a lead's HTML. `raw/` is the source of truth.
- Do not rename a lead folder to encode tier.
- Do not write to `reviews` from any stage.
- Do not bind the server to anything but `127.0.0.1`.
- Do not reimplement `lib-scoring.js`. Retune its `WEIGHTS` block and bump
  `scorer` to `rules@2` when you do.

# PROSPECTOR — Master Specification

**Status:** frozen. Every contract in this document is law for all workstreams.
**Scope:** full system. CRM excluded — it folds in after this completes (§11).
**Determinism:** the pipeline is a pure function of saved bytes. No LLM, no model
endpoint, no API key for judging, no randomness, no wall-clock read inside
scoring. Same inputs produce byte-identical outputs, forever.

Read this document first. Then read only your own workstream spec:

| Spec | Owns | Depends on |
|---|---|---|
| `W1-discovery.md` | `discover`, `qualify` | nothing (Places contract only) |
| `W2-capture.md` | `audit` | W1 output shape (§4.0) |
| `W3-extract-score.md` | `extract`, `score`, `report`, CLI, SQLite | W2 output shape (§4.6) |
| `W4-frontend.md` | dashboard, review deck, exports UI | `index.json` (§4.7) |

**All four can start immediately.** The contracts below are already instantiated
as real files on disk under `data/` — 18 lead folders written by
`emit-sample.js`. Those files are the normative examples. No workstream waits for
another to exist.

---

## 1. What this system is for

Find businesses in Coimbatore who **already pay for a website** and whose current
site is dated or broken enough that a redesign is an easy sell. Produce, per
business: screenshots, measured signals, every hyperlink, contact details, the
agency that built the current site, a tier, and a ready-to-send pitch sentence.

One operator reviews the shortlist in a keyboard-driven deck, marks what is worth
pitching, exports a CSV, and pitches by email or WhatsApp with the mobile
screenshot attached.

### 1.1 The core insight — two axes, never one

Ranking by ugliness alone fills the shortlist with one-man carpenters on free
builders. In the calibration set the **ugliest site is the worst lead**:
`bestinterior.co` is an AI site-builder page, which means nobody ever paid for a
website and nobody will.

```
score = pain × ability_to_pay × reachability
```

A business on a paid 2016 agency template with a WhatsApp float button has proven
it writes cheques for a website and is actively buying leads. That is the money.
Any axis near zero removes the lead regardless of the others.

### 1.2 Non-goals

- No dialler, no email sender, no outreach automation. The pipeline ends at a CSV.
- No vision model and no machine aesthetic judgement. **The machine measures; the
  human decides.** Taste happens in the review deck.
- No multi-city support. The Coimbatore bounding box is a constant.
- No CRM tables in v1. §11 reserves the shape so it lands without a migration.

### 1.3 Why there is no LLM anywhere

Earlier drafts of this design used a model for verdicts, pitch prose, agency
pricing, credit normalisation, and contact attribution. Every one collapsed into
deterministic code:

| Was going to be LLM | Is actually |
|---|---|
| Tier / score verdict | Weighted formula over measured fields (§5) |
| Pitch angle prose | Template lookup keyed by dominant flaw (§6) |
| Agency credit normalisation | Verb-prefix strip + alias map (§7.2) |
| Contact attribution | Cross-site frequency rule (§7.3) |
| Agency pricing extraction | Currency regex + nearest heading (§7.4) |

The result is reproducible, auditable, instant, free, and offline. It also means
no model-gateway failure mode can corrupt a tier. **Do not reintroduce a model
anywhere in the pipeline.** If a judgement feels like it needs one, it belongs in
the review deck as a human decision.

---

## 2. Architecture

One local Node process. Disk holds artifacts, SQLite holds queryable state, a
static frontend reads a generated JSON index. No cloud, no auth, no server-side
rendering.

```
node 20+            plain JS (CommonJS). TypeScript optional, not required.
playwright          chromium headless-shell. Capture only.
better-sqlite3      synchronous, single file.
fastify             serves preview/ and index.json on 127.0.0.1. Localhost only.
vanilla js frontend no build step, no framework, no bundler.
```

Dependencies are pinned to exact versions in `package.json` — no `^`, no `~`.

### 2.1 Six stages

```
discover <vertical>  grid-tile the city, keyword variants, dedupe by registrable domain
qualify              HEAD + cert + viewport probe + wayback cdx   (no browser, ~50ms/site)
audit                playwright: 3 captures + save raw html       (the slow stage)
extract              signals, links, contacts, agency credits     (pure code, over raw/)
score                the weighted formula → tier, score, angle    (pure code, instant)
report               rebuild index.json + CSV exports
```

`qualify` before `audit` is the cost lever: it kills parked domains, dead hosts,
and Instagram-only businesses for nearly nothing, so the browser only ever opens
for real candidates. Expect per vertical: 300–800 discovered, 150–250 with their
own domain, ~120 worth rendering.

`extract` and `score` run **over saved bytes in `raw/`**, never over the network.
Improving an extractor or retuning a weight is a seconds-long re-run.
**This is the single most important property of the design.** Every stage must
preserve it. A stage that needs the network to re-derive a value has a bug.

### 2.2 Stage contract — applies to all six

- **Idempotent.** Running twice produces the same result. Never append.
- **Resumable.** `--resume` skips any domain whose output file already exists.
- **Per-domain atomic.** Write `<name>.json.tmp`, `fsync`, then rename. A kill
  mid-run never leaves a half-written JSON.
- **Fail-soft per domain.** A domain's failure is written to that domain's
  `error.json` and never aborts the run.
- **No stage reads another stage's internals.** Only the frozen files in §4.
- **No stage mutates another stage's files.** `score` never edits `signals.json`.

---

## 3. Directory layout — FROZEN

```
PROSPECTOR/
  spec/                 this document + four workstream specs
  lib-scoring.js        the scorer. Reference implementation, already written.
  emit-sample.js        regenerates data/ from preview/data.js + lib-scoring.js
  src/
    discover/           W1
    capture/            W2
    extract/            W3
    score/              W3
    cli/                W3
  preview/              frontend. app.css is the DESIGN CONTRACT (§9)
    data.js             18 SYNTHETIC leads — frontend dev only (§10)
  config/               city.json  verticals.json  angles.json  reasons.json
                        agency-aliases.json  themeforest-slugs.json
  fixtures/places/      recorded provider responses, replayed by --source fixture
  .env                  GOOGLE_PLACES_KEY — gitignored, never logged
  data/
    <vertical>/
      <domain>/
        mobile.png      390×844    capture
        desktop.png     1440×900   capture
        full.png        1440×full  capture
        signals.json    measured facts                 (W3 writes)
        links.json      every hyperlink, classified    (W3 writes)
        contacts.json   phones, emails, address        (W3 writes)
        score.json      tier, score, angle             (W3 writes)
        error.json      present only on failure
        raw/
          home.html     verbatim response body         (W2 writes)
          headers.json  response headers + timing      (W2 writes)
    _run.json           run manifest
    _leads.csv          flat export, all leads
    _pitch.csv          flat export, operator-marked only
    _agencies.csv       agency → sites built → pricing
    index.json          what the frontend reads
  index.db              sqlite
```

**Folder names never encode tier.** Tier lives in `score.json` and SQLite, so
re-tiering never renames a directory. The operator re-tiers constantly.

`<domain>` is the **registrable domain**: lowercased, no scheme, no `www.`, no
port, no trailing slash, no path. `WWW.BlitzGlobe.com/` → `blitzglobe.com`. This
exact string is the join key across every stage, file, and table. Use the
`tldts` package (pinned) for the public-suffix split; do not hand-roll it, and do
not split on the last two labels — `co.in` and `co.uk` break that.

---

## 4. File contracts — FROZEN

Absent-but-known values are the strings `"none"` / `"missing"`, never `null`,
never omitted. The scorer's parsers are tolerant; the *shape* is fixed. Live
reference instances exist at `data/interior-design/blitzglobe.com/` — read them.

### 4.0 W1 → W2 handoff

`discover` writes one file per vertical:

```jsonc
// data/<vertical>/_discovered.json
{
  "run": "run-2026-09-18T09-20-11Z",
  "vertical": "interior-design",
  "source": "places-new",           // or "brave", "manual"
  "queried_at": "2026-09-18T09:02:00Z",
  "tiles": 9, "keywords": 5, "raw_results": 412,
  "businesses": [
    {
      "places_id": "ChIJ...",
      "name": "Blitz Globe Interior Architect",
      "domain": "blitzglobe.com",       // registrable. null when no website.
      "website_raw": "https://blitzglobe.com/",
      "rating": 4.6,
      "review_count": 87,
      "address": "Sathy Road, Ganapathy, Coimbatore 641006",
      "phone": "+91 91596 95555",       // or null
      "lat": 11.0413, "lng": 77.0261,
      "business_status": "OPERATIONAL",
      "primary_type": "interior_designer"
    }
  ]
}
```

`qualify` writes `_qualified.json` with the same `businesses` array, each entry
gaining:

```jsonc
{
  "qualify": {
    "verdict": "audit",              // "audit" | "skip"
    "reason": null,                  // skip reason when verdict is "skip"
    "http_status": 200,
    "final_url": "https://blitzglobe.com/",
    "https": "ok",
    "cert_expires": "2027-01-14",
    "viewport_meta": false,
    "wayback_first": "2015",
    "server": "Apache",
    "generator_hint": "WordPress 4.9.8"
  }
}
```

**`rating` and `review_count` must be carried through to `score`** — they are the
entire ability-to-pay axis. A pipeline that loses them produces meaningless tiers.

### 4.1 signals.json

```jsonc
{
  "run": "run-2026-09-18T09-20-11Z",
  "domain": "blitzglobe.com",
  "final_url": "https://blitzglobe.com/",
  "captured_at": "2026-09-18T09:34:02Z",
  "measured": {
    // staleness
    "copyright": "2019",            // footer year, or "none"
    "jquery": "1.12.4",             // version string, or "none"
    "bootstrap": "3.3.7",
    "slider": "revslider 5.2",      // library + version, or "none"
    "wayback": "2015",              // first snapshot year, or "none"
    "redesigned": "never",          // year | "never" | "n/a"
    "generator": "WordPress 4.9.8",
    "theme": "interico (ThemeForest)",
    "domainAge": "11 yr",
    // mobile
    "viewport": "missing",          // "present" | "missing"
    "overflow": "+142px",           // horizontal overflow at 390px
    "tapTargets": "19 under 44px",
    // performance — LCP is bucketed by the scorer, never trusted as a float
    "lcp": "8.4s",
    "pageWeight": "11.2 MB",
    "heroVideo": "6.1 MB mp4, autoplay",   // or "none"
    // trust
    "https": "ok",                  // "ok" | "none — http only" | "expired 2024-11"
    "mixedContent": "3 assets",     // or "none"
    "brokenImages": "2",
    // investment — drives ability-to-pay, not pain
    "whatsapp": "present",          // or "none"
    "quoteForm": "mailto: only",    // or "none"
    "blog": "last post 2021"        // or "none"
  },
  "flagged": ["viewport","overflow","lcp","slider","redesigned",
              "mixedContent","jquery","heroVideo"],
  "captures": {
    "mobile":  {"file":"mobile.png","viewport":"390x844",
                "note":"no meta viewport — 980px legacy layout"},
    "desktop": {"file":"desktop.png","viewport":"1440x900"},
    "full":    {"file":"full.png","viewport":"1440xfull"}
  },
  "raw": {"html":"raw/home.html","headers":"raw/headers.json"}
}
```

`flagged` is the subset of `measured` keys judged bad by the threshold table
(§4.5). It drives the deck's inverted rows and angle selection.

### 4.2 links.json

```jsonc
{
  "run": "...", "domain": "...",
  "counts": {"total":64,"internal":41,"external":19,
             "nav":7,"footer":28,"dead":3,"socials":5},
  "agency_credit": {                 // null when none found
    "name": "Aabasoft Technologies",
    "domain": "aabasoft.com",
    "raw_text": "Designed & Maintained by Aabasoft",
    "region": "footer"
  },
  "links": [
    {"href":"https://blitzglobe.com/gallery","text":"GALLERY","region":"nav",
     "kind":"internal","rel":"","visible":true,"status":200}
  ]
}
```

`kind` ∈ `internal | external | mailto | tel | anchor | social`.
`region` ∈ `nav | header | footer | main | aside`.
`status` is present only on links W3 chose to probe — internal links only, capped
at 40 per site.

### 4.3 contacts.json

```jsonc
{
  "run": "...", "domain": "...",
  "address": "Sathy Road, Ganapathy, Coimbatore 641006",
  "contacts": [
    {"kind":"phone","value":"+91 91596 95555","owner":"business"}
  ],
  "source": "business own contact page + footer"
}
```

`kind` ∈ `phone | email | whatsapp | instagram | facebook | hours`.
`owner` ∈ `business | agency`, decided by the cross-site frequency rule (§7.3).

### 4.4 score.json

Written by `lib-scoring.js` verbatim, plus `run`, `domain`, `flaws`,
`pitch_angle`, `angle_template`. **Never hand-authored.**

```jsonc
{
  "run": "...", "domain": "blitzglobe.com",
  "scorer": "rules@1",
  "pain": 104.77,
  "pain_parts": {"staleness":51,"mobile":26.33,"trust":6.6,"perf":20.84},
  "pay": 0.91,
  "reach": 1,
  "score": 100,
  "tier": "A",
  "gate": null,                    // gate reason string when a hard rule fired
  "lcp_bucket": "dire",
  "flaws": ["viewport","overflow","lcp", ...],
  "pitch_angle": "Your gallery is your product, and on a phone it runs off ...",
  "angle_template": "mobile-gallery-broken"
}
```

### 4.5 Flag threshold table — FROZEN

A `measured` key enters `flagged` when:

| key | flagged when |
|---|---|
| `viewport` | `== "missing"` |
| `overflow` | numeric > 0 |
| `tapTargets` | numeric ≥ 5 |
| `lcp` | bucket is `slow` or `dire` (≥ 4s) |
| `pageWeight` | > 4 MB |
| `heroVideo` | not `"none"` |
| `https` | not `"ok"` |
| `mixedContent` | not `"none"` |
| `brokenImages` | numeric ≥ 1 |
| `jquery` | major < 3 |
| `bootstrap` | major < 4 |
| `slider` | matches `revslider\|revolution\|nivo\|owl\|cycle\|flexslider` |
| `redesigned` | `== "never"`, or year ≤ refYear − 6 |
| `copyright` | year ≤ refYear − 5 |
| `generator` | WordPress < 5.5, or matches `frontpage\|static html` |
| `whatsapp` | `== "none"` |
| `quoteForm` | `== "none"` |
| `blog` | year ≤ refYear − 3 |
| `domainAge` | < 1 yr |

`refYear` is **injected** (currently 2026), never read from the system clock. A
compliant run in 2027 over the same `raw/` bytes must produce identical output.

### 4.6 raw/headers.json

```jsonc
{
  "domain": "...", "final_url": "...", "status": 200,
  "redirect_chain": ["http://blitzglobe.com/", "https://blitzglobe.com/"],
  "headers": {"server":"Apache","content-type":"text/html; charset=UTF-8"},
  "timing": {"lcp_ms": 8412, "cls": 0.14, "transfer_bytes": 11744051,
             "requests": 87, "image_bytes": 9214003, "video_bytes": 6395392},
  "assets": [{"url":"...","type":"script","bytes":284104,
              "last_modified":"2016-04-11T00:00:00Z"}],
  "console_errors": 3,
  "broken_requests": [{"url":"...","status":404}]
}
```

W2 writes this; W3 reads it and never re-fetches. `timing.lcp_ms` is the only
non-reproducible number in the system, which is exactly why §5 buckets it.

### 4.7 index.json — what the frontend reads

`report` generates this. It is the **only** file W4 loads. One file, one fetch,
no per-lead requests.

```jsonc
{
  "run": "run-2026-09-18T09-20-11Z",
  "generated_at": "2026-09-18T10:02:41Z",
  "synthetic": false,               // true when built from fixtures (§10)
  "city": "Coimbatore",
  "verticals": [
    {"slug":"interior-design","label":"Interior Design","city":"Coimbatore",
     "keywords":["interior designer", "..."],
     "discovered":212,"withDomain":147,"audited":124}
  ],
  "leads": [
    {
      "vertical":"interior-design","domain":"blitzglobe.com",
      "name":"Blitz Globe Interior Architect",
      "rating":4.6,"reviews":87,
      "address":"Sathy Road, Ganapathy, Coimbatore 641006",
      "score":100,"tier":"A","gate":null,
      "signals":{ /* the measured object, verbatim */ },
      "flaws":["viewport","overflow", ...],
      "reasons":["No viewport meta and 142px of horizontal overflow at 390px ..."],
      "angle":"Your gallery is your product, and on a phone ...",
      "contacts":[{"kind":"phone","value":"...","owner":"business"}],
      "agency":{"name":"Aabasoft Technologies","domain":"aabasoft.com",
                "credit":"Designed & Maintained by Aabasoft"},
      "links":{"total":64,"internal":41,"external":19,
               "nav":7,"footer":28,"dead":3,"socials":5},
      "shots":{"mobile":"data/interior-design/blitzglobe.com/mobile.png",
               "desktop":"...","full":"..."}
    }
  ],
  "agencies":[
    {"name":"Cbe Web Solutions","domain":"cbewebsolutions.in",
     "builtInRun":4,"portfolioClients":38,
     "pricing":[{"tier":"WordPress business","price":"₹28,000"}],
     "note":"Local floor-setter. ThemeForest resale."}
  ]
}
```

`reasons` is generated by `report` from `flagged` using the same template table
as the angle (§6) — one sentence per flagged key, ordered by severity weight,
capped at 5. No prose is authored by hand or by a model.

---

## 5. Scoring — the reference implementation exists

`lib-scoring.js` at the repo root is **already written, calibrated, and frozen as
`rules@1`**. W3 wires it in; nobody rewrites it. Its entire public surface:

```js
const { score, WEIGHTS, lcpBucket } = require('./lib-scoring.js');

const result = score({
  signals,        // the `measured` object from signals.json
  links,          // the `counts` object from links.json
  contacts,       // the contacts array from contacts.json
  rating,         // number from _discovered.json
  reviews,        // number from _discovered.json  ← ability-to-pay axis
  agency,         // truthy when links.agency_credit is non-null
  refYear: 2026,  // injected, never Date.now()
});
// → { scorer, pain, pain_parts, pay, reach, score, tier, gate, lcp_bucket }
```

### 5.1 Shape of the formula

```
pain  = staleness + mobile_broken + trust_broken + perf     (each sub-capped)
pay   = sqrt(min(reviews,120)/120), adjusted by rating floor,
        domain age, proven agency spend, and lead-capture presence   → 0..1
reach = 1.0 both phone and (email|instagram) · 0.8 one of them · 0.4 neither
score = round(clamp(pain/150, 0, 1) × pay × reach × 2.25 × 100)
tier  = score ≥ 62 → A · ≥ 42 → B · ≥ 24 → C · else X
```

`sqrt` on reviews is deliberate: 200 reviews is roughly 3× a 20-review shop, not
10×, which matches how business size actually scales.

### 5.2 LCP is bucketed, and that is not a shortcut

LCP and CLS move with CPU load and network conditions — they are the only
non-reproducible measurements in the system. They enter the score as a **bucket**
(`fast` < 2.5s · `ok` < 4s · `slow` < 6s · `dire` ≥ 6s), never as a float.
Bucketing is what makes a re-score bit-identical, and the bucket is all the score
ever used. Never feed a raw millisecond value into a weight.

### 5.3 Gates outrank arithmetic

Four hard rules fire before the cuts and also clamp the score into the gated
tier's band, so sort order always agrees with the displayed letter:

| Gate | Tier | Why |
|---|---|---|
| Generator matches AI/free builder (`wix`, `weebly`, `godaddy builder`, `builder default`) | C | Never paid for a site, never will |
| Domain < 1 yr **and** reviews < 10 | C | Too new to have budget |
| `pain < 12` | X | No measurable pain — nothing to sell |
| Reviews < 20 **and** `pain > 45` | C | Maximum pain, minimum budget — fixed-price only |

The last gate is load-bearing. Without it a one-man trade with a wrecked site
floats into tier A on the pain term alone and wastes the operator's best hours.

### 5.4 Calibration status — read this before retuning

Against the 18-lead fixture set, `rules@1` reproduces **15 of 18** hand-assigned
tiers. The three misses are a property of the hand labels, not a bug:
`thehomestudio.co.in` has *more* measured pain than `happyhomesinteriors.com`
(59.8 vs 52.9) at comparable ability to pay, yet was hand-labelled B against
happyhomes' A. No monotonic formula can satisfy both — those labels were assigned
narratively. The formula is self-consistent; the labels were not.

Retune only against **real** data after the first live run, by editing the `W`
block at the top of `lib-scoring.js`. Bump `scorer` to `rules@2` when you do, so
old `score.json` files remain attributable. Never tune weights to fit fixtures.

---

## 6. Pitch angles — a template table, not generated prose

The angle is a **lookup keyed by the dominant flaw**, not writing. This is better
than generated text: it is the operator's own wording, identical across every
lead, edited in one place instead of read 200 times.

Selection is deterministic: walk the table in order, take the first template
whose `when` condition is satisfied by `flagged`. Order encodes severity —
provable-today flaws outrank cosmetic staleness.

```jsonc
// config/angles.json  — W3 owns, operator edits
[
  {"key":"cert-expired","when":["https"],"guard":"expired",
   "text":"Your site currently shows a security warning before anyone reaches it. That is costing you every mobile enquiry today."},

  {"key":"no-https","when":["https"],
   "text":"Your site still loads over plain HTTP, so every browser marks it Not Secure before a visitor reads a word."},

  {"key":"form-broken","when":["quoteForm"],"guard":"broken",
   "text":"Your enquiry form posts to an address that no longer exists. I filled it in and nothing arrived."},

  {"key":"mobile-gallery-broken","when":["viewport","overflow"],
   "text":"Your gallery is your product, and on a phone it runs off the side of the screen. That is where most of your enquiries are coming from."},

  {"key":"mobile-overflow","when":["overflow"],
   "text":"Your site runs off the side of the screen on a phone, which is where most of your enquiries start."},

  {"key":"hero-video-weight","when":["heroVideo","lcp"],
   "text":"Your hero video costs mobile visitors several megabytes before they see a single project."},

  {"key":"slow-photography","when":["lcp","pageWeight"],
   "text":"Your photography is the best thing you have and it takes six seconds to appear. Compress and restructure and you keep the visitors you already pay to attract."},

  {"key":"unpatched-cms","when":["generator"],
   "text":"Your site runs a CMS version that stopped receiving security patches years ago."},

  {"key":"broken-images","when":["brokenImages"],
   "text":"Several images on your homepage are broken, which reads as abandoned to anyone comparing you against a competitor."},

  {"key":"dated-template","when":["redesigned","slider"],
   "text":"Your site has not changed visually since it was built, and three of your competitors in Coimbatore run the identical template."},

  {"key":"no-lead-capture","when":["whatsapp","quoteForm"],
   "text":"No WhatsApp button and no enquiry form, so you have no way of knowing how many visitors wanted to talk to you."},

  {"key":"generic","when":[],
   "text":"Everything works and nothing stands out. The pitch here is differentiation, not repair."}
]
```

Two special cases, both deterministic:

- **`gate` fires** → the angle is the gate reason, prefixed appropriately. A
  tier-X lead's angle reads `"No measurable pain. Skip."`, never a sales line.
- **`guard`** narrows a match on the raw value (`"expired"` matches
  `https: "expired 2024-11"` but not `https: "none — http only"`).

`angle_template` in `score.json` records which key fired, so a bad template is
traceable across every lead that used it.

---

## 7. The four deterministic rules that replace the LLM

### 7.1 Why these are better than a model, not merely cheaper

Each rule below is not an approximation of model judgement — it is *more* correct
than one, because it uses information a per-page model call cannot see.

### 7.2 Agency credit normalisation

Regex over footer text and `<meta name="generator">`:

```
/(?:designed|developed|created|maintained|powered|crafted|built)\s*(?:&|and)?\s*
 (?:designed|developed|maintained)?\s*by\s*[:\-]?\s*(.{2,60})/i
/website\s+by\s+(.{2,60})/i
/a\s+unit\s+of\s+(.{2,60})/i
```

Then: strip trailing punctuation, collapse whitespace, drop a trailing legal
suffix (`Pvt Ltd`, `Technologies`, `Solutions`, `Media`, `Studio` are **kept** —
they disambiguate), title-case, and resolve through `config/agency-aliases.json`:

```jsonc
{"cbe web solns":"Cbe Web Solutions", "webcastle":"Webcastle Media"}
```

The same handful of agencies recur across a whole run, so an alias you correct
once is permanently right. Prefer the outbound link's registrable domain as the
identity key when a link accompanies the credit text — a domain is unambiguous
where a name is not.

### 7.3 Contact attribution — the cross-site frequency rule

**A phone number or email appearing on more than one lead's site belongs to the
agency, not the business.** This is a global fact no per-page heuristic can
access, and it is exact rather than probabilistic.

```
build a map value → set of domains, across the whole run
if |domains| > 1            → owner = "agency"
else if value appears within 200 chars of the agency credit text → "agency"
else                        → "business"
```

This runs as a **second pass** after all per-domain extraction completes, so
`extract` must write contacts with a provisional owner and `report` finalises
them. Document that ordering in code; it is easy to get wrong.

### 7.4 Agency pricing extraction

There are 4–10 agencies per run, not 200, so this is cheap to get right and cheap
to eyeball. Fetch each agency's `/pricing`, `/packages`, `/plans`, `/rates` (stop
at the first that returns 200), then:

```
find every text node matching /₹\s?[\d,]{3,}|Rs\.?\s?[\d,]{3,}|INR\s?[\d,]{3,}/
for each match, the tier label is the nearest preceding heading
  (h1–h4, or the closest ancestor card's first strong/bold text)
emit {tier, price} pairs in document order, deduped
```

When nothing matches, write `pricing: [{"tier":"Not published","price":"—"}]`.
Never infer a price.

### 7.5 Agency inversion — the compounding move

Footer credits are an **expansion list**, and this is the feature that scales the
system past one city. An agency's own portfolio page names its entire client
roster, and every one of those clients has the same dated site and the same proven
willingness to pay.

```
for each discovered agency:
  fetch /portfolio, /clients, /work, /projects
  extract outbound registrable domains, excluding the agency's own and socials
  emit as candidate leads with source = "agency-portfolio:<agency domain>"
```

These candidates enter `qualify` directly, skipping `discover`. One agency can
hand you twenty leads with no Places call. Cap portfolio crawling at 2 pages per
agency and respect the same politeness rules as §8.

---

## 8. Crawl politeness — non-negotiable

Every fetch in the system, in every stage, obeys:

- **robots.txt** honoured. Parse once per host, cache for the run. A disallowed
  path is skipped and recorded, never fetched anyway.
- **One concurrent request per host.** Global concurrency is a separate cap.
- **Minimum 1500ms between requests to the same host.**
- **Identifying User-Agent** with a contact URL or email. No browser spoofing to
  evade blocks. `--headless=new` is used because old headless is detected as a
  bot even for legitimate traffic, not to disguise anything.
- **Hard per-page budget**: 30s navigation + 10s settle. On timeout, capture and
  keep whatever rendered rather than failing empty.
- **Homepage only** for lead sites, plus at most one contact page. This is a
  survey, not a crawl. Never spider a lead's whole site.
- **Never fetch** anything behind a login, paywall, or `noindex` directive.

A stage that cannot obey these skips the domain and writes `error.json`.

---

## 9. Design contract

`preview/app.css` is **authoritative and copied forward byte-for-byte.** It is
not a reference to reinterpret. W4 reuses it directly; the tokens are also
restated literally in `W4-frontend.md` so an agent that never opens the file
still lands in the same place.

The one rule that explains every other decision: **pure `#000` ground, `#fff`
ink, and nothing else.** All hierarchy comes from four opacity steps
(1 / .64 / .40 / .24), hairline `rgba(255,255,255,.12)` rules, and inverted
blocks for emphasis. Tier is a **glyph**, never a hue: `■ A · ▣ B · □ C · · X`.

The point of the monochrome is that **the screenshots are the only colour in the
interface.** Every coloured pixel in the operator's field of view belongs to a
lead, not to the chrome. That is what makes reviewing 200 sites in fifteen
minutes tolerable. Do not add an accent colour. Do not add a colour-coded tier
badge. Do not add a chart with a palette.

One monospace typeface throughout. No shadows, no rounded corners, no animation
beyond a 120ms crossfade.

---

## 10. Fixtures — synthetic, and labelled as such

`preview/data.js` contains **18 invented businesses**: fabricated phone
numbers, fabricated addresses, fabricated agency names, fabricated agency
pricing. Three domains are real names
(`blitzglobe.com`, `happyhomesinteriors.com`, `bestinterior.co`) with **entirely
fabricated signals**.

Rules:

- The file declares `const SYNTHETIC = true;` and opens with a header comment
  saying so. It stays a `.js` file of globals, not JSON, because `preview/`
  has no build step and must open over `file://` — where a `fetch` of a local
  JSON file is blocked by CORS but a `<script src>` global is not.
- `index.json` built from it carries `"synthetic": true`, and W4 **must** show a
  persistent marker in the topbar when that flag is set.
- Never export a fixture row as a lead. Never quote a fixture price to anyone.
- Its hand-authored tiers are **not** ground truth; §5.4 explains why.
- It exists so W4 can build the entire frontend before W1–W3 produce anything.

`preview/mocks.js` renders CSS recreations of sites when a real PNG is absent. It
was written only because the original screenshots had been cleared from cache.
**Delete it once real captures exist** — W4's stage painter already probes for
the real PNG first and falls back, so removal is a one-line change.

---

## 11. Reserved for CRM — do not build now

The schema leaves room so this lands without a migration:

```sql
deals      (site_id, stage, amount_discussed, currency, probability, next_action_at)
activities (deal_id, kind, at, notes)        -- call | whatsapp | email | meeting
tasks      (deal_id, due_at, done, label)
```

Stages: `marked → contacted → replied → quoted → negotiating → won | lost`, with
a `lost_reason`. After thirty losses the reasons teach more than the wins, and
both outcomes feed back into weight retuning — which is when the pipeline starts
genuinely predicting who converts.

Build none of it in v1. Just do not take a design decision that blocks it: keep
`site_id` a stable key, and never delete a row on re-run.

---

## 12. SQLite schema — W3 owns

```sql
CREATE TABLE verticals (
  slug TEXT PRIMARY KEY, label TEXT, city TEXT, keywords TEXT,
  discovered INTEGER, with_domain INTEGER, audited INTEGER);

CREATE TABLE businesses (
  domain TEXT PRIMARY KEY,          -- registrable. the join key everywhere.
  vertical TEXT, name TEXT, places_id TEXT,
  rating REAL, review_count INTEGER, address TEXT, phone TEXT,
  lat REAL, lng REAL, business_status TEXT,
  source TEXT,                      -- places-new | brave | agency-portfolio:<d>
  first_seen TEXT);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, started_at TEXT, finished_at TEXT,
  vertical TEXT, stage TEXT, config_hash TEXT, scorer TEXT);

CREATE TABLE scores (
  domain TEXT, run_id TEXT, tier TEXT, score INTEGER,
  pain REAL, pay REAL, reach REAL, gate TEXT,
  angle_template TEXT, flaws TEXT,
  PRIMARY KEY (domain, run_id));

CREATE TABLE reviews (                      -- the operator's marks. NEVER
  domain TEXT PRIMARY KEY,                  -- overwritten by any stage.
  human_tier TEXT, pitch INTEGER DEFAULT 0, note TEXT, reviewed_at TEXT);

CREATE TABLE contacts (
  domain TEXT, kind TEXT, value TEXT, owner TEXT,
  PRIMARY KEY (domain, kind, value));

CREATE TABLE agencies (
  domain TEXT PRIMARY KEY, name TEXT, pricing TEXT,
  portfolio_clients INTEGER, note TEXT);

CREATE TABLE agency_clients (
  agency_domain TEXT, domain TEXT, confidence REAL,
  PRIMARY KEY (agency_domain, domain));
```

`scores` and `reviews` are **separate tables on purpose.** A pipeline re-run
rewrites `scores` and must never touch `reviews`. The gap between machine tier
and human tier is a feature — it is what the Disagreements view audits, and it is
how weights get retuned in §5.4.

---

## 13. Glossary

| Term | Meaning |
|---|---|
| **pain** | Measured badness of the current site. 0–~115. |
| **ability to pay / pay** | 0–1 proxy for budget, driven mostly by review count. |
| **reach** | 0.4–1.0 factor for how contactable the business is. |
| **tier** | A hot · B warm · C weak · X skip. Machine-assigned. |
| **human_tier** | The operator's override. Never overwritten by a stage. |
| **gate** | A hard rule that sets tier regardless of arithmetic. |
| **registrable domain** | Public-suffix + 1 label. The universal join key. |
| **refYear** | Injected current year. Never `Date.now()` in scoring. |
| **flagged / flaws** | Measured keys judged bad by the §4.5 table. |
| **angle** | The one-sentence pitch, selected from a template table. |
| **synthetic** | Fixture data. Never a measurement, never a lead. |

---

## 14. What is genuinely unknown

Honest list. None of these block implementation; all affect volume or tuning.

1. **What fraction of Coimbatore businesses have their own domain.** Estimate
   40–60% of those with any web presence. Affects run size, not design.
2. **Places API cost for the field mask in `W1-discovery.md`.** `websiteUri` and
   `userRatingCount` put it in a higher SKU tier. Verify the SKU table in console
   before the first full run; the daily quota cap bounds the damage regardless.
3. **Whether the scoring weights survive contact with real data.** `rules@1` is
   fitted to 18 synthetic leads, which is not evidence. Expect to retune once.
4. **Cookie-consent prevalence on Indian local business sites.** Probably low,
   which would make W2's consent handling mostly dead code. Build it anyway; a
   banner in a screenshot ruins the one asset the pitch depends on.
5. **How many sites block headless entirely.** If it exceeds ~10%, W2's headful
   fallback stops being optional.

---

## 15. Definition of done

The system is complete when, from a cold start:

```
node src/cli discover interior-design
node src/cli qualify
node src/cli audit
node src/cli extract
node src/cli score
node src/cli report
node src/cli serve          # → http://127.0.0.1:7777
```

produces a browsable deck of real Coimbatore interior-design leads with three
captures each, a tier, a pitch angle, an agency table with pricing where
published, and a `_pitch.csv` the operator can send from — and re-running
`extract`, `score`, and `report` over the saved `raw/` bytes reproduces every
number bit-identically without touching the network.

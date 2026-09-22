# PROSPECTOR — pending work

**As of 2026-09-19, after run 1.** Every number below is measured against the
completed run (18 verticals, 3,906 scored leads, 496 agencies, 4.95 hours on an
8-vCPU/30GB EC2 box), not estimated. Where something is unverified it says so.

Ordered by cost, because that decides sequence: group 1 re-runs offline in
~4 min/vertical and spends no quota; group 2 needs a re-crawl.

---

## 1. Offline fixes — no re-crawl, no quota

All read bytes already on disk. Verified by one pass of:

```bash
node src/cli extract <vertical> --no-probe   # --no-probe = fully network-free
node src/cli score   <vertical>
node src/cli report
```

### 1.1 Merge the Places phone as a fallback — `src/extract/contacts.js`

**953 of 3,906 leads display no phone number while Places already gave us one.**
Samples: `chandraauto.com` → `095009 97217`, `grthotels.com` → `080 6925 0565`,
`krishnanursinghome.com` → `0422 223 4508`.

Coverage measured on the 4,077 qualified domains:

| source | phone | address | email |
|---|---|---|---|
| Places (`_qualified.json`) | 3,723 (91.3%) | 4,077 (100%) | 0 — no such field |
| site scrape (`contacts[]`) | 2,853 | — | 2,759 |

Cause is an asymmetry: address already falls back to Places
(`contacts.js`, `if (address === 'none' && qualified?.address)`), phone does not.
The plumbing is already there — `extractContacts($rendered, qualified, domain)`
receives the business entry carrying `phone` at top level. Roughly three lines.

Expected: phone coverage **2,853 → ~3,806 of 3,906 (97.4%)**.

**Subtlety:** a Places phone is definitionally the *business's* listed number, so
it must be **exempt from the cross-site frequency rule** that reassigns contacts
to agencies. A scraped number on twelve sites is the agency's; a Places number
never is.

Scraping still earns its place: 193 phones Places lacked, and **email, which the
Places API cannot provide at all** — 2,759 leads have one only because we scraped
it. Same for WhatsApp, Instagram, opening hours.

### 1.2 Phone regex drops 11.5% of valid mobiles — `src/extract/contacts.js:30`

```js
const badPhoneRe = /(?:19|20)\d{2}|\d{4}\-\d{4}|^\d{6}$|[A-Z]{5}\d{4}[A-Z]/;
```

The year clause is unanchored and tested against the *normalised* digit string,
so any mobile containing `19xx` or `20xx` anywhere inside it is discarded:

```
DROPPED  9820123456   ← contains "2012"
DROPPED  9619876543   ← contains "1987"
DROPPED  7019456789   ← contains "1945"
```

Measured over 200,000 generated valid 10-digit Indian mobiles: **11.5% wrongly
dropped.** Applies to `tel:` hrefs too — same guard.

Two clauses are also dead code: `normalisePhone` strips non-digits before the
test, so `\d{4}-\d{4}` and `[A-Z]{5}\d{4}[A-Z]` can never match. The year check
was never needed either — `phoneRe1` requires 10 digits starting 6-9, so a bare
`2016` could not have matched it.

Fix: keep `^\d{6}$` (rejects PIN codes), delete the rest.

### 1.3 WhatsApp extraction yields nothing — `src/extract/contacts.js`

0 of 139 dental leads carry a WhatsApp contact, while the signal detector reports
77 of them have WhatsApp on the page. The two disagree and the extractor is
dropping them. WhatsApp is how Indian local businesses actually get contacted.

### 1.4 Agency attribution is noisy — `src/report/agency.js`

Every agency name appears **exactly once**, so the cross-site frequency rule
never compounds and agency inversion does not work. Visible failures: copyright
fragments parsed as company names (`"Vivdleo.com , All rights reserved"`), and
one domain emitted with a doubled TLD (`krishnadentalclinic.com.com`).

### 1.5 Platform domains reach scoring — `src/discover/index.js`

`vercel.app`, `ueniweb.com`, `bolt.host`, `mypixieset.com`, `sleek.fitness` are
hosting or free-builder platforms, not businesses. Many businesses collapse onto
one registrable domain, and they error at score time with
`review_count is undefined`. Same bug class as the 99acres fix, different domain
set — they belong in `REJECT_DOMAINS` or `GREENFIELD_DOMAINS`.

---

## 2. Needs a re-crawl

### 2.1 Deploy the `nextPageToken` field-mask fix — `src/discover/places.js`

**Fixed locally, NOT on the box.** `grep -c nextPageToken src/discover/places.js`
returns 1 on EC2 (only the original read of the field), so during run 1 the
response never carried a token and **every tile×keyword returned page 1 only,
capped at 20 results.** `night.log` is full of lines reading exactly
`20 results`, which is the signature of hitting that cap rather than exhausting
the tile.

Places API (New) omits `nextPageToken` unless it is named in the field mask. It
is a response-level field, not place data, and costs nothing.

### 2.2 Re-run `discover` on the fixed mask

**Unquantified.** Before spending quota, count how many tile×keyword pairs
returned exactly 20 in `night.log` to size the loss. Dense belts
(Saravanampatti) likely truncated hardest. Quota is not a constraint —
run 1 used ~14% of the 75,000/day `SearchTextRequest` ceiling.

---

## 3. Frontend — W4 / `preview/`

### 3.1 Sort by review count; keep tier as a glyph

Tier stays (operator's call), but it is not the primary sort. Review count comes
straight from Google and is the one input that is not our inference; `pain` is
the half that is miscalibrated. Nothing was ever excluded by tier — all 3,906
leads are in `index.json` (A:140, B:387, C:1126, X:2253). The operator's own
picks were ranked low, not dropped, so this is a sorting fix with no re-crawl.

### 3.2 Flags as filters

Findings that are **invisible in a screenshot** and unreachable by eye review:

```
920  sites on plain HTTP
826  with broken images
 32  with expired certificates   ← strongest cold open in the dataset
```

### 3.3 Drop `full.png` from the deck

Remove the `F` capture tab. `O` (open real site in a new tab) already covers the
full-page view. Pairs with §4.1.

### 3.4 A view for the no-website pool

**259 dental businesses have no website at all, 211 of them with phone numbers —
a pool larger than the 139 scored dental leads.** Includes clinics at 4,684 /
2,302 / 556 / 431 reviews. Maximum ability to pay, no incumbent to displace, no
sunk-cost defensiveness. They exist only in `_qualified.json`; the UI cannot show
them. Same shape as the greenfield portal-profile bucket.

Arguably the most valuable single output of run 1.

---

## 4. Robustness before the next run

### 4.1 Stop writing `full.png` — W2 capture list

| file | count | size | avg |
|---|---|---|---|
| mobile.png | 4,263 | 0.73 GB | 178 KB |
| desktop.png | 4,268 | 2.75 GB | 675 KB |
| **full.png** | 4,263 | **10.72 GB** | **2,638 KB** |
| raw/ HTML+headers | — | 2.18 GB | what `extract` reads |

**75% of all image storage, for the least-used capture.** Also update the
manifest in `src/extract/index.js` (the only place any `.png` is named) and the
W4 deck.

Existing files can be deleted separately to reclaim 10.72 GB — irreversible, and
not urgent: the box is at 13% of 200 GB with 175 GB free.

### 4.2 Audit concurrency 8 → 16 — `run-night.sh`, `src/capture/index.js:45`

Capture is **wait-bound, not CPU-bound**: 11.5s per capture at concurrency 1 vs
~12.5s at concurrency 8 — 9% slower at 8× the parallelism, because ~7s of each
capture is deliberate sleeps in the settle sequence. 8 vCPUs sat idle.

Audit is ~9.5m of the 15.6m per vertical, so 16 takes a vertical to ~11m and a
full 18-vertical run from ~5h to ~3.3h. Watch `uptime`; under ~12 load has room
for more.

### 4.3 Hard per-capture deadline ~60s — `src/capture/capture-domain.js`

One capture took **677.3s** against a 12s mean — as much as 56 normal captures.
`timeout = 30000` bounds *navigation only*, not the settle sequence or
`_forceImageDecode`, so a pathological site can stall a worker indefinitely.

Wrap the whole capture in `Promise.race` against ~60s and keep whatever shots
landed. **Caveat: seen once in a tail sample; true frequency unmeasured.** Worth
counting outliers in `night.log` before deciding how much it matters.

### 4.4 `error.json` must be append-only or stage-namespaced

The score stage **overwrote** each `error.json`, destroying the original robots
errors. The first recovery attempt found 0 affected domains because of it; the
list had to be dug out of `night.log`. Next diagnosis would be impossible.

---

## 5. Deferred deliberately

### 5.1 `rules@2` retune — `lib-scoring.js`

**Do not tune against fixtures.** Two known inputs from the operator's own
hand-marked dental list:

- **Broken CTAs score near zero.** Three of the operator's notes were literally
  "submit button", "button", "check button". `quoteForm` only detects a *missing*
  form; a form that exists but posts nowhere barely scores. Leads the operator
  marked came out X/12 and X/5.
- **`pain × pay` multiplication zeroes high-review, low-pain leads.**
  `toddlersbiggteethh.com`: 1,130 reviews, mild flaws, lands C/28. The operator
  reads an obvious payer; the formula sees nothing to sell.

Let the Disagreements view accumulate real marks first. Bump `scorer` to
`rules@2` when changing weights so old `score.json` stays attributable.

### 5.2 Broken-CTA detection — prerequisite for 5.1

The `form-broken` angle already exists in `config/angles.json` with nothing
feeding it.

### 5.3 Live iframe as a deck tab — undecided

**80.4% of sites are framable; 19.6% are not** (736 send `X-Frame-Options`, 278
send CSP `frame-ancestors`, 835 either). Those 835 render as a permanent blank
box with no browser-side workaround.

Two things a stored capture gives that a live view cannot: it is dated evidence
of what was seen (pitching off a site they fixed yesterday looks unprepared), and
a 390px iframe on desktop lays out at 390px — it cannot reproduce the
980px-fallback-then-scale-down behaviour that is the most sellable fact the tool
produces.

Note: **nothing scored comes from a screenshot.** `extract` and `score` never
read a PNG — the only `.png` references in the scoring path are three filename
strings in a manifest. Captures exist purely for the operator's eyes. The ranking
needs the *crawl*, not the *images*.

---

## Already done — do not redo

- **robots.txt parser fix** (deployed to EC2, verified). Blank lines were treated
  as group separators; Boost360's template lists per-bot blocks back-to-back with
  none, so nine other bots' `Disallow:/` merged into the wildcard group. **45
  domains across 13 verticals wrongly refused, all recovered (45/45, 0 still
  refused).** Group boundaries are "a user-agent line following a rule line",
  never blank lines. 8 regression tests pass, genuine-block cases included.
- Greenfield bucket + dedup fix — portal profiles (99acres, Practo, MakeMyTrip,
  WedMeGood…) kept as `aggregator-profile-only` and excluded from domain merge.
  Dedup ran *before* classification, so 39 of 40 brokers sharing a portal domain
  were vanishing entirely, not even recorded as skips.
- 8 req/sec Places limiter + backoff + `pageToken` retry.
- 18 verticals in priority order, 8 keywords each; 5×5 grid, Coimbatore only.
- Two missing angles (`mobile-tap-targets`, `mixed-content`) — 5 of 7 and 2 of 7
  fixture leads were falling through to `generic`.
- `spec/W1-discovery.md` reconciled with the shipped code (§2.2 rate limit, §2.5
  no-merge-on-portal, new §2.6.1, two acceptance criteria).

# Architecture

How prospector is built, where each part runs, and why. The decisions here are
closed; don't reopen them without new evidence.

- Per-item state (built, broken, deferred): `docs/STATUS.md`.
- Remaining work and its order: `docs/PENDING-SPECS.md`.
- Tables, statuses and file shapes: `docs/SCHEMA.md`. It wins for those; the
  code wins for behaviour, and this file describes the behaviour.

*Measured* figures come from run 1 (`logs/night.log`). Everything else is
modelled and says so.

## The product

- Finds Coimbatore businesses in Google Places, checks that the listed website
  answers, and captures each site: two screenshots, the post-JavaScript DOM, and
  what extract finds in it — the first email and every outside link.
- The operator reviews the captures in a deck and records their own decision per
  business (tier, pitch flag, note).
- **No machine scoring.** No score, tier or pitch angle is computed anywhere.
- The pipeline is three stages: `discover → qualify → capture`, and capture
  runs extract per domain. Extract is part of capture, not a stage (its re-run
  is `capture --extract-only`). `migrate`, `ingest`, `control` and `serve` are
  commands.

### Built vs planned

| Part | State |
|---|---|
| `discover`, `qualify` | Built. Run from the control panel on the box |
| Box, Caddy, control panel | Live at <https://prospect.themaverick.tech> |
| Capture Lambda, image, failure queue | Deployed, never invoked. The deployed image predates spec A; spec C rebuilds it |
| `capture` stage (capture then extract) | Built. Same code on the box and in the Lambda |
| Scoring removed | Done. `src/score/`, `lib-scoring.js`, `src/report/` and the signals are deleted |
| Disk layout matching S3 | Done. `data/<city>/companies/<domain>/` on both sides |
| MySQL, `ingest`, resume from `companies.status` | Built. `docs/SCHEMA.md` is the contract; SQLite and the file artifacts are gone |
| Peering to mavdb, the database and its grants | Written (`terraform/mavdb`, `terraform/db`), **not applied**. `./p peer` then `./p db`, on the operator's go |
| The deck | Built. Serves on 127.0.0.1:7777; public at `leads.themaverick.tech` once the DNS record and `DECK_PASSWORD` exist |
| Dispatching captures at scale, budget guard | Spec C |

## Where things run

```
 rogue (700897991126)                                   clasher (028972816671)
 ┌──────────────────────────────────────┐   3306 over   ┌─────────────────────┐
 │ box: Caddy, control, deck,           │   peering     │ mavdb               │
 │      discover, qualify, ingest       ├──────────────►│ RDS MySQL, private  │
 └──────┬─────────────────────▲─────────┘               └─────────────────────┘
        │ async invoke        │
        │                     │ companies/ down (ingest)
 ┌──────▼───────┐  put  ┌─────▼────────┐
 │ capture      ├──────►│ S3 bucket    │
 │ Lambda       │       │              │
 └──────────────┘       └──────────────┘
```

| Edge | State |
|---|---|
| Box → Lambda invoke | Spec C. The box role has no `lambda:InvokeFunction` yet |
| Lambda → S3 `companies/` | Built; exercised only against a stub S3 client |
| S3 → box (`ingest`) | Built. The box role now has `ReadCompanies`, `ListCompanies` and `PutExtract`; `terraform apply stack` still pending |
| Box → mavdb | Code built and tested against a local MySQL. The peering and the database are written and **not applied** |

**One handoff, forced by one constraint.** The Lambda runs outside any VPC, so
it cannot reach mavdb. A VPC-attached Lambda needs a NAT gateway at ~$32/month,
more than the compute it runs. So capture writes S3 and nothing else, and
`ingest` on the box turns S3 objects into files on disk and rows in MySQL.

Everything prospector owns is in rogue. Only the MySQL connection crosses into
clasher.

## Pipeline

### Stage contract

Every stage, and every command `src/cli` dispatches, keeps these:

- **Interface.** `module.exports = { run: async (argv, ctx) => {} }`, with
  `ctx = { root, config, log }`. `argv` is the raw array after the stage name;
  each stage parses its own flags. `run` returns `{ ok, err, skipped }` and
  closes the MySQL pool before returning.
- **Idempotent and resumable.** The work list is a query over
  `companies.status`, so running a stage again does exactly what is left.
- **Per-domain atomic.** Files are written as `<name>.tmp`, then renamed. A kill
  mid-run never leaves a half-written file, and nothing uploads a `.tmp`.
- **Fail-soft per domain.** A capture failure becomes that domain's
  `error.json` and the run continues. An extract failure is logged and counted,
  writes no `error.json`, and never marks the capture failed.
- **Exit codes:** `0` success, `1` some domains errored (or `all` stopped at a
  stage that produced nothing), `2` fatal: unknown stage, config or I/O.

### discover

Slices the Coimbatore bounding box (`config/city.json`) into a 5×5 grid, then
runs every keyword of a vertical against every tile: 8 keywords × 25 tiles = 200
searches. Each search is a Places Text Search restricted to one tile, because a
single query caps at 60 results (3 pages × 20) and a city-wide query silently
truncates dense areas.

- **Pagination depends on the `nextPageToken` field mask**
  (`src/discover/places.js:17`). Without it the API omits the token and every
  query stops at 20. That was run 1's silent failure: 952 of 3,600 queries
  (26.4%) capped, an estimated 2,000–3,000 leads never collected, and no error
  logged. Every run now logs its commit, per-query page counts and a summary of
  capped queries, and warns when nothing paginated.
- **No merging.** `place_id` is unique and that is the only identity rule: every
  place ID a scan returns is its own `companies` row, in a run and across runs.
  Two showrooms on one company website are two listings the operator may want to
  call separately, and forty brokers listing the same 99acres profile are forty
  businesses — the old domain merge collapsed both. Rows that share a website
  share one capture instead. Portal profiles (99acres, Practo, WedMeGood) are
  kept with `domain NULL` and `skip_reason = 'aggregator-profile-only'`: a
  business paying a portal every month for leads it does not own is a
  first-website pitch, not a redesign.
- **Rate limit** 8 req/s in code (`src/discover/places.js:42`) against 600/min
  and 75,000/day.
- **Only stage that spends Places quota.** It is left out of the
  `.claude/settings.json` allowlist so it always prompts, and the panel shows the
  request estimate before the button.

**Writes rows, not a file.** The insert runs straight after each tile × keyword
search, with `ON DUPLICATE KEY UPDATE company_id = company_id` — a deliberate
no-op, so first write wins including the vertical, and unlike `INSERT IGNORE` it
does not also swallow a truncation or a bad foreign key. Killing a run part-way
keeps every row already written; re-running it inserts only place IDs that are
new.

That is also why the S3 backup is gone: there is no JSON on disk to copy up, and
the rows are backed up with the database, which is the operator's concern. Raw
response bodies are not archived either — `places-raw/` was provenance for a run
whose truncation bug is now fixed and instrumented.

### qualify

An eligibility gate: DNS, a HEAD request, `robots.txt`, certificate validity. No
browser, and no file — it writes `companies.status` (`0` eligible, `-1` skipped)
with a `skip_reason`, plus `final_url`, `http_status`, `https_status`,
`cert_expires` and `qualified_at`.

**One probe per distinct domain**, not per row: the work list is
`GROUP BY domain` and the `UPDATE` matches on the domain, so every listing that
shares a website gets the same verdict from one request. There is no `--resume`
any more either — the work list is `status IS NULL`, which a finished probe
clears, so running qualify again probes exactly what is left.

**Sibling inheritance.** A later discover can find a new place ID for a website
that is already qualified and captured. Probing it again would be wasteful;
leaving it at `status = 0` would be worse, because capture skips the domain as
already done and the row would sit pending forever. So a new row whose domain
already has a qualified sibling copies that row's qualify, capture and extract
columns and its `links`, in one transaction, and is not probed.

`https_status` is `ENUM('ok','expired','none')` and `cert_expires` is a `DATE`.
The old free-text `"expired 2024-03"` carried the verdict and the month in one
string, which made "every expired certificate" a `LIKE` query.

In run 1 it removed 507 domains that did not resolve, 69 timeouts, plus 404s,
403s and dropped connections. Those businesses are kept, not deleted: a Google
listing that names a dead domain is a different pitch. The Wayback lookup,
`server`, `generator_hint` and `viewport_meta` are gone — nothing read them once
the scoring did not exist.

### capture

Capture then extract, per domain, in the same worker slot on the box and the
same container in the Lambda. One page visit produces four files, flat in
`<city>/companies/<domain>/`:

| File | What it is |
|---|---|
| `desktop.webp` | 1440×900 viewport, resized to 720 px, webp q50 |
| `mobile.webp` | 390×844 viewport, same encoding |
| `rendered.html` | DOM after JS ran, scrolling finished, images forced; extract reads this. Written last |
| `extract.json` | The first email on the site and every outside link (`docs/SCHEMA.md`) |
| `error.json` | Only when the capture failed or was cut short |

- **Screenshots are viewport-only** (`fullPage: false`). `full.png` was dropped;
  it was 75% of image storage at 2.6 MB average.
- **Only the rendered DOM is kept.** `home.html`, `headers.json`, the redirect
  chain, the asset list, the timings and the mobile-layout measurements went with
  the scoring that consumed them. Nothing reads a measurement any more, so
  collecting one is capture time and storage spent on nobody.
- **~12 s per business, ~7 s of it deliberate settle** (11.5 s mean, measured at
  concurrency 1 on 8 vCPU). The settle is a deadline race, not a sleep:
  `Promise.race([_forceImageDecode(page), _delay(5000)])` at
  `capture-domain.js:236,256`. Starve the CPU and the decode loses, and the
  screenshot comes out half-rasterised. Low CPU costs capture quality, not just
  time.
- **Hard per-capture deadline**, 60 s (`--deadline`,
  `src/capture/capture-domain.js:109`). Shots that landed are kept and listed in
  `error.json` as `partial`, `kind: "deadline"`. Not retried: a slow page burns
  the deadline again.
- **Complete** means `desktop.webp`, `mobile.webp` and `rendered.html` all
  exist (`completionFiles()`, `capture-domain.js`), which is why `rendered.html`
  is written last. `desktop.webp` alone proves nothing, because a
  deadline-truncated capture can have it. `extract.json` is deliberately not a
  completion file: extract is free to re-run and a capture is not, so a domain
  missing only that is extracted rather than captured again.
- **Extract makes no network request.** The dead-link check is removed entirely,
  not defaulted off: it sent a HEAD to every link, which at ~22 links with 5 s
  timeouts exceeded the whole 60 s capture budget on its own, and nothing
  downstream read the result.
- **An extract failure never fails a capture.** It is logged and counted, and
  the capture is uploaded either way. Extract is our own parser over bytes we
  already hold — re-running it costs nothing.
- **The mobile screenshot is the product.** It is what the pitch attaches. A
  cookie banner, a blank lazy-load band or a half-rendered hero in it makes the
  lead worthless, which is what everything below is for.

#### Browser and page

- **One browser, one context per domain**, closed in a `finally`. A context is
  ~5–10 MB against ~80 MB for a browser, so `--concurrency` counts contexts. A
  leaked context is what exhausts memory on a long run.
- **Launch.** The box uses `channel: 'chromium'` (full Chromium in new headless
  mode) with `--disable-blink-features=AutomationControlled`. The Lambda uses
  the image's default build and adds `--no-sandbox` and
  `--disable-dev-shm-usage`.
- **Context options are fixed**, so a capture looks the same tomorrow: 1440×900,
  `deviceScaleFactor: 1`, `en-IN`, `Asia/Kolkata`, `reducedMotion: 'reduce'`,
  `colorScheme: 'light'`, service workers blocked. `ignoreHTTPSErrors: true`,
  because an expired certificate is a finding and the site behind it must still
  be captured.
- **User agent:** desktop Chrome plus `ProspectorBot/1.0 (+mailto:…)`. The
  Chrome prefix is there because many sites serve broken markup to unknown
  agents; the suffix is the identification politeness requires, and it stays
  when a site blocks it. The address in `capture-domain.js` is still the
  placeholder `prospector@example.com`.
- **Navigation** is `goto(final_url or https://<domain>/, { waitUntil:
  'domcontentloaded' })`, never `networkidle`: analytics beacons, chat widgets
  and autoplay video never go idle, so it would burn the full timeout on every
  lead. A navigation timeout is not a failure; capture continues with whatever
  rendered. Any other navigation error is classified and ends the capture.
- **`finalUrl` is `page.url()`**, not the response URL. A JavaScript redirect
  after `domcontentloaded` moves the page without a new main response, and
  extract needs the URL the DOM belongs to.

#### Settle sequence

In this order, budgeted at ~10 s. Fonts before the shot, consent before the
scroll, scroll before the shot.

1. **Freeze.** A stylesheet zeroes every animation and transition duration and
   delay, and every `<video>` is paused at frame 0. Carousels are the reason: an
   unfrozen slider gives a different hero on every run.
2. **Dismiss consent** (below).
3. `document.fonts.ready`, capped at 3 s.
4. **Stepped scroll** to the bottom in 80%-of-viewport steps, 120 ms apart,
   capped at 30,000 px, then back to the top. Stepped, because
   `IntersectionObserver` loaders only fire for viewports actually traversed;
   capped, so an infinite-scroll page cannot eat the budget. It also puts
   scroll-loaded content into `rendered.html`.
5. **Force images:** `loading="lazy"` becomes `eager`, `data-src` is copied to
   an empty `src`, and every incomplete image is decoded, raced against 5 s so
   one broken image cannot stall the capture.
6. **Freeze again**, since lazy content can bring its own animations.
7. Wait 1,200 ms.

#### Consent

Three strategies, in order. The outcome is not recorded anywhere.

1. **Block the script.** Before navigation, any request matching
   `cookiebot|onetrust|cookieyes|termly|iubenda|osano|quantcast|cookie-?consent|cookie-?notice|gdpr|borlabs`
   is aborted.
2. **Click.** Buttons by role, then any element by text, matching *Accept all,
   Accept all cookies, I accept, Accept, Allow all, Got it, OK, I agree, Agree,
   Understood, Continue, Close, Sounds good*. First match wins, 2 s budget.
   Anything matching `settings|preferences|manage|customi[sz]e|reject|decline|more info`
   is never clicked: it opens a modal, which is worse than the banner.
3. **Remove what survived:** a `fixed` or `sticky` element with `z-index` over
   900, taller than 60 px, whose text mentions `cookie|consent|gdpr|privacy`. The
   text test is what keeps a legitimate sticky header, which the operator needs
   to see.

How common banners are on Coimbatore sites is unmeasured, probably low. The
handling stays regardless, because one banner ruins the pitch asset.

#### Viewports

- **Desktop first**, 1440×900. Then **mobile**, 390×844, with a fresh scroll,
  image pass, freeze and an 800 ms wait, because resizing re-triggers
  responsive layout and lazy loading. `rendered.html` is taken after both, so it
  holds the DOM after the mobile re-settle.
- **Mobile keeps the desktop user agent**, with no `isMobile`, touch or device
  emulation. The shot exists to show what a desktop-layout site does squeezed
  into a phone; a mobile UA can switch the site to a separate mobile theme and
  hide the defect the pitch is about.
- **Encoding:** each shot is a PNG in memory, resized by `sharp` to 720 px wide
  (`fit: 'inside'`, never enlarged), WebP quality 50, effort 4, written as
  `.tmp` and renamed. About 34 KB for both.

#### Failures and retries

Every failure is per domain and writes `error.json` (shape and `kind` values in
`docs/SCHEMA.md`); the run moves on.

- **Retried once:** `nav-timeout`, `crash`, `blocked-429`, `blocked-403`, after
  5 s (30 s for a 429). **Never retried:** `dns`, `refused`, `robots`,
  `deadline` — a slow page burns the deadline again.
- **Headful fallback.** A `blocked-403` retry asks for headful, but it only
  takes effect when the browser had to be relaunched: the context ignores the
  flag and a live browser stays headless. `--headful` launches headful for the
  whole run. How many sites block headless is unmeasured; if it passes ~10% of a
  run, make headful the default rather than a fallback.
- **Crash recovery.** `browser.isConnected()` is checked before each capture and
  a dead browser is relaunched. A thrown capture is caught and written as
  `crash` or `unknown`.

#### Politeness

Non-negotiable, for qualify and capture alike. A stage that cannot obey these
skips the domain.

- **robots.txt honoured**, parsed once per host and cached for the run. Qualify
  skips a disallowed `/` as `robots-disallow`; capture writes
  `kind: "robots"`. Neither fetches the path anyway.
- **1,500 ms minimum between requests to the same host**, on top of the global
  concurrency cap (qualify 8, capture 4).
- **Identifying user agent**, never stripped to get past a block. New headless
  is used because old headless is flagged as a bot even for legitimate traffic,
  not to disguise anything.
- **Homepage only.** A survey, not a crawl: no contact page, no second page.
- **Hard budget:** 30 s navigation (`--timeout`), ~10 s settle, 60 s over the
  whole capture (`--deadline`).
- **Extract fetches nothing** (below).

### Extract (inside capture)

Not a stage and not a command: it is what capture does to each domain after the
shots land, and it lives in `src/capture/extract/`. A parser over `rendered.html`, and nothing else: no fetch, no HEAD, no DNS, no
model, no clock. `extractDir({ dir, domain, finalUrl })` in
`src/capture/extract/index.js` is synchronous, parses with cheerio, and writes
`extract.json` (shape in `docs/SCHEMA.md`). `finalUrl` resolves relative hrefs
and names the site's second own domain; it defaults to `https://<domain>/`.
Three callers share it: capture on the box and the Lambda pass the browser's
`page.url()`, `capture --extract-only` passes `companies.final_url`.

**Output is a pure function of `rendered.html`, `domain` and `finalUrl`.** Two
runs give byte-identical files, and `npm run test:extract` asserts it. One
honest caveat: after a JavaScript redirect to another domain, `page.url()` and
`final_url` differ, and so can the own-domain filter, so a `--extract-only` re-extract
may not reproduce the Lambda's file exactly.

No phones, addresses, hours or agency credit — Places already supplies the first
two, and the operator derives agencies from `links`.

#### Links (`src/capture/extract/links.js`)

Every outside link, in document order. The site's **own domains** are two: the
registrable domain of `https://<domain>/` and of `finalUrl`, so a site that
redirects `example.com` to `example.net` does not list itself.

For each `a[href]` and `area[href]`:

1. Skip an empty href or one starting with `#`.
2. Resolve against `finalUrl`, drop the hash, and delete `utm_source`,
   `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `gclid`, `fbclid`,
   `mc_cid`, `mc_eid`.
3. Keep only `http:` and `https:` after resolution. That drops `mailto:`,
   `tel:`, `javascript:` and the rest, and keeps a protocol-relative `//host/x`.
4. Skip anything longer than 2,048 characters.
5. `target_domain` is `tldts.parse(url).domain`, lowercased. Skip it when null,
   one of the own domains, or WhatsApp (`wa.me`, `whatsapp.com`;
   `api.whatsapp.com` resolves to the latter). WhatsApp is a phone number
   wearing a URL, and Places has the phone.
6. Dedupe on the normalised URL; first occurrence wins.
7. `kind` is `social` when `target_domain` is in `SOCIAL_HOSTS` (facebook,
   instagram, twitter, x, youtube, youtu.be, linkedin, pinterest, tiktok, t.me,
   snapchat), else `external`.
8. `region` is the nearest `nav`, `header`, `footer`, `main` or `aside`
   ancestor, else `main`.
9. `text` is the element's text, whitespace collapsed, trimmed, at most 120
   characters.

Internal links, shadow DOM and iframes are out of scope.

#### Email (`src/capture/extract/email.js`)

One address, lowercase, or `null`: `companies.email` is one column, and the
operator writes to whichever address the site puts first.

1. `a[href^="mailto:"]` in document order, with `mailto:` and any `?…` query
   stripped. A site that links an address means that one.
2. Otherwise the page text: `<body>` with `<script>` and `<style>` dropped and a
   newline at every non-inline element boundary. `$('body').text()` would glue
   `<p>info@foo.com</p><p>Call us</p>` into `info@foo.comCall`, a
   valid-looking wrong address.
3. Match `/[\w.+\-]+@[\w\-]+\.[\w.]{2,}/g`; the first accepted match wins.

Rejected in both passes: a domain in `REJECT_EMAIL_DOMAINS` (`example.com`,
`sentry.io`, `wixpress.com`, `cloudflare.com`, `schema.org`, `w3.org`,
`google.com`, `googleapis.com`), a domain ending in an image extension
(`logo@2x.png`), and `noreply@`, `no-reply@`, `donotreply@`.

#### `capture --extract-only`

Skips the browser and re-extracts what failed, so a parsing change never costs a re-crawl. That is its
only reason to exist; a normal run never invokes it.

Its work list is `status = 1 AND extract_status = -2`: captured, and extract
either never ran or produced something unusable. `--resume` is gone with the
files — the rows say which domains need doing. When `rendered.html` is not on
this machine, which is the usual case because the Lambda captured it, it is
downloaded from S3 first and the new `extract.json` uploaded back, so the next
`ingest` and the Lambda's own skip check both see the fix.

### ingest

An independent command, never part of `all`: a local capture records itself, and
ingest exists for the Lambda path, where the bytes land in S3 and nothing would
otherwise tell the database they exist. It runs after every Lambda dispatch and
on a 15-minute systemd timer (`prospector-ingest.timer`). It does not load
business details — discover and qualify write those rows directly.

It lists `<city>/companies/` **once** per run, paginated: about five keys per
domain, so ~50 requests for 9,600 domains. The alternative, a HEAD per completion
file per pending domain, is 30,000 requests to learn the same thing. Then, per
domain in the work set, eight in flight:

1. **Copy to disk** from S3: the screenshots, `extract.json`, and `error.json`
   if present. `rendered.html` only with `--with-html`, which keeps the box's
   data disk small.
2. **Record in MySQL**, one transaction for every row with that domain: the
   email and the `links` rows, `extract_status`, then `status` (`1` or `-2`, by
   the completion rule), written last.

- **Copy first, mark second.** Every file is renamed into place before the
  transaction opens, and "complete" requires both screenshots to be on local disk
  as well as in the listing. A crash before the commit leaves the row exactly as
  it was and the next run redoes the domain; a crash after it leaves a row at
  `status = 1` whose screenshots the deck can actually serve.
- **Idempotent.** A second run over unchanged S3 downloads nothing (size and
  `LastModified` are compared against the local copy) and writes nothing
  (`recordDomain` compares the row it would write against the row that is there).
- It never runs extract; the Lambda already did.
- It never writes the operator's decision columns, or a discover or qualify one.

## Storage

### S3 layout: FIXED

Bucket `prospector-captures-700897991126`, versioning suspended, SSE-S3,
Standard class.

```
s3://prospector-captures-700897991126/
  <city>/companies/<domain>/desktop.webp
                            mobile.webp
                            rendered.html     post-JS DOM; extract reads this
                            extract.json      first email + outside links
                            error.json        only when the capture failed
```

That is the whole bucket. Discover and qualify write rows, so nothing is written
under `<city>/places/` any more and the box's role no longer grants it.

Keys are built in `src/capture/s3.js`, every segment lowercase and produced by
`lib-keys.js`. One domain is one flat prefix: nothing nests under it, and
`companyDir` in `lib-keys.js` builds the identical path on disk.

Objects under the old `captures/`, `derived/` and `places-raw/` prefixes are
left where they are. Nothing writes or reads them.

Other buckets: `prospector-deploy-700897991126` (releases, 30-day expiry) and
`prospector-tfstate-700897991126` (Terraform state).

**City first.** A city is a whole campaign: one keyword set, one bbox, one
billing story, one decision to archive. A second city adds a prefix and touches
nothing existing, and a city can move to its own bucket as one prefix copy. One
domain in two cities is stored twice; not worth a dedup table at ~34 KB of
screenshots.

**No vertical in the capture key.** A vertical is a classification, and
classifications get corrected; a domain is a fact. A vertical in the key strands
the bytes the moment a company is recategorised, and stores two copies when one
website backs two `place_id`s in different verticals. Nothing needs it: `ingest`
works from rows and the deck from MySQL. Extract's output does not depend on the
vertical either, so it shares the folder.

**The consequence is that a domain must be deduped before it is captured.** One
website listed by two businesses is one folder, so the second capture would pay
for bytes the first already wrote. That is now a property of the queries rather
than of three hand-written passes: `capture`, `capture --extract-only`, `dispatch` and `ingest`
all take their work from `SELECT DISTINCT domain`, and `recordDomain` writes the
result to every row with that domain. The control panel's counts are rows, and
say so.

**No date and no run id.** The key must be computable from columns that exist,
because nothing stores a path. A 16-hour sweep also crosses midnight, so a date
would split one run across two prefixes.

**Versioning is suspended.** A domain is captured once and never re-captured —
`captureComplete` in the Lambda and `--resume` on the box both skip one that is
already there — so no key is overwritten and there is nothing for versioning to
protect. It was load-bearing only while `places-raw/` overwrote a per-query key
every run. Suspended rather than removed because a bucket that has once had
versioning cannot return to unversioned; the noncurrent versions already written
stay as they are, and there is still no expiry rule.

**Standard, not Standard-IA.** IA bills a 128 KB minimum per object against
~34 KB of screenshots. At this scale it is moot anyway: 50,000 captures is
~1.7 GB of screenshots, about $0.04/month.

**The capture is what can't be recreated; `extract.json` is what can.**
`rendered.html` is always uploaded (~133 KB per domain *measured*; ~1.3 GB for
~9,600 domains, about $0.03/month), so extract can be re-run on the box at any
time against the exact DOM the shots were taken from.

### One canonical spelling

`lib-keys.js` owns `canonicalCity` and `canonicalDomain`. The S3 key, the local
directory and `companies.domain` / `companies.city` must agree byte for byte. If
they drift, resume stops recognising finished work and the next run re-captures
everything at full cost, looking exactly like a first run.

The producer of a domain is `registrable()` (`src/discover/provider.js:29`),
which runs the URL through `tldts.getDomain()`: lowercase, every subdomain
(`www` included) removed. `canonicalDomain` re-applies the same rules, is
idempotent, and throws rather than emit a path-unsafe segment. A bad key that
lands in the bucket is worse than a loud failure.

### Local disk

The disk mirrors S3, so `ingest` is a prefix copy with nothing to translate:

```
data/<city>/companies/<domain>/   desktop.webp  mobile.webp
                                  rendered.html  extract.json  [error.json]
```

That is all of it. There are no per-vertical directories any more: the business
list and every piece of pipeline state are rows, so nothing walks `data/`
looking for a vertical and nothing can mistake the city directory for one.

`companyDir` in `lib-keys.js` builds the path and `companyKey` in
`src/capture/s3.js` the matching key; nothing else spells either.

On the box, `data/` is a symlink to `/var/lib/prospector/data` on the data
volume. In this checkout, `data/` is whatever `npm run test:run` last left
behind, not a real run.

### MySQL

The schema is `docs/SCHEMA.md`: three tables, `verticals`, `companies`, `links`,
plus `schema_migrations`. `db/migrations/0001_init.sql` creates them and
`node src/cli migrate` applies them.

`src/db/mysql.js` is the only module that opens a connection — one pool, at most
four, because mavdb is a `db.t4g.micro` with 1 GiB shared by every app in
clasher. Configuration is `DATABASE_URL` when set (the laptop and every test) and
`DB_HOST` + `DB_PASSWORD` from `/run/prospector/env` otherwise (the box, with TLS
verified). `DATABASE_URL` must never reach SSM: `load-env.sh` turns every
parameter under `/prospector/` into an environment variable, so one there would
silently replace the box's verified connection with whatever it pointed at.

`tx()` runs at **READ COMMITTED**, not the default. `recordDomain` opens with
`SELECT … WHERE city = ? AND domain = ? FOR UPDATE` over the non-unique
`by_site` index; under REPEATABLE READ that takes next-key locks covering the
gaps between index entries, so two of ingest's eight workers recording
`alpha.com` and `beta.com` — adjacent in that index — lock each other's gaps and
deadlock. It is not a rare race: it happened on the first run of the ingest test.
READ COMMITTED takes no gap locks, and nothing here needs more, since every
transaction reads and writes exactly one `(city, domain)` group. A bounded retry
on `ER_LOCK_DEADLOCK` sits behind that for the foreign-key checks on `links`.

**S3 holds bytes; MySQL holds state.** "What is left to capture" is one indexed
query on `companies.status`. The bucket is never listed to answer it, except by
`ingest`, once per run.

- **Instance:** `mavdb` in clasher. RDS MySQL 8.4.8, `db.t4g.micro`, 20 GB,
  single-AZ, not publicly accessible, shared by every app, 1 GiB of memory.
- **Network:** VPC peering from rogue `10.43.0.0/16` to clasher's
  `vpc-0fb530a7a75f1cdb0` (CIDR read from a data source; a `precondition` fails
  the plan if the two overlap), in its own Terraform root (`terraform/mavdb/`) so
  `./p down` / `./p up` never touch clasher. The clasher side is standalone
  resources only (accepter, routes, one SG ingress rule), so Terraform never owns
  clasher's route tables or security group. mavdb has **two** security groups, so
  the rule's target is a variable checked against the instance rather than
  guessed. The rogue VPC, subnet, gateway and route table now live in `persist`
  so the peering survives `./p down` — and that route table carries no inline
  `route {}` block, because an inline route would make `persist` the owner of
  every route in it and the next apply would delete the peering route. A relay on MaverickInstance was rejected: it
  would face the internet, put clasher's production box in prospector's path,
  and add a process to maintain.
- **Isolation:** its own database `prospector` and its own user `prospector`,
  never `maverick`. The database name in a URL restricts nothing; grants do.
  One user for now, with DML and DDL on `prospector.*`; a separate migration
  user is deferred (spec E). Database, user and grants are created by Terraform
  (`terraform/db/`); its state holds the generated password, never `maverick`'s.
- **Credentials:** SSM SecureString `/prospector/db-password`, read at service
  start by `deploy/load-env.sh` like every other secret. TLS verified against
  the pinned RDS CA bundle. Connection pool of at most 4.
- **IAM database authentication: rejected.** It needs 300–1000 MiB of spare
  memory on the instance
  ([AWS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.html)),
  and mavdb has 1 GiB for every app.
- **Migrations:** numbered plain-SQL files plus a small runner, no ORM, on the
  laptop's MySQL 8.0.39 and on mavdb's 8.4. `./p up` runs `migrate` on the box
  after `ship`; it is idempotent, so it runs every time rather than trying to
  remember whether it has.
- **The generated password is in `db.tfstate`** — `random_password` keeps its
  result and `mysql_user` keeps the value it was given. That bucket is private,
  public access blocked and SSE-S3 encrypted. `maverick`'s password is not:
  provider configuration is never written to state.

#### `companies.status`

`NULL` discovered, `-1` no usable website, `0` pending capture, `1` captured,
`-2` capture failed; plus `extract_status`. Who sets which is in
`docs/SCHEMA.md`.

A later capture that completes moves `-2` to `1`. The `-2` state exists
because captures do fail (one run-1 capture took 677 s against a 12 s mean), and
without it every resume retries the same broken sites and "never tried" is
indistinguishable from "tried and failed". Retrying `-2` is an explicit action
(spec C's re-dispatch).

#### Deliberately absent

- **No `cities`, `runs`, `scores`, `agencies` or `contacts` tables.** City is a
  slug column; a business is captured once, so the capture date is a column;
  there is no scoring; agencies are a query the operator runs over `links`; the
  first email is a column.
- **No S3 paths.** Every key is computable from city and domain.
- **No merging by website.** `place_id` is the only identity. Rows can share a
  domain, and then share one capture, one extract and the same links.

## Capture on Lambda

Built: `src/capture/lambda.js` (handler), `src/capture/s3.js` (keys, uploads),
`scripts/dispatch.js` (fan-out), `Dockerfile.capture` (image, built natively on
the box, ~1.05 GB), `terraform/stack/lambda.tf`.

`captureDomain` already took `outDir`, so the handler points it at `/tmp`,
uploads, and clears `/tmp`. The CLI path is unchanged.

| Setting | Value | Why |
|---|---|---|
| Architecture | arm64 | Matches the box that builds the image |
| Memory | 2,048 MB | See below |
| Timeout | 900 s | Lambda's maximum |
| Batch | 10 domains | `10 × 60 s = 600 s < 900 s`; 15 hits 900 s exactly |
| Deadline | 60 s (`CAPTURE_DEADLINE_MS`) | What makes any batch's worst case finite |
| VPC | None | A NAT gateway is ~$32/month, more than the compute |
| Invocation | Async, 2 retries, then SQS `prospector-capture-failed` | The on-failure destination records the error, not just the event |
| Reserved concurrency | None | An account capped at 10 cannot reserve any |

**Why 2,048 MB.** Lambda scales CPU with memory (1,769 MB = 1 vCPU). The settle
is a deadline race (see *capture*), so less CPU means worse screenshots, not just
slower ones. `_forceImageDecode` has no memory ceiling, and an OOM kills the
invocation, losing all 10 domains: fail-soft per domain does not survive process
death. Measure rather than model: every `REPORT` log line carries Max Memory
Used. The bigger cost lever is the settle itself: ~7 s of every ~12 s capture is
billed waiting, so trim what is padding rather than measured need.

**Handled, and easy to get wrong:**

- One browser per invocation. Chromium launch is 1–2 s; per domain it would
  waste 10–20 s of every batch.
- Fail-soft per domain. A thrown capture is caught and the batch continues.
- `/tmp` cleared after every domain. It persists across warm invocations, and a
  full `/tmp` fails in a way that looks like a capture bug.
- Before each domain the handler checks the three completion files in S3, so
  re-dispatching never re-captures finished work.
- Extract runs in the same container, right after the capture. It is cheerio
  over one local file, so the 60 s capture deadline does not cover it and a
  batch's worst case is still 10 × 60 s plus change. An extract failure is
  recorded on the result row and in `ExtractFailed`, and never withholds the
  upload.

**Dispatch** takes `SELECT DISTINCT domain … WHERE status = 0` (plus `-2` with
`--retry-failed`), builds each event business as `{ domain, qualify: { final_url } }`
— which is all the handler reads — and sends one async invoke per 10. Async
queued events expire after at most 6 hours; at concurrency 10 a large sweep's
late batches can expire into the failure queue. That is safe, because re-dispatch is idempotent, but spec C makes
it visible in the panel.

**Metrics.** The handler emits one EMF block per batch in
`Prospector/Capture`: `CapturesOk`, `CapturesFailed`, `CapturesSkipped`,
`BatchDurationMs`, and `ExtractOk` / `ExtractFailed`. Lambda's own
Invocations/Errors count batches, not pages, and read clean through a total
collapse. warden's `adapters/capture.py` reads the first four by name.

**IAM, fixed but not yet applied:** the Lambda role now has `s3:PutObject` and
`s3:GetObject` on `*/companies/*` plus `s3:ListBucket` on the bucket. Both are
required and neither was there. `captureComplete` uses HeadObject, which is
authorized as `s3:GetObject`, and without `s3:ListBucket` S3 answers a missing
key with 403 rather than 404 — which `_exists` throws on, by design. Every
domain in a real batch would have errored at the skip check before capturing
anything. A stub-S3 test cannot catch this; only spec C's first real batch can.

**Not wired yet (spec C):**

- The box role has no `lambda:InvokeFunction` or SQS read, so the panel's Lambda
  mode still fails. Its `companies/` read and list are written but need
  `terraform apply stack`.
- The deployed image predates spec A: it writes the old `captures/` layout and
  does not extract. `./p ship` rebuilds it (spec C task 1).
- The box has no browser (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` in
  `deploy/install.sh`), so local capture fails too.

### Throughput and free tier

- **Concurrency 10** (the new-account default) is enough for overnight runs.
  Worst case, every capture hits its 60 s deadline: 10 batches per 10 minutes,
  ~600 domains/hour, so ~9,600 domains in at most ~16 h. Typical is far faster.
- **Raise to 100** by support ticket only when overnight at 10 stops being
  enough. New accounts are the slowest to be granted.
- **Free tier** is 400,000 GB-s/month per account. Modelled: a typical capture is
  ~12 s × 2 GB ≈ 24 GB-s, so ~9,600 domains ≈ 230,000 GB-s. At the 60 s worst case
  it is ~1.15M GB-s, over the free tier. Measure the real figure, extract
  included, from the first batch (spec C).

### Six-account fleet (not built)

The design for when a second city needs it. One account is ~11× oversized for
~9,600 captures today.

- Six standalone accounts, six billing families, six free tiers: 2.4M GB-s/month
  pooled, about 100,000 captures/month at ~24 GB-s each.
- **Never invite them into an Organization with consolidated billing.** Free tier
  is per billing family, so joining collapses six allowances into one. Account
  `008` is already a management account (`o-348fkge8wq`) from an accidental
  Identity Center enablement; keep the other five outside it.
- One ECR repository in the central account with a cross-account pull policy.
  Cross-account pull works; cross-region does not, so every account stays in
  `ap-south-1`.
- The Terraform shape is a module per provider alias, a `for_each`, as warden
  already does for `warden-roles`.
- Round-robin across accounts. Don't route on `freetier:GetFreeTierUsage`: it lags
  billing by hours. Keep a local counter and reconcile daily.
- Sharding does nothing for discover: `GOOGLE_PLACES_KEY` is a Google Cloud
  project quota.

## Auth: access-key CSVs, never a profile

**There is no SSO in this project and no profile to log into.** Every AWS call
`./p` makes is authenticated from an access-key CSV, exported into
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` after `unset AWS_PROFILE
AWS_DEFAULT_PROFILE` (`p:83–92`). The `default` profile on the operator's laptop
is SSO into a **different, forbidden account**, which is precisely why `p` unsets
it rather than inheriting it; `allowed_account_ids` in each root's `versions.tf`
is the second layer, and `verify_account` comparing `sts get-caller-identity`
against the expected id is the third.

| CSV | Default path | Identity | Used by |
|---|---|---|---|
| root | `~/Downloads/rogue.csv` | root of rogue, `700897991126` | `./p up`, `peer`, `db` — anything that creates IAM or applies a root |
| deploy | `~/.prospector/deploy.csv` | `prospector-deploy` user in rogue | `./p ship`, `status`, `secrets`, `logs` |
| clasher | `~/Downloads/clasher.csv` | root of clasher, `028972816671` | `./p peer` only — the accepter and the route live in that account |

Override any of them with `PROSPECTOR_ROOT_CSV`, `PROSPECTOR_DEPLOY_CSV`,
`PROSPECTOR_CLASHER_CSV`. The deploy CSV is not downloaded: `./p up` creates the
scoped user with root creds and writes the CSV at mode 600 (`p:459–470`),
skipping the step when the file already exists.

**A bare `aws` or `terraform` command inherits the forbidden SSO profile
instead**, which is how an expired-token error gets mistaken for missing
credentials. Run AWS work through `./p`, or export the CSV keys the same way it
does. `terraform plan` has no `p` subcommand, so it is the one thing that needs
the export done by hand.

Root keys are the bootstrap credential and are meant to be deleted afterwards —
`box-discover-qualify` task 7.4, still untested.

## The box

Built 2026-09-26 by `.kiro/specs/box-discover-qualify/`. Live resource ids are
in `docs/STATUS.md`.

- **t4g.small, Ubuntu 24.04 arm64**, free until 2026-12-31. Not Amazon Linux
  2023: Playwright publishes arm64 Chromium for Ubuntu and treats AL2023 as
  unsupported, so `playwright install --with-deps` has no apt there.
- **Its own VPC** (`10.43.0.0/16`, one public subnet in `ap-south-1a`), not the
  default, because the box faces the internet.
- **Security group: 80 and 443 only.** Shell is SSM Session Manager; there is no
  port 22.
- **Two Terraform roots.** `persist/` holds what must survive `./p down`: both
  buckets, ECR, the data volume (`/var/lib/prospector`), the image-tag SSM
  parameter. `stack/` holds the rest and is destroyed by `./p down`. Two roots
  instead of `prevent_destroy`, which makes `down` fail rather than skip.
- **Secrets** are SSM SecureStrings under `/prospector/*`, copied from `.env` by
  `./p secrets`. `deploy/load-env.sh` writes them to `/run/prospector/env`
  (tmpfs, 0600) at service start.
- **Deploy** is `./p`: `doctor` (preflight, no credentials), `up`, `down`,
  `ship`, `status`, `logs`, `secrets`. `ship` uploads a `git archive` of HEAD
  and runs `deploy/install.sh` over SSM, which keeps 3 releases and rolls back on
  a failed health check. The capture image is built on the box itself, tagged by
  git sha.
- **Cost:** one public IPv4, ~$3.60/month. Proxying through warden's EIP instead
  was rejected: it puts warden's box in the path of every request.

### Two hostnames, one Caddy

| Hostname | Serves | Upstream | State |
|---|---|---|---|
| `prospect.themaverick.tech` | control (`src/control/`) | `127.0.0.1:7778` | Live |
| `leads.themaverick.tech` | the deck (`src/server/` + `preview/`) | `127.0.0.1:7777` | Built; live once the A record and `DECK_PASSWORD` exist |

- **Names, not paths.** Both apps emit root-absolute URLs (control's `api()`
  helper in `src/control/ui.html`, the deck's `/data/*` and `/preview/*`).
  `handle_path` strips a prefix on the way in but cannot change what the browser
  asks for. One hostname split by path was also rejected: the first new endpoint
  on either side collides silently as a confusing 404.
- **Separate names allow separate auth.** They have separate credentials:
  `CONTROL_PASSWORD` and `DECK_PASSWORD` in `.env`, copied by `./p secrets` to
  `/prospector/control-password` and `/prospector/deck-password`, hashed into
  `/etc/caddy/auth.env` by `install.sh`. Control can spend Places quota and start
  runs; the deck can be read. One credential for both would mean handing out the
  second to give away the first. The deck's `basic_auth` is at the site level, so
  it covers `/api/*` and the screenshots too.
- **The Caddyfile is assembled, not installed whole.** `deploy/Caddyfile.global`
  (the options block, which must come first and appear once), then
  `Caddyfile.prospect` and `Caddyfile.leads`, each included only when its name
  resolves — a block for a name that does not resolve puts Caddy in an ACME retry
  loop it cannot get out of. The two names are polled independently, so a missing
  deck record never keeps the control panel off the internet.
- **Caddy, not nginx.** Automatic ACME, built-in `basic_auth` with bcrypt, no
  certbot or cron. Caddy flushes `text/event-stream` immediately and sets no read
  timeout on a stream, so control's SSE log works with no tuning.
- **Cert storage** is `/var/lib/prospector/caddy` on the data volume, owned by
  the `caddy` user, so certificates survive restarts and `./p down` without
  re-issuing into a Let's Encrypt rate limit.
- **DNS is Netlify**, not Route53. Each hostname is a manual A record to the EIP,
  and it must resolve before Caddy enables the site, or HTTP-01 fails. `./p`
  polls both names and enables whichever site block resolves.
- **No CSP.** Copying warden's `script-src 'self'` blanks the control panel,
  because `ui.html` is one file with inline script and style. Add a CSP only
  after splitting it into three files.

## Control: `node src/cli control`

A dashboard on port 7778 that shows progress and starts runs, built for a phone.
`src/control/`.

- **Progress:** captured / pending / failed per vertical and in total, with a
  failure breakdown, pushed over SSE every 3 s. One `GROUP BY` over
  `companies.status` replaces the filesystem walk this used to do — which could
  only see what was on *this* box, and so went wrong the moment the Lambda
  started capturing into S3. A Lambda capture appears once `ingest` has recorded
  it. **The counts are rows, not domains**, since several listings can share one
  website; the page says so.
- **Run:** capture the remaining domains `local` (on the box) or `lambda`
  (dispatch batches, then `ingest`), with concurrency, deadline and batch size
  set from the page.
- **New vertical:** a name and keywords, written to the `verticals` table, then
  discover → qualify → capture back to back — or discover → qualify alone with
  `captureMode: 'none'`. The Places request estimate (25 tiles × keywords, up to
  3 pages) shows before the button.

Constraints it enforces:

- **One run at a time.** Two captures would fight for the same 2 GB and the same
  per-host throttle, and re-capture each other's work.
- **A pipeline halts on a failing stage.** Qualifying an empty discover, or
  capturing an unvetted list, produces a confidently empty result rather than an
  error.
- **Stop is safe.** SIGTERM, then SIGKILL after 8 s. Capture is per-domain
  atomic, so a stop loses at most the page in flight.
- **Auth is Caddy `basic_auth`, with `CONTROL_TOKEN` unset.** Unset, the server
  binds `127.0.0.1` (`src/control/index.js:316`) and Caddy is the only public
  listener. Setting the token binds `0.0.0.0` and puts the secret in a query
  string, where it lands in logs and phone history. The token stays for the case
  where nothing is in front.

## The deck: `node src/cli serve`

What the operator reads to decide. A lead is a `companies` row at `status = 1`:
the two screenshots, what Places knows, what qualify measured, the first email
and the outside links grouped social / other — and the operator's own tier,
pitch flag and note, which are the only things the deck writes.

**Nothing here computes a judgement.** No score, tier, gate, angle, flaw, signal
or agency: not in a column, not in a filter, not in the export. Searching the
served files for any of those words finds nothing, and that is a check, not a
coincidence.

`src/server/index.js` (Fastify, ~7 routes) and `preview/` (one page, no
framework, no build step). `preview/app.css` is unchanged — it was always the
design contract, and the rewrite is `app.js` alone. `src/db/index.js`,
`preview/data.js` and `preview/mocks.js` are deleted with the old deck.

- **Binds `127.0.0.1`**, hard-coded. Caddy holds the certificate and the
  password and is the only public listener; a deck on `0.0.0.0` would serve
  every lead and every decision to anything that could reach port 7777.
- **Auth covers the screenshots too.** `basic_auth` is at the site level in
  `Caddyfile.leads`, so `/api/*` and `/shots/*` are behind it as well. Gating
  only `/` leaves the captures public, and it looks correct when you test it.
- **Screenshots are served from local disk**, never by proxying S3 and never
  from a FUSE mount: mounted, every request is an S3 GET, a 60-card grid is 60
  round trips, and a stale mount makes the server 500. That is also why `ingest`
  requires both screenshots on disk before it will mark a row captured.
  `/shots/:domain/:file` validates the domain against `lib-keys.DOMAIN_RE` and
  the file against a two-name allow-list, and sets
  `Cache-Control: private, max-age=604800` — a capture never changes.
- **Everything pages.** `limit` defaults to 60 and is capped at 60; no endpoint
  returns every lead. The old deck read the whole of `data/index.json` with
  `readFileSync` on every request, under `Cache-Control: no-store`, at ~4.2 KB a
  lead — 16 MB at run 1's 3,906, 41 MB at ~9,600. Offset paging is fine at ~530
  leads a vertical; revisit only past ~5,000.
- **Filters are a fixed map**, looked up by key and never interpolated. An
  unknown key is a 400, so a typo in the UI fails loudly instead of quietly
  widening the result set. It is the one place the deck builds SQL by
  concatenation.
- **Decisions are optimistic, and honest about it.** The control flips first so a
  fast reviewer is not waiting on a round trip; if the `PUT` fails it reverts and
  says "not saved". `localStorage` holds no decision — a decision that exists
  only in one browser is a decision that is lost — and `reviewed_at` is set by
  the server, not sent by the page.
- **The pitch CSV is defused.** UTF-8 with a BOM, CRLF, every field quoted with
  `"` doubled, and a leading `=`, `+`, `-` or `@` prefixed with an apostrophe: a
  business called `=Zeta` is a name, not a formula.
- **No CSP**, for the same reason control has none.

### Deck design

`preview/app.css` is the design contract. Extend it in the same idiom; don't
rewrite or reinterpret it. Where this section and the CSS disagree, the CSS
wins.

- **The screenshots are the only colour in the interface.** Every coloured
  pixel in view belongs to a lead, not to the chrome, and that is what makes
  reviewing hundreds of sites in one sitting tolerable. `#000` ground, `#fff`
  ink, and greys only: no accent, no brand colour, no colour-coded badge, no
  chart palette. A feature that seems to need colour uses weight, opacity,
  inversion or space instead.
- **Hierarchy is four opacity steps** (`--o1` 1, `--o2` .64, `--o3` .40,
  `--o4` .24) and hairline rules (`--rule` `rgba(255,255,255,.12)`,
  `--rule-strong` .22). **Emphasis is an inverted block**, white ground and
  black ink, as on a pressed chip or tier button.
- **Tier is a glyph or a letter, never a hue:** A, B, C, X, told apart by
  opacity.
- **One monospace stack** (`--mono`), a fixed type scale (`.t-micro` 10 px to
  `.t-num` 34 px), `tabular-nums` on every numeric column, spacing in multiples
  of `--u` (8 px). No shadows, no rounded corners, no animation beyond the
  120 ms crossfade (`--t`).
- **Layout:** the lead view is `270px | minmax(0,1fr) | 300px`, narrowing at
  1100 px; below 860 px the rails collapse and nothing scrolls sideways.
- **No toolchain and no network.** Plain HTML, CSS and JS: no framework, no
  bundler, no build step. No external font, CDN or telemetry request;
  `index.html` loads `app.css` and `app.js` and nothing else.

Accessibility, as the deck implements it:

- Every control is a real `<button>` or `<a href>`, never a `div` with a click
  handler, and every key binding (A/B/C/X tier, pressing the current one
  clears it; P pitch; Esc back) is also a visible, clickable control. The
  keycap footer is the keyboard documentation.
- Filter chips, tabs and the pitch button carry `aria-pressed`; the tier
  buttons are `role="radio"` with `aria-checked` as well; the nav marks the
  current view with `aria-current="page"`. Keys are ignored while a textarea or
  input has focus.
- Every screenshot `<img>` has a real alt: "Mobile screenshot of <name>" in the
  grid, "<shot> screenshot of <name>" in the lead view.
- `:focus-visible` is a 1 px white outline at a 2 px offset; never remove it.
  `prefers-reduced-motion: reduce` turns off every animation and transition.
- `--o4` is decorative only. Never put text the operator needs to read at .24
  on black.

## Observability

The capture Lambda emits CloudWatch Embedded Metric Format on every batch: a log
line, not an API call, so it costs nothing and needs no extra permission.

```
Namespace   Prospector/Capture
Dimensions  [Vertical] and [] (aggregate)
Metrics     CapturesOk, CapturesFailed, CapturesSkipped, BatchDurationMs,
            ExtractOk, ExtractFailed
```

**Lambda's own metrics cannot answer the question that matters.** `Invocations`
and `Errors` count batches: a batch that captured 3 and failed 7 is a successful
invocation, so `Errors` reads zero through a total collapse.

warden (`D:\PROJECTS\AWS-COMMAND-CENTER`) reads these as a `capture` tile
(`warden/app/adapters/capture.py`), gated on a `prospector` capability tag so
only the account running captures collects it. The backend emits the tile; the
UI doesn't draw it yet, and rogue doesn't carry the tag yet (spec D). Free-tier
use is derived from summed billed `Duration` × configured memory, because there
is no "free tier used" metric and `freetier:GetFreeTierUsage` lags by hours.

## Scale

Measured from run 1 (18 verticals, on an EC2 box, truncated by the field-mask
bug):

| | Run 1 (*measured*) | Untruncated (*modelled*) |
|---|---|---|
| Places requests | 3,600 (4.8% of the daily quota) | ~5,504 (7.3%, ~12 min at 8 req/s) |
| Raw results | 31,284 | ~55,000–69,000 |
| Domains captured | 4,315 | ~7,600–9,600 |
| Leads | 3,906 | — |
| Wall clock | 4 h 57 m | — |

The untruncated estimate comes from the measured 26.4% cap rate: 952 capped
queries lifting from 20 toward 60 results. Discover is not the long pole; the
quota allows ~13 full sweeps a day. 50,000 is used below only as a round
city-wide ceiling, not a projection.

Per 50,000 domains, beyond compute (*modelled*):

| Item | Cost |
|---|---|
| S3 PUTs, 4 per domain (5 when the capture failed) | ~$1.00 once |
| S3 storage, ~8 GB (1.7 GB screenshots, ~6.4 GB rendered DOM) | ~$0.20/month |
| ECR storage, per retained ~1 GB image | ~$0.10/month |

## Open

- **Clasher network facts.** The instance is read: `mysql 8.4.8`,
  `db.t4g.micro`, private, `mavdb.cv0wqe8og7uh.ap-south-1.rds.amazonaws.com`, in
  `vpc-0fb530a7a75f1cdb0`, two subnets
  (`subnet-092a18e2fd85bd0b1`, `subnet-0825e0989e6f07196`), and **two** security
  groups — so `terraform/mavdb` takes `-var mavdb_security_group_id` rather than
  assuming one, and `./p peer` fails at plan time naming both until it is given.

  Read 2026-09-27, with the clasher key: **clasher's VPC is `10.0.0.0/16`**, so
  it does **not** overlap prospector's `10.43.0.0/16` and the CIDR precondition
  passes. The instance is `available` and `PubliclyAccessible: false`. The two
  security groups are `sg-0dd18a4efc3b3c824` (`default`, the VPC's default group)
  and `sg-08d3393b63a12b9ca` (`rds-ec2-1`, purpose-built, "attached to maverick
  to allow EC2 instances with specific security groups attached to connect").
  **`rds-ec2-1` is the one to pass:** it is where database access is expressed,
  and its 3306 ingress is security-group-sourced rather than a CIDR. Ingress
  across attached groups is a union, so either would function — this is a
  hygiene choice, not a functional one.

  Still unread: each subnet's route-table association, which is not guessed —
  one `data "aws_route_table"` per subnet resolves the main table when a subnet
  has no explicit association. Still unverified: whether mavdb's endpoint
  resolves to a private IP from rogue, a check on the box after `./p peer`.

- **mavdb's default security group allows 3306 from `0.0.0.0/0`** —
  `sg-0dd18a4efc3b3c824`, alongside 22 from `172.31.0.0/16`. The instance is not
  publicly accessible, so this is not reachable from the internet; what it does
  mean is that **anything inside clasher's VPC, and anything peered to it, can
  already reach MySQL on 3306** — including all of `10.43.0.0/16` the moment
  `./p peer` applies, which makes the ingress rule `terraform/mavdb` adds
  redundant in practice. That rule is still worth adding: it states the intent
  explicitly, and it is what should remain once the `0.0.0.0/0` rule is narrowed.
  Narrowing it is **spec E**, it is another team's database, and it should not be
  changed as a side effect of peering.
- **mavdb's existing users and grants** have never been inspected. The MySQL MCP
  tool connects to a local 8.0.39 on the laptop, not RDS (spec E).
- **Lambda cold start** (`Init Duration`) for the ~1.05 GB image, and whether
  2,048 MB survives image-heavy pages. Measured in spec C's first batch.
- **Places cost per request.** Billing showed ~Rs 171 for run 1's 3,600
  requests, far below the documented rate. Settle it from Billing → Reports,
  18–19 Sep, grouped by SKU, gross and net.
- **Extract time per domain** is not measured. It is cheerio over one file with
  no network, so it is expected to be milliseconds, but the Lambda's batch
  arithmetic assumes that rather than knowing it. Measured in spec C's first batch.

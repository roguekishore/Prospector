# Architecture

The target shape after the run-1 post-mortem: three stages, one MySQL schema, one
S3 bucket, and a deck that queries the database instead of a generated file.

**Built so far:** the capture Lambda and its S3 layer, the dispatcher, and the
container image (see *Capture on Lambda*). The `discover` and `qualify` stages
work as CLI commands.

**Not built:** MySQL — every stage still writes the per-domain file tree, there is
no `status` column, no `ingest`, and `serve` still reads `index.json`.
`src/db/index.js` is SQLite with a JSON fallback and has never persisted a mark.

Read the schema below as the contract to build against, and `docs/STATUS.md` for
per-item state.

## Pipeline

    discover ──live──► MySQL          rogue box
    qualify  ──live──► MySQL          rogue box
    capture  ─────────► S3            Lambda
    ingest   ◄── S3 ──► MySQL         rogue box
    serve    ◄── MySQL                rogue box  (runs any time)

Three stages produce data. `ingest` produces none — it reads what capture stored
and turns it into rows. `serve` is always-on and independent.

**`ingest` replaces the `extract` CLI stage**, and the name is deliberate: the old
`extract` both parsed HTML and wrote per-domain JSON files, so reusing it for a
stage that writes MySQL invites exactly the ambiguity this doc is meant to remove.
Parsing links out of the page is one thing `ingest` does, not what it is.

### discover

Slices the Coimbatore bounding box (`config/city.json`) into a 5×5 grid of 25
tiles, then runs every keyword of a vertical against every tile — 8 keywords ×
25 tiles = 200 searches. Each search is a Places Text Search restricted to one
tile rectangle, not the whole city: a single query caps at 60 results (3 pages ×
20), so a city-wide query silently truncates dense areas.

Paginates up to 3 pages per tile × keyword. **The `nextPageToken` field mask
(`src/discover/places.js:17`) is what makes pagination happen at all** — without
it the API omits the token, the loop breaks after page 1, and every query caps at
20. That was run 1's silent failure: 3,600 searches, 952 of them (26.4%) capped,
an estimated 2,000–3,000 leads never collected. No error was logged, because
nothing failed.

Deduplicates twice: by Places ID (same business found in adjacent tiles), then by
registrable domain (two listings, one website — the higher review count wins).
Portal profiles (99acres, Practo, WedMeGood) are bucketed as
`aggregator-profile-only` and excluded from the domain merge.

Rate-limited to 8 req/s in code (`src/discover/places.js:42`) against a quota
ceiling of 600/min and 75,000/day. A full untruncated 18-vertical sweep is ~5,504
requests — 7.3% of the daily quota, ~12 minutes of wall clock.

Writes: one `companies` row per business, upserted on `places_id`. Also drops the
verbatim Places response into S3 — MySQL holds what is queried, S3 holds
everything Google actually said.

**Only stage that spends Places quota.** Deliberately not in the
`.claude/settings.json` allowlist so it always prompts.

### qualify

An eligibility gate, nothing more. For each company with a website: DNS
resolution, a HEAD request, `robots.txt`, certificate validity. No browser.

In run 1 this removed 507 domains that did not resolve, 69 timeouts, plus 404s,
403s and dropped connections. Those are not failures — a business whose Google
listing names a dead domain is a different pitch, and the row stays in the table
marked `-1` rather than being deleted.

Writes: `companies.status` → `0` (ready to capture) or `-1` (no usable website).

### capture

The only stage that needs a browser, and the only expensive one — ~12s per
business. One page visit produces everything:

| File | What it is |
|---|---|
| `home.html` | The bytes the server sent, before any JavaScript ran |
| `rendered.html` | The DOM after JS executed, scrolling finished, images forced |
| `headers.json` | Response headers, redirect chain, cert, load timing, every asset |
| `desktop.webp` | 1440×900 viewport, resized to 720px, webp q50 |
| `mobile.webp` | 390×844 viewport, same encoding |

Both HTML versions are kept. `rendered.html` is what a visitor sees and what
extraction reads. `home.html` is what a crawler sees first, and the gap between
them is itself a finding — an empty `home.html` with a full `rendered.html` means
the site is invisible to basic crawlers.

Screenshots are viewport-only (`fullPage: false`), never full-page. `full.png` was
dropped; it was 75% of image storage at 2.6 MB average.

Writes: S3 only. Lambda cannot reach MySQL — see *Handoff* below.

### ingest

Reads capture output from S3, pulls every `<a href>` out of `rendered.html`, and
writes MySQL. Runs on the box on a timer (~30s) while capture is in flight.

**Offline and re-runnable.** It touches no websites, so re-running it over stored
HTML costs nothing. That property is why it stays separate from capture even
though the two are triggered together: link parsing rules will change — the agency
heuristic is new and untuned — and a rule change must never cost a crawl.

It doubles as the progress meter — once it is updating rows, "how far along are
we" is a count of rows by status. No separate counters needed.

Writes: `links` rows, and `companies.status` → `1` or `-2`.

Two constraints on what it may do:

- **No link probing in Lambda.** Dead-link detection sends a HEAD to every
  external link; at ~22 links with 5s timeouts that exceeds the whole 60s capture
  deadline. Probe later from the box over stored links if it is wanted at all.
- **Contacts come from Places, not the page** — address and phone are Places
  fields. Email, WhatsApp and socials have no Places equivalent and are derived
  from `mailto:`, `wa.me` and social links. An email printed as plain text rather
  than a hyperlink is not a link and will not be captured.

### serve

Queries MySQL and paginates. Runs any time — rows appear as `ingest` writes them,
so a vertical can be reviewed while another is still capturing.

Filter to `status = 1`; an uncaptured company renders with no screenshot and looks
broken.

## Handoff

One handoff, in one place, forced by one constraint: **Lambda runs outside any
VPC and cannot reach mavdb.** Attaching it to a VPC requires a NAT gateway at
~$32/mo — more than the compute it would be running.

So discover and qualify, which run on the rogue box, write MySQL live. Capture,
which runs on Lambda, writes S3 and nothing else. `ingest` on the box closes the
gap.

    rogue account          clasher account
    ┌────────────────┐     ┌──────────────┐
    │ prospector box │     │ maverick     │
    │  discover      ├────►│  instance    │
    │  qualify       │     │      │       │
    │  ingest        │     │      ▼       │
    │  serve         │     │ mavdb MySQL  │
    └───────┬────────┘     └──────────────┘
            │ sync
    ┌───────▼────────┐     ┌──────────────┐
    │   S3 bucket    │◄────┤ capture      │
    │   (rogue)      │     │ Lambda ×N    │
    └────────────────┘     └──────────────┘

S3 and the prospector box live in rogue. Only the MySQL connection is routed
through the maverick instance in clasher.

Sync the bucket to local disk, do not mount it. A FUSE mount turns every deck
request into an S3 GET and a 50-thumbnail grid into 50 round trips; mounts also go
stale and the server 500s when they do.

## Schema

```sql
CREATE TABLE cities (
  id     INT AUTO_INCREMENT PRIMARY KEY,
  slug   VARCHAR(64)  NOT NULL UNIQUE,   -- lib-keys.canonicalCity: 'coimbatore'
  label  VARCHAR(128) NOT NULL            -- config/city.json "city": 'Coimbatore'
);

CREATE TABLE verticals (
  id     INT AUTO_INCREMENT PRIMARY KEY,
  slug   VARCHAR(64)  NOT NULL UNIQUE,
  label  VARCHAR(128) NOT NULL
);

CREATE TABLE companies (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  places_id       VARCHAR(255) NOT NULL UNIQUE,
  city_id         INT NOT NULL,
  vertical_id     INT NOT NULL,
  domain          VARCHAR(255),          -- lib-keys.canonicalDomain(website); the S3 key segment

  -- Places, verbatim
  name            VARCHAR(255),
  website         VARCHAR(255),
  rating          DECIMAL(2,1),
  review_count    INT,
  address         TEXT,
  phone           VARCHAR(32),
  lat             DECIMAL(10,7),
  lng             DECIMAL(10,7),
  business_status VARCHAR(32),
  primary_type    VARCHAR(64),

  -- pipeline
  status          TINYINT  NOT NULL DEFAULT 0,
  attempts        TINYINT  NOT NULL DEFAULT 0,

  -- human review
  review_status   ENUM('pitch','maybe','no','skip') NULL,
  note            TEXT,
  reviewed_at     DATETIME,

  first_seen      DATETIME NOT NULL,

  FOREIGN KEY (city_id)     REFERENCES cities(id),
  FOREIGN KEY (vertical_id) REFERENCES verticals(id),
  INDEX (city_id, vertical_id, status, review_count),
  INDEX (domain),
  INDEX (review_status)
);

CREATE TABLE links (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id     BIGINT NOT NULL,
  href           TEXT NOT NULL,
  text           VARCHAR(512),
  region         VARCHAR(16),   -- nav | header | footer | main
  kind           VARCHAR(16),   -- internal | external | social | mailto | tel | anchor
  rel            VARCHAR(64),
  target_domain  VARCHAR(255),

  FOREIGN KEY (company_id) REFERENCES companies(id),
  INDEX (company_id),
  INDEX (target_domain)
);
```

### `companies.status`

| Value | Meaning | Set by |
|---|---|---|
| `1` | Captured | ingest |
| `0` | Pending | qualify |
| `-1` | No usable website | qualify |
| `-2` | Capture attempted, failed | ingest |

Resume is `WHERE status = 0 AND attempts < 3`. The `-2` state exists because
captures do fail — run 1 had one run 677s against a 12s mean, and with a 60s
deadline those become failures. Without a distinct state, every resume retries the
same permanently-broken sites and "never tried" is indistinguishable from "tried
three times".

### Why these indexes

`(vertical_id, status, review_count)` is the deck's query: open a vertical, show
captured companies, sorted by ability to pay. `target_domain` is the agency query
(below). `website` exists because two companies can legitimately share one site.

### What is deliberately absent

- **No `runs` table.** A business is scraped once. Re-scraping is not part of the
  design, so there is no run to scope anything to. The capture date lives in the
  S3 path, which gives free history if a site is ever re-crawled.
- **No `site_audits` / signals table.** Machine-derived quality signals were
  dropped: the operator reviews screenshots directly, and a machine tier is not a
  selling point to a non-technical buyer. This is the same reasoning that deferred
  `score`.
- **No `scores` table.** `score` is not in the pipeline. `lib-scoring.js` stays
  frozen at `rules@1`.
- **No `agencies` table yet.** Agency detection is
  `GROUP BY target_domain HAVING COUNT(DISTINCT company_id) >= N`, restricted to
  footer-region links — a domain credited across many unrelated sites is an
  agency. Build it as a query; add a table only when resolving names and pricing.
  This replaces keyword matching against `config/agency-aliases.json`.
- **No S3 paths in MySQL.** The path is computable from vertical, website and
  capture date. `status` records whether the capture succeeded, which is the only
  part that is not derivable.

### Known wrinkle

`companies` will not hold every business Places returns. Discover collapses
duplicates sharing a website, keeping the higher review count, so two clinics on
one group site become one row. Expect counts not to tie.

## S3 layout — FIXED

    s3://<bucket>/
      <city>/captures/<domain>/desktop.webp
                               mobile.webp
                               rendered.html      post-JS DOM; link extraction reads this
                               home.html          raw response body; fallback
                               headers.json
                               error.json         only when the capture failed
      <city>/places/<vertical>/discovered.json
                              /qualified.json
      <city>/places-raw/<vertical>/<query-sha>.json

Implemented in `src/capture/s3.js`. Every segment is lowercase and produced by
`lib-keys.js`, which is the only place a city or a domain is spelled. `raw/` is
flattened away — the local tree nests it for tidiness, but in S3 one domain is
already one prefix.

### City first

A city is a whole campaign: one keyword set, one bbox, one billing story, one
decision to archive. At the top of the key, a second city adds a prefix and
touches nothing existing, and a city can later be moved to its own bucket as a
single prefix copy. `config/city.json` already holds the display name, the bbox
and the grid, and `src/discover/index.js:307` already stamps the city into every
business — so this dimension exists in the data today and was only missing from
the key.

One domain appearing in two cities is stored twice. At ~34 KB a capture that is
not worth a dedup table.

### The vertical is not in the capture key

Vertical is a classification and classifications get corrected; a domain is a
fact. A key built from the vertical breaks the moment a company is
recategorised — the bytes are still good but nothing can compute their
location — and it stores two copies when one website backs two `place_id`s in
different verticals.

Nothing needs it. `ingest` works from MySQL rows, the deck queries MySQL, and no
code lists the bucket by vertical. A flat high-cardinality prefix is also kinder
to S3's request-rate partitioning than eighteen fat ones.

### No date and no run id either

The key must be computable from columns that exist, because nothing stores a
path — a date would itself have to be stored to be recoverable. A run id is
worse: a 16-hour sweep crosses midnight, so even a date splits one run across two
prefixes.

**Enable object versioning on the bucket. It is load-bearing, not optional.** A
re-capture then overwrites the key while the previous bytes stay retrievable as a
prior version: history with no date in the path and no schema. Without it a
re-capture is destructive, and that failure is silent.

There is deliberately **no noncurrent-version lifecycle rule**. A domain is
captured once and never on a schedule, so versions accumulate only from a
deliberate re-capture. Add an expiry rule if a periodic refresh is ever
introduced — that is the point at which version growth becomes invisible cost.

Captures also stay on S3 **Standard**. Standard-IA looks like the obvious saving
and is not: it bills a 128 KB minimum per object against an average capture of
~34 KB. The whole question is moot at this scale — 50,000 captures is ~1.7 GB,
roughly $0.04/month, and the 250,000 PUTs that write them about $1.25 once.

### One canonical spelling

`lib-keys.js` owns `canonicalCity` and `canonicalDomain`. Three places must agree
byte for byte: the S3 key, the local directory `data/<vertical>/<domain>/`, and
`companies.domain` / `cities.slug` in MySQL. If they drift, `--resume` stops
recognising finished work and the next run re-captures the whole estate at full
cost, indistinguishably from a first run.

The producer of a domain is `registrable()` (`src/discover/provider.js:29`),
which runs the URL through `tldts.getDomain()` and so already returns a lowercase
registrable domain with every subdomain — `www` included — removed.
`canonicalDomain` re-applies the same invariants, is idempotent, and throws
rather than emitting a path-unsafe segment. A bad key is worse than a loud
failure: it lands in the bucket and nothing notices until ingest cannot find it.

### `places-raw/` is provenance

`discovered.json` is processed output, not what Google said. The raw response
bodies are archived because they cost money, cannot be reproduced, and are the
only record of what the API actually returned on the night — the truncation bug
stayed invisible for a year for want of exactly this. The object name is a SHA of
the request descriptor, so a repeated query overwrites its own archive instead of
accumulating near-duplicates, and versioning keeps the earlier bodies.

### S3 holds bytes; MySQL holds state

"What is left to capture" is `companies.status` — 0 pending, 1 done, -1 no
website — in one indexed query. The bucket is never consulted for it. Doing so
would cost a HEAD per pending domain per dispatch and create a second opinion
that can disagree with the first.

`captureComplete()` therefore exists for a `--verify` repair mode that reconciles
the database against the bucket on demand, not for the resume path. It checks all
three completion files (`desktop.webp`, `mobile.webp`, `headers.json`), mirroring
`completionFiles()` at `capture-domain.js:127`. The earlier version tested only
`desktop.webp`, which a deadline-truncated capture can have on its own
(`capture-domain.js:75`) — that read as complete and would have abandoned a
half-captured domain permanently.

### Both HTML files are uploaded

`docs/DEPLOYMENT.md` treats `raw/` as an optional upload to save transfer — that
is overruled here. Storing the HTML makes every future parsing change a re-read
instead of a re-crawl, at ~2 GB for ~9,600 domains, about $0.05/month.
`rendered.html` is the post-JS DOM and is what link extraction reads;
`home.html` is the raw response body and the fallback.

Because the HTML ships either way, `DEPLOYMENT.md`'s argument for fusing the
HTML-parsing step into the capture Lambda no longer holds — the transfer it was
meant to avoid happens regardless. Lambda captures; `ingest` parses on the box.

## Capture on Lambda

Built: `src/capture/lambda.js` (handler), `src/capture/s3.js` (keys and uploads),
`scripts/dispatch.js` (fan-out), `Dockerfile.capture` (image).

`captureDomain` already took `outDir` as a parameter, so the capture itself is
unchanged: the handler points it at `/tmp`, uploads, and clears `/tmp`. That is
the whole adaptation — no rewrite, and the CLI path keeps working identically.

| Setting | Value | Why |
|---|---|---|
| Memory | **2,048 MB** | `_forceImageDecode` has no ceiling, and an OOM kills the batch, not one domain |
| Timeout | 900s | Lambda's max |
| Batch | **10 domains** | 10 x 60s deadline = 600s < 900s; 15 would be 900s exactly |
| VPC | **none** | A VPC needs a NAT gateway at ~$32/mo, more than the compute |
| Deadline | 60s (`CAPTURE_DEADLINE_MS`) | What makes the batch worst case finite at all |

Four properties that are easy to get wrong, and are handled:

- **One browser per invocation.** Chromium launch is 1-2s; per-domain it would
  waste 10-20s of every batch.
- **Fail-soft per domain.** A thrown capture is caught and the batch continues.
- **`/tmp` cleared after every domain.** It persists across warm invocations, so
  a batch that does not clean up eventually fills it and fails in a way that
  looks like a capture bug.
- **Resume is a HEAD on the expected key.** Re-running the dispatcher is the
  recovery path for anything async invoke dropped, and it re-captures nothing.

Async invoke reports nothing back. Attach a DLQ or failure destination, or a
domain that fails its two automatic retries is simply absent with nothing logged.

## Control — `node src/cli control`

A dashboard on port 7778 that shows capture progress and starts runs, built for a
phone first. `src/control/`.

**Progress is read from disk, never from the runner.** `qualified.json` says what
should be captured, `isComplete()` says what was, `error.json` says what failed
and why — the same triple `--resume` uses, read for display instead of for
skipping. That means a Lambda capture only appears once S3 is synced, which is the
honest number, because the deck serves from that same disk.

Three things it does:

- **Progress** — captured / pending / failed per vertical and in total, with the
  failure breakdown by kind. Pushed over SSE every 3s.
- **Run** — capture the remaining domains, either `local` (this box, slow,
  unattended overnight) or `lambda` (dispatch batches). Concurrency, per-capture
  deadline and batch size are all set from the page.
- **New vertical** — add a name and keywords, then run
  discover → qualify → capture back to back. The request estimate
  (25 tiles x keywords, up to 3 pages) is shown before the button, because
  discover is the only stage that spends Places quota and a phone tap is a low
  bar for spending money.

### Constraints it enforces

**One run at a time.** Two concurrent captures would fight for the same 2 GB and
the same per-host throttle, and the second would re-capture what the first is
mid-way through.

**A pipeline halts on a failing stage.** Qualifying domains discover never found,
or capturing a list qualify never vetted, produces a confidently empty result
rather than an error — the worse outcome.

**Stop is safe.** SIGTERM then SIGKILL after 8s. Capture is per-domain atomic, so
a stop loses at most the page in flight and `--resume` continues from there.

**Auth is not optional.** The server starts runs, spends Places quota and edits
`config/`. Without `CONTROL_TOKEN` it binds `127.0.0.1` only and says so; with one
it binds `0.0.0.0` and gates every route but the page itself. A shared token is
the floor — put Caddy with `basicauth` and TLS in front before it answers on a
public address.

## Observability

The capture Lambda emits CloudWatch Embedded Metric Format on every batch — a
structured log line, not an API call, so it costs nothing per invocation and
needs no permission the function does not already have.

    Namespace   Prospector/Capture
    Dimensions  [Vertical] and [] (aggregate)
    Metrics     CapturesOk, CapturesFailed, CapturesSkipped, BatchDurationMs

**Lambda's own metrics cannot answer the question that matters.** `Invocations`
and `Errors` count *batches*: a batch of 10 that captured 3 and failed 7 is a
successful invocation, so `Errors` reads zero straight through a total collapse.
Only these counters say how many pages were actually taken.

warden (`D:\PROJECTS\AWS-COMMAND-CENTER`) reads them as a `capture` tile —
`warden/app/adapters/capture.py`, contract §5.7. It is gated on a new
`prospector` capability tag in the registry, so only the account running the
fleet collects it and the other five render `not_applicable`.

The tile reports captures ok/failed/skipped with a failure rate, invocations and
throttles, and free-tier consumption in GB-s with the headroom expressed in
captures remaining. Six metrics on a 30-minute cadence, about $0.09/month against
warden's CloudWatch budget.

Free-tier usage is derived from summed billed `Duration` x configured memory.
There is no "free tier used" metric, and `freetier:GetFreeTierUsage` lags billing
by hours — already rejected as a routing input in `docs/DEPLOYMENT.md`.

**Still needed on the AWS side:** add the `prospector` tag to the account's row in
the `/warden/registry` SecureString (the local `accounts.local.json` copy has it,
the authoritative one does not), and grant the warden reader role
`cloudwatch:GetMetricData` and `lambda:GetFunctionConfiguration` in that account.

## Scale

Measured from run 1 (`logs/night.log`), truncated:

| | Run 1 | Untruncated estimate |
|---|---|---|
| Places requests | 3,600 | ~5,504 |
| Raw results | 31,284 | ~55,000–69,000 |
| Companies audited | 4,315 | ~7,600–9,600 |
| Wall clock | 4h 57m | — |

At 2,048 MB Lambda, ~9,600 captures is ~209,000 GB-s — **52% of one account's
monthly free tier.** One account covers a full city sweep twice over; the
six-account fleet in `docs/DEPLOYMENT.md` is sized against a capture count that
was roughly double the real one.

## Open

- mavdb schema — the `mysql` MCP server has been timing out, so the existing
  tables are unverified.
- Whether the maverick instance is a jump host or carries the MySQL credentials.
- `internal` vs `external` link classification looks wrong in the smoke tree
  (`internal: 0` for a site linking only to itself). The agency query depends on
  it. Verify before relying on it.
- Emails printed as plain text rather than `mailto:` links are not captured by a
  links-only model. Decide whether they are wanted.

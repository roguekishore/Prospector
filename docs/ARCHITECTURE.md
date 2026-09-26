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
CREATE TABLE verticals (
  id     INT AUTO_INCREMENT PRIMARY KEY,
  slug   VARCHAR(64)  NOT NULL UNIQUE,
  label  VARCHAR(128) NOT NULL
);

CREATE TABLE companies (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  places_id       VARCHAR(255) NOT NULL UNIQUE,
  vertical_id     INT NOT NULL,

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

  FOREIGN KEY (vertical_id) REFERENCES verticals(id),
  INDEX (vertical_id, status, review_count),
  INDEX (website),
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
      places/<vertical>/discovered.json
      places/<vertical>/qualified.json
      captures/<vertical>/<domain>/desktop.webp
                                  /mobile.webp
                                  /home.html
                                  /rendered.html
                                  /headers.json
                                  /error.json        (only when the capture failed)

Implemented in `src/capture/s3.js`. `raw/` is flattened away — the local tree
nests it for tidiness, but in S3 one domain is already one prefix.

**Enable object versioning on the bucket. It is load-bearing, not optional.**

Three constraints had to hold at once:

1. **Deterministic from columns that exist.** Nothing stores an S3 path, so the
   key must be computable from `vertical` and `domain` alone.
2. **Re-capturing must never destroy the previous capture.**
3. **`ingest` must find finished work cheaply.**

A date in the path satisfies (2) and breaks (1) — the date would have to be
stored to be recoverable, and storing paths was rejected. A run id breaks it
worse: a 16-hour sweep crosses midnight, so even a date splits one run across two
prefixes.

Versioning resolves all three. A re-capture overwrites the same key while the old
bytes stay retrievable as a prior version — history for free, no date, no schema.
(1) holds because the key is vertical + domain. (3) becomes a HEAD on the
expected key per pending row: O(pending), no bucket listing, and the same "does
the object exist" test `--resume` already uses against local disk.

Without versioning, a re-capture is destructive and constraint (2) fails
silently. That is the one piece of bucket config this design cannot do without.

**`home.html` and `rendered.html` are uploaded, not discarded.**
`docs/DEPLOYMENT.md` treats `raw/` as an optional upload to save transfer — that
is overruled here. Storing the HTML is what makes every future parsing change a
re-read instead of a re-crawl, at ~2 GB for ~9,600 domains, about $0.05/month.

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

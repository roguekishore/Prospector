# Architecture

How prospector is built, where each part runs, and why. The decisions here are
closed; don't reopen them without new evidence.

- Per-item state (built, broken, deferred): `docs/STATUS.md`.
- Remaining work and its order: `docs/PENDING-SPECS.md`.
- File layouts and JSON shapes: `spec/MASTER.md` (spec wins for contracts).

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
  runs extract per domain. `extract`, `ingest` and `control` are independent
  commands.

### Built vs planned

| Part | State |
|---|---|
| `discover`, `qualify` | Built. Run from the control panel on the box |
| Box, Caddy, control panel | Live at <https://prospect.themaverick.tech> |
| Capture Lambda, image, failure queue | Deployed, never invoked |
| `capture` stage (capture then extract) | Built. Same code on the box and in the Lambda |
| Scoring removed | Done. `src/score/`, `lib-scoring.js`, `src/report/` and the signals are deleted |
| Disk layout matching S3 | Done. `data/<city>/companies/<domain>/` on both sides |
| MySQL, `ingest`, resume from `companies.status` | Spec B. Today state is files; `src/db/index.js` is retired with the old deck |
| Dispatching captures, local capture on the box | Spec p4 |
| Deck at `leads.themaverick.tech` | Spec B |

## Where things run

```
 rogue (700897991126)                                   clasher (028972816671)
 ┌──────────────────────────────────────┐   3306 over   ┌─────────────────────┐
 │ box: Caddy, control, deck,           │   peering     │ mavdb               │
 │      discover, qualify, ingest       ├──────────────►│ RDS MySQL, private  │
 └──────┬─────────────────────▲─────────┘               └─────────────────────┘
        │ async invoke        │
        │                     │ places/ up, companies/ down
 ┌──────▼───────┐  put  ┌─────▼────────┐
 │ capture      ├──────►│ S3 bucket    │
 │ Lambda       │       │              │
 └──────────────┘       └──────────────┘
```

| Edge | State |
|---|---|
| Box → S3 `places/` | Built (`scripts/backup-places.js`) |
| Box → Lambda invoke | Spec p4. The box role has no `lambda:InvokeFunction` yet |
| Lambda → S3 `companies/` | Built; exercised only against a stub S3 client |
| S3 → box (`ingest`) | Spec B. The box role cannot read `companies/` yet |
| Box → mavdb | Spec B |

**One handoff, forced by one constraint.** The Lambda runs outside any VPC, so
it cannot reach mavdb. A VPC-attached Lambda needs a NAT gateway at ~$32/month,
more than the compute it runs. So capture writes S3 and nothing else, and
`ingest` on the box turns S3 objects into files on disk and rows in MySQL.

Everything prospector owns is in rogue. Only the MySQL connection crosses into
clasher.

## Pipeline

### discover

Slices the Coimbatore bounding box (`config/city.json`) into a 5×5 grid, then
runs every keyword of a vertical against every tile: 8 keywords × 25 tiles = 200
searches. Each search is a Places Text Search restricted to one tile, because a
single query caps at 60 results (3 pages × 20) and a city-wide query silently
truncates dense areas.

- **Pagination depends on the `nextPageToken` field mask**
  (`src/discover/places.js:19`). Without it the API omits the token and every
  query stops at 20. That was run 1's silent failure: 952 of 3,600 queries
  (26.4%) capped, an estimated 2,000–3,000 leads never collected, and no error
  logged. Every run now logs its commit, per-query page counts and a summary of
  capped queries, and warns when nothing paginated.
- **Dedup twice:** by Places ID (adjacent tiles), then by registrable domain (two
  listings, one website; the higher review count wins). Portal profiles
  (99acres, Practo, WedMeGood) are kept as `aggregator-profile-only` and left out
  of the domain merge.
- **Rate limit** 8 req/s in code (`src/discover/places.js:47`) against 600/min
  and 75,000/day.
- **Only stage that spends Places quota.** It is left out of the
  `.claude/settings.json` allowlist so it always prompts, and the panel shows the
  request estimate before the button.

Writes `data/<vertical>/discovered.json`. `scripts/backup-places.js` copies it
and `qualified.json` to S3, at the end of every control pipeline and every 15
minutes from `prospector-backup.timer`, skipping unchanged files by ETag. A
failed backup never fails discover.

Raw response bodies are no longer archived. `places-raw/` was provenance for a
run whose truncation bug is now fixed and instrumented, and `discovered.json`
carries every field the pipeline reads.

### qualify

An eligibility gate: DNS, a HEAD request, `robots.txt`, certificate validity. No
browser. Writes `data/<vertical>/qualified.json`, each business with
`qualify.verdict` `audit` or `skip`. The verdict string stays `audit`; spec B
replaces it with `companies.status`.

In run 1 it removed 507 domains that did not resolve, 69 timeouts, plus 404s,
403s and dropped connections. Those businesses are kept, not deleted: a Google
listing that names a dead domain is a different pitch. `ingest` records them as
status `-1` (spec 3).

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
  `capture-domain.js:278,302`. Starve the CPU and the decode loses, and the
  screenshot comes out half-rasterised. Low CPU costs capture quality, not just
  time.
- **Hard per-capture deadline**, 60 s (`--deadline`,
  `src/capture/capture-domain.js:103`). Shots that landed are kept and listed in
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
- **Extract output:** `email`, the first valid address in document order
  (`mailto:` links first, then page text), and `links[]`, every http(s) link
  whose registrable domain differs from the site's own, deduplicated, each
  `social` or `external`. No phones, addresses, hours or agency credit — Places
  already supplies the first two, and the operator derives agencies from `links`.

### extract (standalone)

Re-runs extract over captures already on disk, so a parsing change never costs a
re-crawl. That is its only reason to exist; a normal run never invokes it.
`--resume` skips domains that already have `extract.json`, so a fix is applied by
deleting the files it should change and re-running.

### ingest (spec 3)

An independent command, never part of `all`. Runs at the end of every Lambda
dispatch and on a systemd timer. Per domain, in order:

1. **Load business details** from each vertical's
   `places/<vertical>/qualified.json` into `companies`, as status `0` or `-1`.
   Existing statuses are never downgraded.
2. **Copy to disk** from S3: the screenshots, `extract.json`, and `error.json`
   if present. `rendered.html` only with `--with-html`, which keeps the box's
   data disk small.
3. **Record in MySQL:** extract results, then the status (`1` or `-2`, by the
   completion rule). The status is written last.

- **Copy first, mark second.** A domain is marked `1` only after its files are
  on disk, so a killed run resumes cleanly.
- **Idempotent.** Anything already copied and marked is skipped.
- It never runs extract; the Lambda already did.
- It doubles as the progress meter: once rows update, "how far along" is a count
  by status.

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
  <city>/places/<vertical>/discovered.json
                          /qualified.json
```

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
website listed in two verticals is one folder, so the second capture would pay
for bytes the first already wrote. Three places dedupe by `canonicalDomain`: the
capture queue, `scripts/dispatch.js`, and `src/control/status.js`. Missing one
gives a double capture or a double count, not data loss.

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
directory and `companies.domain` / `cities.slug` must agree byte for byte. If
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
data/<vertical>/discovered.json   qualified.json
```

`companyDir` in `lib-keys.js` builds the first path and `companyKey` in
`src/capture/s3.js` the matching key; nothing else spells either.

`data/<city>/` sits beside the `data/<vertical>/` directories. Every walker of
`data/` — the capture queue, `dispatch.js`, `control/status.js` — skips a
directory with no `qualified.json`, so the city directory is never mistaken for
a vertical. Keep it that way.

The verticals keep their own `discovered.json` and `qualified.json` until spec B
moves the business list into MySQL. On the box, `data/` is a symlink to
`/var/lib/prospector/data` on the data volume. In this checkout, `data/` is
whatever `npm run test:run` last left behind, not a real run.

### MySQL (spec 3)

**S3 holds bytes; MySQL holds state.** "What is left to capture" is one indexed
query on `companies.status`. The bucket is never listed to answer it: that costs
a request per pending domain and creates a second opinion that can disagree.
`captureComplete()` (`src/capture/s3.js`) is for an `ingest --verify` repair
mode only.

- **Instance:** `mavdb` in clasher. RDS MySQL 8.4.8, `db.t4g.micro`, 20 GB,
  single-AZ, not publicly accessible, shared by every app, 1 GiB of memory.
- **Network:** VPC peering from rogue `10.43.0.0/16` to clasher (presumed
  `172.31.0.0/16`). The clasher side is three standalone resources (accepter, one
  route, one SG ingress rule), so Terraform never owns clasher's route table or
  security group. A relay on MaverickInstance was rejected: it would face the
  internet, put clasher's production box in prospector's path, and add a process
  to maintain.
- **Isolation:** its own database `prospector` and its own users, never
  `maverick`. The database name in a URL restricts nothing; grants do.
  - `prospector`: DML only.
  - `prospector_migrate`: DDL, used only by the migration runner.
- **Credentials:** SSM SecureString `/prospector/db-password`, read at service
  start by `deploy/load-env.sh` like every other secret. TLS verified against
  the pinned RDS CA bundle. Connection pool of at most 4.
- **IAM database authentication: rejected.** It needs 300–1000 MiB of spare
  memory on the instance
  ([AWS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.html)),
  and mavdb has 1 GiB for every app.
- **Migrations:** numbered plain-SQL files plus a small runner, no ORM,
  compatible with the laptop's MySQL 8.0 for offline runs.

#### `companies.status`

| Value | Meaning | Set by |
|---|---|---|
| `0` | Pending | ingest, from `qualified.json` |
| `-1` | No usable website | ingest, from qualify's verdict |
| `1` | Done: all three completion files present | ingest |
| `-2` | Failed: `error.json` present, capture not complete | ingest |

A later re-capture that completes moves `-2` to `1`. The `-2` state exists
because captures do fail (one run-1 capture took 677 s against a 12 s mean), and
without it every resume retries the same broken sites and "never tried" is
indistinguishable from "tried and failed". Retrying `-2` is an explicit action
(spec 4's re-dispatch).

#### Tables

The DDL is spec 3's to write. What is settled:

- `cities`, keyed by `lib-keys.canonicalCity`.
- `companies`, keyed by Places ID, because a no-website business has no domain.
  Places fields verbatim, `domain` from `canonicalDomain`, and `status`.
- Company ↔ vertical membership in its own table, since a vertical is a
  correctable classification.
- Extract results per `(city, domain)`, matching S3.
- `decisions` per domain: the operator's own tier, pitch flag and note. Today
  they live in browser localStorage plus a fire-and-forget `PUT`
  (`preview/app.js:134`), and are at risk of being lost.

Deliberately absent:

- **No `runs` table.** A business is captured once; the capture date is S3's
  `LastModified`.
- **No scoring tables.** There is no scoring.
- **No S3 paths.** Every key is computable from city and domain.
- **No `agencies` table yet.** Agency detection is meant to be a query: a domain
  credited in the footer of many unrelated sites is an agency
  (`GROUP BY target_domain HAVING COUNT(DISTINCT company) >= N`). Add a table
  only when resolving names and prices. See *Open* for what this needs.

**Known wrinkle.** `companies` will not hold every business Places returns:
discover collapses listings that share a website, so two clinics on one group
site become one row. Expect counts not to tie.

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

**Dispatch today** reads `data/<vertical>/qualified.json`, takes every
`verdict === 'audit'` business deduped by canonical domain, and sends one async
invoke per 10. After spec B, pending work comes from `companies.status`. Async queued events expire after at
most 6 hours; at concurrency 10 a large sweep's late batches can expire into the
failure queue. That is safe, because re-dispatch is idempotent, but spec 4 makes
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
anything. A stub-S3 test cannot catch this; only p4's first real batch can.

**Not wired yet (spec p4):**

- The box role has no `lambda:InvokeFunction`, no SQS read and no `s3:GetObject`
  on `companies/`, so the panel's Lambda mode fails today.
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
  included, from the first batch (spec 4).

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
| `leads.themaverick.tech` | the deck (`src/server/` + `preview/`) | `127.0.0.1:7777` | Spec 5 |

- **Names, not paths.** Both apps emit root-absolute URLs (control's `api()`
  helper in `src/control/ui.html`, the deck's `/data/*` and `/preview/*`).
  `handle_path` strips a prefix on the way in but cannot change what the browser
  asks for. One hostname split by path was also rejected: the first new endpoint
  on either side collides silently as a confusing 404.
- **Separate names allow separate auth.** A prospect may one day be shown the
  deck; never control.
- **Caddy, not nginx.** Automatic ACME, built-in `basic_auth` with bcrypt, no
  certbot or cron. Caddy flushes `text/event-stream` immediately and sets no read
  timeout on a stream, so control's SSE log works with no tuning.
- **Cert storage** is `/var/lib/prospector/caddy` on the data volume, owned by
  the `caddy` user, so certificates survive restarts and `./p down` without
  re-issuing into a Let's Encrypt rate limit.
- **DNS is Netlify**, not Route53. Each hostname is a manual A record to the EIP,
  and it must resolve before Caddy enables the site, or HTTP-01 fails. `./p`
  waits for DNS before enabling a block.
- **No CSP.** Copying warden's `script-src 'self'` blanks the control panel,
  because `ui.html` is one file with inline script and style. Add a CSP only
  after splitting it into three files.

## Control: `node src/cli control`

A dashboard on port 7778 that shows progress and starts runs, built for a phone.
`src/control/`.

- **Progress:** captured / pending / failed per vertical and in total, with a
  failure breakdown, pushed over SSE every 3 s. Today it is read from disk:
  `qualified.json` says what should be captured, `isComplete()` what was,
  `error.json` what failed. A Lambda capture only appears once `ingest` has
  copied it (spec 3).
- **Run:** capture the remaining domains `local` (on the box) or `lambda`
  (dispatch batches), with concurrency, deadline and batch size set from the
  page. Both modes fail today (see *Not wired yet*).
- **New vertical:** a name and keywords, then discover → qualify → capture back
  to back, or discover → qualify → backup with `captureMode: 'none'`. The Places
  request estimate (25 tiles × keywords, up to 3 pages) shows before the button.

Constraints it enforces:

- **One run at a time.** Two captures would fight for the same 2 GB and the same
  per-host throttle, and re-capture each other's work.
- **A pipeline halts on a failing stage.** Qualifying an empty discover, or
  capturing an unvetted list, produces a confidently empty result rather than an
  error.
- **Stop is safe.** SIGTERM, then SIGKILL after 8 s. Capture is per-domain
  atomic, so a stop loses at most the page in flight.
- **Auth is Caddy `basic_auth`, with `CONTROL_TOKEN` unset.** Unset, the server
  binds `127.0.0.1` (`src/control/index.js:286`) and Caddy is the only public
  listener. Setting the token binds `0.0.0.0` and puts the secret in a query
  string, where it lands in logs and phone history. The token stays for the case
  where nothing is in front.

## The deck (spec B)

`src/server/`, `src/db/` and `preview/` are the old deck. They depend on the
removed `report` stage and on score fields, so they are retired, not deleted:
`serve` is not a CLI stage and nothing loads them. Spec B rebuilds the deck on
MySQL.

It will show business details from Places, the screenshots, the first email, the
outside links, and the operator's own decisions. Nothing from a machine score.
The notes below are what the old one taught us and still apply.

- **Binds `127.0.0.1`**, hard-coded at `src/server/index.js:202`.
- **Auth must cover `/data/*` too.** Gating only `/` leaves captures and
  per-domain JSON public, and it looks correct when you test it.
- **Sync captures to local disk; never FUSE-mount the bucket.** Mounted, every
  request is an S3 GET, a 50-thumbnail grid is 50 round trips, and a stale mount
  makes the server 500.
- **The index is the first wall at real scale.** `src/server/index.js:73` reads
  the whole `data/index.json` with `readFileSync` on every request, under
  `Cache-Control: no-store`, at ~4.2 KB per lead:

  | Leads | `index.json` |
  |---|---|
  | 3,906 | 16 MB |
  | ~9,600 | 41 MB |
  | 50,000 | 210 MB |

  Spec 5 replaces the single file (a paginated MySQL query, or one file per
  vertical).

## Observability

The capture Lambda emits CloudWatch Embedded Metric Format on every batch: a log
line, not an API call, so it costs nothing and needs no extra permission.

```
Namespace   Prospector/Capture
Dimensions  [Vertical] and [] (aggregate)
Metrics     CapturesOk, CapturesFailed, CapturesSkipped, BatchDurationMs
```

Spec 1 adds `ExtractOk` and `ExtractFailed`.

**Lambda's own metrics cannot answer the question that matters.** `Invocations`
and `Errors` count batches: a batch that captured 3 and failed 7 is a successful
invocation, so `Errors` reads zero through a total collapse.

warden (`D:\PROJECTS\AWS-COMMAND-CENTER`) reads these as a `capture` tile
(`warden/app/adapters/capture.py`), gated on a `prospector` capability tag so
only the account running captures collects it. The backend emits the tile; the
UI doesn't draw it yet, and rogue doesn't carry the tag yet (spec 6). Free-tier
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

- **Clasher network facts:** VPC CIDR (presumed `172.31.0.0/16`), the route
  tables of mavdb's subnets, its security group, and whether its endpoint
  resolves to a private IP from rogue (spec 3).
- **mavdb's existing users and grants** have never been inspected. The MySQL MCP
  tool connects to a local 8.0.39 on the laptop, not RDS (spec 7).
- **Lambda cold start** (`Init Duration`) for the ~1.05 GB image, and whether
  2,048 MB survives image-heavy pages. Measured in p4's first batch.
- **Places cost per request.** Billing showed ~Rs 171 for run 1's 3,600
  requests, far below the documented rate. Settle it from Billing → Reports,
  18–19 Sep, grouped by SKU, gross and net.
- **Extract time per domain** is not measured. It is cheerio over one file with
  no network, so it is expected to be milliseconds, but the Lambda's batch
  arithmetic assumes that rather than knowing it. Measured in p4's first batch.

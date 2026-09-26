# Deployment plan

Target shape: capture runs as sharded Lambda, everything else runs on a small
always-on box, S3 is the durable store, marks go to MySQL, and the whole run is
triggered from warden.

Figures marked **measured** come from run 1 (`docs/STATUS.md`); everything else is
modelled and labelled as such.

> **The box in "Hosting the box" now exists.** Built 2026-09-26 by
> `.kiro/specs/box-discover-qualify/`, serving
> <https://prospect.themaverick.tech>. It runs `discover` and `qualify` only, and
> the capture Lambda is staged but never invoked. `docs/STATUS.md` has the live
> resource ids and what is and isn't verified. The Lambda fleet, the six-account
> fan-out and the MySQL work below remain unbuilt.

> **Superseded in part.** Run 1's log has since been measured directly and
> several figures below were roughly 2x reality — they are corrected inline and
> marked *(corrected)*. More importantly, `docs/ARCHITECTURE.md` now carries the
> agreed design, and it differs here in two ways: **capture runs on an EC2 box,
> not Lambda** (a once-only sweep does not repay the build), and **`raw/` HTML is
> always uploaded, never optional** (which also removes the reason to fuse
> extract into capture). Read that doc first; this one is the Lambda option,
> kept for when a second city makes it worth building.



## Architecture

```
jk / any account        central account            rogue t4g.small
┌──────────────┐        ┌──────────────┐          ┌──────────────┐
│ capture+     │  put   │  S3 bucket   │   sync   │ Caddy + node │
│ extract      ├───────►│  (durable)   ├─────────►│ serves deck  │
│ Lambda xN    │        └──────────────┘          └──────┬───────┘
└──────▲───────┘                                        │ 3306
       │ async invoke                                    ▼
┌──────┴───────┐                                  ┌──────────────┐
│   warden     │                                  │ mavdb MySQL  │
│  (one click) │                                  │  (clasher)   │
└──────────────┘                                  └──────────────┘
```

Stages `discover`, `qualify`, `score`, `report` stay on the small box.
`extract` moves **into** the capture Lambda — see below.

## Decisions and why

**Capture on Lambda, not EC2.** Not for cost — both are ~free under existing
credits. For wall clock: 100 concurrent invocations finish a city-wide sweep in
~2h against ~11h on an m5.2xlarge at concurrency 16. No 8-vCPU box reaches that
at any price.

**Capture and extract fuse into one invocation.** `extract` reads
`raw/home.html` and `rendered.html` (**212 KB/domain measured** — 48 KB home,
133 KB rendered, 31 KB headers; *corrected* from ~300 KB) to produce ~7 KB of
`signals/links/contacts.json`. Running it in-process while the HTML is still in
`/tmp` means shipping ~41 KB/domain instead of ~254 KB — at 50,000 domains,
2 GB moved instead of 12.7 GB (*corrected* from 17 GB).

**This argument no longer applies.** `docs/ARCHITECTURE.md` requires `raw/` to be
uploaded so that a parsing change never costs a re-crawl. The HTML ships either
way, so fusing saves nothing. `raw/` becomes an optional upload, needed only by
`scripts/scan-platform.js`.

**Lambda stays out of any VPC.** It needs internet and S3, not RDS. A VPC-
attached Lambda forces a NAT gateway at ~$32/mo plus data — more than the
compute it would be running.

**S3 is published to, not written through.** `spec/MASTER.md:121-127` mandates
per-domain atomic `.tmp` + fsync + rename. S3 has no rename. Stages write local
disk and sync afterwards; only the fused Lambda writes S3 directly, and that one
stage carries the rewrite.

**Marks go to MySQL (`mavdb`), not SQLite.** Today marks live in browser
localStorage (`preview/app.js:15`) with a fire-and-forget PUT
(`preview/app.js:128-135`); `src/db/index.js` falls back to a JSON stub when the
native addon fails. No mark has ever persisted server-side in this checkout.
Marks are the only irreplaceable state here and they block the `rules@2` retune
(`docs/STATUS.md:73-79`).

## Lambda memory sizing

Lambda scales CPU with memory (1,769 MB = 1 vCPU, linear). Normally raising
memory is cost-neutral. That inverts here because **~7s of each 11.5s capture is
settle sleep** (measured, `docs/STATUS.md:56-59`) — wall clock that ignores CPU.
Only ~4.5s scales, so dropping memory makes the sleep portion cheaper.

| Memory | vCPU | CPU work | +sleep | Total | GB-s/capture |
|---|---|---|---|---|---|
| 2,048 | 1.16 | 3.9s | 7s | 10.9s | 22.3 |
| 1,769 | 1.00 | 4.5s | 7s | 11.5s | 20.3 |
| 1,536 | 0.87 | 5.2s | 7s | 12.2s | 18.7 |
| **1,024** | **0.58** | **7.8s** | **7s** | **14.8s** | **15.2** |
| 768 | 0.43 | 10.4s | 7s | 17.4s | 13.4 |

Modelled, not measured, and **the model is wrong in one way that matters**: the
7s is not fixed sleep. `capture-domain.js:233,257` is
`Promise.race([_forceImageDecode(page), _delay(5000)])` — a *deadline*. Starve
the CPU and the decode loses the race, so images never finish rasterizing and the
screenshot comes out half-broken. Only ~2s is genuinely fixed. Low memory
therefore costs capture *quality*, not just wall clock, and extra memory buys
more than the table predicts.

**Recommend 2,048 MB, not 1,024.** Above the 1-vCPU line, ~1.4 GB of headroom for
the image-heavy tail, and the decode races complete. An OOM kills the invocation,
so under-provisioning loses all 10 domains in the batch — fail-soft-per-domain
does not survive process death. Then measure rather than model: every Lambda
`REPORT` line carries Max Memory Used.

The original reasoning for 1,024 MB, kept for the record: 32% cheaper per capture
than 2,048. Below that Chromium becomes the constraint rather than arithmetic, and
`_forceImageDecode` rasterizes every image on the page into memory, so 768 MB
will work on lean pages and OOM on an image-heavy one mid-run.

Bigger lever than the memory dial: audit the 7s settle. It is 60% of every
invocation's bill. Cut what is padding rather than measured need.

## Scale

**Capture count is not 3,906.** That is scored leads; audited domains is higher
(rejects and failures never reach scoring).

**Measured: 4,315** (*corrected* from ~8,000 — summed `Audit complete: N/N` in
`logs/night.log`). The ~8,000 estimate was roughly double. Note 3,906/4,315 =
**90.5% of audited domains reach scoring**, not the ~50% the old figure implied.

The command this section used to suggest — `find data -name desktop.webp | wc -l`
— returns 5 in this checkout, which is the smoke tree. Run 1's `data/` never left
EC2; `logs/night.log` did, and it is the source above.

At 1,024 MB / 14.8s / 100 concurrent, single account:

| Captures | GB-s | vs free tier | Cost | Lambda @100 | EC2 @16 |
|---|---|---|---|---|---|
| **4,315 (measured)** | 66K | 16% | $0 | 11 min | 0.9 h |
| **~9,600 (untruncated)** | 146K | 36% | $0 | 24 min | 2.0 h |
| 50,000 (city-wide) | 760K | over | $6.00 | 2.1 h | 10.9 h |

*Corrected.* The old rows read 8,000 and 24,000; both were roughly 2.5x high.
Untruncated is derived from the measured 26.4% cap rate, not from a guess —
952 capped queries lifting from 20 toward 60 gives ~7,600–9,600 audited.
The 50,000 row has nothing behind it and is aspiration, not projection.

**One account covers the real workload twice over**, which is the figure that
matters: 9,600 captures is 36% of a single free tier at 1,024 MB, or 52% at the
2,048 MB now recommended.

## Six-account capture fleet

Six standalone accounts, six separate billing families, six free tiers:
**2.4M GB-s/month pooled, about 158,000 captures/month** at 1,024 MB — or
**110,000 at the 2,048 MB** now recommended (see sizing note below). Against a
real workload of ~9,600 that is roughly 11x oversized: **build one account, not
six.** The fan-out is a `for_each` when a second city needs it.

The operational rule this depends on: never invite these accounts into an
Organization with consolidated billing. Free tier is calculated per billing
family, so joining one collapses six allowances into one. Account `008` is
already a management account (`o-348fkge8wq`) from the accidental Identity
Center enablement — leave the other five outside it.

### What exists where

| Resource | Accounts | Notes |
|---|---|---|
| ECR repository | central only | cross-account pull policy |
| Lambda function | all six | capture+extract, 1,024 MB, 900s timeout, no VPC |
| Execution role | all six | `s3:PutObject` to central bucket, logs |
| Log group | all six | short retention |
| S3 bucket | central only | `BucketOwnerEnforced`, policy names all six roles |

One image, built once, pushed once, pulled by six Lambdas. Cross-account ECR
pull is supported; **cross-region is not** — keep every account in `ap-south-1`.

### Terraform shape

warden already declares six provider aliases and instantiates `warden-roles`
once per account. A `prospector-capture` module follows the same shape: one
module block per alias, identical inputs but the account id. The fleet is a
`for_each` over six providers, not six copies of anything.

### Batch size is pinned by two limits

Cold start on a ~500 MB image is 10-20s, so batching amortizes it. The 900s
ceiling caps how far:

    10 domains x 60s hard cap = 600s worst case  <  900s   ok
    15 domains x 60s hard cap = 900s worst case  =  900s   fails

**10 domains per invocation.** Larger and one batch of slow captures times out
with everything in it lost. This is why the per-capture deadline is a
prerequisite rather than a nicety — without it the worst case is unbounded and
no batch size is safe.

### Dispatch

Async invoke (`InvocationType: Event`) lets the dispatcher fire and exit —
Lambda's own async queue buffers the backlog and drains it at each account's
concurrency limit. 50,000 domains is 5,000 invokes, a few minutes of API calls,
so warden can trigger it inside a request rather than owning a long-running job.

Round-robin by index across the six. Weighted routing on remaining free tier is
tempting, but `freetier:GetFreeTierUsage` lags billing by hours — keep a local
counter and reconcile against it daily instead of routing on it live.

Async invoke retries twice by default. Point a failure destination at a DLQ so a
domain that fails three times is visible rather than silently absent.

Completion and resume are both "does the S3 object exist" — the same contract
`--resume` already uses against local disk.

### Wall clock

| Captures | @60 (limits today) | @600 (after increase) |
|---|---|---|
| 4,315 (measured) | 18 min | 2 min |
| ~9,600 (untruncated) | 40 min | 4 min |
| 50,000 | 3.4 h | 20 min |

Six accounts at the default limit of 10 already beat one m5.2xlarge at
concurrency 16. The increase to 100 each is what buys the 20-minute city sweep.

### What this costs that is not free

| Item | Per city-wide run (50,000) |
|---|---|
| Lambda compute | $0 — 32% of pooled free tier |
| S3 PUT, **5** objects/domain | **~$1.25** *(corrected — 2 webp + 3 json, not 3)* |
| S3 storage | ~$0.05/mo |
| ECR storage | ~$0.10/mo |
| CloudWatch Logs | ~$0.03 |

Under a dollar per run. If PUT costs ever matter, bundle
`signals`/`links`/`contacts` into one object instead of three.

### Sharding does not help discover

`GOOGLE_PLACES_KEY` is a Google Cloud project quota, untouched by AWS account
count. *Corrected:* run 1 used **4.8%** of the 75,000/day `SearchTextRequest`
ceiling (3,600 requests), not ~14% — that figure matches an untruncated sweep and
was a projection recorded as a measurement.

Untruncated is ~5,504 requests, **7.3% of the daily quota and ~12 minutes** at the
in-code 8 req/s limit. So **discover is not the long pole** — 12 minutes against
capture's 2–11 hours. Quota permits ~13.6 full sweeps a day; Coimbatore runs out
of businesses long before the quota does. Cost per sweep is the open question,
not throughput.

## Hosting the box

Settled 2026-09-26. Everything below is a decision, not a proposal.

**One box in rogue, Ubuntu 24.04 on arm64 (t4g.small).** Deliberately *not*
Amazon Linux 2023, which is what the hub runs. Playwright publishes arm64
Chromium builds for Ubuntu and treats AL2023 as unsupported, so
`playwright install --with-deps` has no apt to work with there and Chromium's
shared libraries become a hand-resolved dependency hunt. t4g.small is free per
account until 2026-12-31.

**Two hostnames, one box, one Caddy.**

| Hostname | Serves | Port | Bind |
|---|---|---|---|
| `prospect.themaverick.tech` | control — `src/control/` | 7778 | `127.0.0.1` |
| `leads.themaverick.tech` | the deck — `src/server/` | 7777 | `127.0.0.1`, hard-coded at `src/server/index.js:202` |

Names, not paths. Both apps build root-absolute URLs — `ui.html`'s single
`api()` helper (`src/control/ui.html:249`) and the deck's `/data/*` and
`/preview/*` assets — so mounting one under `/control/` means editing both apps.
Caddy's `handle_path` cannot help: it strips a prefix on the way in but cannot
change what the browser asks for.

Routing both to one hostname by explicit path was considered and rejected. The
two `/api/*` surfaces do not currently overlap (control owns `status`, `run/*`,
`events`, `verticals`, `pipeline/*`; the deck owns `index.json` and friends) but
the first endpoint added to either side collides silently, and the symptom is a
confusing 404 rather than an error. Separate names also permit separate auth
policy, which matters: the deck is something a prospect might eventually be
shown, control never is.

**Caddy, not nginx.** Automatic ACME issuance and renewal — no certbot, no cron,
no webroot, no hand-written server blocks. `basic_auth` with bcrypt is built in,
`file_server` covers `/data/*`, `reverse_proxy` covers the API. The only argument
for nginx was reusing warden's `deploy/` tooling, and since this is a different
box in a different account there is nothing to reuse.

Two Caddy gotchas: cert storage must sit on a persistent volume or every restart
re-issues into a Let's Encrypt rate limit, and HTTP-01 needs port 80 reachable
(DNS-01 would need a Netlify plugin build).

**Caddy also removes two failure modes nginx would have introduced.** Recorded
because both look like things a later pass would want to "harden" back in:

- *Response buffering.* The live log is SSE — one response that never ends.
  nginx accumulates upstream output and forwards it in chunks, which shows a
  phone nothing for minutes and then a wall of text, indistinguishable from a
  hung run. The app already defends itself (`X-Accel-Buffering: no` at
  `src/control/index.js:149`, plus a 25s ping at `:156` to stay under nginx's
  60s idle timeout) so nginx would have worked — but Caddy flushes
  `text/event-stream` immediately and sets no read timeout on a stream, so
  neither defence is load-bearing here.
- *CSP.* Copying warden's header (`script-src 'self'`) blanks the control panel.
  `ui.html` is one file with an inline `<script>` and an inline `<style>`, so the
  browser fetches the page, refuses to execute it, and leaves a styled corpse
  with console errors — confusing precisely because the page loads. Caddy sends
  no CSP unless asked. Add one only after splitting `ui.html` into three files.

**Auth: Caddy `basic_auth`, with `CONTROL_TOKEN` left unset.** Unset means the
control server binds `127.0.0.1` (`src/control/index.js:279`) and Caddy is the
only process on the box listening publicly — the shape warden already uses with
uvicorn on 8000. Setting the token instead binds `0.0.0.0` and puts the secret in
a query string, where it lands in access logs and phone history. The token stays
in the code for the case where nothing is in front of the app.

**Security group: 80 and 443 from anywhere, nothing else.** 7777 and 7778 never
face the internet. Shell access is SSM Session Manager — no port 22, matching the
hub — which needs the instance profile and egress for the agent.

**DNS is Netlify, not Route53** (`terraform/outputs.tf:2` records the same for
warden). Two manual A records, and both must resolve *before* Caddy starts or the
ACME challenge fails.

**Cost: one more public IPv4, ~$3.60/mo.** Every public IPv4 has been billed at
$0.005/hr since Feb 2024, attached or not. The hub already pays it; a second box
answering for its own name pays it again, so ~$7.10/mo across the two. The only
way to avoid it is proxying prospector through the hub's EIP, rejected — that
puts warden's box in the path of every capture-control request.

## Serving

**The index is the real scaling wall, and it arrives before the Lambda work
lands.** `data/index.json` is 21 KB for 5 domains — 4.2 KB per lead — and
`src/server/index.js:73` reads the whole file with `readFileSync` on every
request under `Cache-Control: no-store`.

| Leads | index.json | on a 2 GB box |
|---|---|---|
| 3,906 | 16 MB | already bad |
| ~9,600 | 41 MB | unusable |
| 50,000 | 210 MB | 10% of RAM, per request |

Fix by splitting per vertical, or by backing the deck with a paginated MySQL
query. The second kills this and the marks problem together, and MySQL is
already required for marks.

Captures on disk scale fine — 50,000 x 34 KB is ~1.7 GB, just provision the EBS.

**Sync the bucket, do not mount it.** The deck's working set is small enough to
copy in under a minute, after which every read is local disk with page cache
behind it. Mounted, `src/server/index.js:73` becomes an S3 GET per request and
`sendFile()` (`:41-49`) becomes one per capture — a 50-thumbnail grid is 50
round trips. FUSE mounts also go stale, and the server 500s when they do. Mount
only `raw/` read-only, on demand, if `scan-platform.js` ever needs it.

The web tier is Caddy, on the same box, serving both hostnames — see
**Hosting the box** above.

The auth gate must cover `/data/*` too. Gate only `/` and the captures and
per-domain JSON stay public while the homepage prompts — and it looks correct
when you test it.

## Prerequisites

- [x] **Settle the S3 key layout.** Done — `<city>/captures/<domain>/…`, no
      vertical and no date in the key, one canonical spelling in `lib-keys.js`.
      `src/capture/s3.js`, rationale in `docs/ARCHITECTURE.md`.
- [ ] **Terraform provider auth.** Aliases authenticate with static root keys
      (`terraform/providers.tf:5-45`) that were deleted 2026-09-20; operator is
      reissuing them. The `warden-admin` roles exist per account as the
      longer-lived alternative if the keys are ever retired again.
- [ ] **Lambda concurrency increase** 10 to 100, in each of six accounts.
      Support ticket, not config. File early — six tickets, and new accounts
      with no usage history are the slowest to be granted.
- [x] **Hard per-capture deadline (~60s).** Done — `--deadline`, default 60s,
      `Promise.race` around the whole capture, partial shots kept.
      `src/capture/capture-domain.js:29`.
- [ ] **`nextPageToken` field mask** deployed to the box
      (`src/discover/places.js:17`, local only per `docs/STATUS.md:102-103`).
- [ ] **Places quota headroom** sized against the real keyword x tile count
      before a city-wide sweep.
- [ ] **Two A records in Netlify DNS** — `prospect` and `leads` — resolving
      before Caddy first starts, or ACME fails. `prospect` → `35.154.77.31` is
      done (it replaced a CNAME pointing at Netlify, which had to be deleted
      first); `leads` waits on the deck being served from this box.
- [x] **Caddy cert storage on a persistent path**, so a restart does not re-issue
      into a Let's Encrypt rate limit. `/var/lib/prospector/caddy` on the data
      volume, not `/var/lib/caddy` on the root disk, so the certs also survive
      `./p down`. Must be owned by the `caddy` user — Caddy writes them as itself,
      and root-owned storage fails after the config has already validated.

## Order of work

1. **Marks to MySQL.** Independent of all AWS work, currently losing data,
   unblocks the `rules@2` retune.
2. **Paginate or DB-back the index.** The wall that arrives first.
3. **Hard per-capture deadline.** Fleet prerequisite, EC2 win anyway.
4. **Fused capture+extract Lambda** against one account, 1,024 MB, no VPC —
   proving the image, the S3 contract and the batch shape.
5. **Fan out to six** via the Terraform module once one works. Concurrency
   tickets filed in parallel from step 3.
6. **warden dispatch action**, following the four-step pattern in
   `warden/app/actions/ec2.py:98-125`.

Steps 1 and 2 pay off whether or not the fleet ever ships.

## Open

- `mavdb` schema — the `mysql` MCP server has been timing out.
- Image size after slimming — cold start and batch economics both turn on it.
- Places cost per request. Billing showed ~Rs 171 for run 1's 3,600 requests
  (~Rs 47.5/1,000); the documented Text Search rate for this field mask is far
  higher. Settle it from Billing -> Reports, 18-19 Sep, grouped by SKU, gross
  and net. Repeat-sweep affordability turns on it; nothing else here does.

**Closed since this was written:**

- Real capture count from run 1 — **4,315**, measured from `logs/night.log`.
- clasher VPC routing — settled: S3 and the prospector box live in rogue, and
  only the MySQL connection routes through the maverick instance in clasher.

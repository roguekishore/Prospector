# Handoff — 2026-09-26

Written for the next agent picking this up. It covers two repos: this one, and
`AWS-COMMAND-CENTER` (warden) beside it at `D:\PROJECTS\AWS-COMMAND-CENTER`.

Read `CLAUDE.md` first, then this. `CLAUDE.md` tells you what not to touch;
this tells you where the work stopped and why it stopped there.

Nothing in here has run against real AWS. Not one Lambda invoke, not one S3
object, not one instance. Treat every AWS-facing claim below as designed and
reviewed, never as verified.

---

## 1. Where things stand

### This repo

Eight commits on `main`, **none pushed** — `origin` is
`https://github.com/roguekishore/Prospector.git`:

| Commit | What |
|---|---|
| `17bd0fe` | city-first S3 layout, `lib-keys.js` |
| `4204e67` | hosting decisions in `docs/DEPLOYMENT.md` |
| `5f89507` | `src/control/` — the dashboard and run control |
| `9fb70da` | EMF metrics from the capture Lambda |
| `8f901dc` | `docs/ARCHITECTURE.md`, corrected figures in `DEPLOYMENT.md` |
| `64337c2` | capture on Lambda, S3 publishing, `scripts/dispatch.js` |
| `33c7818` | hard per-capture deadline |
| `c1164d8` | discover records request counts, pagination, commit sha |

**Push before provisioning anything.** The box clones from `origin`, so
unpushed work is invisible to it.

### warden

`5c9e9ee` on `master`, **and that branch has no upstream and the repo has no
remote at all**. It is local-only. It also has not been deployed — `./w ship`
has not run since the commit.

That commit adds a read-only `capture` tile: `warden/app/adapters/capture.py`
plus registrations in `warden/app/models.py`, `warden/app/collectors.py`,
`warden/app/registry.py`, `warden/tests/test_collectors.py`,
`fixtures/build_fixture.py`, `fixtures/snapshot.sample.json` and
`docs/snapshot-contract.md` §5.7 — paths relative to the warden repo.

**warden's React UI at `warden/ui/` was not touched.** The backend collects,
persists and serves a seventh tile kind that the frontend has never seen.
Whether it ignores the tile or throws on an unhandled kind is **unverified** —
find out before `./w ship`, because that command's first step is
`npm run build` on that UI. The deploy target is `i-01a6e16cb6b89bced` in
`ap-south-1` (`deploy/remote-install.sh:35`).

### Dependencies

`npm install` has **not** been run since `@aws-sdk/client-s3` and
`@aws-sdk/client-lambda` were added to `package.json`. Neither is in
`node_modules`.

Everything still runs today only because every SDK `require` is lazy — inside
the function that uses it (every helper in `src/capture/s3.js`,
`src/capture/lambda.js:126`, and `scripts/dispatch.js:121`, which sits after the
`--dry-run` early return). So `dispatch.js --dry-run` passes on a machine with no
SDK installed and proves nothing about the real path. Run `npm install` before
believing any S3 or Lambda result.

---

## 2. Decisions that are closed

These were argued out with the operator. Do not reopen them without new
evidence; do read the *why*, because several are counter-intuitive.

| Decision | Why |
|---|---|
| **Capture key is `<city>/captures/<domain>/`** | City is the campaign boundary. Vertical is out of the key because it is a classification that gets corrected, and a key built from it strands bytes on recategorisation. No date, no run id: the key must be computable from columns that exist, and a 16-hour sweep crosses midnight. |
| **Bucket versioning is load-bearing** | It is what makes a re-capture non-destructive without a date in the path. Without it, re-capture destroys silently. |
| **No noncurrent-version lifecycle rule** | Operator's call: a domain is captured once, never on a schedule. Add an expiry rule only if a periodic refresh is introduced. |
| **Captures stay on S3 Standard** | Standard-IA bills a 128 KB minimum per object against a ~34 KB average capture, so it costs *more*. Moot anyway: ~1.7 GB for 50,000 captures. |
| **S3 holds bytes, MySQL holds state** | `companies.status` answers "what is left" in one indexed query. `captureComplete()` is for a `--verify` repair mode, not the resume path. |
| **Both HTML files are uploaded** | Makes every future parsing change a re-read instead of a re-crawl, for ~$0.05/month. This overrules the older "skip `raw/` to save transfer" line in `docs/DEPLOYMENT.md`, and with it the argument for fusing HTML parsing into the capture Lambda. |
| **`places-raw/` archives raw Places bodies** | They cost money, cannot be reproduced, and are the only record of what Google actually returned. The truncation bug hid for a year for want of exactly this. |
| **Control lives in prospector, not warden** | See §5. |
| **Caddy, not nginx** | See §4. |
| **Ubuntu 24.04 arm64, not AL2023** | Playwright publishes arm64 Chromium for Ubuntu and treats AL2023 as unsupported. |
| **Two hostnames, not two paths** | Both apps emit root-absolute URLs, so a path mount means editing both apps. |
| **Auto-routing at 90% free tier is deferred** | Agreed with the operator. When built: warden publishes the percentage, `dispatch.js` consumes it. Warden stays a sensor. |
| **The audit and score stages are not the product** | Operator reviews sites personally; machine scoring does not sell to non-technical buyers. Do not invest here. `lib-scoring.js` stays frozen — see `CLAUDE.md`. |

Full rationale for the S3 items is in `docs/ARCHITECTURE.md` §"S3 layout —
FIXED"; for hosting, `docs/DEPLOYMENT.md` §"Hosting the box".

---

## 3. The next task: Terraform, one command

The operator's requirement, verbatim in intent: **everything IaC, no manual
work, builds included, one command, reproducible.** Nothing of this exists yet.

### Layout to create

```
terraform/
  providers.tf          aws.rogue, assuming the existing warden-admin role
  main.tf
  variables.tf
  outputs.tf            box ip, bucket, ecr url, function name
  versions.tf
  modules/
    bucket/             versioning ON, public access blocked, NO lifecycle rule
    box/                ubuntu 24.04 arm64 via AMI data source, user-data
    capture-lambda/     ecr repo, fn (arm64 / 2048 MB / 900 s / no VPC), DLQ, log group
deploy/
  Caddyfile
  prospector-control.service
  prospector-serve.service
p                       the one command — model it on warden's ./w
```

Its own root module and its own state, **not** a module inside
`AWS-COMMAND-CENTER/terraform`. Prospector's resources have their own
lifecycle; warden's state is a six-account bootstrap that should not gain and
lose a bucket on every apply.

Authenticate by assuming `warden-admin` in rogue. Do **not** depend on
`AWS-COMMAND-CENTER/terraform/providers.tf:5-45`, whose static root keys were
deleted 2026-09-20.

### Two changes that belong in warden's repo, not here

Because that is where the modules live:

1. Reader role gains `cloudwatch:GetMetricData` and
   `lambda:GetFunctionConfiguration` — `terraform/modules/warden-roles`.
2. The account gets the `prospector` capability tag — `terraform/write_registry.py`
   and `/warden/registry` in SSM. Without it the capture tile gates off as `na`.

### What `./p up` should do

1. `terraform apply` — bucket, box, ECR, Lambda, DLQ, SSM params.
2. **Build and push the image on the box, over SSM** — `git pull`,
   `docker build`, ECR push.
3. Point the function at the new digest.
4. Install the systemd units and the Caddyfile (user-data on first boot,
   `./p ship` on later pushes).

**Build on the box, not on the laptop.** The image is arm64; building it on
Windows/x86 needs buildx plus QEMU, which for a Playwright image is slow and
fragile. The box is arm64 and has to exist anyway. Lambda then runs arm64 too,
which is ~20% cheaper per GB-s — and GB-s is the constrained resource, so that
is not incidental.

### The AWS shape, already decided

- **Lambda**: 2,048 MB, 900 s, arm64, **no VPC**, `CAPTURE_BUCKET` set, DLQ
  attached. No VPC because a NAT gateway would cost ~$32/month and this design
  exists to avoid it. 2,048 MB because the capture settle is a `Promise.race`
  deadline, not a sleep — low memory silently degrades capture *quality*, it
  does not just slow things down.
- **Batch size 10**, pinned by arithmetic: `10 x 60s = 600s < 900s`;
  `15 x 60s = 900s` exactly fails. See `scripts/dispatch.js` header.
- **Bucket** in `ap-south-1`, same region as the Lambdas — same-region transfer
  is free, which is the whole reason S3 beat base64-in-DynamoDB.
- **Box**: t4g.small, Ubuntu 24.04 arm64, in rogue. Free per account until
  2026-12-31. Security group 80 and 443 only; 7777 and 7778 never face the
  internet. SSM Session Manager for shell, no port 22.
- **Two hostnames**: `prospect.themaverick.tech` → control (7778),
  `leads.themaverick.tech` → the deck (7777). Both apps bind loopback; Caddy is
  the only public listener.

---

## 4. Traps

**`CONTROL_TOKEN` must stay unset on the box.** Unset means control binds
`127.0.0.1` (`src/control/index.js:279`) and Caddy's `basic_auth` is the only
gate. Setting it binds `0.0.0.0` and puts the secret in a query string, where it
lands in access logs and phone history.

**Do not copy warden's CSP header.** `deploy/nginx.conf` sends
`script-src 'self'`; `src/control/ui.html` is one file with an inline `<script>`
and `<style>`. The page would load, refuse to execute, and leave a styled corpse
with console errors. Caddy sends no CSP unless asked. If you want a real CSP,
split `ui.html` into three files first.

**SSE is already defended — don't "fix" it.** `X-Accel-Buffering: no`
(`src/control/index.js:149`) and a 25-second ping (`:156`) exist so the live log
survives a buffering proxy and a 60-second idle timeout. Caddy makes both
redundant; they stay in case something else is ever put in front.

**Caddy's cert storage must be on a persistent path.** Otherwise every restart
re-issues into a Let's Encrypt rate limit.

**DNS is Netlify, not Route53** (`AWS-COMMAND-CENTER/terraform/outputs.tf:2`).
No official Terraform provider. Either a `curl` step in `./p up` with a PAT from
SSM, or two manual A records. Both records must resolve **before** Caddy first
starts, or ACME fails. **Ask the operator for the PAT** — they have not supplied
one.

**A stage must never return from `run()` if it is a server.** The CLI calls
`process.exit(0)` the moment a stage resolves. `src/control/index.js:292` ends
with `return new Promise(() => {})` for exactly this reason, matching
`src/server/index.js`.

**`STAGES` in `src/cli/index.js:152` is an explicit whitelist.** A new stage
that is not listed there is rejected, with no fallback.

**The CLI hands each stage the raw argv array**, not parsed flags
(`src/cli/index.js:148`). Every stage parses its own; `control` uses `_flags()`.

**`lib-keys.js` is the only place a city or domain is spelled.** If the S3 key,
the local directory and `companies.domain` ever drift, `--resume` stops
recognising finished work and the next run re-captures the whole estate at full
cost — indistinguishably from a first run.

**`error.json` is still deleted by the score stage** on success
(`src/score/index.js:140`), destroying capture diagnostics. Open item in
`docs/STATUS.md`. `src/control/status.js` works around it by only counting a
failure when the domain is *not* complete.

**`npm run test:w1` leaves `data/interior-design/` behind** with no clean-up
script, and qualify in it makes real DNS and HTTP requests. Delete the directory
yourself.

---

## 5. Why control is not in warden

The operator asked this directly; the answer is load-bearing, so it is recorded
rather than left to be re-derived.

warden *does* have write paths — `warden/app/actions/ec2.py`,
`docs/write-contract.md`, and the outpost command queue. But outpost cannot
carry this, per `docs/outpost-contract.md`:

1. **Every action is a docker verb** (§6: `container.restart|stop|start|pull|recreate`,
   `log.tail`, `outpost.update`, closing "No AWS CLI. No credentials.").
   Prospector is not containerised, so step zero would put
   Playwright-in-Docker-on-arm64 into the control path — the one path that must
   work when everything else is broken.
2. **Commands expire in 120 s, claim-once, single terminal ok/fail** (§4). A
   capture run is sixteen hours. There is no job concept to report progress
   against.
3. **`log.tail` is 100 lines on request**, with a 15-second poll floor and one
   queued round trip per tail. The control panel pushes each line over SSE as it
   is emitted.
4. **No progress primitive and no file write.** Progress is a filesystem walk
   over `data/*/*/` (`src/control/status.js`); outpost reports container
   inventory and CPU/memory frames. Adding a vertical is an atomic write to
   `config/verticals.json` (`src/control/verticals.js:33`), and a remote
   file-write primitive is precisely what §4's design refuses.

The contract is frozen as of 2026-09-20, with the queue, the UI, `outpost/outpost.sh`
and `docs/write-contract.md` all built against it.

**Where outpost *is* right:** once prospector runs as a systemd unit, outpost is
the correct way to restart it when it wedges, tail its journal, and self-update
it. Outpost operates the box; the control panel operates the pipeline. Keep that
split deliberate.

---

## 6. Needs the operator, not an agent

- **Netlify PAT**, or accept two manual DNS records.
- **Lambda concurrency 10 → 100**, per account. A support ticket; not
  automatable. New accounts are slowest to be granted, so file early.
- **`GOOGLE_PLACES_KEY`** — created in the GCP console, stored in SSM for
  user-data to read. Required by `discover`, which is the only stage that spends
  quota and is deliberately excluded from `.claude/settings.json` so it always
  prompts.
- **Whether to add UI support for warden's `capture` tile**, or hold the warden
  deploy. Note that until a Lambda has actually run, the tile renders `na`
  because the metrics do not exist — so deploying warden first tells you
  nothing.
- **Verify one Lambda batch end to end before fanning out.** Nothing has run.

---

## 7. Verifying you have not broken anything

Offline, no network, no API quota:

```
node --check lib-keys.js src/capture/s3.js src/capture/lambda.js scripts/dispatch.js
node src/cli extract interior-design-smoke --no-probe
node src/cli score   interior-design-smoke
node src/cli report
node scripts/dispatch.js --dry-run      # must print city=coimbatore
```

Key shapes, which are easy to break and expensive to get wrong:

```
node -e "const s=require('./src/capture/s3');
console.log(s.capturePrefix('Coimbatore','WWW.Example.com'));  // coimbatore/captures/example.com
console.log(s.placesKey('Coimbatore','interior-design','qualified.json'));"
```

`npm run test:w1` runs the 40 W1 assertions but makes real DNS and HTTP
requests and leaves a directory behind — see §4.

In warden: `pytest warden/tests/` — nine contract tests assert that the docs,
the fixtures and the code agree on the set of tile kinds. If you add a kind,
they are *supposed* to fail until you update all four registration surfaces and
regenerate the fixture with `fixtures/build_fixture.py`. Never hand-edit
`fixtures/snapshot.sample.json`.

---

## 8. Known open item worth a look

`internal`/`external` link classification looks wrong in the smoke tree —
`internal: 0` for a site that links to itself. The agency-by-links query
depends on it. Not yet diagnosed; start at `src/extract/links.js`.

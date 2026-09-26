# Status

The pipeline is `discover → qualify → capture`, and capture runs extract. It
has completed one real run (18 verticals, 3,906 leads, on an EC2 box) — under
the old seven-stage shape, with scoring. That run is what produced most of the
open list below. Figures come from it and cannot be reproduced against local
`data/`.

Update this file in the same commit as the fix.

## spec A — capture and extract (`.kiro/specs/spec-a-capture-extract/`)

Built. The pipeline is three stages, there is no scoring anywhere, and capture
and extract share one folder per domain.

- [x] **Scoring, signals and the report stage deleted.** `src/score/`,
      `lib-scoring.js`, `src/report/`, `src/extract/signals/`,
      `src/extract/contacts.js`, `config/{angles,reasons,themeforest-slugs,agency-aliases}.json`,
      `ops/run-night.sh`, `scripts/{emit-sample,gen-fixtures,compress-shots}.js`.
      `audit`, `score`, `report` and `serve` are not CLI stages.
- [x] **One folder per domain,** `<city>/companies/<domain>/` on disk and in S3,
      flat, built by `companyDir` / `companyKey`. A domain in two verticals is
      captured once; the capture queue, `dispatch.js` and `control/status.js`
      each dedupe by canonical domain.
- [x] **Capture writes three files** — both shots and `rendered.html`, written
      last so it is the completion marker. No headers, timings, asset list,
      console errors, mobile metrics or raw body.
- [x] **Extract writes `extract.json`** — first email, outside links — and makes
      no network request. The dead-link probe is removed, not defaulted off.
      Deterministic: no run id, no timestamp, so a re-run is byte-identical.
      Verified by deleting one file and re-extracting (`npm run test:extract`,
      38 assertions).
- [x] **`registrable()` fixed.** It returned `antaryaconcepts.com.com` — domain
      plus the suffix a second time — so own-domain links never matched and every
      one of them was classified `external`. This is the "link classification
      looks wrong" item below. — `src/extract/links.js`
- [x] **Email text scan no longer glues blocks.** `$('body').text()` concatenates
      text nodes with nothing between them, so a minified
      `<p>info@foo.com</p><p>Call us</p>` scanned as `info@foo.comCall` — a
      plausible, valid-looking, wrong address. — `src/extract/email.js`
- [x] **`error.json` survives.** Written only by capture, never deleted; the
      score stage that deleted it is gone. A complete domain counts as captured
      even if a stale `error.json` remains.
- [x] **Lambda captures and extracts in one container,** `runBatch` split out so
      the whole per-domain flow is testable against a stub S3 client
      (`npm run test:lambda`, 28 assertions, two real captures).
      `Dockerfile.capture` now copies `lib-keys.js`; without it the image built
      clean and every invocation would have died at require time.
- [x] **Places raw-body archiving removed.** No `places-raw/` locally or in S3.

Not verified, and needing the operator:

- [ ] **`terraform plan` for both roots.** Edited and `fmt -check` + `validate`
      clean; no plan run, because the SSO token on this laptop is expired. The
      diff should be exactly: versioning `Suspended`, the Lambda policy's two S3
      statements, and the box policy's narrowed `places/*`.
- [ ] **The Lambda image build.** `docker build` for `linux/arm64` and
      `node -e "require('/var/task/src/capture/lambda')"` inside it were not run.
- [ ] **One real batch.** See the IAM item under *Open — Lambda capture*.

## box-discover-qualify (`.kiro/specs/box-discover-qualify/`)

**The box is live.** `./p up` ran against rogue (700897991126) on 2026-09-26 and
the control panel answers on <https://prospect.themaverick.tech> behind Caddy
basic auth. Both Terraform roots re-apply as a no-op, so `./p up` is safe to
repeat.

| What | Where |
|---|---|
| Instance | `i-0bf50fee5a6cbc935`, t4g.small, Ubuntu 24.04 arm64 |
| EIP | `35.154.77.31`, DNS `prospect.themaverick.tech` A |
| Data volume | `vol-0c3cf5fb03fd56d75` at `/var/lib/prospector`, survives `./p down` |
| Buckets | `prospector-captures-700897991126`, `prospector-deploy-700897991126` |
| Capture image | `prospector-capture:03ce726…`, ~1.05 GB, built natively on the box |
| Function | `prospector-capture`, arm64, 2048 MB, DLQ `prospector-capture-failed` |

Verified against the real box: HTTPS 401 without credentials, control service
`active` with local health 200, a real Let's Encrypt certificate, `ship` and
`status` working under the scoped `prospector-deploy` user, failure queue at 0.

Still open, both needing the operator rather than more code — a discover+qualify
run from the panel (it spends Places quota, and the `places*` backup objects and
their version counts can only be checked after one), and `./p down` + `./p up`
proving `data/` survives. Task 7.4's root-key deletion is also untested.

The capture function is **staged, never invoked** — that was the spec's intent.

**`./p doctor` exists so this class of failure cannot recur.** Nine checks —
binaries, DNS through `resolve_a`, absolute paths surviving the trip to a native
`.exe`, the aws CLI printing non-ASCII, `curl` discarding a body, `.env` parsing
by key name — all of which run with no credentials and no box. `./p up` calls it
first. Verified both directions: green on this machine, and red with the correct
diagnosis when the environment fixes are stripped out of a copy.

It exists because most of the cost of this spec was not AWS. `./p` runs on
Windows under Git Bash, where MSYS rewrites bare absolute-Unix-path arguments
before they reach a native `.exe` (hence `MSYS_NO_PATHCONV=1`, and hence local
paths going as `cd` plus a relative name, and `/dev/null` as `NULL_DEV`), there is
no `getent`, the aws CLI encodes stdout as cp1252 unless told otherwise, and
editors save UTF-16LE. `terraform validate`, `shellcheck` and `bash -n` pass on
every one of those.

- [x] **`scripts/backup-places.js`.** ETag-skip backup for
      `discovered.json` and `qualified.json`. No-op verified when
      `CAPTURE_BUCKET` is unset. The bucket now exists, but the ETag-compare path
      still needs a real discover run to exercise it.
- [x] **Control: `captureMode: 'none'`.** Discover → qualify → backup, no
      capture. UI button added. — `src/control/index.js`, `src/control/ui.html`
- [x] **Terraform, both roots.** `terraform validate` and `fmt -check` pass for
      `persist/` and `stack/`; both lockfiles committed. Applied 2026-09-26 and
      re-applied clean. `versions.tf` is duplicated byte-for-byte across the
      two roots rather than shared from a top-level file: Terraform has no
      cross-root include, and this repo has no symlink support on the Windows
      box it was written on (`core.symlinks=false`).
- [x] **`Dockerfile.capture`.** Base image pinned by digest (multi-arch index).
      `npm ci --omit=dev --ignore-scripts` replaces the old `npm pkg delete` +
      `npm install` — verified locally that `sharp` still resolves with
      `--ignore-scripts` (needs no lifecycle script), which is what makes
      dropping `better-sqlite3`'s native build free. `aws-lambda-ric@4.0.2`
      needs a build toolchain Ubuntu noble doesn't ship
      (`cmake`/`autoconf`/`libtool`/`libcurl4-openssl-dev`), installed and
      purged in the same layer — confirmed with an actual `docker buildx build
      --platform linux/arm64`, all 7 layers, no errors. Slow (~21 minutes,
      almost all of it `node-gyp rebuild` for aws-lambda-ric's native addon
      under QEMU emulation on this x86 laptop) — resolves design.md's open
      items 1–2. That laptop build was a check only, never pushed. The real build
      path (`deploy/install.sh` step 6) has since run natively on the box's own
      arm64 hardware in ~6 minutes, no emulation, and pushed the image to ECR.
- [x] **`./p`, `deploy/install.sh`, systemd units, Caddyfile, load-env.sh.**
      Written per design.md, then run against the real box until `install.sh`
      completed end to end and `./p status` came back green on all seven checks.
- [x] **Task 7 — the first real run.** Done, bar the two operator-only items and
      the root-key deletion listed at the top of this section.

## Open — offline, no re-crawl, no API quota

Verify with `npm run test:extract`, then `npm run test:run` for a real crawl.

- [x] **Phone, WhatsApp and address extraction** — dropped entirely with the
      contacts file. Places supplies the phone and address; `extract.json` holds
      the email and the links, and nothing else wants them.
- [x] **Agency attribution never compounds.** Closed by deletion, not by a fix:
      the pipeline no longer detects agencies. The operator derives them from
      `links` — a domain that appears in many unrelated sites' footers is an
      agency — which is a query over `docs/SCHEMA.md`, and it needs the
      `registrable()` fix above to work at all.
- [x] **Hosting platforms reach the pipeline as businesses.** Added
      `vercel.app`, `ueniweb.com`, `bolt.host`, `mypixieset.com`,
      `sleek.fitness` to `REJECT_DOMAINS`. — `src/discover/index.js:21`

## Open — needs a re-crawl

- [ ] **Re-run `discover` on the fixed field mask.** During run 1 the box lacked
      the `nextPageToken` field-mask fix, so every tile×keyword returned page 1
      only, capped at 20 results. **3,906 is a floor, not a census**, biased
      hardest against dense commercial belts.

      Loss now measured from `logs/night.log`: **3,600 requests, 952 capped at
      exactly 20 (26.4%)**, 31,284 raw results, 4,315 audited. Capped queries
      held 19,040 of those results — 61% of the data from 26% of the spend.
      Worst by vertical: builders-promoters **59%**, gyms-fitness 34%,
      plot-promoters 33%; lightest commercial-leasing 9.5%. Untruncated
      estimate ~5,504 requests → ~7,600–9,600 audited.

      Quota is not a constraint: run 1 used **4.8%** of the 75,000/day
      `SearchTextRequest` ceiling, not the ~14% previously recorded here (that
      figure matches an untruncated sweep, 10,800/75,000, and appears to have
      been a projection recorded as a measurement).

- [x] **Instrument `discover` so this cannot recur silently.** Every run now
      logs `commit=<sha>` in its header, per-query page counts, and a summary
      of requests issued / queries paginated / queries at the 60-result
      ceiling — all four also written into `discovered.json`. A `places-new`
      run with zero paginated queries now warns outright. Run 1 left no record
      of any of this, which is why the truncation went unnoticed.
      — `src/discover/index.js:100`, `src/discover/places.js:150`

## Open — the deck (spec B)

`src/server/`, `src/db/` and `preview/` are retired and unreachable: they depend
on the deleted `report` stage and on score fields. Spec B rebuilds the deck on
MySQL. Two findings from the old one are worth carrying over:

- [ ] **A view for the no-website pool.** 259 dental businesses have no website
      at all, 211 of them with phone numbers — a larger pool than the 139 dental
      leads that had one, including clinics at 4,684 and 2,302 reviews. Maximum
      ability to pay, no incumbent to displace. They exist only in
      `qualified.json` and the old deck could not show them.
- [ ] **The operator's decisions are at risk today.** They live in browser
      localStorage plus a fire-and-forget `PUT` (`preview/app.js:134`). Spec B's
      `companies.tier` / `pitch` / `note` columns are the fix.

## Open — robustness before the next run

- [ ] **Raise capture concurrency.** Capture is wait-bound, not CPU-bound:
      11.5s per capture at concurrency 1 vs ~12.5s at 8, because ~7s of each is
      deliberate settle sleeps. 8 vCPUs sat idle. Default is 4; the control
      panel's local mode passes 2 on a t4g.small. At 16 a full 18-vertical run
      goes from ~5h to ~3.3h. — `src/capture/index.js`
- [x] **Hard per-capture deadline.** Whole capture wrapped in `Promise.race`
      against `--deadline` (default 60s); whatever shots landed are kept and
      listed in `error.json` as `partial`, `kind: "deadline"`. Not retried —
      re-running a slow page just burns the deadline again. Verified both ways:
      `--deadline 1` trips it and exits clean, default path unchanged at 12.4s.
      **60s is ~5x the 11.5s mean measured on an 8-vCPU box — a 2-vCPU
      t4g.small is slower, so watch the `deadline` count on the first vertical
      and raise it rather than losing pages.**
      — `src/capture/capture-domain.js:29`, `src/capture/index.js:50`
- [x] **Stop the score stage destroying `error.json`.** Closed permanently:
      the score stage is gone, and `error.json` is written only by capture.

## Open — Lambda capture

- [x] **Capture Lambda built.** Handler, S3 layer, dispatcher, Dockerfile.
      `captureDomain` already took `outDir`, so the handler points it at `/tmp`,
      uploads, and clears it — no rewrite, CLI path unchanged.
      — `src/capture/lambda.js`, `src/capture/s3.js`, `scripts/dispatch.js`,
      `Dockerfile.capture`
- [x] **S3 key layout fixed.** `<city>/companies/<domain>/<file>`, flat, no
      vertical and no date — derivable from columns that exist.
      — `src/capture/s3.js`
- [x] **Bucket versioning suspended.** A domain is captured once and never
      re-captured, so no key is overwritten and versioning protects nothing. It
      was load-bearing only while `places-raw/` overwrote a per-query key every
      run. Suspended, not removed: a bucket that has had versioning cannot go
      back to unversioned. SSE-S3 stays, which is what makes the backup ETag
      check equal MD5. Edited, not applied. — `terraform/persist/main.tf`
- [x] **`npm install`** — `@aws-sdk/client-s3` (3.1141.0) and
      `@aws-sdk/client-lambda` (3.1141.0) pinned exact and actually installed;
      the lockfile had never been regenerated since they were added to
      `package.json`. `npm ci --ignore-scripts` verified clean (`better-sqlite3`'s
      native build fails on this Windows devbox — pre-existing, unrelated).
- [x] **Build and push the image, create the function.** Both done for real.
      `deploy/install.sh` step 6 built the arm64 image natively on the box — no
      QEMU, ~6 minutes against the ~21 the emulated laptop build took — pushed
      ~1.05 GB to ECR, and `terraform apply` then created `prospector-capture`
      against that tag. Step 6 skips the build when the sha is already an ECR tag,
      so a commit that cannot change the image still costs a full rebuild today;
      see the note under **Deferred on purpose**.
- [x] **Attach a DLQ or failure destination.** `aws_sqs_queue.capture_failed`
      (14-day retention) plus `aws_lambda_function_event_invoke_config` with
      `maximum_retry_attempts = 2`, applied alongside the function.
      — `terraform/stack/lambda.tf`
- [x] **Observability.** Handler emits EMF counters per batch
      (`Prospector/Capture`: CapturesOk/Failed/Skipped/BatchDurationMs, plus
      ExtractOk/ExtractFailed, per vertical and aggregate). The four warden reads
      keep their names. warden renders them as a `capture` tile gated on a new
      `prospector` capability tag — 602 tests green in that repo.
      Lambda's own Invocations/Errors count batches, not pages, and read clean
      through a total collapse, which is why the handler counts for itself.
      — `src/capture/lambda.js`, `AWS-COMMAND-CENTER warden/app/adapters/capture.py`
- [ ] **Tag the account `prospector` in `/warden/registry`** and grant the warden
      reader role `cloudwatch:GetMetricData` + `lambda:GetFunctionConfiguration`.
      The local `accounts.local.json` copy is tagged; the authoritative SSM one
      is not, so the tile renders `not_applicable` until it is.
- [ ] **The Lambda role could not have read its own skip check.** The policy
      granted `s3:PutObject` only. `captureComplete` uses HeadObject, authorized
      as `s3:GetObject`, and without `s3:ListBucket` a missing key answers 403
      rather than 404 — which `_exists` throws on, by design, so every domain in
      a real batch would have errored before capturing anything. Fixed in
      `terraform/stack/lambda.tf` (`Companies` + `ListForHeadObject`), **not
      applied**. A stub-S3 test cannot catch this class of bug.
- [ ] **Verify one batch end to end before fanning out.** `npm run test:lambda`
      covers the handler's logic against a stub client; nothing has run against
      real AWS.

## Deferred on purpose

- **`rules@2` retune — closed, will not happen.** The operator's hand-marked
  dental list showed the scorer miscalibrated in two directions at once (broken
  CTAs near zero; `pain × pay` zeroing high-review low-pain leads), and the
  answer chosen was to stop scoring rather than to retune. There is no formula
  to bump. Broken-CTA detection goes with it.
- **Image rebuilds on every release sha.** `install.sh` step 6 asks ECR whether
  the tag exists, and the tag is the git sha, so any commit forces a fresh ~1 GB
  arm64 build and push even when it cannot have changed the image — a docs-only
  change costs ~6 minutes. Tag-by-sha is design.md's call and worth keeping for
  traceability; what is wrong is treating the release sha as the image identity.
  The fix is to key the skip on a hash of the image's real inputs
  (`Dockerfile.capture`, `package-lock.json`, `src/capture/**`) and re-tag the
  existing manifest with `aws ecr put-image` when they match, which costs seconds
  and no layer upload. Done by hand once already, to avoid a pointless rebuild
  mid-deploy.
- **Live iframe as a deck tab — undecided.** 19.6% of sites refuse framing (736
  `X-Frame-Options`, 278 CSP `frame-ancestors`, 835 either) and render as a
  permanent blank box. A stored capture also gives dated evidence, and a 390px
  iframe on desktop lays out at 390px — it cannot reproduce the
  980px-fallback-then-scale-down behaviour, which is the most sellable fact the
  tool produces.

## Done

- **`nextPageToken` field mask** — `src/discover/places.js`. **Local only;
  absent on the EC2 box.** Deploy it before the next run.
- **`full.png` dropped.** Captures write `desktop.webp` / `mobile.webp` in place;
  the deck's `F` tab is gone. Was 75% of image storage at 2.6 MB average. The
  ~10.7 GB of existing `full.png` on the box can be deleted separately —
  irreversible, not urgent.
- **robots.txt group parsing.** Blank lines were treated as group separators, so
  nine bots' `Disallow:/` merged into the wildcard group; 45 domains across 13
  verticals were wrongly refused and all 45 recovered. Group boundaries are a
  user-agent line following a rule line, never blank lines. 8 regression tests.
- **Greenfield bucket + dedup order.** Portal profiles (99acres, Practo,
  MakeMyTrip, WedMeGood) are kept as `aggregator-profile-only` and excluded from
  domain merge. Dedup ran before classification, so 39 of 40 brokers sharing a
  portal domain vanished entirely without even being recorded as skips.
- **Places rate limiting** — 8 req/sec limiter, backoff, `pageToken` retry.
- **Two missing pitch angles** — `mobile-tap-targets`, `mixed-content`. Five of
  seven fixture leads were falling through to `generic`.
- **`spec/W1-discovery.md` reconciled to the shipped code** — rate limit,
  no-merge-on-portal, new §2.6.1, two acceptance criteria.

## Note on `logs/`

`logs/night.log` is force-tracked run-1 evidence (1.4 MB). Two open items above
say to grep it — sizing the 20-result truncation, and counting capture outliers.
Drop it once both are closed.

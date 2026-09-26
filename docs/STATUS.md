# Status

All seven stages are built and the pipeline has completed one real run
(18 verticals, 3,906 scored leads, on an EC2 box). That run is what produced the
open list below — the pipeline works end to end, and running it at scale exposed
these. Figures come from that run and cannot be reproduced against local `data/`.

Update this file in the same commit as the fix.

## box-discover-qualify (`.kiro/specs/box-discover-qualify/`)

Tasks 1–6 are written and verified everything that can be verified without
real AWS. Task 7 — the actual `./p up` against rogue (700897991126) — has
**not run**. Nothing in this section has been applied.

- [x] **Places raw-body archiving (R5.3).** `postSearch` writes every
      successful response to `data/<vertical>/places-raw/<sha>.json`; `sha` is
      the same `placesRawSha` the S3 key uses. Verified with a stubbed
      `fetch()` that the written filename matches. — `src/discover/places.js`,
      `src/capture/s3.js`
- [x] **`scripts/backup-places.js`.** ETag-skip backup for
      `discovered.json`/`qualified.json`/`places-raw/*`. No-op verified when
      `CAPTURE_BUCKET` is unset; the ETag-compare path itself needs a real
      bucket to exercise (task 2.3), which does not exist until Terraform is
      applied.
- [x] **Control: `captureMode: 'none'`.** Discover → qualify → backup, no
      capture. UI button added. — `src/control/index.js`, `src/control/ui.html`
- [x] **Terraform, both roots.** `terraform validate` and `fmt -check` pass for
      `persist/` and `stack/`; both lockfiles committed. Never applied — no AWS
      resources exist yet. `versions.tf` is duplicated byte-for-byte across the
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
      items 1–2. Not `--load`ed or pushed anywhere; this was a build-only
      check. The real build path (`deploy/install.sh` step 6) runs natively on
      the box's own arm64 hardware, no emulation, once task 7 stands it up.
- [x] **`./p`, `deploy/install.sh`, systemd units, Caddyfile, load-env.sh.**
      Written per design.md. `bash -n p` and `bash -n deploy/install.sh` pass.
      **Not run against the box** — there is no box yet.
- [ ] **Task 7 — the first real run.** `./p up` against rogue, using the root
      CSV, has not been attempted. Everything above is designed and
      offline-verified, never AWS-verified.

## Open — offline, no re-crawl, no API quota

Verify each with `extract --no-probe` → `score` → `report` (see `CLAUDE.md`).

- [x] **Phone regex drops 11.5% of valid Indian mobiles.** Reduced `badPhoneRe`
      to `^\d{6}$` only; removed the unanchored year clause and two dead clauses.
      — `src/extract/contacts.js:30`
- [x] **953 leads display no phone though Places supplied one.** Added
      Places phone fallback after body-text scan; marked `owner:'places'` to
      exempt it from the cross-site frequency rule. — `src/extract/contacts.js`
- [x] **No WhatsApp extraction exists at all.** Added `wa.me` href handling;
      emits `kind:'whatsapp'` contacts. — `src/extract/contacts.js`
- [ ] **Agency attribution never compounds.** Every agency name appears exactly
      once, so cross-site frequency inversion cannot work. Copyright fragments
      parse as company names (`"Vivdleo.com , All rights reserved"`) and one
      domain emitted a doubled TLD (`krishnadentalclinic.com.com`).
      — `src/report/agency.js`
- [x] **Hosting platforms reach scoring as businesses.** Added `vercel.app`,
      `ueniweb.com`, `bolt.host`, `mypixieset.com`, `sleek.fitness` to
      `REJECT_DOMAINS`. — `src/discover/index.js:21`

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

## Open — review deck (`preview/`)

- [x] **Sort by review count, keep tier as a glyph.** `leadsIn()` now sorts by
      `review_count` descending. — `preview/app.js:142`
- [ ] **Expose flags as filters.** Filters are `all`/`unreviewed`/`pitch`/tier
      only. Invisible in a screenshot and unreachable by eye: 920 sites on plain
      HTTP, 826 with broken images, 32 with expired certificates — the last is
      the strongest cold open in the dataset. — `preview/app.js:145`
- [ ] **Add a view for the no-website pool.** 259 dental businesses have no
      website at all, 211 of them with phone numbers — a larger pool than the 139
      scored dental leads, including clinics at 4,684 and 2,302 reviews. Maximum
      ability to pay, no incumbent to displace. They exist only in
      `qualified.json` and the deck cannot show them.

## Open — robustness before the next run

- [ ] **Raise audit concurrency.** Capture is wait-bound, not CPU-bound: 11.5s
      per capture at concurrency 1 vs ~12.5s at 8, because ~7s of each is
      deliberate settle sleeps. 8 vCPUs sat idle. Default is 4; the night driver
      passes 8. At 16 a full 18-vertical run goes from ~5h to ~3.3h.
      — `src/capture/index.js:45`, `ops/run-night.sh:11`
- [x] **Hard per-capture deadline.** Whole capture wrapped in `Promise.race`
      against `--deadline` (default 60s); whatever shots landed are kept and
      listed in `error.json` as `partial`, `kind: "deadline"`. Not retried —
      re-running a slow page just burns the deadline again. Verified both ways:
      `--deadline 1` trips it and exits clean, default path unchanged at 12.4s.
      **60s is ~5x the 11.5s mean measured on an 8-vCPU box — a 2-vCPU
      t4g.small is slower, so watch the `deadline` count on the first vertical
      and raise it rather than losing pages.**
      — `src/capture/capture-domain.js:29`, `src/capture/index.js:50`
- [x] **Stop the score stage destroying `error.json`.** Removed the
      `unlinkSync` on success (`src/score/index.js:140`). Prior-stage errors
      now survive a successful score run.

## Open — Lambda capture

- [x] **Capture Lambda built.** Handler, S3 layer, dispatcher, Dockerfile.
      `captureDomain` already took `outDir`, so the handler points it at `/tmp`,
      uploads, and clears it — no rewrite, CLI path unchanged.
      — `src/capture/lambda.js`, `src/capture/s3.js`, `scripts/dispatch.js`,
      `Dockerfile.capture`
- [x] **S3 key layout fixed.** `captures/<vertical>/<domain>/<file>`, no date.
      History comes from bucket versioning instead, which keeps the key
      derivable from columns that exist. — `src/capture/s3.js`
- [x] **Enable S3 object versioning on the bucket.** Written into Terraform
      (`box-discover-qualify` persist root), not yet applied against real AWS.
      — `terraform/persist/main.tf`
- [x] **`npm install`** — `@aws-sdk/client-s3` (3.1141.0) and
      `@aws-sdk/client-lambda` (3.1141.0) pinned exact and actually installed;
      the lockfile had never been regenerated since they were added to
      `package.json`. `npm ci --ignore-scripts` verified clean (`better-sqlite3`'s
      native build fails on this Windows devbox — pre-existing, unrelated).
- [ ] **Build and push the image, create the function.** Scripted end to end
      (`deploy/install.sh` step 6, `terraform/stack/lambda.tf`) but **not run
      against real AWS** — nothing has been applied yet. The Dockerfile build
      itself was smoke-tested locally with `docker buildx build --platform
      linux/arm64`; see `box-discover-qualify` below for the result.
- [x] **Attach a DLQ or failure destination.** `aws_sqs_queue.capture_failed`
      (14-day retention) plus `aws_lambda_function_event_invoke_config` with
      `maximum_retry_attempts = 2`, written into Terraform but not yet applied.
      — `terraform/stack/lambda.tf`
- [x] **Observability.** Handler emits EMF counters per batch
      (`Prospector/Capture`: CapturesOk/Failed/Skipped/BatchDurationMs, per
      vertical and aggregate). warden reads them as a `capture` tile gated on a
      new `prospector` capability tag — 602 tests green in that repo.
      Lambda's own Invocations/Errors count batches, not pages, and read clean
      through a total collapse, which is why the handler counts for itself.
      — `src/capture/lambda.js`, `AWS-COMMAND-CENTER warden/app/adapters/capture.py`
- [ ] **Tag the account `prospector` in `/warden/registry`** and grant the warden
      reader role `cloudwatch:GetMetricData` + `lambda:GetFunctionConfiguration`.
      The local `accounts.local.json` copy is tagged; the authoritative SSM one
      is not, so the tile renders `not_applicable` until it is.
- [ ] **Verify one batch end to end before fanning out.** Nothing here has run
      against real AWS; only the key helpers, the upload walker and the batching
      were testable offline.

## Deferred on purpose

- **`rules@2` retune.** Two known miscalibrations from the operator's hand-marked
  dental list: broken CTAs score near zero (`quoteForm` only detects a *missing*
  form, not one that posts nowhere), and `pain × pay` multiplication zeroes
  high-review low-pain leads (1,130 reviews, mild flaws → C/28 where the operator
  reads an obvious payer). Let the Disagreements view accumulate real marks
  first. Do not tune against fixtures. Bump `scorer` to `rules@2` when weights
  change. — `lib-scoring.js`
- **Broken-CTA detection.** Prerequisite for the retune. The `form-broken` angle
  exists in `config/angles.json:19` with nothing in `src/` feeding it.
- **Live iframe as a deck tab — undecided.** 19.6% of sites refuse framing (736
  `X-Frame-Options`, 278 CSP `frame-ancestors`, 835 either) and render as a
  permanent blank box. A stored capture also gives dated evidence, and a 390px
  iframe on desktop lays out at 390px — it cannot reproduce the
  980px-fallback-then-scale-down behaviour, which is the most sellable fact the
  tool produces.

## Done

- **`nextPageToken` field mask** — `src/discover/places.js:17`. **Local only;
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

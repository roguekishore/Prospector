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
      looks wrong" item below. — `src/capture/extract/links.js`
- [x] **Email text scan no longer glues blocks.** `$('body').text()` concatenates
      text nodes with nothing between them, so a minified
      `<p>info@foo.com</p><p>Call us</p>` scanned as `info@foo.comCall` — a
      plausible, valid-looking, wrong address. — `src/capture/extract/email.js`
- [x] **`error.json` survives.** Written only by capture, never deleted; the
      score stage that deleted it is gone. A complete domain counts as captured
      even if a stale `error.json` remains.
- [x] **Lambda captures and extracts in one container,** `runBatch` split out so
      the whole per-domain flow is testable against a stub S3 client
      (`npm run test:lambda`, 28 assertions, two real captures).
      `Dockerfile.capture` now copies `lib-keys.js`; without it the image built
      clean and every invocation would have died at require time.
- [x] **Places raw-body archiving removed.** No `places-raw/` locally or in S3.

- [x] **Extract is not a stage.** A directory under `src/` is a stage if and only
      if `all` runs it, so extract — which runs inside capture, per domain —
      lives in `src/capture/extract/`. There is no `extract` command, no
      `npm run extract` and no `src/extract/`; `node src/cli extract` fails with
      "Unknown command". `src/cli/index.js` keeps two lists, `PIPELINE` and
      `COMMANDS`, and the help text shows them apart. Re-running extract over
      captures that already exist is `capture --extract-only`. — a7d3735

- [x] **`capture --extract-only` runs.** Verified 2026-09-27 against a local
      MySQL 8.0.39 and the 5-domain smoke tree: `extract.json` deleted for
      `cabiinetdesigns.com` and `thefineceiling.in` and their rows set to
      `extract_status = -2`, then one run re-extracted both — `2 ok  0 errors
      0 skipped`, rows back to `extract_status = 1`, the 3 `links` rows restored
      identically, and the regenerated `extract.json` **byte-identical** (647 B,
      `cmp`) to the one the original capture had written earlier that evening —
      the determinism claim proved against a real capture rather than a fixture. The work
      list has no hole: `src/db/record.js:117` writes `-2` whenever a capture
      completes without a usable `extract.json`, so no row can sit at
      `status = 1` with `extract_status` NULL. The flag reads the **database**,
      not the disk — deleting `extract.json` alone leaves the row at `1` and the
      domain is correctly not picked up.
- [ ] **The S3 fallback in `--extract-only` is still unrun.** `_downloadRendered`
      / `_uploadExtract` need `CAPTURE_BUCKET` and real credentials. Spec C.

Not verified, and needing the operator:

- [ ] **`terraform plan` for both roots.** Edited and `fmt -check` + `validate`
      clean; no plan run, because the SSO token on this laptop is expired. The
      diff should be exactly: versioning `Suspended`, the Lambda policy's two S3
      statements, and the box policy's narrowed `places/*`.
- [ ] **The Lambda image build.** `docker build` for `linux/arm64` and
      `node -e "require('/var/task/src/capture/lambda')"` inside it were not run.
- [ ] **One real batch.** See the IAM item under *Open — Lambda capture*.

All three close in spec C task 1 (`.kiro/specs/spec-c-running-capture/`).

## spec B — MySQL and the deck (`.kiro/specs/spec-b-mysql-deck/`)

**The code is built and tested; none of the infrastructure has been applied.**
MySQL is the source of truth for businesses and pipeline state: `discovered.json`,
`qualified.json`, `config/verticals.json`, SQLite and the places backup are all
gone, and every stage reads and writes `companies`.

`.kiro/specs/spec-b-mysql-deck/HANDBACK.md` is the hand-back: what was verified,
what was not, and the one thing left to decide.

Verified on the laptop against a local MySQL 8.0.39, 2026-09-26:

| Suite | Result |
|---|---|
| `npm run test:db` | 99 assertions — migrate, discover, qualify, `recordDomain`, ingest |
| `npm run test:deck` | 77 assertions — paging, filters, decisions, CSV, screenshots |
| `npm run test:w1` | 41 assertions — AC1–AC10, qualify over real DNS and HTTP |
| `npm run test:run` | 5 real captures, asserted on disk **and** on the rows |
| `npm run test:extract` | 38 assertions |
| `npm run test:lambda` | 28 assertions, 2 real captures |

`npm run test:clean` leaves `data/` and the test tables empty. Done-when 3's
grep — `qualified.json`, `discovered.json`, `verticals.json`, `better-sqlite3`,
`backup-places`, `verdict === 'audit'`, `placesKey` over `src scripts deploy
package.json` — finds nothing.

Two real bugs found by running it, both fixed:

- **Eight concurrent ingest workers deadlocked** on `recordDomain`'s
  `SELECT … FOR UPDATE` over the non-unique `by_site` index. Under REPEATABLE
  READ that takes next-key locks covering the gaps between index entries, so two
  workers on adjacent domains lock each other out. `tx()` now runs at READ
  COMMITTED, which takes no gap locks, with a bounded retry behind it for the
  foreign-key checks on `links`. — `src/db/mysql.js`
- **Every insert counted as new.** `migrate --import-verticals` reported "19
  inserted, 0 already present" on a re-import of the same file, and discover's
  `N new / M seen` had the same fault. mysql2 connects with `CLIENT_FOUND_ROWS`,
  under which a duplicate whose `ON DUPLICATE KEY UPDATE` changed nothing still
  reports a row — so `affectedRows` equals the batch size whatever happened.
  Both now read which keys are already present before inserting. The rows were
  always right; only the counts lied, which is the kind of lie that makes a
  re-run look like a fresh one. — `src/db/migrate.js`, `src/discover/index.js`

Needing the operator, in this order:

- [ ] **`./p peer`** — apply `terraform/mavdb`. Needs the clasher root CSV, and
      **`-var mavdb_security_group_id=<sg-…>`**: mavdb has two security groups
      (`sg-0dd18a4efc3b3c824`, `sg-08d3393b63a12b9ca`) and picking one here would
      be a guess about another team's network. The plan must show **only creates**
      in clasher — the accepter, one route per route table, one ingress rule. Any
      `update` or `replace` there means stop.
- [ ] **`./p db`** — apply `terraform/db`. Needs `MAVERICK_DB_PASSWORD` in `.env`
      and `session-manager-plugin` on `PATH` (`./p doctor` warns when it is
      missing). Afterwards, check the password appears in no SSM parameter and no
      SSM command history.
- [ ] **`terraform apply persist` then `stack`.** The network moved from `stack`
      to `persist`, so the peering survives `./p down`. **If the stack is up**
      this needs `import` blocks in persist and `removed { lifecycle { destroy =
      false } }` blocks in stack, applied persist-first, then both plans clean and
      the blocks deleted in a follow-up commit. Neither set of blocks is written:
      whether the stack is up could not be checked from here.
- [ ] **`./p up`** — `ship`, then `migrate` on the box, then Caddy. Add
      `DECK_PASSWORD` to `.env` first, or the leads site block is skipped.
- [ ] **A Netlify A record, `leads` → the EIP.** Until it resolves the deck is
      reachable only on the box's loopback. `./p` polls both names independently,
      so a missing record never keeps the control panel off the internet.
- [ ] **Seed the `verticals` table on the box.** `migrate --import-verticals
      /var/lib/prospector/config/verticals.json` — the persistent copy on the data
      volume, which `install.sh` no longer maintains but has not deleted either.
      If it is gone, the same 19 verticals are in git:
      `git show 4f5c735:config/verticals.json`. Nothing else will put them back,
      and discover reads its keywords from that table.
- [ ] **Done-when 1, 2, 6, 8** — the `mysql --ssl-mode=VERIFY_IDENTITY` and
      `SHOW GRANTS` from an SSM shell, two clean plans across a `./p down` /
      `./p up`, the two 401s, and a decision made on one device appearing on
      another.
- [ ] **Rebuild `Dockerfile.capture`.** The lock changed (`better-sqlite3` out,
      `mysql2` in). Docker Desktop was not running here, so
      `npm ci --ignore-scripts` inside the image is unverified — though it now
      has nothing needing node-gyp to fail on.

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

- [ ] **Re-run `discover` on the fixed field mask.** Was held until spec B; the
      code is now ready and the run writes straight into MySQL. It still waits
      for `./p peer` and `./p db`, because the box cannot reach mavdb until
      those are applied. During run 1 the box lacked
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
      ceiling. A `places-new` run with zero paginated queries now warns
      outright. Run 1 left no record
      of any of this, which is why the truncation went unnoticed.
      — `src/discover/index.js:100`, `src/discover/places.js:150`

## The deck (spec B)

Rebuilt on MySQL. `node src/cli serve` on 127.0.0.1:7777, `leads.themaverick.tech`
in front of it. `src/db/index.js`, `preview/data.js` and `preview/mocks.js` are
deleted; `preview/app.css` is unchanged, because it was always the design
contract and only `app.js` needed rewriting. Verified by `npm run test:deck`
(77 assertions, offline).

- [x] **A view for the no-website pool.** 259 dental businesses have no website
      at all, 211 of them with phone numbers — a larger pool than the 139 dental
      leads that had one, including clinics at 4,684 and 2,302 reviews. Maximum
      ability to pay, no incumbent to displace. They are rows with
      `domain IS NULL`, and the deck has a tab for them that takes decisions like
      any other row. — `src/server/index.js` (`view=no-website`)
- [x] **The operator's decisions are at risk today.** Closed: they are
      `companies.tier` / `pitch` / `note` / `reviewed_at`, written by a `PUT`
      whose failure reverts the control and shows "not saved". No decision is
      kept in localStorage. A decision made on one device appears on another
      after a refresh, and survives `./p ship` — **still to confirm by hand with
      the operator once the deck is public** (spec B done-when 8).
- [ ] **The one date the deck shows is the UTC date, not the operator's.**
      Storage is UTC everywhere on purpose — that is what makes the laptop, the
      box and Lambda agree (see the clock item under *Open — robustness before
      the next run*) — but `reviewed_at` is rendered by truncating the stored
      string: `String(r.reviewed_at).slice(0, 10)` in `preview/app.js:386`. IST
      is UTC+5:30, so a decision taken between **00:00 and 05:30 IST shows the
      previous day's date**. Nothing else is affected: it is the only timestamp
      any UI displays. `captured_at` is returned by `src/server/index.js:253` and
      rendered nowhere, the control panel's "Running since" comes from
      `Date.now()` (`src/control/runner.js:122`) and is formatted with
      `toLocaleTimeString()`, so that one is already correct in local time.

      The fix belongs in the renderer, not the column: format the instant in
      `Asia/Kolkata` rather than slicing the UTC string, which also means parsing
      it as UTC first — `new Date(s.replace(' ', 'T') + 'Z')` — because
      `new Date('2026-09-26 18:52:34')` is read as *local* by every browser and
      would shift the date the other way. Worth doing whenever the deck next
      changes; it misreports only a 5½-hour window and only by one day.

- [ ] **Nothing has been reviewed through it yet.** Every assertion is against
      seeded rows; no human has used it on real leads.

## Open — robustness before the next run

- [x] **Every clock in the database is UTC, the two MySQL fills included.**
      `toMysqlDatetime` (`src/db/record.js:63`) writes `DATETIME` columns in UTC
      and `qualify` already used `UTC_TIMESTAMP()`, so the `DATETIME` side was
      never wrong. `companies.updated_at` and `verticals.created_at` were:
      `TIMESTAMP … CURRENT_TIMESTAMP` (`db/migrations/0001_init.sql:17,67`) is
      filled by the *server* in the session's timezone and converted back on
      read, which made those two the only session-dependent values in the
      database. The same instant therefore stored 5h30m apart on this laptop and
      not at all on the box, and any query comparing `updated_at` — or a later
      `NOW()` — against a `DATETIME` column would have been wrong by the host
      offset rather than wrong everywhere: a bug that hides on the machine that
      runs in UTC. Measured before the fix, one `recordDomain` call wrote
      `extracted_at = 2026-09-26 18:41:58` beside `updated_at = 2026-09-27
      00:11:58` — **330 minutes apart**, the same instant.

      Fixed by pinning every pooled connection to UTC — `SET time_zone =
      '+00:00'` on the pool's `connection` event, which runs before the
      connection is handed out, so the SET is first in its queue — making
      `NOW()`, `CURRENT_TIMESTAMP` and `UTC_TIMESTAMP()` agree and `TIMESTAMP`
      read back UTC. `dateStrings` was already half of this decision; this is the
      other half. — `src/db/mysql.js:97`

      Locked in by `testClocksAreUtc` in `scripts/test-db.js`, verified both
      directions: with the fix 102 pass, and with the four lines removed the
      three new assertions fail and reproduce the 330-minute gap exactly. A test
      that only reads Node-written columns cannot catch this, which is why the
      assertion reads `extracted_at` beside `updated_at`.

      Note for whoever reads these columns with another client: `DATETIME` is
      returned literally and `TIMESTAMP` is converted into the reader's session
      timezone, so a `mysql` CLI or MCP session left at `SYSTEM` shows the two
      column families 5h30m apart even though both are correct. Read them through
      the pool, or `SET time_zone = '+00:00'` first.

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
- [ ] **Tag the account `prospector` in `/warden/registry`.** The local
      `accounts.local.json` copy is tagged; the authoritative SSM one is not, so
      the tile renders `not_applicable` until it is. No reader-role change is
      needed: rogue's `infra` capability already grants
      `cloudwatch:GetMetricData` and `lambda:GetFunctionConfiguration`
      (confirmed in warden's tfstate). Spec D.
- [ ] **The Lambda role could not have read its own skip check.** The policy
      granted `s3:PutObject` only. `captureComplete` uses HeadObject, authorized
      as `s3:GetObject`, and without `s3:ListBucket` a missing key answers 403
      rather than 404 — which `_exists` throws on, by design, so every domain in
      a real batch would have errored before capturing anything. Fixed in
      `terraform/stack/lambda.tf` (`Companies` + `ListForHeadObject`), **not
      applied**. A stub-S3 test cannot catch this class of bug.
- [ ] **`terraform apply stack` is pending for the box role.** `ReadCompanies`,
      `ListCompanies` and `PutExtract` are written and the `*/places*` write is
      gone, but `ingest` on the box cannot read a thing until that is applied.
      — `terraform/stack/box.tf`
- [ ] **The deployed image predates spec A.** `prospector-capture:03ce726…`
      still writes `captures/` and does not extract. `./p ship` rebuilds it;
      do that before any real invoke. Spec C task 1.
- [ ] **Verify one batch end to end before fanning out.** `npm run test:lambda`
      covers the handler's logic against a stub client; nothing has run against
      real AWS. Spec C.

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
- **The W1 discovery spec reconciled to the shipped code** — rate limit,
  no-merge-on-portal, the portal-profile bucket, two acceptance criteria.
  `spec/` has since been retired into `docs/`.

## Note on `logs/`

`logs/night.log` is force-tracked run-1 evidence (1.4 MB). The two things it was
kept for — sizing the 20-result truncation and counting capture outliers — are
measured and recorded above. Spec C deletes it and the other run-1 logs, with
the operator's go.

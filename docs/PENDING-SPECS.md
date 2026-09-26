# Pending specs

Deferred work, one section per future spec, in the order to do them. Remaining
tasks of the `box-discover-qualify` spec are tracked in
`.kiro/specs/box-discover-qualify/tasks.md`, not here.

Each section has the same parts:
- **Why.** What it is for.
- **Decided.** Closed decisions; don't reopen them without new evidence.
- **Work.** What the spec has to build.
- **Unverified.** What has to be checked first.
- **Done when.** How to know it's finished.

"Unverified" means read from code or docs, never run against real AWS.

## Standing decisions (operator, 2026-09-26, final)

- **No scoring, ever.** The deck shows business details, screenshots and the
  operator's own decisions. No machine tier, score or pitch angle. The `score`
  stage and `lib-scoring.js` are removed, not frozen.
- **The pipeline is three stages:** `discover → qualify → capture`.
  - `capture` = two screenshots and `rendered.html`, then extract (the first
    email and the outside links), run the same way on the box and in the Lambda.
  - `ingest` and `control` are independent commands, not pipeline stages.
- **Extract runs inside the capture Lambda,** and makes no network request of
  its own. `rendered.html` is always saved to S3, so extract can be re-run on the
  box against the exact DOM the shots were taken from.
- **Credentials.** The operator supplies root keys for rogue (and clasher,
  where needed) to the agent at run time. No spec here builds an admin role.

## Order

| # | Spec | State |
|---|---|---|
| 1 | Three-stage pipeline | **Done** — spec A |
| 2 | Local disk layout matching S3 | **Half done** — capture output by spec A; the business list is spec B |
| 3 | MySQL for prospector | Folded into spec B. Table design in `docs/SCHEMA.md` |
| 4 | Running capture | Next. Needs nothing further built; needs real AWS |
| 5 | The `leads` deck | Folded into spec B |
| 6 | Warden follow-ups | The capture tile only shows data after 4's first Lambda run |
| 7 | mavdb security | Independent of the rest and can run any time |

## Files removed for good

Every tracked file the specs below delete, in one place. A file leaves the repo
in the same commit as the spec step that makes it dead, never earlier: most are
still imported by live code today.

| File | Removed by | Blocker before deleting |
|---|---|---|
| `docs/DEPLOYMENT.md` | Done, 2026-09-26 | Merged into `docs/ARCHITECTURE.md` |
| `src/score/`, `lib-scoring.js`, `src/report/` | Done, spec A | — |
| `src/extract/signals/`, `src/extract/contacts.js` | Done, spec A | — |
| `config/{angles,reasons,themeforest-slugs,agency-aliases}.json` | Done, spec A | — |
| `scripts/{emit-sample,gen-fixtures,compress-shots}.js` | Done, spec A | — |
| `ops/run-night.sh` | Done, spec A | — |
| `logs/night.log` | Spec p4 | Close the truncation-sizing and capture-outlier items in `docs/STATUS.md` |
| `logs/recover.log`, `logs/squeeze.log`, `logs/swap.log`, `logs/web.log` | Spec p4 | None. Run-1 output; nothing reads them |
| `src/server/`, `src/db/`, `preview/` | Spec B | Retired in place today: nothing loads them, `serve` is not a stage. Import the `reviews` rows into `companies` first |
| `better-sqlite3` in `package.json`, `index.db*` in `.gitignore` | Spec B | Same. `Dockerfile.capture` relies on `--ignore-scripts` until then |
| `ops/recover.sh` | Spec p4 | None. A run-1 script, rewritten by spec A to call `capture`; delete once the box's recovery path is the control panel |

Generated, never tracked, and no longer produced: `score.json`,
`verdict.json`, `signals.json`, `links.json`, `contacts.json`, `headers.json`,
`home.html`, `data-webp/`, `places-raw/`. `data/index.json` and the CSVs stop
with the old deck (spec B). Any of these still sitting in `data/` or in S3 are
leftovers; nothing reads them.

Not decided yet (each needs an operator call in its spec):

- `preview/mocks.js` and `preview/data.js` (18 synthetic leads with hand-written
  tiers and scores). They go with the old deck. Spec B.
- `scripts/migrate-layout.js`, once spec B has moved the business list.
- This file, once `.kiro/specs/p4-*` to `p7-*` and spec B are committed and
  carry everything here.

---

## 1. Three-stage pipeline — done

Built by **spec A** (`.kiro/specs/spec-a-capture-extract/`). The pipeline is
`discover → qualify → capture`; capture runs extract per domain, in the same
worker slot on the box and the same container in the Lambda. Nothing computes a
score, tier, pitch angle, flag or signal, and the files that did are deleted.

What it shipped, what it left unverified, and what it deliberately did not
touch: `docs/STATUS.md`, section "spec A".

---

## 2. Local disk layout matching S3 — half done

The capture half is done by **spec A**: `data/<city>/companies/<domain>/` on
disk is byte-for-byte the S3 key `<city>/companies/<domain>/`, both built from
`lib-keys.js`, so `ingest` is a prefix copy with nothing to translate. There was
nothing to migrate — the only local data was the regenerable smoke tree.

What is left is the *other* half, and it is **spec B**: discover and qualify
still write `data/<vertical>/discovered.json` and `qualified.json`, and the
capture queue, the dispatcher and the control panel all read the business list
from there. Spec B moves that to MySQL, at which point the per-vertical
directory and `scripts/migrate-layout.js` go away.

---

## 3. MySQL for prospector — folded into spec B

`docs/SCHEMA.md` is the table design: `verticals`, `companies`, `links`, on
mavdb. `extract.json`'s fields map one to one onto the columns `ingest` writes,
so loading a capture is a straight copy.

Spec B owns all of it: the DDL, `ingest`, moving discover / qualify / dispatch /
the control panel off `discovered.json` and `qualified.json`, and the deck that
queries it. The decisions recorded in this section are carried into
`docs/SCHEMA.md`; read that, not this.

---

## 4. Running capture

### Why

box-discover-qualify provisions the Lambda (ECR, function, SQS failure
destination, log group) but never invokes it. The box also has no browsers, so
local capture does not work either.

### Decided

- **Lambda shape:** arm64, 2048 MB, 900 s timeout, no VPC (a NAT gateway would be
  ~$32/month), `CAPTURE_BUCKET` set, no reserved concurrency (an account capped
  at 10 cannot reserve any).
- **What each invocation does:** captures a batch and runs extract on each site,
  in the same container, uploading each domain's folder to
  `<city>/companies/<domain>/`. Built; see `docs/STATUS.md` section "spec A".
- **Batch size 10**, pinned by arithmetic: `10 × 60 s = 600 s < 900 s`, and 15 fails
  exactly. The per-capture hard deadline (`--deadline`, 60 s) is what makes any
  batch size safe. Extract adds seconds per site, not minutes.
- **Invocation:** async (`InvocationType: Event`), 2 retries, then the SQS on-failure
  destination, which records the error rather than just the event.
- **Accounts:** one account (rogue). The six-account `for_each` fan-out waits
  until a second city needs it; one account is ~11× oversized for ~9,600
  captures.
- **Concurrency:** 10 is acceptable for overnight runs. Worst case (every
  capture hits the 60 s deadline) is 10 batches per 10 minutes, about 600
  domains/hour, so a ~9,600-domain sweep is at most ~16 h. Typical is far faster.

### Work

0. **Apply the Lambda role's S3 statements.** `terraform/stack/lambda.tf` grants
   `s3:PutObject` + `s3:GetObject` on `*/companies/*` and `s3:ListBucket` on the
   bucket; both are needed for `captureComplete`'s HeadObject to answer 404
   rather than 403, and neither is applied. Without this the first real batch
   errors on every domain before capturing anything.
1. **Box role grants:**
   - `lambda:InvokeFunction` on `prospector-capture`;
   - `sqs:GetQueueAttributes`, `ReceiveMessage` and `DeleteMessage` on
     `prospector-capture-failed`;
   - `s3:GetObject` and `ListBucket` on `*/captures/*` and `*/derived/*`, for
     `ingest`.
2. **Lambda execution role:** add `s3:PutObject` on `bucket/*/derived/*`. Today
   it has `*/captures/*` only.
3. **Verify one batch end to end before fanning out:**
   - one batch of 10 real domains;
   - check the S3 objects under `<city>/captures/<domain>/` and
     `<city>/derived/<domain>/`;
   - check the EMF metrics in CloudWatch, the logs and duration (including
     extract time per site);
   - check the failure queue is empty;
   - check GB-s consumed.
4. **Async event age.** Queued events expire after at most 6 hours. At
   concurrency 10, a large sweep can have late batches expire into the failure
   queue. That's safe because re-dispatch is idempotent, but it must be visible:
   - the control panel shows failure-queue depth;
   - a "re-dispatch missing" button runs `dispatch.js --resume` against
     `companies.status` (spec 3).
5. **Run spec 3's `ingest`** at the end of every dispatch. Without it, Lambda
   results never reach the box's disk, the dashboard or the deck.
6. **Local capture on the box**, if wanted:
   - `npx playwright install --with-deps chromium`, version-matched to
     `playwright` 1.63.0;
   - drop `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` from the install;
   - t4g.small (2 vCPU, 2 GB) supports concurrency 1–2.
   
   Until this is done, the panel's local-capture button fails; hide or disable it.
7. **Free-tier budget.** Per account, 400,000 GB-s/month.
   - Typical batch: ~12 s × 10 × 2 GB ≈ 240 GB-s, so ~9,600 domains ≈ 230,000 GB-s.
   - Worst case: 60 s each, 1,200 GB-s per batch, ~1.15M GB-s, which exceeds
     free tier.
   
   Measure the real figure, extract included, from the first batch.
8. **Concurrency 10 → 100** support ticket in rogue, only when overnight at 10
   stops being enough. It is the slowest to be granted on new accounts.
9. `docs/ARCHITECTURE.md` "Six-account fleet" stays as the design for when a
   second city needs it. Replace the modelled throughput and free-tier figures
   there with the measured ones.

### Unverified

- Real cold-start time (`Init Duration`) for the ~1.05 GB image.
- Whether 2048 MB is enough for `_forceImageDecode` on heavy pages (an OOM
  kills the whole batch).

### Done when

- One vertical dispatched from the panel lands in S3 with `captures/` and
  `derived/`, is ingested, and shows in the dashboard progress.
- The failure queue is visible, and re-dispatch fills the gaps.

---

## 5. The `leads` deck — folded into spec B

`src/server/`, `src/db/` and `preview/` are retired in place: they depend on the
deleted `report` stage and on score fields, `serve` is not a CLI stage, and
nothing loads them. Spec B rebuilds the deck on MySQL rather than repairing
them.

It shows Places details, the two screenshots, the first email, the outside
links, and the operator's own tier / pitch / note — which today live in browser
localStorage behind a fire-and-forget `PUT` and are at risk of being lost.

---

## 6. Warden follow-ups (in `AWS-COMMAND-CENTER`)

### Capture tile

- **The backend emits a seventh tile kind, `capture`,** since commit `5c9e9ee`:
  - `warden/app/models.py:24` (KINDS), capability `prospector`, cadence 1800,
    max-age 5400;
  - `collectors.py:68` maps it to `adapters/capture.py`;
  - `registry.py:36` adds `prospector` to CAPABILITIES.
- **The UI never draws it.** It is ignored without error, because:
  - `warden/ui/src/data/types.ts:13-28` has a closed `TileKind` union and `TILE_KINDS`;
  - `AccountTiles` (~`:355-362`) and `AccountsPage.tsx` (`:76-88`, `:114-121`,
    `:253-270`) read tiles by fixed name;
  - `transport.ts:99-107` does no schema validation.
- **UI work:** add `capture` to `TileKind`, `TILE_KINDS`, `AccountTiles`,
  `KIND_TITLES` and the page layout, with a card showing batches run, failures,
  and GB-s used against free tier.
- **Turn the tile on:**
  - add `prospector` to rogue's capabilities in `terraform/variables.tf` (~`:42-53`);
  - run `./bootstrap.sh apply`, which rewrites `/warden/registry` in SSM;
  - run `./bootstrap.sh registry` for the local copy.
- **No reader-role change is needed.** Rogue has `infra`, which already grants
  `cloudwatch:GetMetricData` and `lambda:GetFunctionConfiguration`
  (`terraform/modules/warden-roles`, confirmed in tfstate). The item at
  `docs/STATUS.md:171` saying otherwise is stale; correct it.
- **Contract tests:** `pytest warden/tests/` must pass. Regenerate the fixture with
  `fixtures/build_fixture.py`; never hand-edit `fixtures/snapshot.sample.json`.
- **Timing:** after spec 4's first real Lambda run. Before that the metrics don't
  exist and the tile shows `na`.

### Repo state

- `5c9e9ee` is local-only. The warden repo has no remote, and `master` has no
  upstream. Add a remote and push.
- `./w ship` has not run since `5c9e9ee`. It is safe to run: the UI ignores the
  new tile.

### Auto-routing at 90% free tier (deferred by agreement)

Warden publishes the free-tier percentage per account, and `dispatch.js`
consumes it. Warden stays a sensor, not a controller. Relevant only once the
six-account fan-out exists.

### Weaknesses found in warden's tooling (not yet adopted as work)

- **State and pinning:**
  - State is local (`terraform/terraform.tfstate`), with no locking, and
    contains the random ExternalIds.
  - `.terraform.lock.hcl` is gitignored (`.gitignore:13`), so provider pins are
    not reproducible from git.
  - `modules/warden-deploy` has its own lock on aws 6.65.0, which conflicts with
    the root's `~> 5.60`.
  - `deploy/deploy.sh` runs unpinned `pip install --upgrade pip setuptools wheel`.
    `./w ship` runs `npm run build`, not `npm ci`.
- **Credentials:** `WardenTerraformAdmin` (`modules/warden-admin`) is assumable
  by nothing. `WardenInstance` can only assume Reader and Operator, and the
  role's policy could not create EC2, VPC, S3 or Lambda anyway. Harmless while
  root keys are the operator's chosen path; remove it or document it as unused.
- **Manual pieces:**
  - `/warden/agent-token` in SSM is not in Terraform, presumably created by hand.
  - The first deploy is manual (`deploy/README.md` §5), and so is Netlify DNS
    (M4).
- **Bug:** in `deploy/upload-release.sh` (~`:52`), sourcing `rogue-creds.sh`
  happens inside `if [[ -z "$TARBALL" ]]`, so passing an explicit tarball
  leaves the credentials function undefined. `./w ship` passes none, so it
  isn't hit today.

---

## 7. mavdb security

Separate from prospector and independent of specs 1–6, so it can run any time.
Spec 3's prospector user already follows its conventions.

### Findings (2026-09-26)

- **Every Spring Boot app connects as `maverick`**, almost certainly the RDS
  master user, so every app can read, change or drop every other app's
  database.
- **The `maverick` password is a literal fallback default in config:**

  | App | File | Committed |
  |---|---|---|
  | VANTAGE | `APPS/VANTAGE/springapp/src/main/resources/application.properties:4-7` | No: gitignored, never committed. The repo `roguekishore/Vantage` is public. |
  | DEMO | `APPS/DEMO/springapp/src/main/resources/application.yml:18-21` | Yes: commit `aa8a104`, pushed to `neopass2/NeoPass-Code` (private, operator's account) |
  | ADMIN | `APPS/ADMIN/springapp/src/main/resources/application.yml:18-21` | Yes: commit `6f2ce8a`, pushed to `roguekishore/admin` (private) |

- TRUXPERT defaults to `root`/`root` on localhost. SPICERACK and ARGUS read env
  vars with no defaults.
- **Every app runs `ddl-auto: update`**, so Hibernate alters production tables on
  startup.
- **mavdb's users and grants have not been inspected.** The MySQL MCP tool
  connects to a local MySQL 8.0.39 on the laptop, not RDS.

### Decided

- **Two locks.** A teammate or agent needs both:
  1. **An AWS login.** It opens an SSM port-forward through MaverickInstance, and
     can be short-lived, scoped and expiring. Every tunnel is recorded in
     CloudTrail.
  2. **A personal MySQL user** with grants only on what they need.
- **Warden displays access, never grants it.** Its write paths are frozen by
  design, and a dashboard that creates database users is a target.
- **IAM database authentication is rejected** (memory; see spec 3).
- **Root keys** are supplied by the operator at run time. Root can switch off
  every control here, including deleting the audit logs, so the keys should
  not sit on disk between runs.

### Work, in order (the order matters)

1. **Safety net.** A manual RDS snapshot; turn on deletion protection if it is off.
2. **Per-app users,** each limited to its own database and to clasher's network:
   ```sql
   CREATE USER 'vantage'@'172.31.%' IDENTIFIED BY '<random 32>' REQUIRE SSL;
   GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES
     ON vantage.* TO 'vantage'@'172.31.%';
   ```
   DDL grants stay only until step 8 moves each app to migrations.
3. **Passwords in SSM**, one per app (`/apps/<app>/db-password`), injected as
   `DB_PASSWORD` at startup. Remove every password default from the config files
   so a missing setting fails loudly instead of falling back to admin.
4. **Switch apps one at a time.** Restart each and confirm it works.
5. **Rotate `maverick`.** This makes the copies in GitHub history useless.
   Rewriting history afterwards is optional.
6. **`maverick` is admin-only from here:** creating databases and users, one-off
   fixes. No app, agent or teammate uses it.
7. **Audit logging:**
   - Add a custom option group with `MARIADB_AUDIT_PLUGIN`, supported on MySQL 8.4
     ([AWS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.MySQL.Options.AuditPlugin.html)).
     Adding it may cause a brief outage, so do it at a quiet time.
   - Log `QUERY` for humans, agents and `maverick`. Exclude app users and
     `rdsadmin` (it queries every second) to control volume. `CONNECT` is always
     logged for everyone.
   - Export the audit log to CloudWatch Logs, with short retention.
   - Metric filters and SNS email alerts on: failed logins, any `maverick` login,
     `DROP`, `GRANT`/`REVOKE`, `CREATE USER`.
8. **Migrations.** Per app, move from `ddl-auto: update` to `validate` plus Flyway.
   A larger change, done app by app, separately from steps 1–6.
9. **Access for people and agents,** via one file (e.g. `access.yaml`: who,
   level, databases, expiry) and one command that reconciles it:
   - creates or locks MySQL users with the declared grants (read-only by default);
   - creates IAM principals whose only permission is `ssm:StartSession` on
     MaverickInstance with `AWS-StartPortForwardingSessionToRemoteHost` to mavdb
     port 3306, with an expiry enforced by an `aws:CurrentTime` condition and a
     short session duration;
   - removing a line or passing its expiry locks both.
   
   The file doubles as the access history. Agents get their own read-only user;
   schema changes go through reviewed migrations only.
10. **Operator's own access:** the same SSM port-forward instead of SSH on port 22.
    The DB client connects to `localhost:3306`.
11. **Warden view, later.** Read-only: who has access, expiring soon, recent
    alerts.

### Unverified

- Whether MaverickInstance's instance role has `AmazonSSMManagedInstanceCore`,
  which the tunnel needs. Adding it touches the production box, so flag it
  before doing it. Its 8 GB root volume is also marginal (warden
  `docs/inventory.md`).
- Whether port 22 is open on MaverickInstance today.
- mavdb's existing users, grants and deletion-protection status.

### Done when

- No app, agent or person connects as `maverick`.
- The old `maverick` password is rejected.
- Every login appears in CloudWatch.
- An alert email fires on a test `maverick` login.
- A teammate entry with an expiry stops working at that time with no manual
  step.

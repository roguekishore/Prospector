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

**Credentials.** The operator supplies root keys for rogue (and clasher,
where needed) to the agent at run time. No spec here builds an admin role.

## Order

| # | Spec | Why here |
|---|---|---|
| 1 | Local disk layout matching S3 | Before the first real capture run, while there is nothing to migrate |
| 2 | MySQL for prospector | Unblocks `ingest`, resume from `companies.status`, marks, deck scaling |
| 3 | Pipeline quality | Fix `error.json` and link classification before a real sweep depends on them |
| 4 | Running capture | Needs 1; uses 2's `ingest` and resume |
| 5 | The `leads` deck | Index scaling is simplest on 2's MySQL |
| 6 | Warden follow-ups | The capture tile only shows data after 4's first Lambda run |
| 7 | mavdb security | Independent of 1–6 and can run any time; reuses 2's user conventions |

---

## 1. Local disk layout matching S3

### Why

S3 is keyed by city and domain. Local disk is keyed by vertical
(`data/<vertical>/<domain>/`, with a nested `raw/`). Two layouts mean `ingest`
must translate every path through `qualified.json`. That translation is exactly
where the drift `lib-keys.js` warns about would live: if the S3 key, the local
directory and `companies.domain` disagree, `--resume` re-captures everything,
and it looks like a first run.

The reasons for keeping the vertical out of the S3 key apply to disk too:
recategorisation strands files, and one website under two verticals is stored
twice.

### Decided (proposed, confirm when the spec is written)

```
data/<city>/captures/<domain>/          exact mirror of S3 (raw/ flattened)
data/<city>/places/<vertical>/          exact mirror of S3
data/<city>/places-raw/<vertical>/      exact mirror of S3
data/<city>/derived/<domain>/           signals, links, contacts, score (local only, rebuildable)
data/index.json, leads.csv, …           report outputs, unchanged
```

With identical layouts:
- `ingest` is a prefix copy with nothing to translate;
- backing up local captures is the same copy in reverse;
- `scripts/backup-places.js` reduces to a sync of `places/` and `places-raw/`.

### Work

1. Add local-path functions to `lib-keys.js`, so every local path is spelled in
   one place, next to `canonicalCity`/`canonicalDomain`.
2. Replace every hand-built `path.join(DATA, vertical, domain)` with them:
   - `src/capture/` (capture-domain, audit);
   - `src/extract/index.js` (`:44`, `:182`, `:211`);
   - `src/score/index.js` (`:30`, `:109`, `:126`, and the `qualified.json` read at `:41`);
   - `src/report/index.js` (`:28`, `:109`, `:240`, `:322`, `:364`, `:444`);
   - `src/qualify/index.js` (`:492`, `:501`);
   - `src/discover/` (output paths and the new `places-raw/` from box-discover-qualify);
   - `src/server/index.js` (`/data/*` URLs, the `score.json` lookup at `:214`);
   - `src/control/status.js` (progress walk);
   - `scripts/backup-places.js`, `scripts/gen-fixtures.js`,
     `scripts/emit-sample.js`, `scripts/smoke.js`, `scripts/smoke-clean.js`,
     `scripts/test-w1.js`.
3. Update the file-layout contract in `spec/MASTER.md`. Spec wins for contracts,
   so this is the source of truth.
4. Update the W1 assertions that depend on paths.
5. The deck's `/data/*` URL shape changes, so `preview/` asset paths change with it.
6. Decide the fate of `data-webp/` (the compressed parallel tree).

### Unverified

- Whether scoring gives a different result for the same domain under two
  verticals. If it does, `derived/` needs the vertical in its path
  (`derived/<vertical>/<domain>/`).

### Done when

- `npm run test:run`, then `extract --no-probe` → `score` → `report`, produces
  identical output to before, apart from paths.
- The 40 W1 assertions pass.
- `aws s3 sync s3://<bucket>/coimbatore/captures/ data/coimbatore/captures/` is
  sufficient for `extract` to run with no other step.

**Timing.** Do this before the first real capture run. Today the only local
data is the regenerable smoke tree; after a real run it becomes a migration.

---

## 2. MySQL for prospector

### Why

The docs treat MySQL as prospector's state store: "S3 holds bytes, MySQL holds
state" (`docs/ARCHITECTURE.md`), and `companies.status` answers "what is left".
None of it exists in code yet. There is:
- no MySQL driver;
- no tables;
- no `ingest` stage.

Today the pipeline runs on files plus a local SQLite file (`src/db/index.js`).

### Decided

- **Database.** `mavdb` in clasher (028972816671):
  - RDS MySQL 8.4.8, `db.t4g.micro`, 20 GB, single-AZ;
  - not publicly accessible;
  - reachable today only from MaverickInstance (`i-0c694c2174cd3e74c`, private IP
    `172.31.0.10`), which is in the same VPC.
- **Network.** VPC peering, rogue `10.43.0.0/16` to clasher (`172.31.0.0/16`,
  presumed default VPC). A relay listener on MaverickInstance was rejected:
  - it would have to face the internet, because there is no private path between
    the accounts;
  - it puts clasher's production box in prospector's path;
  - it is another process to secure and maintain.
- **Isolation.** Prospector gets its own database `prospector` and its own user,
  never `maverick`. The database name in a connection URL does not restrict
  access; the user's grants do.
- **Password storage.** SSM SecureString `/prospector/db-password`, read at
  service start by `deploy/load-env.sh`, the same path as the other secrets.
- **IAM database authentication: rejected.** It needs 300–1000 MiB of spare
  memory on the instance
  ([AWS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.html)),
  and mavdb has 1 GiB total, shared by every app.

### Work

1. **Peering, rogue side** (`terraform/stack`):
   - `aws_vpc_peering_connection` to clasher's VPC;
   - route `172.31.0.0/16` → pcx in the box's route table;
   - SG egress 3306 to `172.31.0.0/16`.
2. **Peering, clasher side.** Three standalone resources only, never inline blocks
   or whole-table resources, so Terraform never takes ownership of clasher's
   existing route table or security group:
   - `aws_vpc_peering_connection_accepter`;
   - one `aws_route` (`10.43.0.0/16` → pcx) in the route table of mavdb's subnets;
   - one `aws_vpc_security_group_ingress_rule` on mavdb's SG, tcp 3306 from
     `10.43.0.0/16`.
   
   Needs a clasher provider alias, authenticated with clasher root keys supplied
   by the operator at run time (`./p` reads a second CSV, e.g.
   `${PROSPECTOR_CLASHER_CSV:-~/Downloads/clasher.csv}`, and checks the account
   is 028972816671). Decide whether this lives in `stack` (recreated by
   `./p down` / `./p up`) or its own root (survives `down`).
3. **Database and user bootstrap:** `./p db-bootstrap`, run over SSM
   `send-command` on the box, since only the box can reach mavdb.
   - It reads `MAVERICK_DB_PASSWORD` from `.env` once and generates a random
     32-character password.
   - It runs:
     ```sql
     CREATE DATABASE IF NOT EXISTS prospector;
     CREATE USER IF NOT EXISTS 'prospector'@'10.43.%' IDENTIFIED BY '<random>' REQUIRE SSL;
     GRANT SELECT, INSERT, UPDATE, DELETE ON prospector.* TO 'prospector'@'10.43.%';
     ```
   - Consider a second user, `prospector_migrate`, with `CREATE, ALTER, INDEX, DROP`
     on `prospector.*`, used only by the migration runner. That split matches
     spec 7.
   - It writes the password(s) to SSM and never stores `maverick` anywhere. The
     operator removes it from `.env` afterwards.
4. **Driver and TLS:**
   - `mysql2`, exact version pinned in `package.json`;
   - TLS verified against the RDS CA bundle (`global-bundle.pem`), pinned with a
     sha256 in `deploy/versions.env`.
5. **Schema and migrations:**
   - Numbered plain-SQL migration files plus a small runner; no ORM.
   - Tables per the MySQL section of `docs/ARCHITECTURE.md` (`cities`,
     `companies` with `status` = 0 pending, 1 done, -1 no website, -2 failed, and
     the rest listed there).
   - Keep the "no `scores` table" and "no `agencies` table yet" decisions recorded
     there.
6. **`ingest` stage** (new `src/ingest/`, added to the `STAGES` whitelist in
   `src/cli/index.js:152`). One pipe that grows; there is no separate "sync":
   - S3 `<city>/captures/<domain>/` → local disk (spec 1 layout);
   - then extract → score on the new domains;
   - then upsert results and `companies.status` into MySQL.
   
   Runs at the end of every Lambda dispatch and on a systemd timer.
7. **Resume from MySQL.** `dispatch.js` and `audit --resume` read pending work
   from `companies.status` instead of walking disk. `captureComplete()`
   (`src/capture/s3.js`) is for a `--verify` repair mode only, not for resume.
8. **Marks to MySQL.** Operator marks are currently being lost (DEPLOYMENT.md
   "Order of work" item 1), and they are the input the `rules@2` retune waits for.
   Where marks live today is not verified.
9. **Doc fix.** `docs/ARCHITECTURE.md`, MySQL section: "The path is computable
   from vertical, website and capture date" contradicts the FIXED layout. It
   should say "from city and domain".
10. **Health check.** `./p status` checks the MySQL connection as the
    `prospector` user.

### Unverified

- Clasher's VPC CIDR and which route tables mavdb's subnets use. It is presumed
  to be the default `172.31.0.0/16`, from MaverickInstance's IP.
- The mavdb endpoint resolving to a private IP from rogue. It should, since a
  non-public RDS endpoint resolves to its private address, but confirm; otherwise
  enable DNS resolution on the peering options.
- mavdb's security group id and its current rules.

### Done when

- From the box, `mysql --ssl-mode=VERIFY_IDENTITY -u prospector` connects to
  mavdb.
- `maverick` is absent from the box, SSM and `.env`.
- Migrations apply cleanly on an empty `prospector` database, and re-running
  them is a no-op.
- `ingest` on a Lambda-captured vertical fills `companies`, and a second run
  changes nothing.
- `dispatch --resume` skips every domain with `status = 1`.

---

## 3. Pipeline quality (from `docs/STATUS.md`)

Open items the first real overnight run will hit. The bugs come first because
spec 4's sweep depends on them.

### Bugs (fix before spec 4)

- **The score stage deletes `error.json` on success** (`src/score/index.js:140`),
  destroying capture diagnostics. `src/control/status.js` works around it by
  counting a failure only when the domain is not complete.
- **Links to a site's own pages count as external.** The smoke tree shows
  `internal: 0` for a site that links to itself, and the agency-by-links query
  depends on this. Undiagnosed; start at `src/extract/links.js`.
- **`npm run test:w1` leaves `data/interior-design/` behind** with no clean-up
  script, after making real DNS and HTTP requests. Add a clean-up.

### Before the next city-wide sweep

- **Re-run discover on the fixed field mask.** Run 1 lacked the `nextPageToken`
  fix, so every tile × keyword was capped at 20 results. 3,906 is a floor, not a
  census.
- **Places quota headroom,** sized against the real keyword × tile count.
- **Places cost per request.** Billing showed ~Rs 171 for run 1's 3,600 requests,
  far below the documented rate. Settle it from Billing → Reports, 18–19 Sep,
  grouped by SKU, gross and net.
- **Raise audit concurrency.** Capture is wait-bound (~7 s of each ~12 s is
  deliberate settle), not CPU-bound.

### Extraction

- **Agency attribution never compounds.** Every agency name appears once, so
  cross-site frequency inversion cannot work, and copyright fragments parse as
  company names. Related: `REJECT_DOMAINS` at `src/discover/index.js:21`.

### Deck

- **Expose flags as filters** (`preview/app.js:145`):
  - 920 sites on plain HTTP;
  - 826 with broken images;
  - 32 with expired certificates, the strongest cold open in the dataset.
- **A view for the no-website pool.** For example, 259 dental businesses have
  no website (211 with phone numbers), a larger pool than the 139 scored dental
  leads. `qualified.json` has them, but the deck cannot show them.

### Deferred on purpose

- **`rules@2` retune.** Waits for real operator marks (spec 2's marks table).
  `lib-scoring.js` stays frozen at `rules@1`; never tune against fixtures.
- **Drop `logs/night.log`** (1.4 MB of run-1 evidence) once the truncation-sizing
  and capture-outlier items are closed.

### Optional

- **A real CSP for control.** Only after splitting `src/control/ui.html` into
  HTML, JS and CSS files. Copying warden's `script-src 'self'` onto the single
  file blanks the page.

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
- **Batch size 10**, pinned by arithmetic: `10 × 60 s = 600 s < 900 s`, and 15 fails
  exactly. The per-capture hard deadline (`--deadline`, 60 s) is what makes any
  batch size safe.
- **Invocation:** async (`InvocationType: Event`), 2 retries, then the SQS on-failure
  destination, which records the error rather than just the event.
- **Accounts:** one account (rogue). The six-account `for_each` fan-out waits
  until a second city needs it; one account is ~11× oversized for ~9,600
  captures.
- **Concurrency:** 10 is acceptable for overnight runs. Worst case (every
  capture hits the 60 s deadline) is 10 batches per 10 minutes, about 600
  domains/hour, so a ~9,600-domain sweep is at most ~16 h. Typical is far faster.

### Work

1. **Box role grants:**
   - `lambda:InvokeFunction` on `prospector-capture`;
   - `sqs:GetQueueAttributes`, `ReceiveMessage` and `DeleteMessage` on
     `prospector-capture-failed`;
   - `s3:GetObject` and `ListBucket` on `*/captures/*`, for `ingest`.
2. **Verify one batch end to end before fanning out:**
   - one batch of 10 real domains;
   - check the S3 objects under `<city>/captures/<domain>/`;
   - check the EMF metrics in CloudWatch, the logs and duration;
   - check the failure queue is empty;
   - check GB-s consumed.
3. **Async event age.** Queued events expire after at most 6 hours. At
   concurrency 10, a large sweep can have late batches expire into the failure
   queue. That's safe because re-dispatch is idempotent, but it must be visible:
   - the control panel shows failure-queue depth;
   - a "re-dispatch missing" button runs `dispatch.js --resume` against
     `companies.status` (spec 2).
4. **Wire spec 2's `ingest`** at the end of every dispatch. Without it, Lambda
   results never reach the dashboard or the scorer.
5. **Local capture on the box**, if wanted:
   - `npx playwright install --with-deps chromium`, version-matched to
     `playwright` 1.63.0;
   - drop `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` from the install;
   - t4g.small (2 vCPU, 2 GB) supports concurrency 1–2.
   
   Until this is done, the panel's local-capture button fails; hide or disable it.
6. **Free-tier budget.** Per account, 400,000 GB-s/month.
   - Typical batch: ~12 s × 10 × 2 GB ≈ 240 GB-s, so ~9,600 domains ≈ 230,000 GB-s.
   - Worst case: 60 s each, 1,200 GB-s per batch, ~1.15M GB-s, which exceeds
     free tier.
   
   Measure the real figure from the first batch.
7. **Concurrency 10 → 100** support ticket in rogue, only when overnight at 10
   stops being enough. It is the slowest to be granted on new accounts.
8. `docs/DEPLOYMENT.md` "Six-account capture fleet" stays as the design for
   when a second city needs it.

### Unverified

- Real cold-start time and image size (DEPLOYMENT.md "Open").
- Whether 2048 MB is enough for `_forceImageDecode` on heavy pages (an OOM
  kills the whole batch).

### Done when

- One vertical dispatched from the panel lands in S3, is ingested, and shows in
  the dashboard progress.
- The failure queue is visible, and re-dispatch fills the gaps.

---

## 5. The `leads` deck

### Why

box-discover-qualify serves only `prospect.themaverick.tech` (control). The
review deck (`src/server/`, port 7777) is not deployed.

### Decided

- **A separate hostname:** `leads.themaverick.tech`, not a path, because both
  apps emit root-absolute URLs. Separate names also allow separate auth, since a
  prospect may one day be shown the deck, but never control.
- **The deck binds 127.0.0.1**, hard-coded at `src/server/index.js:202`. Caddy is
  the only public listener.
- **Auth covers `/data/*` too.** Gating only `/` leaves captures and per-domain
  JSON public, and it looks correct when you test it.
- **Captures are synced to local disk, never FUSE-mounted from S3.** A mounted
  bucket makes every request an S3 GET and goes stale.

### Work

1. `deploy/prospector-serve.service`, the same pattern as control
   (`load-env.sh`, `EnvironmentFile`).
2. Caddy block for `leads.themaverick.tech`: `basic_auth` (its own credential in
   SSM, e.g. `/prospector/deck-password`), `reverse_proxy 127.0.0.1:7777`.
3. The operator adds a second Netlify A record, `leads` → EIP. `./p` waits for
   DNS before enabling the block, as it does for `prospect`.
4. **Index scaling, the first wall at real scale.** `src/server/index.js:73`
   reads the whole `data/index.json` with `readFileSync` on every request, under
   `Cache-Control: no-store`. At 4.2 KB per lead:

   | Leads | Size |
   |---|---|
   | 3,906 | 16 MB |
   | ~9,600 | 41 MB |
   | 50,000 | 210 MB |

   Fix with a paginated MySQL query on spec 2's tables, which also fixes marks.
   Splitting per vertical is the fallback.
5. `./p status` checks the deck: service active, 401 without auth.

### Done when

- `https://leads.themaverick.tech` prompts for the password, and `/data/…`
  returns 401 without it.
- The deck loads a real vertical in under 2 s on a phone.

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
Spec 2's prospector user already follows its conventions.

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
- **IAM database authentication is rejected** (memory; see spec 2).
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

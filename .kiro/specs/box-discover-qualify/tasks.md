# Tasks — prospector box: discover + qualify, Lambda staged

- [x] 1. Repo prep (R1.3)
  - [x] 1.1 `npm install`, then pin `@aws-sdk/client-s3`, `@aws-sdk/client-lambda`
        and `sharp` to exact versions; commit `package-lock.json`. Check that `npm ci` passes.
  - [x] 1.2 Dockerfile.capture: base image by digest, `npm ci --omit=dev`,
        pinned `aws-lambda-ric`, `ENV HOME=/tmp`. Resolve design open items 1–2.
        Open items resolved: `--ignore-scripts` (sharp needs no lifecycle
        script, verified locally); aws-lambda-ric needs build-essential/cmake/
        autoconf/libtool/libcurl4-openssl-dev, installed and purged in one
        layer. `docker buildx build --platform linux/arm64` run locally end to
        end, all 7 layers, no errors (~21 min, QEMU-emulated on x86).
  - [x] 1.3 Add `CONTROL_PASSWORD=` to `.env.example`. Check that `.env` is still gitignored.
  - [x] 1.4 Run the offline checks (extract --no-probe, score, report — CLAUDE.md's
        "Verifying a change offline"). All pass unchanged.

- [x] 2. Places backup (R5.3, R5.4)
  - [x] 2.1 Make `postSearch` persist raw bodies to `data/<vertical>/places-raw/<sha>.json`,
        with the same sha as `placesRawKey`. Plumb the vertical into `search()`.
  - [x] 2.2 Add `scripts/backup-places.js` with an ETag skip. It is a no-op without `CAPTURE_BUCKET`.
  - [ ] 2.3 Check against the smoke tree: run backup twice and confirm no second PUT.
        No-op-without-bucket path verified; the ETag-skip path itself needs a
        real bucket (task 4), so it can only be checked once task 7 runs.

- [x] 3. Control (R6.1)
  - [x] 3.1 Add `captureMode: 'none'` to the pipeline route (discover → qualify → backup).
  - [x] 3.2 Add a "Discover + qualify" button in `ui.html`.

- [x] 4. Terraform (R7, R8, R5.1)
  - [x] 4.1 `versions.tf`: exact versions; `allowed_account_ids`.
  - [x] 4.2 `persist/`: capture bucket (versioned, public access blocked, no lifecycle),
        deploy bucket (30-day `releases/` expiry), ECR (IMMUTABLE), data volume
        (gp3, `ap-south-1a`), `/prospector/capture-image-tag` = `none`.
  - [x] 4.3 `stack/` network: VPC `10.43.0.0/16`, public subnet in `ap-south-1a`, IGW, SG 80/443.
  - [x] 4.4 `stack/` box: Ubuntu 24.04 arm64 AMI data source, t4g.small,
        `cpu_credits = "standard"`, 20 GB gp3 root, IMDSv2 required, EIP, volume attachment,
        role (SSM core, `/prospector/*` read, deploy-bucket read, bucket `*/places*` put,
        ECR push), user-data.
  - [x] 4.5 `stack/` Lambda: execution role, function (`count` on the tag), invoke config
        with SQS on-failure, log group.
  - [x] 4.6 `stack/` `prospector-deploy` user and policy.
  - [x] 4.7 `terraform validate` and `fmt -check` on both roots; commit both lockfiles.
        Neither root has been applied — no AWS resources exist yet.

- [x] 5. Box (R2.3, R3.3, R4, R5.1, R5.2)
  - [x] 5.1 `deploy/versions.env`, `install.sh`, `load-env.sh`.
  - [x] 5.2 `prospector-control.service`, `prospector-backup.service` and `.timer`,
        Caddyfile, Caddy drop-in.
  - [x] 5.3 `shellcheck` all scripts (via `npx shellcheck`, none installed
        system-wide) — clean but for two style/info nits left as-is (a `sed`
        indent shellcheck would rather see as parameter expansion; `ls` over
        `find` for release pruning, safe since names are always git shas).
        `.gitattributes eol=lf` added for `*.sh`/`*.service`/`*.timer`/`*.conf`/
        `Caddyfile`/`deploy/versions.env`.

- [x] 6. `./p` (R1, R2, R3, R8)
  - [x] 6.1 Credential loading with the account check; state bucket bootstrap.
  - [x] 6.2 `secrets`, `up`, `ship`, `status`, `logs`, `down`, following the design.
  - [x] 6.3 `status` covers: SSM ping, service active, local health check, DNS vs EIP,
        HTTPS 401 without auth, function image tag, failure-queue depth.
        `bash -n` and shellcheck pass; never run against a real box.

- [ ] 7. First real run: operator plus agent (Done when 1–6)
  - [ ] 7.1 Operator: rogue root CSV outside the repo; fill `.env`.
  - [ ] 7.2 `./p up`. Operator adds the Netlify A record for `prospect`.
  - [ ] 7.3 Check Done-when items 2–6. Run `./p up` a second time and confirm a no-op plan.
  - [ ] 7.4 Operator deletes the root keys. Confirm `./p ship` still works.
  - [ ] 7.5 Update `docs/DEPLOYMENT.md` and `docs/STATUS.md`, and replace `docs/HANDOFF.md`.

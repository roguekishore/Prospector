# Design — prospector box: discover + qualify, Lambda staged

## Layout

```
p                                the one command (bash)
.env.example                     + CONTROL_PASSWORD
terraform/
  versions.tf                    exact terraform + aws provider versions
  persist/                       state key: persist.tfstate — never destroyed
    bucket, deploy bucket, ECR, data EBS volume, image-tag SSM param
  stack/                         state key: stack.tfstate — ./p down destroys this
    network, box (EIP, SG, role, instance, volume attachment),
    capture Lambda, SQS failure destination, log group, prospector-deploy user
deploy/
  install.sh                     the only install path (user-data and ship)
  versions.env                   NODE_VERSION, NODE_SHA256, CADDY_VERSION
  Caddyfile
  prospector-control.service
  prospector-backup.service / .timer
scripts/backup-places.js         uploads places artifacts, skip-if-unchanged
```

Two roots instead of `prevent_destroy`: `prevent_destroy` makes `./p down`
error out rather than skip. The EBS volume and the instance share one pinned AZ
(`ap-south-1a`).

Names: `prospector-captures-700897991126`, `prospector-deploy-700897991126`
(30-day expiry on `releases/`), `prospector-tfstate-700897991126`.

## Auth

`./p` unsets `AWS_PROFILE`/`AWS_DEFAULT_PROFILE` (`default` is SSO into a
forbidden account, same reason as warden's `rogue-creds.sh`) and exports keys
from a CSV:

- admin: `${PROSPECTOR_ROOT_CSV:-~/Downloads/rogue.csv}` for `up`, `down`
- deploy: `${PROSPECTOR_DEPLOY_CSV:-~/.prospector/deploy.csv}` for everything else

Every command checks `sts get-caller-identity` equals 700897991126. The
provider also sets `allowed_account_ids = ["700897991126"]`.

`prospector-deploy` is created by Terraform; its access key is created by
`./p up` with the CLI (so the secret never enters state) and written to
`~/.prospector/deploy.csv` if absent. Policy: `s3:PutObject` on
`deploy-bucket/releases/*`; `ssm:SendCommand` on the instance and
`AWS-RunShellScript`; `ssm:GetCommandInvocation`, `DescribeInstanceInformation`;
`ssm:PutParameter`/`GetParameter` on `/prospector/*`; `lambda:UpdateFunctionCode`
and `GetFunction` on the function; `ecr:DescribeImages` on the repo.

Later infra changes need admin keys again — the operator reissues them or a
later spec adds an admin role.

## State backend

`./p` creates the state bucket with the CLI if missing (versioned, public access
blocked), then `terraform init -backend-config=…`. S3 backend with
`use_lockfile = true`; no DynamoDB.

## Image tag without drift

The source of truth for the capture image is SSM `/prospector/capture-image-tag`
(String), created in `persist` with value `none` and `ignore_changes = [insecure_value]`.
`stack` reads it with `data "aws_ssm_parameter"`, creates the function only
when it is not `none` (`count`), and sets `image_uri = <repo>:<tag>`.

`./p ship` writes the parameter and calls `update-function-code` when the
function exists. The next `terraform apply` reads the same value, so there is
no drift and no `ignore_changes` on the function. ECR tags are IMMUTABLE; if
the sha is already in ECR the box skips the build.

## `./p up`

1. Admin creds. Ensure state bucket.
2. `terraform apply` persist, then stack. First run: no function yet.
3. `./p secrets`.
4. Create the deploy access key if the CSV is missing.
5. Wait for the instance to be SSM `Online`.
6. `./p ship`.
7. `terraform apply` stack again — creates the function on the first run, no-op after.
8. Print the EIP and the one Netlify record to add. Poll DNS for up to 10
   minutes; when `prospect.themaverick.tech` resolves to the EIP, send
   `install.sh --enable-caddy`. If it times out, say so; the next
   `./p ship` enables Caddy once DNS resolves.

## `./p ship`

1. Refuse a dirty tree. `sha=$(git rev-parse HEAD)`.
2. `git archive --format=tar sha | gzip -n` plus `.sha256` →
   `s3://deploy-bucket/releases/<sha>.tar.gz`.
3. SSM `send-command`: `install.sh <sha>`. Poll to completion; print output;
   non-zero exit on failure.
4. Write `/prospector/capture-image-tag = sha`; `update-function-code` if the
   function exists.

## `install.sh <sha>` (idempotent, runs as root)

1. First run only: mount the data volume at `/var/lib/prospector`
   (`mkfs.ext4` only if blank, `fstab` by UUID); apt `docker.io
   build-essential python3 unzip awscli`; Node from the pinned nodejs.org
   tarball, checked against `NODE_SHA256`; Caddy pinned from its apt repo;
   create the `prospector` user; 2 GB swapfile.
2. Download the release and check sha256; unpack to `/opt/prospector/releases/<sha>`.
3. `npm ci --omit=dev` with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` (no local
   capture in this spec).
4. Persistent paths: `data/` → `/var/lib/prospector/data`;
   `config/verticals.json` → `/var/lib/prospector/config/verticals.json`,
   seeded from the release only if absent (the panel writes it atomically at
   `src/control/verticals.js:33`). A repo change to `verticals.json` after the
   first install does not propagate; that is the trade for R5.2.
5. Flip `/opt/prospector/current`, restart `prospector-control`, then check
   `127.0.0.1:7778/` returns 200. On failure, flip back and exit non-zero.
   Keep 3 releases.
6. If the tag is not in ECR: `docker build --platform linux/arm64 -f
   Dockerfile.capture`, tag `<repo>:<sha>`, push. Prune images.
7. With `--enable-caddy` or DNS resolving: install the Caddyfile, `caddy
   validate`, reload.

User-data is only: install the AWS CLI, fetch `install.sh` from the latest
release named in SSM `/prospector/release`, run it. `./p ship` writes that
parameter.

## Secrets

`.env` → SSM SecureString: `/prospector/google-places-key`,
`/prospector/brave-key` (optional), `/prospector/control-password`.

`prospector-control.service` has `ExecStartPre=+/opt/prospector/current/deploy/load-env.sh`,
which writes `/run/prospector/env` (tmpfs, 0600, owned by the service user)
from `get-parameters-by-path`; `EnvironmentFile=/run/prospector/env`. Child
processes spawned by the runner inherit `GOOGLE_PLACES_KEY`.

Caddy: `install.sh` runs `caddy hash-password` on the SSM value and writes
`/etc/caddy/auth.env` (0600); a Caddy systemd drop-in loads it and the
Caddyfile uses `{$CONTROL_AUTH_HASH}`. Cert storage is
`/var/lib/prospector/caddy` (`storage file_system`).

## Caddyfile

```
{
    storage file_system /var/lib/prospector/caddy
}
prospect.themaverick.tech {
    basic_auth {
        operator {$CONTROL_AUTH_HASH}
    }
    reverse_proxy 127.0.0.1:7778
}
```

No CSP, no buffering settings (Caddy flushes `text/event-stream`).

## Places backup

discover does not keep raw response bodies today (`src/discover/places.js:60`
`postSearch` parses and drops them). Change: `postSearch` also writes the raw
body to `data/<vertical>/places-raw/<sha>.json`, where `sha` comes from the
same descriptor as `placesRawKey()` (request body plus page token). That
needs the vertical plumbed into `search()`.

`scripts/backup-places.js` walks each vertical's `discovered.json`,
`qualified.json` and `places-raw/*`, computes the local MD5, and `HeadObject`s
the key built by `placesKey`/`placesRawKey` from `src/capture/s3.js`. It skips
if the ETag matches (single-part PUT with SSE-S3 means ETag = MD5), otherwise
`putJson`. It runs:
- as the final step of every control pipeline;
- from `prospector-backup.timer` every 15 minutes, which retries anything a
  failed upload missed.

A failed upload logs and exits non-zero, but discover and qualify never fail
because of backup.

## Control change

`POST /api/pipeline/start` accepts `captureMode: 'none'`, which gives steps
discover → qualify → backup (`src/control/index.js`, pipeline route). The UI
gets a "Discover + qualify" button that sends it.

## Capture Lambda (staged)

- **Function:** `prospector-capture`, `package_type = Image`,
  `architectures = ["arm64"]`, 2048 MB, 900 s, no VPC, env
  `CAPTURE_BUCKET`, no reserved concurrency.
- **Failure handling:** `aws_lambda_function_event_invoke_config` with
  `maximum_retry_attempts = 2` and on-failure destination SQS
  `prospector-capture-failed` (14-day retention).
- **Log group:** `/aws/lambda/prospector-capture`, 14-day retention.
- **Execution role:** `s3:PutObject` on `bucket/*/captures/*`, logs,
  `sqs:SendMessage` to the failure queue.
- **Dockerfile.capture:**
  - base image pinned by digest;
  - `npm ci --omit=dev` against the committed lock, replacing `npm pkg delete`
    plus `npm install` (for better-sqlite3, see open question 2);
  - `aws-lambda-ric@<exact>`;
  - `ENV HOME=/tmp`.

## Open, verify at implementation

1. Whether `aws-lambda-ric` builds on the Playwright noble image without
   cmake, autoconf or libtool. Check the first build log; add the apt packages
   if needed.
2. The `npm ci` path for dropping better-sqlite3 from the image. Options:
   `--ignore-scripts` so it is installed but never built, which is safe
   because the capture path never loads it; or keep it, since prebuilt
   linux-arm64 binaries likely exist. Pick whichever builds cleanly.
3. Whether Ubuntu 24.04's `docker.io` has buildx for `--platform`. The build
   is native arm64, so the flag can be dropped if not.

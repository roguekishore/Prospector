# Requirements — prospector box: discover + qualify, Lambda staged

## Scope

Run `discover` and `qualify` on a prospector box in rogue (700897991126,
ap-south-1), controlled from a phone over HTTPS, with the capture Lambda
provisioned but not yet run. One command builds it from nothing.

Out of scope, each its own later spec: MySQL (peering, prospector user,
`ingest`), local disk layout matching S3, running capture (Lambda or local),
the `leads` deck, mavdb security, the warden `capture` tile, the `error.json`
and link-classification bugs.

## Requirements

**R1 — One command, reproducible.**
- R1.1 `./p up` on a clean rogue account produces the working system with no
  console steps other than the Netlify A record.
- R1.2 Running `./p up` twice in a row changes nothing the second time.
- R1.3 Every version that affects a build is pinned: npm deps (exact, with a
  committed lockfile), Docker base image (by digest), Terraform and providers
  (exact, lockfile committed), Node and Caddy on the box.
- R1.4 The laptop needs only bash, terraform, aws CLI and git.

**R2 — What runs on the box is an exact commit.**
- R2.1 `./p ship` refuses a dirty working tree.
- R2.2 The box never talks to GitHub. Code arrives as a `git archive` of one
  sha via S3, checked by sha256.
- R2.3 First boot and `./p ship` run the same install script.

**R3 — Secrets never in git or Terraform state.**
- R3.1 The operator writes secrets once into a gitignored `.env`.
- R3.2 `./p secrets` (also run by `./p up`) copies them to SSM Parameter Store
  under `/prospector/` as SecureString.
- R3.3 The box reads them at service start. A rebuilt box needs nothing copied.

**R4 — Access.**
- R4.1 Control is served only at `https://prospect.themaverick.tech`, behind
  Caddy `basic_auth`. `CONTROL_TOKEN` stays unset, so control binds 127.0.0.1.
- R4.2 Security group: 80 and 443 only. No port 22; shell via Session Manager.
- R4.3 No CSP header (inline script in `ui.html`).

**R5 — Data survives.**
- R5.1 `data/` and Caddy's cert storage live on a separate EBS volume that
  survives instance replacement and `./p down`.
- R5.2 Verticals added from the panel survive `./p ship`.
- R5.3 `discovered.json`, `qualified.json` and every raw Places response body
  are backed up to the capture bucket at the FIXED S3 keys
  (`<city>/places/<vertical>/…`, `<city>/places-raw/<vertical>/<sha>.json`).
- R5.4 Backup never creates a new S3 version for unchanged bytes.

**R6 — Control panel runs discover + qualify.**
- R6.1 A "discover + qualify" pipeline for one vertical, without a capture step.

**R7 — Lambda staged.**
- R7.1 ECR repo, capture function (arm64, 2048 MB, 900 s, no VPC,
  `CAPTURE_BUCKET` set), SQS on-failure destination and log group exist.
- R7.2 The image is built on the box (arm64) and tagged with the git sha.
- R7.3 Terraform and the running function never disagree about the image.

**R8 — Least privilege after setup.**
- R8.1 Root keys are used only by `./p up` / `./p down`. `./p ship`, `status`,
  `logs` and `secrets` run under a scoped `prospector-deploy` IAM user, so the
  root keys can be deleted after first setup.

## Done when

1. `./p up` succeeds from nothing and prints the EIP.
2. After the A record resolves, `https://prospect.themaverick.tech` prompts for
   the password, and without it `/api/status` returns 401 from Caddy.
3. A discover + qualify run on one vertical, started from a phone, completes
   and its live log streams.
4. `places/` and `places-raw/` objects for that vertical exist in S3; re-running
   backup leaves version counts unchanged.
5. The Lambda function exists with image `<repo>:<sha of HEAD>`.
6. `./p down`, then `./p up`: the vertical's `data/` is still there.

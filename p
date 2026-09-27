#!/bin/bash
#
# ./p — the one command. box-discover-qualify design.md.
#
#   ./p up        build everything from nothing, print the EIP
#   ./p ship      build web/, push HEAD + the build to the box, restart it (refuses a dirty tree)
#   ./p secrets   copy .env into SSM SecureString
#   ./p status    SSM ping, service state, DNS vs EIP, HTTPS 401, image tag, DLQ depth,
#                 MySQL row counts
#   ./p logs      tail the control service's journal
#   ./p down      destroy stack.tfstate (persist.tfstate is never touched)
#   ./p peer      apply terraform/mavdb — the VPC peering to clasher. Not run by up.
#   ./p db        apply terraform/db — the database, user and grants. Not run by up.
#
# R1.4 — needs only bash, terraform, the aws CLI and git on the laptop.
set -euo pipefail

# Git Bash on Windows silently rewrites any argument that looks like an
# absolute Unix path before exec'ing a native .exe — `/prospector/foo` becomes
# `C:/Program Files/Git/prospector/foo`. Every SSM parameter name here starts
# with `/prospector/`, so without this every aws ssm call sends a mangled name
# and SSM rejects it as "not a fully qualified name". A no-op on every other
# platform.
export MSYS_NO_PATHCONV=1

# The aws CLI is Python, and on Windows it encodes stdout with the console
# codepage (cp1252), so printing anything outside it dies with "'charmap' codec
# can't encode character". install.sh logs an arrow, which was enough to kill
# `ship` *after* a successful install — the box was fine, the CLI just could not
# render its output. Any docker/npm output with box drawing or a dash would do
# the same. A no-op where the locale is already UTF-8.
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ACCOUNT_ID="700897991126"
REGION="ap-south-1"
TFSTATE_BUCKET="prospector-tfstate-700897991126"
DEPLOY_BUCKET="prospector-deploy-700897991126"
ECR_REPO="prospector-capture"
DEPLOY_USER="prospector-deploy"

ROOT_CSV="${PROSPECTOR_ROOT_CSV:-$HOME/Downloads/rogue.csv}"
DEPLOY_CSV="${PROSPECTOR_DEPLOY_CSV:-$HOME/.prospector/deploy.csv}"
# mavdb lives in a second account. Its root key is read at run time, checked
# against the account id, handed to one Terraform process as a variable, and
# never written to disk, SSM or state (R1.6).
CLASHER_CSV="${PROSPECTOR_CLASHER_CSV:-$HOME/Downloads/clasher.csv}"
CLASHER_ACCOUNT_ID="028972816671"
DECK_HOST="leads.themaverick.tech"
CONTROL_HOST="prospect.themaverick.tech"

log() { echo "[p] $*" >&2; }
die() { echo "[p] ERROR: $*" >&2; exit 1; }

need_bin() {
  for b in "$@"; do
    command -v "$b" >/dev/null 2>&1 || die "missing required binary: $b"
  done
}

# ---------------------------------------------------------------------------
# Credentials — design.md "Auth". Two CSVs, never a profile: `default` is SSO
# into a different, forbidden account, same reason warden's rogue-creds.sh
# unsets it. `allowed_account_ids` in versions.tf is the second layer; this is
# the first.
# ---------------------------------------------------------------------------
_csv_field() {
  local file="$1" want="$2"
  # A CSV saved by Windows tools (Excel, the IAM console's own download on this
  # box) commonly leads with a UTF-8 BOM on the header line — strip it before
  # matching, or the first column's header never equals anything.
  sed '1s/^\xef\xbb\xbf//' "$file" | awk -F',' -v want="$want" '
    NR==1 {
      for (i=1;i<=NF;i++) { gsub(/^"|"$|\r/,"",$i); if (tolower($i)==tolower(want)) col=i }
      next
    }
    NR==2 && col { gsub(/^"|"$|\r/,"",$col); print $col; exit }
  '
}

load_creds_from_csv() {
  local csv="$1"
  [ -f "$csv" ] || die "credentials CSV not found: $csv"
  unset AWS_PROFILE AWS_DEFAULT_PROFILE
  AWS_ACCESS_KEY_ID="$(_csv_field "$csv" 'Access key ID')"
  AWS_SECRET_ACCESS_KEY="$(_csv_field "$csv" 'Secret access key')"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
  [ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ] \
    || die "could not parse an access key out of $csv"
}

verify_account() {
  local got
  got="$(aws sts get-caller-identity --query Account --output text 2>&1)" \
    || die "sts get-caller-identity failed: $got"
  [ "$got" = "$ACCOUNT_ID" ] \
    || die "sts get-caller-identity returned account $got, expected $ACCOUNT_ID — refusing to proceed"
}

load_admin_creds()  { load_creds_from_csv "$ROOT_CSV";   verify_account; log "admin creds ok ($ACCOUNT_ID)"; }
load_deploy_creds() { load_creds_from_csv "$DEPLOY_CSV"; verify_account; log "deploy creds ok ($ACCOUNT_ID)"; }

# ---------------------------------------------------------------------------
# Terraform
# ---------------------------------------------------------------------------
terraform_apply() {
  ( cd "$HERE/terraform/$1" && terraform init -input=false && terraform apply -auto-approve )
}

# Same, but the operator sees the plan and types yes. Used for the two roots that
# reach outside this stack — a peering accepter and a route in another account,
# and the database's user and grants — where "apply and find out" is not an
# acceptable failure mode.
terraform_apply_reviewed() {
  local root="$1" answer
  ( cd "$HERE/terraform/$root" && terraform init -input=false && terraform plan -out=tfplan )
  echo
  read -r -p "[p] apply the plan above to terraform/$root? type yes: " answer
  [ "$answer" = "yes" ] || { rm -f "$HERE/terraform/$root/tfplan"; die "not applied"; }
  ( cd "$HERE/terraform/$root" && terraform apply tfplan && rm -f tfplan )
}

# `cd` + a relative path, never `-chdir=$HERE/...`: MSYS_NO_PATHCONV=1 (set at
# the top, so SSM names like /prospector/x reach aws.exe intact) also stops Git
# Bash rewriting /d/PROJECTS/... into D:/PROJECTS/... for native .exes, and
# terraform.exe cannot resolve a Unix path. Stderr is deliberately *not*
# swallowed: hiding it here turned this exact bug into a silent empty string.
tf_output() {
  ( cd "$HERE/terraform/$1" && terraform output -raw "$2" ) || true
}

# Everything after `apply` reads the box's identity from SSM, not from state:
# `ship` and `status` run under the scoped deploy user, which cannot read the
# state bucket (see terraform/stack/params.tf). Terraform writes both parameters,
# so they track the stack exactly, and `down` removes them along with it — an
# empty answer means there is no stack, which is what the callers check for.
ssm_get() {
  aws ssm get-parameter --name "/prospector/$1" \
    --query Parameter.Value --output text --region "$REGION" 2>/dev/null || true
}

# Build the --cli-input-json for an AWS-RunShellScript send-command out of one
# shell command per argument.
#
# The alternative is `--parameters 'commands=[...]'`, whose shorthand syntax has
# its own quoting rules layered under the shell's: a command containing a double
# quote, a bracket or a comma has to be escaped twice, and getting it wrong does
# not fail — it silently sends a different command. Node is already required
# here, and JSON.stringify knows exactly one set of rules.
_ssm_commands_json() {
  node -e '
    const commands = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      DocumentName: "AWS-RunShellScript",
      Parameters:   { commands },
    }));
  ' "$@"
}

# Print every A record for a name, one IPv4 per line, empty if it doesn't
# resolve. Not `getent`: that's a glibc NSS tool and Git Bash on Windows ships
# no such binary, so the DNS checks below found nothing forever — Caddy could
# never have been enabled here, no matter what the record said. nslookup is the
# one resolver present on all three platforms, but it prints the *server's* own
# address first, so only lines after "Name:" are real answers.
resolve_a() {
  local name="$1"
  if command -v getent >/dev/null 2>&1; then
    getent ahostsv4 "$name" 2>/dev/null | awk '{print $1}'
  elif command -v dig >/dev/null 2>&1; then
    dig +short A "$name" 2>/dev/null
  else
    nslookup -type=A "$name" 2>/dev/null | tr -d '\r' | awk '
      /^Name:/ { f = 1 }
      f && /^(Address|Addresses):/ { sub(/^[^:]*:[[:space:]]*/, ""); print }
      f && /^[[:space:]]+[0-9]+\./  { gsub(/[[:space:]]/, ""); print }
    '
  fi | grep -E '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' | sort -u || true
}

# The null device to hand a *native* binary. MSYS_NO_PATHCONV=1 (above) stops Git
# Bash translating /dev/null into NUL, so curl.exe tries to create a file named
# literally "/dev/null", fails, and exits non-zero *after* printing its result —
# which appended a spurious "?" to every status code this script reported.
NULL_DEV=/dev/null
[ -n "${WINDIR:-}" ] && NULL_DEV=NUL

# ---------------------------------------------------------------------------
# doctor — preflight, run first by `up`.
#
# Every check here needs no AWS account and no box, because the expensive
# mistakes on this project were not AWS mistakes: they were this laptop not being
# the Linux machine the script was written as though it were. `terraform
# validate`, `shellcheck` and `bash -n` all passed on every one of them. If you
# add a check, it belongs here only if it can fail on a machine with no
# credentials.
# ---------------------------------------------------------------------------
DOCTOR_FAILED=0
_dok()   { printf '  ok    %s\n' "$*"; }
_dfail() { printf '  FAIL  %s\n' "$*" >&2; DOCTOR_FAILED=1; }
# A warning is for something this machine may legitimately not need: a laptop
# that only ships does not need the root CSV, and one that never peers does not
# need clasher's. It must not set DOCTOR_FAILED, or `./p up` stops for it.
_dwarn() { printf '  warn  %s\n' "$*"; }

cmd_doctor() {
  echo "[p] doctor — checking this machine before it touches AWS"

  local b
  for b in git terraform aws curl node npm tar; do
    if command -v "$b" >/dev/null 2>&1; then _dok "$b present"
    else _dfail "$b is not on PATH (R1.4 needs all of them; npm and tar build and pack web/ for ship)"; fi
  done

  # Only `./p db` needs it, which is why this warns rather than fails: a laptop
  # that will never apply the database root is not broken for lacking it.
  if command -v session-manager-plugin >/dev/null 2>&1; then
    _dok "session-manager-plugin present (./p db needs it)"
  else
    _dwarn 'session-manager-plugin is not on PATH — ./p db cannot open its tunnel'
    printf '        see docs/COMMANDS.md for where to get it\n'
  fi

  # `resolve_a` is the reason this one exists: the original code called `getent`,
  # which Git Bash does not ship, so DNS silently never matched and Caddy could
  # never be enabled from here.
  local addrs
  addrs="$(resolve_a amazonaws.com | head -n3 | tr '\n' ' ')"
  if [ -n "$addrs" ]; then _dok "DNS resolves (amazonaws.com -> ${addrs% })"
  else _dfail "resolve_a returned nothing — no working getent, dig or nslookup"; fi

  # Absolute paths must reach a native .exe unmangled, or every /prospector/*
  # SSM name arrives as C:/Program Files/Git/prospector/* and SSM rejects it.
  # The aws CLI checks a local path before it needs credentials, and echoes it
  # back, which makes it a probe that works offline. Matching on the "path "
  # prefix matters: a mangled path still *contains* the original as a substring.
  local probe out
  probe="/prospector/__doctor_probe"
  out="$(aws s3 cp "$probe" s3://prospector-doctor-probe/x 2>&1 || true)"
  case "$out" in
    *"path $probe does not exist"*) _dok "absolute paths reach native binaries intact" ;;
    *) _dfail "a native binary received a rewritten path — MSYS_NO_PATHCONV is not taking effect. aws said: $out" ;;
  esac

  # The aws CLI is Python and on Windows encodes stdout with the console
  # codepage, so one arrow in a log line killed `ship` after a successful install.
  out="$(aws s3 cp "arrow-$(printf '\342\206\222')-end" s3://prospector-doctor-probe/x 2>&1 || true)"
  case "$out" in
    *'\u2192'*) _dfail "the aws CLI cannot print non-ASCII (got an escape) — check PYTHONIOENCODING/PYTHONUTF8" ;;
    *"arrow-$(printf '\342\206\222')-end"*) _dok "the aws CLI prints non-ASCII" ;;
    *) _dfail "could not tell whether the aws CLI handles non-ASCII. It said: $out" ;;
  esac

  # curl must be able to throw a body away; see NULL_DEV above.
  # 7 (connection refused) is the expected answer and must not abort the run;
  # 23 is "failed writing body", which is the failure being tested for.
  local rc=0
  curl -s -o "$NULL_DEV" -w '' --max-time 5 http://127.0.0.1:1/ >/dev/null 2>&1 || rc=$?
  if [ "$rc" = 23 ]; then _dfail "curl cannot write to $NULL_DEV — status codes get a spurious suffix"
  else _dok "curl can discard a body ($NULL_DEV)"; fi

  # .env last, and by key name only — never echo a secret.
  if [ -f "$HERE/.env" ]; then
    local k missing=""
    # MAVERICK_DB_PASSWORD is deliberately not required: only `./p db` reads it,
    # and it should not be on a laptop that is not applying the database root.
    for k in GOOGLE_PLACES_KEY CONTROL_PASSWORD DECK_PASSWORD; do
      [ -n "$(_dotenv_get "$k")" ] || missing="$missing $k"
    done
    if [ -z "$missing" ]; then _dok ".env parses and has the required keys"
    else _dfail ".env is missing or empty for:$missing (if the file looks right, check it is UTF-8, not UTF-16)"; fi
  else
    _dfail ".env not found — copy .env.example and fill it in"
  fi

  # The credential CSVs, by presence only — never parsed, never echoed. Every
  # AWS command here dies without one, and the message it dies with looks like a
  # credential problem rather than a missing file, so say it up front. Needs no
  # AWS access, which is what keeps this doctor-shaped.
  _dcsv() {
    local label="$1" file="$2" why="$3"
    if [ -f "$file" ]; then _dok "$label credentials present ($file)"
    else _dwarn "$label credentials not found at $file — $why"; fi
  }
  _dcsv root    "$ROOT_CSV"    "./p up, peer and db cannot authenticate"
  _dcsv deploy  "$DEPLOY_CSV"  "./p ship and status cannot authenticate (./p up writes it)"
  _dcsv clasher "$CLASHER_CSV" "./p peer cannot reach the other account"

  if [ "$DOCTOR_FAILED" != 0 ]; then
    die "doctor found problems above — fix them before deploying"
  fi
  log "doctor: all checks passed"
}

ensure_state_bucket() {
  if aws s3api head-bucket --bucket "$TFSTATE_BUCKET" --region "$REGION" 2>/dev/null; then
    return 0
  fi
  log "creating state bucket $TFSTATE_BUCKET"
  aws s3api create-bucket --bucket "$TFSTATE_BUCKET" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
  aws s3api put-bucket-versioning --bucket "$TFSTATE_BUCKET" \
    --versioning-configuration Status=Enabled
  aws s3api put-public-access-block --bucket "$TFSTATE_BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
}

# ---------------------------------------------------------------------------
# secrets — .env -> SSM SecureString (R3.2)
#
# Named keys, never a loop over the file. `load-env.sh` turns every parameter
# under /prospector/ into an environment variable on the box, so a DATABASE_URL
# that reached SSM would silently override the box's verified-TLS connection
# with whatever it pointed at (src/db/mysql.js). MAVERICK_DB_PASSWORD is not
# here for the same reason: only `./p db` ever needs it, and only in memory.
# ---------------------------------------------------------------------------
# Windows tools (PowerShell's default redirect/Set-Content, some editors) save
# UTF-16LE with a BOM rather than UTF-8 — src/cli/index.js already carries a
# workaround for this exact thing when the app loads .env itself. Plain
# grep/sed here would see every other byte as \0 and match nothing, which is
# indistinguishable from the key being genuinely absent. Normalize once to
# UTF-8 before any key lookup.
_dotenv_utf8() {
  local file="$HERE/.env"
  [ -f "$file" ] || return 1
  if [ "$(head -c2 "$file" | od -An -tx1 | tr -d ' \n')" = "fffe" ]; then
    iconv -f UTF-16LE -t UTF-8 "$file"
  else
    cat "$file"
  fi | sed '1s/^\xef\xbb\xbf//'
}

_dotenv_get() {
  local key="$1"
  # `|| true` at the end: a key that's simply absent (BRAVE_KEY, commonly)
  # makes grep match nothing and exit 1, which under this script's
  # `set -o pipefail` would otherwise kill the whole run right here with no
  # error message at all — silently, mid-`./p up`.
  _dotenv_utf8 2>/dev/null | grep -E "^${key}=" | tail -n1 | sed -E "s/^${key}=//" \
    | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/; s/\r$//' || true
}

cmd_secrets() {
  [ -f "$HERE/.env" ] || die ".env not found — copy .env.example and fill it in"
  local google_key brave_key control_password deck_password
  google_key="$(_dotenv_get GOOGLE_PLACES_KEY)"
  brave_key="$(_dotenv_get BRAVE_KEY)"
  control_password="$(_dotenv_get CONTROL_PASSWORD)"
  deck_password="$(_dotenv_get DECK_PASSWORD)"

  # Every required key is checked before the first put-parameter. `deck_password`
  # was read nowhere and only expanded below, so under `set -u` this aborted
  # *after* writing the first two parameters and before ever writing brave-key —
  # a half-applied secret set, and `/prospector/deck-password` never created,
  # which is the one the leads site block waits on.
  [ -n "$google_key" ]       || die "GOOGLE_PLACES_KEY is empty in .env"
  [ -n "$control_password" ] || die "CONTROL_PASSWORD is empty in .env"
  [ -n "$deck_password" ]    || die "DECK_PASSWORD is empty in .env"

  aws ssm put-parameter --name /prospector/google-places-key --type SecureString \
    --overwrite --region "$REGION" --value "$google_key" >/dev/null
  aws ssm put-parameter --name /prospector/control-password --type SecureString \
    --overwrite --region "$REGION" --value "$control_password" >/dev/null
  # The deck's own credential, separate from control's: control can spend Places
  # quota and start runs, the deck can only be read (R10.1).
  aws ssm put-parameter --name /prospector/deck-password --type SecureString \
    --overwrite --region "$REGION" --value "$deck_password" >/dev/null
  if [ -n "$brave_key" ]; then
    aws ssm put-parameter --name /prospector/brave-key --type SecureString \
      --overwrite --region "$REGION" --value "$brave_key" >/dev/null
  fi
  log "secrets written to SSM"
}

# ---------------------------------------------------------------------------
# ship — R2.1, R2.2
# ---------------------------------------------------------------------------
poll_ssm_command() {
  local instance_id="$1" cmd_id="$2" status
  # 240 x 15s = 60min, matching SSM's own default command timeout. The first
  # install.sh on a fresh box does apt, Node, Caddy, npm ci *and* builds and
  # pushes the arm64 capture image on two t4g.small vCPUs; the old 90 x 5s
  # (7.5min) would have called that a timeout while it was still working.
  for _ in $(seq 1 240); do
    status="$(aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance_id" \
      --region "$REGION" --query 'Status' --output text 2>/dev/null || echo Pending)"
    case "$status" in
      Success)
        aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance_id" \
          --region "$REGION" --query 'StandardOutputContent' --output text
        return 0 ;;
      Failed|Cancelled|TimedOut)
        aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance_id" \
          --region "$REGION" --query 'StandardErrorContent' --output text >&2
        die "install.sh failed on the box (status=$status)" ;;
    esac
    sleep 15
  done
  die "timed out waiting for the SSM command to finish"
}

cmd_ship() {
  need_bin git aws npm
  cd "$HERE"
  [ -z "$(git status --porcelain)" ] || die "refusing to ship a dirty working tree (R2.1)"

  local sha
  sha="$(git rev-parse HEAD)"

  # The two web UIs are built here, never on the box (t4g.small, no toolchain),
  # and never committed: `web/dist/` is gitignored, so the tree stays clean and
  # `git archive` below does not carry it. It is appended to the release tarball
  # instead, and a failed build fails the ship before anything is uploaded.
  # `npm ci` inside web/ is the lockfile install, so the box gets exactly what
  # web/package-lock.json says was tested.
  log "building web/ (npm run web:ci && npm run build:web)"
  npm run web:ci    >/dev/null || die "npm ci inside web/ failed"
  npm run build:web           || die "web build failed — nothing shipped"
  [ -f web/dist/lead/index.html ]     || die "web/dist/lead/index.html missing after build"
  [ -f web/dist/prospect/index.html ] || die "web/dist/prospect/index.html missing after build"
  # Deliberately global, and EXIT rather than RETURN. A RETURN trap is not scoped
  # to the function that installs it: it stays armed and fires again when main
  # returns, where a `local tmp` is gone and `set -u` makes that a fatal "unbound
  # variable" — exit 1 after a completely successful ship, which aborted `./p up`
  # before it could create the Lambda. EXIT fires once, and also cleans up on the
  # die paths below, which RETURN never did.
  SHIP_TMP="$(mktemp -d)"
  trap 'rm -rf "${SHIP_TMP:-}"' EXIT
  local tmp="$SHIP_TMP"

  # git archive over S3, checked by sha256 on the box — the box never talks to
  # GitHub (R2.2). `langfuse/` is `export-ignore` in .gitattributes (540 files
  # of design reference the box has no use for), and the web build output is
  # appended to the archive since it is not in git.
  git archive --format=tar "$sha" > "$tmp/release.tar"
  tar --append -f "$tmp/release.tar" web/dist/lead web/dist/prospect
  gzip -n "$tmp/release.tar"
  sha256sum "$tmp/release.tar.gz" | awk '{print $1}' > "$tmp/release.tar.gz.sha256"

  # Relative names from inside $tmp, for the same reason as tf_output: aws.exe is
  # a native binary and `$tmp` is a Unix path like /tmp/tmp.XXXX, which it reads
  # as a literal and cannot find.
  (
    cd "$tmp"
    aws s3 cp release.tar.gz        "s3://$DEPLOY_BUCKET/releases/$sha.tar.gz"        --region "$REGION" >/dev/null
    aws s3 cp release.tar.gz.sha256 "s3://$DEPLOY_BUCKET/releases/$sha.tar.gz.sha256" --region "$REGION" >/dev/null
  )
  aws ssm put-parameter --name /prospector/release --type String --overwrite \
    --value "$sha" --region "$REGION" >/dev/null

  local instance_id cmd_id
  instance_id="$(ssm_get instance-id)"
  [ -n "$instance_id" ] || die "/prospector/instance-id is unset — run ./p up first"

  log "running install.sh $sha on $instance_id via SSM"
  cmd_id="$(aws ssm send-command \
    --instance-ids "$instance_id" \
    --document-name AWS-RunShellScript \
    --parameters "commands=[\"aws s3 cp s3://$DEPLOY_BUCKET/releases/$sha.tar.gz - --region $REGION | tar -xzO deploy/install.sh > /tmp/install.sh\",\"chmod +x /tmp/install.sh\",\"/tmp/install.sh $sha\"]" \
    --region "$REGION" --query 'Command.CommandId' --output text)"
  poll_ssm_command "$instance_id" "$cmd_id"

  # Image tag without drift (design.md) — write the parameter, then push the
  # function straight at it if it already exists; the next `terraform apply
  # stack` reads the same value either way, so there is never a disagreement.
  aws ssm put-parameter --name /prospector/capture-image-tag --type String --overwrite \
    --value "$sha" --region "$REGION" >/dev/null

  if aws lambda get-function --function-name prospector-capture --region "$REGION" >/dev/null 2>&1; then
    local account_id ecr_url
    account_id="$(aws sts get-caller-identity --query Account --output text)"
    ecr_url="$account_id.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO"
    aws lambda update-function-code --function-name prospector-capture \
      --image-uri "$ecr_url:$sha" --region "$REGION" >/dev/null
    log "updated prospector-capture -> $sha"
  fi

  log "shipped $sha"
}

# ---------------------------------------------------------------------------
# up — R1.1
# ---------------------------------------------------------------------------
wait_for_ssm_online() {
  local instance_id="$1" state
  log "waiting for $instance_id to report Online to SSM"
  for _ in $(seq 1 60); do
    state="$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$instance_id" \
      --query 'InstanceInformationList[0].PingStatus' --output text --region "$REGION" 2>/dev/null || true)"
    [ "$state" = "Online" ] && { log "SSM online"; return 0; }
    sleep 10
  done
  die "instance never reported Online to SSM after 10 minutes"
}

ensure_deploy_key() {
  if [ -f "$DEPLOY_CSV" ]; then
    log "deploy credentials already exist at $DEPLOY_CSV"
    return 0
  fi
  log "creating an access key for $DEPLOY_USER"
  mkdir -p "$(dirname "$DEPLOY_CSV")"
  local key secret
  read -r key secret <<< "$(aws iam create-access-key --user-name "$DEPLOY_USER" \
    --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)"
  printf 'Access key ID,Secret access key\n%s,%s\n' "$key" "$secret" > "$DEPLOY_CSV"
  chmod 600 "$DEPLOY_CSV"
  log "wrote $DEPLOY_CSV"
}

# Two names, polled independently (R10.5). `prospect` is required — nothing else
# in `up` finishes without it — while `leads` is reported and picked up whenever
# it happens to resolve, including by a later `ship`. Coupling them would mean a
# missing deck record kept the control panel off the internet.
wait_for_dns_and_enable_caddy() {
  local eip instance_id
  eip="$(ssm_get eip)"
  log "box is up — EIP $eip"
  log "add Netlify DNS records: $CONTROL_HOST A $eip"
  log "                     and $DECK_HOST A $eip"

  local prospect_up=false leads_up=false
  for _ in $(seq 1 60); do
    # Match against every A record, not just the first: a name mid-migration
    # can answer with both the old host and the new one.
    if [ "$prospect_up" = false ] && resolve_a "$CONTROL_HOST" | grep -qx "$eip"; then
      prospect_up=true
      log "$CONTROL_HOST resolves to the EIP"
    fi
    if [ "$leads_up" = false ] && resolve_a "$DECK_HOST" | grep -qx "$eip"; then
      leads_up=true
      log "$DECK_HOST resolves to the EIP"
    fi
    [ "$prospect_up" = true ] && break
    sleep 10
  done

  if [ "$prospect_up" = false ]; then
    log "$CONTROL_HOST did not resolve within 10 minutes — once it does, run ./p ship again and Caddy enables itself"
    return 0
  fi
  if [ "$leads_up" = false ]; then
    log "$DECK_HOST does not resolve yet — the deck stays off until it does; a later ./p ship picks it up"
  fi

  log "enabling Caddy"
  instance_id="$(ssm_get instance-id)"
  local cmd_id sha
  sha="$(git rev-parse HEAD)"
  cmd_id="$(aws ssm send-command --instance-ids "$instance_id" --document-name AWS-RunShellScript \
    --parameters "commands=[\"/opt/prospector/current/deploy/install.sh $sha --enable-caddy\"]" \
    --region "$REGION" --query 'Command.CommandId' --output text)"
  poll_ssm_command "$instance_id" "$cmd_id"
}

cmd_up() {
  need_bin terraform aws git
  cmd_doctor          # cheap, and catches the class of thing that cost the most
  ensure_state_bucket
  terraform_apply persist
  terraform_apply stack        # first run: no function yet (image tag is "none")

  cmd_secrets                  # still under admin creds — fine, its policy allows either

  ensure_deploy_key
  local instance_id
  instance_id="$(ssm_get instance-id)"
  [ -n "$instance_id" ] || die "stack applied but /prospector/instance-id is unset"
  wait_for_ssm_online "$instance_id"

  ( load_deploy_creds && cmd_ship )   # proves the scoped user is sufficient for ship — R8.1

  terraform_apply stack        # creates the function now that the tag is real; no-op after
  run_migrate "$instance_id"
  wait_for_dns_and_enable_caddy
}

# Apply db/migrations/ on the box, as the service user, with its environment.
# Idempotent — a second run prints "up to date" — so `up` runs it every time
# rather than trying to remember whether it has.
#
# Not a hard failure: `up` on a box whose database root has not been applied yet
# has nothing to migrate against, and that is an ordinary order of operations
# (`./p peer`, then `./p db`, then `./p up`), not a broken deploy.
run_migrate() {
  local instance_id="$1" cmd_id
  log "running migrate on the box"
  # systemd-run rather than `sudo -u prospector env $(cat …)`: the environment
  # file is written by load-env.sh in the format systemd's EnvironmentFile
  # parses, and that is exactly how the services read it. Re-parsing it in a
  # shell would split a value on its first space, which for a generated 40-
  # character password is a bug that shows up once in a while and never
  # reproduces.
  cmd_id="$(aws ssm send-command --instance-ids "$instance_id" --document-name AWS-RunShellScript \
    --parameters 'commands=["/opt/prospector/load-env.sh","systemd-run --wait --collect --pipe --quiet --uid=prospector --gid=prospector --working-directory=/opt/prospector/current --property=EnvironmentFile=-/run/prospector/env /usr/local/bin/node src/cli/index.js migrate"]' \
    --region "$REGION" --query 'Command.CommandId' --output text)"
  # A subshell, because poll_ssm_command dies on a failed command and a missing
  # database is not a reason to abandon a deploy that has otherwise worked.
  if ! ( poll_ssm_command "$instance_id" "$cmd_id" ); then
    log "WARN: migrate did not succeed. If the database root has not been applied yet,"
    log "      run ./p peer then ./p db, and ./p up again."
  fi
}

cmd_down() {
  need_bin terraform aws
  ( cd "$HERE/terraform/stack" && terraform init -input=false && terraform destroy -auto-approve )
  log "stack destroyed. Not touched: persist.tfstate (buckets, ECR, the data volume,"
  log "and now the VPC, subnet, gateway and route table), mavdb.tfstate (the peering)"
  log "and db.tfstate (the database, its user and its grants). The box reconnects to"
  log "mavdb on the next ./p up because the VPC id the peering points at survives."
}

# ---------------------------------------------------------------------------
# peer — terraform/mavdb. Its own root and its own state key, so `./p down` and
# `./p up` never plan, apply or destroy anything in clasher (R1.4).
#
# Two sets of credentials in one process: the rogue root key for the peering
# connection and the route on this side, the clasher root key for the accepter,
# the routes back and the security-group rule. The clasher key goes in as a
# Terraform variable, which means it reaches the provider configuration and
# nothing else — provider configuration is never written to state (R1.6).
# ---------------------------------------------------------------------------
cmd_peer() {
  need_bin terraform aws
  [ -f "$CLASHER_CSV" ] || die "clasher credentials CSV not found: $CLASHER_CSV"

  local key secret got
  key="$(_csv_field "$CLASHER_CSV" 'Access key ID')"
  secret="$(_csv_field "$CLASHER_CSV" 'Secret access key')"
  [ -n "$key" ] && [ -n "$secret" ] || die "could not parse an access key out of $CLASHER_CSV"

  # Checked before Terraform sees them, and with the keys themselves rather than
  # the ambient ones: a CSV for the wrong account would otherwise be discovered
  # by `allowed_account_ids` half way through a plan, after the rogue-side
  # peering connection had already been created.
  got="$(AWS_ACCESS_KEY_ID="$key" AWS_SECRET_ACCESS_KEY="$secret" \
         aws sts get-caller-identity --query Account --output text 2>&1)" \
    || die "sts get-caller-identity with the clasher key failed: $got"
  [ "$got" = "$CLASHER_ACCOUNT_ID" ] \
    || die "the clasher CSV is for account $got, expected $CLASHER_ACCOUNT_ID — refusing to proceed"
  log "clasher creds ok ($CLASHER_ACCOUNT_ID)"

  export TF_VAR_clasher_access_key="$key"
  export TF_VAR_clasher_secret_key="$secret"
  # Unset on every exit path, including the die inside terraform_apply_reviewed.
  trap 'unset TF_VAR_clasher_access_key TF_VAR_clasher_secret_key' EXIT

  terraform_apply_reviewed mavdb

  log "peering applied. From the box: getent hosts \$(./p status | grep mavdb) should be private,"
  log "and nc -zv <that address> 3306 should connect."
}

# ---------------------------------------------------------------------------
# db — terraform/db. The database, its one user, its grants, and the two SSM
# parameters the box reads.
#
# mavdb is not publicly accessible and the laptop is not in either VPC, so the
# MySQL provider cannot reach it directly. The tunnel is an SSM port-forwarding
# session through the box, which *is* peered:
#
#   laptop :13306 --SSM--> box --peering--> mavdb :3306
#
# Encrypted end to end (SSM's own channel, then TLS over the peering), and it
# needs no inbound rule anywhere: the box's SSM agent dials out.
# ---------------------------------------------------------------------------
cmd_db() {
  need_bin terraform aws
  command -v session-manager-plugin >/dev/null 2>&1 \
    || die "session-manager-plugin is not on PATH — ./p doctor says where to get it"

  local instance_id mavdb_address maverick
  instance_id="$(ssm_get instance-id)"
  [ -n "$instance_id" ] || die "/prospector/instance-id is unset — run ./p up first"

  mavdb_address="$(tf_output mavdb mavdb_address)"
  [ -n "$mavdb_address" ] || die "terraform/mavdb has no mavdb_address output — run ./p peer first"

  maverick="$(_dotenv_get MAVERICK_DB_PASSWORD)"
  [ -n "$maverick" ] || die "MAVERICK_DB_PASSWORD is empty in .env (only ./p db needs it)"
  export TF_VAR_maverick_password="$maverick"

  log "opening an SSM port-forward to $mavdb_address:3306 on 127.0.0.1:13306"
  aws ssm start-session \
    --target "$instance_id" \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "host=$mavdb_address,portNumber=3306,localPortNumber=13306" \
    --region "$REGION" >/dev/null &
  SESSION_PID=$!

  # One trap for both: the password must not outlive this command, and a session
  # left running holds a tunnel to the database open for as long as the shell is.
  trap 'unset TF_VAR_maverick_password; kill "${SESSION_PID:-}" 2>/dev/null || true' EXIT

  local ready=false
  for _ in $(seq 1 30); do
    if _port_open 127.0.0.1 13306; then ready=true; break; fi
    sleep 2
  done
  [ "$ready" = true ] || die "127.0.0.1:13306 never accepted a connection (60s)"
  log "tunnel up"

  terraform_apply_reviewed db

  log "database applied. /prospector/db-host and /prospector/db-password are in SSM;"
  log "the next ./p up (or ./p ship + a manual migrate) puts them on the box."
}

# Can something connect to this port? Node is already a hard dependency of the
# repo and is the one TCP prober present on all three platforms — `nc` is absent
# from Git Bash, and bash's /dev/tcp is a bashism this script cannot rely on
# reaching a native resolver correctly on Windows.
_port_open() {
  node -e '
    const net = require("net");
    const s = net.connect(Number(process.argv[2]), process.argv[1]);
    s.on("connect", () => { s.destroy(); process.exit(0); });
    s.on("error",   () => process.exit(1));
    s.setTimeout(2000, () => { s.destroy(); process.exit(1); });
  ' "$1" "$2" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# status — task 6.3
# ---------------------------------------------------------------------------
cmd_status() {
  local instance_id eip
  instance_id="$(ssm_get instance-id)"
  eip="$(ssm_get eip)"
  [ -n "$instance_id" ] || die "/prospector/instance-id is unset — run ./p up first"

  echo "instance:         $instance_id"

  local ping
  ping="$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$instance_id" \
    --query 'InstanceInformationList[0].PingStatus' --output text --region "$REGION" 2>/dev/null || echo unknown)"
  echo "ssm ping:         $ping"

  if [ "$ping" = "Online" ]; then
    # One command, so one round trip: both services, both local health checks,
    # and the row counts read as the `prospector` user — which is also the proof
    # that the peering, the grants and the TLS verification all still work.
    #
    # MYSQL_PWD, never -p"$password": a running process's argument list is
    # world-readable on the box. The document sent to SSM carries the variable
    # name and not its value (single quotes below, expanded on the box), so the
    # password is not in SSM's command history either.
    local cmd_id out sql mysql_cmd
    sql='SELECT IFNULL(status,999) AS status, COUNT(*) AS rows_ FROM companies GROUP BY status ORDER BY 1'
    mysql_cmd="/opt/prospector/load-env.sh && systemd-run --wait --collect --pipe --quiet"
    mysql_cmd="$mysql_cmd --uid=prospector --gid=prospector"
    mysql_cmd="$mysql_cmd --working-directory=/opt/prospector/current"
    mysql_cmd="$mysql_cmd --property=EnvironmentFile=-/run/prospector/env"
    mysql_cmd="$mysql_cmd --setenv=MYSQL_PWD=\$DB_PASSWORD"
    mysql_cmd="$mysql_cmd /usr/bin/mysql --ssl-mode=VERIFY_IDENTITY"
    mysql_cmd="$mysql_cmd --ssl-ca=/opt/prospector/rds-global-bundle.pem"
    mysql_cmd="$mysql_cmd -h \$DB_HOST -u prospector -D prospector -N -B"
    mysql_cmd="$mysql_cmd -e '$sql' 2>&1 || echo 'mysql: unreachable'"

    local services health_control health_deck
    services='for u in prospector-control prospector-serve prospector-ingest.timer; do systemctl is-active $u 2>&1 | sed "s|^|$u: |"; done'
    health_control='curl -s -o /dev/null -w "control health: %{http_code}\n" http://127.0.0.1:7778/ || true'
    health_deck='curl -s -o /dev/null -w "deck health:    %{http_code}\n" http://127.0.0.1:7777/ || true'

    cmd_id="$(aws ssm send-command --instance-ids "$instance_id" --document-name AWS-RunShellScript \
      --cli-input-json "$(_ssm_commands_json "$services" "$health_control" "$health_deck" "$mysql_cmd")" \
      --region "$REGION" --query 'Command.CommandId' --output text 2>/dev/null || true)"
    if [ -n "$cmd_id" ]; then
      sleep 5
      out="$(aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance_id" \
        --region "$REGION" --query 'StandardOutputContent' --output text 2>/dev/null || true)"
      echo "on-box:"
      echo "$out" | sed 's/^/  /'
      echo "  (status 999 = unqualified, -1 no site, 0 pending, 1 captured, -2 failed;"
      echo "   these are rows, and several rows can share one website)"
    fi
  fi

  echo "eip:              ${eip:-unknown}"
  if [ -n "$eip" ]; then
    local dns_ips
    dns_ips="$(resolve_a "$CONTROL_HOST" | tr '\n' ' ' | sed 's/ $//')"
    echo "control dns:      ${dns_ips:-not resolving}"
    if printf '%s\n' "$dns_ips" | tr ' ' '\n' | grep -qx "$eip"; then
      echo "dns matches eip:  yes"
    else
      echo "dns matches eip:  no"
    fi

    local deck_ips
    deck_ips="$(resolve_a "$DECK_HOST" | tr '\n' ' ' | sed 's/ $//')"
    echo "deck dns:         ${deck_ips:-not resolving}"

    local code
    code="$(curl -s -o "$NULL_DEV" -w '%{http_code}' "https://$CONTROL_HOST/api/status" || echo '?')"
    echo "control, no auth: $code (expect 401)"
    code="$(curl -s -o "$NULL_DEV" -w '%{http_code}' "https://$DECK_HOST/" || echo '?')"
    echo "deck, no auth:    $code (expect 401)"
  fi

  local db_host
  db_host="$(ssm_get db-host)"
  echo "mavdb:            ${db_host:-not applied — run ./p peer, then ./p db}"
  local tag
  tag="$(aws ssm get-parameter --name /prospector/capture-image-tag --region "$REGION" \
    --query 'Parameter.Value' --output text 2>/dev/null || echo unknown)"
  echo "image tag:        $tag"

  if aws lambda get-function --function-name prospector-capture --region "$REGION" >/dev/null 2>&1; then
    local fn_image
    fn_image="$(aws lambda get-function --function-name prospector-capture --region "$REGION" \
      --query 'Code.ImageUri' --output text)"
    echo "function image:   $fn_image"
  else
    echo "function:         not staged yet"
  fi

  local queue_url depth
  queue_url="$(aws sqs get-queue-url --queue-name prospector-capture-failed --region "$REGION" \
    --query QueueUrl --output text 2>/dev/null || true)"
  if [ -n "$queue_url" ]; then
    depth="$(aws sqs get-queue-attributes --queue-url "$queue_url" \
      --attribute-names ApproximateNumberOfMessages --region "$REGION" \
      --query 'Attributes.ApproximateNumberOfMessages' --output text 2>/dev/null || echo unknown)"
    echo "failure queue:    $depth message(s)"
  fi
}

cmd_logs() {
  local instance_id cmd_id
  instance_id="$(ssm_get instance-id)"
  [ -n "$instance_id" ] || die "/prospector/instance-id is unset — run ./p up first"
  cmd_id="$(aws ssm send-command --instance-ids "$instance_id" --document-name AWS-RunShellScript \
    --parameters 'commands=["journalctl -u prospector-control -n 200 --no-pager"]' \
    --region "$REGION" --query 'Command.CommandId' --output text)"
  poll_ssm_command "$instance_id" "$cmd_id"
}

# ---------------------------------------------------------------------------
usage() {
  cat <<EOF
usage: ./p <up|ship|secrets|status|logs|down|peer|db|doctor>

  doctor   preflight this machine: binaries, DNS, path handling, encoding, .env
  up       doctor, then terraform apply persist + stack, secrets, ship, migrate,
           enable Caddy. Never runs peer or db.
  ship     build web/, git archive HEAD + web/dist -> S3, install.sh on the box, update the function
  secrets  copy .env into SSM SecureString
  status   SSM ping, service state, DNS vs EIP, HTTPS 401, image tag, DLQ depth,
           MySQL row counts
  logs     tail the control service's journal
  down     destroy stack.tfstate — the box and the Lambda. Never touches
           persist.tfstate (buckets, ECR, the data volume, the network),
           mavdb.tfstate (the peering) or db.tfstate (the database).

  peer     apply terraform/mavdb: the VPC peering to clasher. Needs the clasher
           root CSV. Run once, before db.
  db       apply terraform/db: the database, user, grants and SSM parameters,
           through an SSM tunnel via the box. Needs MAVERICK_DB_PASSWORD in .env.
EOF
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    up)      load_admin_creds;  cmd_up ;;
    down)    load_admin_creds;  cmd_down ;;
    peer)    load_admin_creds;  cmd_peer ;;
    db)      load_admin_creds;  cmd_db ;;
    doctor)  cmd_doctor ;;
    ship)    load_deploy_creds; cmd_ship ;;
    status)  load_deploy_creds; cmd_status ;;
    logs)    load_deploy_creds; cmd_logs ;;
    secrets) load_deploy_creds; cmd_secrets ;;
    *) usage; exit 1 ;;
  esac
}

main "$@"

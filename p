#!/bin/bash
#
# ./p — the one command. box-discover-qualify design.md.
#
#   ./p up        build everything from nothing, print the EIP
#   ./p ship      push HEAD to the box and restart it (refuses a dirty tree)
#   ./p secrets   copy .env into SSM SecureString
#   ./p status    SSM ping, service state, DNS vs EIP, HTTPS 401, image tag, DLQ depth
#   ./p logs      tail the control service's journal
#   ./p down      destroy stack.tfstate (persist.tfstate is never touched)
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

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ACCOUNT_ID="700897991126"
REGION="ap-south-1"
TFSTATE_BUCKET="prospector-tfstate-700897991126"
DEPLOY_BUCKET="prospector-deploy-700897991126"
ECR_REPO="prospector-capture"
DEPLOY_USER="prospector-deploy"

ROOT_CSV="${PROSPECTOR_ROOT_CSV:-$HOME/Downloads/rogue.csv}"
DEPLOY_CSV="${PROSPECTOR_DEPLOY_CSV:-$HOME/.prospector/deploy.csv}"

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
  local google_key brave_key control_password
  google_key="$(_dotenv_get GOOGLE_PLACES_KEY)"
  brave_key="$(_dotenv_get BRAVE_KEY)"
  control_password="$(_dotenv_get CONTROL_PASSWORD)"

  [ -n "$google_key" ]       || die "GOOGLE_PLACES_KEY is empty in .env"
  [ -n "$control_password" ] || die "CONTROL_PASSWORD is empty in .env"

  aws ssm put-parameter --name /prospector/google-places-key --type SecureString \
    --overwrite --region "$REGION" --value "$google_key" >/dev/null
  aws ssm put-parameter --name /prospector/control-password --type SecureString \
    --overwrite --region "$REGION" --value "$control_password" >/dev/null
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
  for _ in $(seq 1 90); do
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
    sleep 5
  done
  die "timed out waiting for the SSM command to finish"
}

cmd_ship() {
  need_bin git aws
  cd "$HERE"
  [ -z "$(git status --porcelain)" ] || die "refusing to ship a dirty working tree (R2.1)"

  local sha tmp
  sha="$(git rev-parse HEAD)"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  # git archive over S3, checked by sha256 on the box — the box never talks to
  # GitHub (R2.2).
  git archive --format=tar "$sha" | gzip -n > "$tmp/release.tar.gz"
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

wait_for_dns_and_enable_caddy() {
  local eip instance_id dns_ip
  eip="$(ssm_get eip)"
  log "box is up — EIP $eip"
  log "add a Netlify DNS record: prospect.themaverick.tech A $eip"

  for _ in $(seq 1 60); do
    # `|| true`: getent legitimately exits non-zero every time the name
    # doesn't resolve yet — that's the expected case on most iterations of
    # this loop, not an error, and under this script's `set -o pipefail` it
    # would otherwise abort the whole run silently on the very first poll.
    dns_ip="$(getent hosts prospect.themaverick.tech 2>/dev/null | awk '{print $1}' | head -n1 || true)"
    if [ "$dns_ip" = "$eip" ]; then
      log "DNS resolved — enabling Caddy"
      instance_id="$(ssm_get instance-id)"
      local cmd_id sha
      sha="$(git rev-parse HEAD)"
      cmd_id="$(aws ssm send-command --instance-ids "$instance_id" --document-name AWS-RunShellScript \
        --parameters "commands=[\"/opt/prospector/current/deploy/install.sh $sha --enable-caddy\"]" \
        --region "$REGION" --query 'Command.CommandId' --output text)"
      poll_ssm_command "$instance_id" "$cmd_id"
      return 0
    fi
    sleep 10
  done
  log "DNS did not resolve within 10 minutes — once it does, run ./p ship again and Caddy enables itself"
}

cmd_up() {
  need_bin terraform aws git
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
  wait_for_dns_and_enable_caddy
}

cmd_down() {
  need_bin terraform aws
  ( cd "$HERE/terraform/stack" && terraform init -input=false && terraform destroy -auto-approve )
  log "stack destroyed. persist.tfstate (buckets, ECR, data volume) was not touched."
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
    local cmd_id out
    cmd_id="$(aws ssm send-command --instance-ids "$instance_id" --document-name AWS-RunShellScript \
      --parameters 'commands=["systemctl is-active prospector-control 2>&1 || true","curl -s -o /dev/null -w \"local health: %{http_code}\n\" http://127.0.0.1:7778/ || true"]' \
      --region "$REGION" --query 'Command.CommandId' --output text 2>/dev/null || true)"
    if [ -n "$cmd_id" ]; then
      sleep 3
      out="$(aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance_id" \
        --region "$REGION" --query 'StandardOutputContent' --output text 2>/dev/null || true)"
      echo "on-box:"
      echo "$out" | sed 's/^/  /'
    fi
  fi

  echo "eip:              ${eip:-unknown}"
  if [ -n "$eip" ]; then
    local dns_ip
    # `|| true`: getent legitimately exits non-zero every time the name
    # doesn't resolve yet — that's the expected case on most iterations of
    # this loop, not an error, and under this script's `set -o pipefail` it
    # would otherwise abort the whole run silently on the very first poll.
    dns_ip="$(getent hosts prospect.themaverick.tech 2>/dev/null | awk '{print $1}' | head -n1 || true)"
    echo "dns resolves to:  ${dns_ip:-not resolving}"
    if [ "$dns_ip" = "$eip" ]; then echo "dns matches eip:  yes"; else echo "dns matches eip:  no"; fi

    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' "https://prospect.themaverick.tech/api/status" || echo '?')"
    echo "https, no auth:   $code (expect 401)"
  fi

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
usage: ./p <up|ship|secrets|status|logs|down>

  up       terraform apply persist + stack, secrets, ship, enable Caddy
  ship     git archive HEAD -> S3, install.sh on the box, update the function
  secrets  copy .env into SSM SecureString
  status   SSM ping, service state, DNS vs EIP, HTTPS 401, image tag, DLQ depth
  logs     tail the control service's journal
  down     destroy stack.tfstate — the box, network, Lambda. Never touches
           persist.tfstate (buckets, ECR, the data volume).
EOF
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    up)      load_admin_creds;  cmd_up ;;
    down)    load_admin_creds;  cmd_down ;;
    ship)    load_deploy_creds; cmd_ship ;;
    status)  load_deploy_creds; cmd_status ;;
    logs)    load_deploy_creds; cmd_logs ;;
    secrets) load_deploy_creds; cmd_secrets ;;
    *) usage; exit 1 ;;
  esac
}

main "$@"

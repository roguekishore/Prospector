#!/bin/bash
#
# deploy/install.sh <sha> [--enable-caddy]
#
# The one install path — first boot (via user-data) and every `./p ship` run
# this exact script (R2.3). Idempotent: safe to run twice in a row for the
# same sha, and safe to run for a new sha on a box that already has an older
# release installed.
#
# Runs as root. Self-sufficient: even when invoked as a bare /tmp/install.sh
# with no sibling files (the bootstrap path — see terraform/stack/user-data.sh.tpl),
# step 2 below downloads and verifies the full release before anything else
# touches it.

set -euo pipefail

SHA="${1:?usage: install.sh <sha> [--enable-caddy]}"
shift
ENABLE_CADDY=false
for arg in "$@"; do
  [ "$arg" = "--enable-caddy" ] && ENABLE_CADDY=true
done

# Fixed names (design.md "Names") — no config file spells these, so none can
# drift from what Terraform actually created. CAPTURE_BUCKET itself is set
# directly in the systemd units (Environment=), not read from here.
DEPLOY_BUCKET="prospector-deploy-700897991126"
ECR_REPO="prospector-capture"
REGION="ap-south-1"

DATA_ROOT="/var/lib/prospector"
DEST="/opt/prospector/releases/$SHA"

log() { echo "[install] $*"; }

# ---------------------------------------------------------------------------
# Step 1 — first run only: data volume, packages, Node, Caddy, the service
# user, swap. Guarded by a marker so every later install.sh run for a new
# release skips straight to step 2.
# ---------------------------------------------------------------------------
if [ ! -f "$DATA_ROOT/.bootstrapped" ]; then
  log "first boot — provisioning the box"

  ROOT_SRC="$(findmnt -no SOURCE /)"
  ROOT_DISK="$(lsblk -no PKNAME "$ROOT_SRC" 2>/dev/null || true)"
  if [ -z "$ROOT_DISK" ]; then
    ROOT_DISK="$(basename "$ROOT_SRC" | sed -E 's/p?[0-9]+$//')"
  fi
  DATA_DISK="$(lsblk -ndo NAME,TYPE | awk -v root="$ROOT_DISK" '$2=="disk" && $1!=root {print $1; exit}')"
  if [ -z "$DATA_DISK" ]; then
    log "FATAL: could not find the data EBS volume (root disk was $ROOT_DISK)"
    exit 1
  fi
  DATA_DEV="/dev/$DATA_DISK"

  if ! blkid "$DATA_DEV" >/dev/null 2>&1; then
    log "formatting $DATA_DEV (blank volume)"
    mkfs.ext4 -L prospector-data "$DATA_DEV"
  fi
  mkdir -p "$DATA_ROOT"
  UUID="$(blkid -s UUID -o value "$DATA_DEV")"
  if ! grep -q "$UUID" /etc/fstab; then
    echo "UUID=$UUID $DATA_ROOT ext4 defaults,nofail 0 2" >> /etc/fstab
  fi
  mount -a

  apt-get update -y
  # No `awscli` here: Ubuntu 24.04 dropped the package ("no installation
  # candidate", which is fatal under apt's exit 100), and it would be the wrong
  # one anyway — user-data already installed CLI v2 from Amazon's own zip, which
  # is what fetched this script. Fail loudly rather than discover it missing in
  # step 2's release download or step 6's ECR push.
  command -v aws >/dev/null 2>&1 || { log "FATAL: aws CLI missing (user-data should have installed v2)"; exit 1; }
  # mysql-client is for the operator, not for the app: `Done when 1` is a
  # `mysql --ssl-mode=VERIFY_IDENTITY` from an SSM shell, and there is no way
  # to check a grant without a client on the box.
  apt-get install -y docker.io build-essential python3 unzip curl gnupg mysql-client

  if ! id prospector >/dev/null 2>&1; then
    useradd --system --create-home --shell /usr/sbin/nologin prospector
  fi
  usermod -aG docker prospector

  if [ ! -f /swapfile ]; then
    log "creating 2G swapfile"
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi

  # Node, pinned exact and checked against NODE_SHA256 — R1.3. The tarball
  # comes from this release's own deploy/versions.env, not a stale copy, so a
  # version bump ships the same way any other code change does.
  # shellcheck disable=SC1091
  . "$(dirname "${BASH_SOURCE[0]}")/versions.env" 2>/dev/null || true
  if [ -z "${NODE_VERSION:-}" ]; then
    # Bare-bootstrap path (/tmp/install.sh, no siblings yet) — versions.env
    # lives in $DEST once step 2 below has run once for this box.
    NODE_VERSION="22.23.3"
    NODE_SHA256="a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f"
    CADDY_VERSION="2.11.4"
  fi

  if ! command -v node >/dev/null 2>&1 || [ "$(node --version)" != "v$NODE_VERSION" ]; then
    log "installing Node $NODE_VERSION"
    NODE_TARBALL="node-v$NODE_VERSION-linux-arm64.tar.xz"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TARBALL" -o "/tmp/$NODE_TARBALL"
    echo "$NODE_SHA256  /tmp/$NODE_TARBALL" | sha256sum -c -
    tar -xJf "/tmp/$NODE_TARBALL" -C /usr/local --strip-components=1
    rm -f "/tmp/$NODE_TARBALL"
  fi

  if ! command -v caddy >/dev/null 2>&1; then
    log "installing Caddy $CADDY_VERSION"
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y
    apt-get install -y "caddy=$CADDY_VERSION"
  fi

  touch "$DATA_ROOT/.bootstrapped"
fi

# ---------------------------------------------------------------------------
# Step 2 — download this release, verify, unpack. Skipped if already unpacked
# (repeat `./p ship` of the same sha, or the redundant re-run when install.sh
# was reached via the bare-bootstrap path in step 1 above).
# ---------------------------------------------------------------------------
if [ ! -f "$DEST/package.json" ]; then
  log "fetching release $SHA"
  mkdir -p "$DEST"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  aws s3 cp "s3://$DEPLOY_BUCKET/releases/$SHA.tar.gz" "$TMP/release.tar.gz" --region "$REGION"
  aws s3 cp "s3://$DEPLOY_BUCKET/releases/$SHA.tar.gz.sha256" "$TMP/release.tar.gz.sha256" --region "$REGION"
  EXPECTED="$(awk '{print $1}' "$TMP/release.tar.gz.sha256")"
  ACTUAL="$(sha256sum "$TMP/release.tar.gz" | awk '{print $1}')"
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    log "FATAL: sha256 mismatch for $SHA (expected $EXPECTED, got $ACTUAL)"
    exit 1
  fi
  tar -xzf "$TMP/release.tar.gz" -C "$DEST"
fi

# ---------------------------------------------------------------------------
# Step 2b — the RDS trust store. After step 2, because the pinned hash comes
# from this release's deploy/versions.env. Not inside the bootstrap guard: Amazon rotates
# the bundle, and a release that bumps RDS_CA_SHA256 has to be able to replace a
# file the box already has. src/db/mysql.js reads it with
# `rejectUnauthorized: true`, so an unreadable or wrong bundle is a refused
# connection, not a silently unverified one.
#
# Read by the `prospector` user at connection time; world-readable because a
# public trust store is not a secret and 600-root would just break the service.
# ---------------------------------------------------------------------------
# Not `2>/dev/null || true`: this file is part of the release that step 2 just
# unpacked, so a missing one is a broken release, and swallowing that would leave
# the box with no trust store and no explanation.
# shellcheck disable=SC1091
. "$DEST/deploy/versions.env"
[ -n "${RDS_CA_SHA256:-}" ] || { log "FATAL: RDS_CA_SHA256 is not set in deploy/versions.env"; exit 1; }

RDS_CA="/opt/prospector/rds-global-bundle.pem"
# The hash check *is* the "do I need to download this" check: a bundle that is
# already the pinned one passes, and anything else — absent, truncated, or the
# previous release's — does not.
if ! echo "$RDS_CA_SHA256  $RDS_CA" | sha256sum -c - >/dev/null 2>&1; then
  log "fetching the RDS CA bundle"
  mkdir -p /opt/prospector
  curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o "$RDS_CA.tmp"
  echo "$RDS_CA_SHA256  $RDS_CA.tmp" | sha256sum -c -
  mv "$RDS_CA.tmp" "$RDS_CA"
  chmod 644 "$RDS_CA"
fi

# ---------------------------------------------------------------------------
# Step 3 — production deps. PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: this box runs
# discover + qualify only in this spec, never a local capture.
# ---------------------------------------------------------------------------
export PATH="/usr/local/bin:$PATH"
(cd "$DEST" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund)

# ---------------------------------------------------------------------------
# Step 4 — persistent paths.
#
# Only `data/` now. The verticals used to be a JSON file copied here on first
# install and symlinked back, so that a box kept its own list: that list is a
# MySQL table now, and `migrate --import-verticals` seeded it once. Anything left
# in $DATA_ROOT/config from before is harmless and nothing reads it.
# ---------------------------------------------------------------------------
mkdir -p "$DATA_ROOT/data"
rm -rf "$DEST/data"
ln -s "$DATA_ROOT/data" "$DEST/data"

chown -R prospector:prospector "$DEST" "$DATA_ROOT/data"

# ---------------------------------------------------------------------------
# Step 5 — flip `current`, restart, health-check. Roll back on failure.
# ---------------------------------------------------------------------------
PREVIOUS="$(readlink -f /opt/prospector/current 2>/dev/null || true)"
ln -sfn "$DEST" /opt/prospector/current

install -m 644 "$DEST/deploy/prospector-control.service" /etc/systemd/system/prospector-control.service
install -m 644 "$DEST/deploy/prospector-serve.service"   /etc/systemd/system/prospector-serve.service
install -m 644 "$DEST/deploy/prospector-ingest.service"  /etc/systemd/system/prospector-ingest.service
install -m 644 "$DEST/deploy/prospector-ingest.timer"    /etc/systemd/system/prospector-ingest.timer
install -m 755 "$DEST/deploy/load-env.sh"                /opt/prospector/load-env.sh

# The places backup is gone: discover and qualify write rows, so there is no
# JSON on disk left to copy into S3. Removed rather than left disabled, or a
# box that has been shipped to for a year keeps a unit nothing understands.
for unit in prospector-backup.timer prospector-backup.service; do
  if [ -f "/etc/systemd/system/$unit" ]; then
    log "removing $unit"
    systemctl disable --now "$unit" || true
    rm -f "/etc/systemd/system/$unit"
  fi
done

systemctl daemon-reload
systemctl enable --now prospector-control.service
systemctl enable --now prospector-serve.service
systemctl enable --now prospector-ingest.timer
systemctl restart prospector-control.service
systemctl restart prospector-serve.service

sleep 3
# Both services, because both are what `./p ship` just replaced. The deck answers
# its own root with the page even before MySQL is reachable, so this checks that
# the process is up and serving, not that the database is healthy — `./p status`
# is what asks that.
HEALTH_FAILED=""
curl -fsS "http://127.0.0.1:7778/" >/dev/null 2>&1 || HEALTH_FAILED="control"
curl -fsS "http://127.0.0.1:7777/" >/dev/null 2>&1 || HEALTH_FAILED="${HEALTH_FAILED:+$HEALTH_FAILED }deck"
if [ -n "$HEALTH_FAILED" ]; then
  log "FATAL: health check failed after switching to $SHA ($HEALTH_FAILED)"
  if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$DEST" ]; then
    log "rolling back to $PREVIOUS"
    ln -sfn "$PREVIOUS" /opt/prospector/current
    systemctl restart prospector-control.service
    systemctl restart prospector-serve.service
  fi
  exit 1
fi

# Keep 3 releases.
ls -1dt /opt/prospector/releases/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf

# ---------------------------------------------------------------------------
# Step 6 — build and push the capture image, only if this sha is not already
# an ECR tag. ECR is IMMUTABLE, so that check is reliable.
# ---------------------------------------------------------------------------
if ! aws ecr describe-images --repository-name "$ECR_REPO" --image-ids imageTag="$SHA" \
     --region "$REGION" >/dev/null 2>&1; then
  log "building capture image for $SHA"
  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
  ECR_URL="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO"
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR_URL"
  docker build --platform linux/arm64 -f "$DEST/Dockerfile.capture" -t "$ECR_URL:$SHA" "$DEST"
  docker push "$ECR_URL:$SHA"
  docker image prune -f
else
  log "capture image for $SHA already in ECR — skipping build"
fi

# ---------------------------------------------------------------------------
# Step 7 — Caddy, once DNS actually points here (or forced).
# ---------------------------------------------------------------------------
# Two names now, and they arrive independently: the operator adds each A record
# at Netlify by hand. `prospect` is the one that has always gated this step;
# `leads` is included whenever it resolves and simply left out until it does, so
# a box with only the first record still gets a working control panel.
PROSPECT_UP=false
LEADS_UP=false
# `if`, not `getent … && VAR=true`: under `set -e` that form exits the script
# when the name does not resolve, because the list's status is getent's and the
# list is the whole command. Which is precisely the case this is testing for.
if getent hosts prospect.themaverick.tech >/dev/null 2>&1; then PROSPECT_UP=true; fi
if getent hosts leads.themaverick.tech    >/dev/null 2>&1; then LEADS_UP=true;    fi

if [ "$ENABLE_CADDY" = true ] || [ "$PROSPECT_UP" = true ] || [ "$LEADS_UP" = true ]; then
  log "configuring Caddy (prospect=$PROSPECT_UP leads=$LEADS_UP)"
  CONTROL_PASSWORD="$(aws ssm get-parameter --name /prospector/control-password --with-decryption \
    --region "$REGION" --query 'Parameter.Value' --output text)"
  CONTROL_HASH="$(caddy hash-password --plaintext "$CONTROL_PASSWORD")"

  # The deck's own credential. Absent means the operator has not put
  # DECK_PASSWORD in .env and run `./p secrets` yet — in which case the leads
  # block is left out rather than written with an empty hash, which Caddy would
  # reject and which would take the control panel down with it. This is the one
  # place a `|| true` is right: the parameter's absence is a state this handles,
  # not a failure it is about to act on as though it were a value.
  DECK_PASSWORD="$(aws ssm get-parameter --name /prospector/deck-password --with-decryption \
    --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || true)"
  DECK_HASH=""
  if [ -n "$DECK_PASSWORD" ] && [ "$DECK_PASSWORD" != "None" ]; then
    DECK_HASH="$(caddy hash-password --plaintext "$DECK_PASSWORD")"
  else
    log "WARN: /prospector/deck-password is unset — the leads site block is skipped"
  fi

  # 755, not 700: caddy.service runs as the unprivileged `caddy` user and has to
  # read /etc/caddy/Caddyfile itself — 700 root-owned made it exit with
  # "reading config from file: permission denied". The hashes stay protected by
  # auth.env's own 600 below, which costs nothing, because systemd reads
  # EnvironmentFile as root before dropping to the service user.
  install -d -m 755 /etc/caddy
  {
    printf 'CONTROL_AUTH_HASH=%s\n' "$CONTROL_HASH"
    printf 'DECK_AUTH_HASH=%s\n'    "$DECK_HASH"
  } > /etc/caddy/auth.env
  chmod 600 /etc/caddy/auth.env

  mkdir -p /etc/systemd/system/caddy.service.d
  install -m 644 "$DEST/deploy/caddy-override.conf" /etc/systemd/system/caddy.service.d/override.conf

  # Assembled, not installed whole: the global options block must come first and
  # appear exactly once, and each site block is included only when its name
  # resolves. A block for a name that does not resolve would make Caddy retry an
  # ACME challenge it cannot pass, on a loop, for that certificate.
  CADDYFILE="$(mktemp)"
  cat "$DEST/deploy/Caddyfile.global" > "$CADDYFILE"
  if [ "$ENABLE_CADDY" = true ] || [ "$PROSPECT_UP" = true ]; then
    cat "$DEST/deploy/Caddyfile.prospect" >> "$CADDYFILE"
  fi
  if [ "$LEADS_UP" = true ] && [ -n "$DECK_HASH" ]; then
    cat "$DEST/deploy/Caddyfile.leads" >> "$CADDYFILE"
  fi
  install -m 644 "$CADDYFILE" /etc/caddy/Caddyfile
  rm -f "$CADDYFILE"

  # The Caddyfile points `storage file_system` here so certificates survive on
  # the persistent volume rather than being re-issued from Let's Encrypt on every
  # box rebuild. Caddy writes them as its own user, so this has to be owned by
  # caddy, not root.
  mkdir -p "$DATA_ROOT/caddy"
  chown -R caddy:caddy "$DATA_ROOT/caddy"

  systemctl daemon-reload
  # Both hashes have to be in *this* process's environment: the Caddyfile reads
  # them as {$CONTROL_AUTH_HASH} / {$DECK_AUTH_HASH}, and /etc/caddy/auth.env is
  # only loaded by the caddy *service* via its systemd drop-in, not by a bare
  # validate. Without them the placeholders expand to nothing and validate
  # rejects the config with "username and password cannot be empty or missing".
  # HOME so caddy stops warning that it cannot find a config dir and writing into
  # the cwd.
  HOME=/root CONTROL_AUTH_HASH="$CONTROL_HASH" DECK_AUTH_HASH="$DECK_HASH" \
    caddy validate --config /etc/caddy/Caddyfile
  systemctl enable --now caddy.service
  systemctl reload caddy.service || systemctl restart caddy.service
else
  log "neither name resolves yet and --enable-caddy not given — skipping Caddy this run"
fi

log "done: $SHA is live"

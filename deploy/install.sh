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
  apt-get install -y docker.io build-essential python3 unzip awscli curl gnupg

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
# Step 3 — production deps. PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: this box runs
# discover + qualify only in this spec, never a local capture.
# ---------------------------------------------------------------------------
export PATH="/usr/local/bin:$PATH"
(cd "$DEST" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund)

# ---------------------------------------------------------------------------
# Step 4 — persistent paths. config/verticals.json is seeded from the release
# only if the persistent copy is absent — a later repo change to it does not
# propagate to a box that already has one (R5.2's trade).
# ---------------------------------------------------------------------------
mkdir -p "$DATA_ROOT/data" "$DATA_ROOT/config"
rm -rf "$DEST/data"
ln -s "$DATA_ROOT/data" "$DEST/data"

if [ ! -f "$DATA_ROOT/config/verticals.json" ]; then
  cp "$DEST/config/verticals.json" "$DATA_ROOT/config/verticals.json"
fi
rm -f "$DEST/config/verticals.json"
ln -s "$DATA_ROOT/config/verticals.json" "$DEST/config/verticals.json"

chown -R prospector:prospector "$DEST" "$DATA_ROOT/data" "$DATA_ROOT/config"

# ---------------------------------------------------------------------------
# Step 5 — flip `current`, restart, health-check. Roll back on failure.
# ---------------------------------------------------------------------------
PREVIOUS="$(readlink -f /opt/prospector/current 2>/dev/null || true)"
ln -sfn "$DEST" /opt/prospector/current

install -m 644 "$DEST/deploy/prospector-control.service" /etc/systemd/system/prospector-control.service
install -m 644 "$DEST/deploy/prospector-backup.service"  /etc/systemd/system/prospector-backup.service
install -m 644 "$DEST/deploy/prospector-backup.timer"    /etc/systemd/system/prospector-backup.timer
install -m 755 "$DEST/deploy/load-env.sh"                /opt/prospector/load-env.sh

systemctl daemon-reload
systemctl enable --now prospector-control.service
systemctl enable --now prospector-backup.timer
systemctl restart prospector-control.service

sleep 3
if ! curl -fsS "http://127.0.0.1:7778/" >/dev/null 2>&1; then
  log "FATAL: health check failed after switching to $SHA"
  if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$DEST" ]; then
    log "rolling back to $PREVIOUS"
    ln -sfn "$PREVIOUS" /opt/prospector/current
    systemctl restart prospector-control.service
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
DNS_UP=false
if getent hosts prospect.themaverick.tech >/dev/null 2>&1; then
  DNS_UP=true
fi

if [ "$ENABLE_CADDY" = true ] || [ "$DNS_UP" = true ]; then
  log "configuring Caddy"
  PASSWORD="$(aws ssm get-parameter --name /prospector/control-password --with-decryption \
    --region "$REGION" --query 'Parameter.Value' --output text)"
  HASH="$(caddy hash-password --plaintext "$PASSWORD")"
  install -d -m 700 /etc/caddy
  printf 'CONTROL_AUTH_HASH=%s\n' "$HASH" > /etc/caddy/auth.env
  chmod 600 /etc/caddy/auth.env

  mkdir -p /etc/systemd/system/caddy.service.d
  install -m 644 "$DEST/deploy/caddy-override.conf" /etc/systemd/system/caddy.service.d/override.conf
  install -m 644 "$DEST/deploy/Caddyfile" /etc/caddy/Caddyfile
  mkdir -p "$DATA_ROOT/caddy"

  systemctl daemon-reload
  caddy validate --config /etc/caddy/Caddyfile
  systemctl enable --now caddy.service
  systemctl reload caddy.service || systemctl restart caddy.service
else
  log "DNS not up yet and --enable-caddy not given — skipping Caddy this run"
fi

log "done: $SHA is live"

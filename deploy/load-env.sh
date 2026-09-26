#!/bin/bash
#
# Writes /run/prospector/env (tmpfs, 0600) from every SecureString under
# /prospector/ in SSM Parameter Store. Run as root via ExecStartPre=+ so it can
# write a file owned by the service user before that user's process starts.
#
# CONTROL_TOKEN must stay unset here — it is never written to SSM by
# `./p secrets`, so it never appears in this file, so control keeps binding
# 127.0.0.1 and Caddy's basic_auth stays the only gate (design.md "Traps").
set -euo pipefail

REGION="ap-south-1"
OUT_DIR="/run/prospector"
OUT="$OUT_DIR/env"

mkdir -p "$OUT_DIR"
: > "$OUT"
chmod 600 "$OUT"

aws ssm get-parameters-by-path --path /prospector/ --with-decryption --region "$REGION" \
    --query 'Parameters[*].[Name,Value]' --output text |
while IFS=$'\t' read -r name value; do
  key="$(basename "$name" | tr '[:lower:]-' '[:upper:]_')"
  printf '%s=%s\n' "$key" "$value" >> "$OUT"
done

chown prospector:prospector "$OUT"

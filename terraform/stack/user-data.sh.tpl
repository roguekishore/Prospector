#!/bin/bash
# Cloud-init user-data — runs once, at first boot only.
#
# Job is deliberately tiny (design.md "User-data is only: install the AWS
# CLI, fetch install.sh from the latest release named in SSM /prospector/release,
# run it."): install the CLI, then pull just `deploy/install.sh` out of the
# release tarball's stream — not the whole tarball — and hand it the sha.
# install.sh does the actual download-and-verify of the full release (its own
# step 2), so first boot and `./p ship` end up running the exact same script
# (R2.3): both do nothing more than this.
set -euo pipefail

apt-get update -y
apt-get install -y unzip curl

if ! command -v aws >/dev/null 2>&1; then
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip
  unzip -q /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install
  rm -rf /tmp/awscliv2.zip /tmp/aws
fi

RELEASE_SHA="$(aws ssm get-parameter --name /prospector/release --region ap-south-1 \
  --query 'Parameter.Value' --output text 2>/dev/null || true)"

if [ -z "$RELEASE_SHA" ] || [ "$RELEASE_SHA" = "None" ]; then
  echo "prospector: no release published yet (/prospector/release unset) — waiting for ./p ship"
  exit 0
fi

aws s3 cp "s3://${deploy_bucket}/releases/$RELEASE_SHA.tar.gz" - --region ap-south-1 \
  | tar -xzO deploy/install.sh > /tmp/install.sh
chmod +x /tmp/install.sh
/tmp/install.sh "$RELEASE_SHA"

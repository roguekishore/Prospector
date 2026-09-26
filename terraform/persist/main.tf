# persist — the things ./p down must never touch: state key persist.tfstate.
#
# Two roots instead of `prevent_destroy` (design.md "Layout"): prevent_destroy
# makes `./p down` error out rather than skip, which is the wrong failure mode
# for a command whose whole point is to tear the stack down cleanly. Putting
# these resources in a separate state file makes `./p down` simply never touch
# this root at all.

# ---------------------------------------------------------------------------
# Capture bucket — captures, and the discover/qualify + places-raw backup this
# spec adds. Versioning is load-bearing (src/capture/s3.js), not optional: it
# is what makes a re-capture non-destructive with no date in the key.
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "captures" {
  bucket = "prospector-captures-700897991126"
}

resource "aws_s3_bucket_versioning" "captures" {
  bucket = aws_s3_bucket.captures.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "captures" {
  bucket                  = aws_s3_bucket.captures.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3, not SSE-KMS. scripts/backup-places.js relies on a single-part PUT's
# ETag equalling the hex MD5 of the body to skip unchanged uploads — SSE-KMS
# breaks that equality, and there is no reason to pay for a CMK on a bucket
# with no cross-account access story.
resource "aws_s3_bucket_server_side_encryption_configuration" "captures" {
  bucket = aws_s3_bucket.captures.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Deliberately no lifecycle rule — design.md "Decisions that are closed": a
# domain is captured once, never on a schedule, so noncurrent versions only
# accumulate from a deliberate re-capture. Add a lifecycle rule only if a
# periodic refresh is introduced.

# ---------------------------------------------------------------------------
# Deploy bucket — ./p ship's git-archive releases. 30-day expiry on releases/
# so a laptop that stops shipping doesn't pay to keep old tarballs forever.
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "deploy" {
  bucket = "prospector-deploy-700897991126"
}

resource "aws_s3_bucket_public_access_block" "deploy" {
  bucket                  = aws_s3_bucket.deploy.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "deploy" {
  bucket = aws_s3_bucket.deploy.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "deploy" {
  bucket = aws_s3_bucket.deploy.id
  rule {
    id     = "expire-releases"
    status = "Enabled"
    filter {
      prefix = "releases/"
    }
    expiration {
      days = 30
    }
  }
}

# ---------------------------------------------------------------------------
# ECR — the capture Lambda's image. IMMUTABLE: install.sh checks "is this sha
# already a tag in ECR" to decide whether to skip the build (design.md "Image
# tag without drift"), and that check is only meaningful if a tag can never be
# silently repointed.
# ---------------------------------------------------------------------------
resource "aws_ecr_repository" "capture" {
  name                 = "prospector-capture"
  image_tag_mutability = "IMMUTABLE"
}

# ---------------------------------------------------------------------------
# Data volume — data/ and Caddy's cert storage (R5.1). Survives instance
# replacement and `./p down` because it lives in this root, not stack/. Pinned
# to the same AZ as the box in stack/ — an EBS volume cannot attach cross-AZ.
# ---------------------------------------------------------------------------
resource "aws_ebs_volume" "data" {
  availability_zone = "ap-south-1a"
  size              = 20
  type              = "gp3"

  tags = {
    Name = "prospector-data"
  }
}

# ---------------------------------------------------------------------------
# Image tag — the single source of truth for which sha the capture function
# should run (design.md "Image tag without drift"). `./p ship` writes this
# directly with the CLI; `ignore_changes` keeps that from looking like drift
# on the next `terraform apply persist`. `insecure_value` (not `value`) because
# a git sha is not a secret and there is no reason to mask it in plan output.
# ---------------------------------------------------------------------------
resource "aws_ssm_parameter" "capture_image_tag" {
  name           = "/prospector/capture-image-tag"
  type           = "String"
  insecure_value = "none"

  lifecycle {
    ignore_changes = [insecure_value]
  }
}

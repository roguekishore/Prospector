# Cross-root reads. stack/ has its own state (stack.tfstate) but needs a few
# values persist/ owns — read via terraform_remote_state rather than passed-in
# variables, so `./p` never has to shuttle bucket names and ARNs by hand.
data "terraform_remote_state" "persist" {
  backend = "s3"
  config = {
    bucket = "prospector-tfstate-700897991126"
    key    = "persist.tfstate"
    region = "ap-south-1"
  }
}

# Ubuntu 24.04 (noble) arm64 — Canonical's own AMIs, not a community copy.
data "aws_ami" "ubuntu_noble_arm64" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"]
  }
  filter {
    name   = "architecture"
    values = ["arm64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# The single source of truth for which image the capture function should run
# (design.md "Image tag without drift"). "none" means not staged yet — the
# function resource below is `count`-gated on this.
#
# Ordering is enforced by ./p, not by Terraform: `./p up` always applies
# persist before stack, so this parameter already exists by the time stack
# reads it.
data "aws_ssm_parameter" "capture_image_tag" {
  name = "/prospector/capture-image-tag"
}

data "aws_caller_identity" "current" {}

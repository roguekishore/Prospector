# Exact versions — R1.3. Kept byte-identical to ../stack/versions.tf: Terraform
# has no cross-root include, and symlinks are off (this repo is worked on from
# Windows without dev-mode symlink rights), so the two roots each carry their
# own copy. If you change one, change both.

terraform {
  required_version = "1.16.2"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.66.0"
    }
  }

  backend "s3" {
    bucket       = "prospector-tfstate-700897991126"
    key          = "persist.tfstate"
    region       = "ap-south-1"
    use_lockfile = true
  }
}

provider "aws" {
  region              = "ap-south-1"
  allowed_account_ids = ["700897991126"]
}

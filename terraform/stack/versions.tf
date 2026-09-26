# Exact versions — R1.3. Kept byte-identical to ../persist/versions.tf: see the
# comment there for why this is a copy and not a shared file.

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
    key          = "stack.tfstate"
    region       = "ap-south-1"
    use_lockfile = true
  }
}

provider "aws" {
  region              = "ap-south-1"
  allowed_account_ids = ["700897991126"]
}

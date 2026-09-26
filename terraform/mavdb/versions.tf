# Exact versions — R1.3. Kept byte-identical to ../persist/versions.tf's
# `terraform` block: Terraform has no cross-root include, and symlinks are off
# (this repo is worked on from Windows without dev-mode symlink rights), so each
# root carries its own copy. If you change one, change all three.

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
    key          = "mavdb.tfstate"
    region       = "ap-south-1"
    use_lockfile = true
  }
}

# rogue — this account. The peering connection and the route on our side.
provider "aws" {
  region              = "ap-south-1"
  allowed_account_ids = ["700897991126"]
}

# clasher — mavdb's account. The accepter, the routes back, and the one security
# group rule.
#
# The keys arrive as variables from `./p peer`, which reads them out of the
# operator's CSV at run time. Provider configuration is never written to state,
# so they exist only in the memory of the one Terraform process (R1.6). They are
# deliberately not a profile: `default` on this laptop is an SSO session into a
# third account, and a profile that silently changes what it points at is how
# resources end up in the wrong place.
provider "aws" {
  alias               = "clasher"
  region              = "ap-south-1"
  allowed_account_ids = ["028972816671"]
  access_key          = var.clasher_access_key
  secret_key          = var.clasher_secret_key
}

variable "clasher_access_key" {
  description = "Root access key id for account 028972816671, from ./p peer. Never stored."
  type        = string
  sensitive   = true
}

variable "clasher_secret_key" {
  description = "Root secret key for account 028972816671, from ./p peer. Never stored."
  type        = string
  sensitive   = true
}

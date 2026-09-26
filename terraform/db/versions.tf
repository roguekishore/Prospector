# Exact versions — R1.3. The `terraform` block matches the other roots; the two
# extra providers are pinned the same way and for the same reason.

terraform {
  required_version = "1.16.2"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.66.0"
    }
    # The MySQL provider is what makes the database, the user and the grants
    # Terraform's rather than a hand-typed `CREATE USER` nobody can diff.
    # 3.0.100 was the latest on the registry on 2026-09-26.
    # https://registry.terraform.io/providers/petoju/mysql
    mysql = {
      source  = "petoju/mysql"
      version = "3.0.100"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.1"
    }
  }

  backend "s3" {
    bucket       = "prospector-tfstate-700897991126"
    key          = "db.tfstate"
    region       = "ap-south-1"
    use_lockfile = true
  }
}

# rogue — for the two SSM parameters the box reads.
provider "aws" {
  region              = "ap-south-1"
  allowed_account_ids = ["700897991126"]
}

# mavdb, through the SSM port-forward `./p db` opens:
#
#     laptop :13306 --SSM--> the box --peering--> mavdb :3306
#
# `skip-verify` because the certificate names the RDS host and this connects to
# 127.0.0.1. The traffic is still encrypted the whole way (SSM's own channel,
# then TLS over the peering); what is not checked is the server's identity, on
# this one admin path, from a laptop that just opened the tunnel itself. The
# application's own connections do verify it, host name included
# (src/db/mysql.js, R3.2).
provider "mysql" {
  endpoint = "127.0.0.1:13306"
  username = "maverick"
  password = var.maverick_password
  tls      = "skip-verify"
}

variable "maverick_password" {
  description = <<-EOT
    mavdb's admin password, read from .env by `./p db` and passed in as
    TF_VAR_maverick_password. Provider configuration is never written to state,
    so this does not land in db.tfstate (R2.4).
  EOT
  type        = string
  sensitive   = true
}

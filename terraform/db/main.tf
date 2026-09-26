# The `prospector` database on mavdb, its one user, its grants, and the two SSM
# parameters that tell the box where to connect and with what.
#
# Its own root and its own state key, like the peering: `./p down` destroys the
# box, and the database has to survive that untouched.
#
# ## Where the passwords live
#
# Two, and they are handled differently on purpose.
#
# `maverick` — mavdb's admin — is read from `.env` at run time and reaches only
# the provider configuration, which Terraform never writes to state (R2.4). It
# is not in SSM, not on the box, and not on any command line.
#
# `prospector` — the application's own user — is generated here, so it is in
# `db.tfstate` (`random_password` keeps its result, and `mysql_user` keeps the
# value it was given). That bucket is private, public access blocked, and SSE-S3
# encrypted; the same is noted in docs/ARCHITECTURE.md. The alternative — typing
# a password in by hand and keeping it somewhere else — replaces a controlled
# exposure with an uncontrolled one.

data "terraform_remote_state" "mavdb" {
  backend = "s3"
  config = {
    bucket = "prospector-tfstate-700897991126"
    key    = "mavdb.tfstate"
    region = "ap-south-1"
  }
}

resource "mysql_database" "prospector" {
  name                  = "prospector"
  default_character_set = "utf8mb4"
  default_collation     = "utf8mb4_0900_ai_ci"
}

# 40 characters and no punctuation. `special = false` is not about entropy —
# 40 alphanumerics is ~238 bits — it is about the password surviving every place
# it gets pasted: a `mysql://` URL where `@` or `/` would terminate a field, a
# shell where a quote would, and a systemd EnvironmentFile line.
resource "random_password" "db" {
  length  = 40
  special = false
}

# `10.43.%` and not `%`: the user is only ever used from inside the prospector
# VPC, over the peering. REQUIRE SSL on top, so a connection that somehow arrived
# unencrypted is refused by the server rather than trusted because it came from
# the right subnet.
resource "mysql_user" "prospector" {
  user               = "prospector"
  host               = "10.43.%"
  plaintext_password = random_password.db.result
  tls_option         = "SSL"
}

# Enough to own its own three tables and run its own migrations, on its own
# database, and nothing anywhere else on the instance — mavdb is shared with
# other applications. No CREATE USER, no GRANT OPTION, no access to `mysql.*`.
# A separate, more restricted user for the application with migrations run as
# this one is deferred (spec E).
resource "mysql_grant" "prospector" {
  user     = mysql_user.prospector.user
  host     = mysql_user.prospector.host
  database = mysql_database.prospector.name
  privileges = [
    "SELECT", "INSERT", "UPDATE", "DELETE",
    "CREATE", "ALTER", "INDEX", "DROP", "REFERENCES",
  ]
}

# ---------------------------------------------------------------------------
# What the box reads
#
# `load-env.sh` turns every parameter under /prospector/ into an environment
# variable, upper-cased with dashes as underscores: `db-host` becomes `DB_HOST`
# and `db-password` becomes `DB_PASSWORD`, which is exactly what
# `src/db/mysql.js` looks for. No change to load-env.sh is needed, and that
# naming is the whole contract between these two resources and the application.
# ---------------------------------------------------------------------------
resource "aws_ssm_parameter" "db_password" {
  name        = "/prospector/db-password"
  type        = "SecureString"
  value       = random_password.db.result
  description = "prospector@10.43.% on mavdb. Written by terraform/db."
}

resource "aws_ssm_parameter" "db_host" {
  name           = "/prospector/db-host"
  type           = "String"
  insecure_value = data.terraform_remote_state.mavdb.outputs.mavdb_address
  description    = "mavdb endpoint. Written by terraform/db."
}

output "db_host" {
  value = data.terraform_remote_state.mavdb.outputs.mavdb_address
}

output "db_user" {
  value = "${mysql_user.prospector.user}@${mysql_user.prospector.host}"
}

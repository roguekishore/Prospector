# The network path from the prospector box to mavdb: a VPC peering connection,
# a route each way, and one ingress rule on mavdb's security group.
#
# Its own root, and its own state key, so `./p down` and `./p up` never plan,
# apply or destroy anything here (R1.4). The box is disposable; the peering is
# not, because tearing it down and rebuilding it would mean touching clasher
# every time the box is rebuilt.
#
# ## What this is allowed to do in clasher
#
# Create three kinds of resource and nothing else (R1.2): the peering accepter,
# an `aws_route` per route table mavdb's subnets use, and one
# `aws_vpc_security_group_ingress_rule`. It never imports, modifies or takes over
# an existing clasher resource — the plan must show only creates on that side,
# and an `update` or `replace` against anything in clasher means stop.
#
# Every clasher identifier is read from a data source rooted at the DB instance
# (R1.3). Nothing about clasher's layout is written down here, so a change on
# that side shows up as a plan diff rather than as a connection that silently
# stopped working.

# ---------------------------------------------------------------------------
# Our side
# ---------------------------------------------------------------------------
data "terraform_remote_state" "persist" {
  backend = "s3"
  config = {
    bucket = "prospector-tfstate-700897991126"
    key    = "persist.tfstate"
    region = "ap-south-1"
  }
}

# ---------------------------------------------------------------------------
# Their side, all discovered from the instance identifier
# ---------------------------------------------------------------------------
data "aws_db_instance" "mavdb" {
  provider               = aws.clasher
  db_instance_identifier = "mavdb"
}

data "aws_db_subnet_group" "mavdb" {
  provider = aws.clasher
  name     = data.aws_db_instance.mavdb.db_subnet_group
}

data "aws_vpc" "clasher" {
  provider = aws.clasher
  id       = data.aws_db_subnet_group.mavdb.vpc_id
}

# One lookup per subnet, which is the only thing that answers *which* table each
# subnet actually uses.
#
# The obvious alternative, `aws_route_tables` filtered on
# `association.subnet-id`, answers a different question: which tables have an
# explicit association with at least one of these subnets. A subnet with no
# explicit association silently uses the VPC's main table and does not appear —
# and a default VPC typically has no explicit associations at all, so the route
# set would come back empty, no return route would be created, and the box would
# see a connection timeout with nothing in any plan to explain it.
#
# `aws_route_table` given a subnet_id resolves the main table for exactly that
# case, so this needs no separate main-table lookup and no guessing.
data "aws_route_table" "per_subnet" {
  provider  = aws.clasher
  for_each  = toset(data.aws_db_subnet_group.mavdb.subnet_ids)
  subnet_id = each.value
}

locals {
  # Exactly the tables that carry mavdb's subnets, explicit or inherited.
  mavdb_route_table_ids = toset([
    for rt in data.aws_route_table.per_subnet : rt.route_table_id
  ])

  mavdb_security_groups = tolist(data.aws_db_instance.mavdb.vpc_security_groups)

  # Do the two VPCs overlap? Peering between overlapping CIDRs is impossible, and
  # the failure without this check is a created-then-useless connection plus a
  # confusing route error several resources later.
  #
  # Terraform has no `cidrcontains`, so this is the definition spelled out: two
  # ranges overlap exactly when one's network address, masked to the other's
  # prefix length, equals that other's network address. Checked both ways round,
  # because either range may be the wider one.
  ours_base     = cidrhost(data.terraform_remote_state.persist.outputs.vpc_cidr, 0)
  theirs_base   = cidrhost(data.aws_vpc.clasher.cidr_block, 0)
  ours_prefix   = split("/", data.terraform_remote_state.persist.outputs.vpc_cidr)[1]
  theirs_prefix = split("/", data.aws_vpc.clasher.cidr_block)[1]

  cidrs_overlap = (
    local.ours_base == cidrhost("${local.theirs_base}/${local.ours_prefix}", 0) ||
    local.theirs_base == cidrhost("${local.ours_base}/${local.theirs_prefix}", 0)
  )

  # Which security group gets the ingress rule. With one attached there is no
  # question; with several, adding the rule to all of them would widen access for
  # whatever else uses them, and picking one arbitrarily would be a guess about
  # another team's network. So the operator names it and the precondition below
  # checks the name against what is actually attached.
  #
  # Not `one(...)`: that fails with "must be a list of at most one element",
  # which says nothing about what to do next. The empty string falls through to
  # the precondition on the rule below, which names the actual candidates.
  mavdb_security_group_id = (
    var.mavdb_security_group_id != null ? var.mavdb_security_group_id :
    length(local.mavdb_security_groups) == 1 ? local.mavdb_security_groups[0] : ""
  )
}

variable "mavdb_security_group_id" {
  description = <<-EOT
    Which of mavdb's security groups takes the ingress rule for 10.43.0.0/16.
    Leave null when mavdb has exactly one; set it when it has several, and the
    precondition below checks it is really attached to the instance.
  EOT
  type        = string
  default     = null
}

# ---------------------------------------------------------------------------
# The peering connection
# ---------------------------------------------------------------------------
resource "aws_vpc_peering_connection" "mavdb" {
  vpc_id        = data.terraform_remote_state.persist.outputs.vpc_id
  peer_vpc_id   = data.aws_vpc.clasher.id
  peer_owner_id = "028972816671"
  peer_region   = "ap-south-1"

  tags = {
    Name = "prospector-to-mavdb"
  }

  lifecycle {
    precondition {
      condition = !local.cidrs_overlap
      error_message = format(
        "The prospector VPC (%s) overlaps clasher's (%s) — peering cannot work. Renumber one of them.",
        data.terraform_remote_state.persist.outputs.vpc_cidr,
        data.aws_vpc.clasher.cidr_block,
      )
    }
  }
}

resource "aws_vpc_peering_connection_accepter" "mavdb" {
  provider                  = aws.clasher
  vpc_peering_connection_id = aws_vpc_peering_connection.mavdb.id
  auto_accept               = true

  tags = {
    Name = "prospector-to-mavdb"
  }
}

# ---------------------------------------------------------------------------
# Routes, both ways
# ---------------------------------------------------------------------------

# Ours. A standalone resource, into the table persist owns — which is exactly why
# that table has no inline `route {}` block (see persist/network.tf).
resource "aws_route" "to_mavdb" {
  route_table_id            = data.terraform_remote_state.persist.outputs.route_table_id
  destination_cidr_block    = data.aws_vpc.clasher.cidr_block
  vpc_peering_connection_id = aws_vpc_peering_connection.mavdb.id
}

# Theirs. One per route table mavdb's subnets actually use — without the return
# route the TCP handshake leaves but never comes back, which presents as a
# connection timeout and not as a routing error.
resource "aws_route" "from_mavdb" {
  provider                  = aws.clasher
  for_each                  = local.mavdb_route_table_ids
  route_table_id            = each.value
  destination_cidr_block    = data.terraform_remote_state.persist.outputs.vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.mavdb.id

  # The accepter has to exist before a route can point at the connection.
  depends_on = [aws_vpc_peering_connection_accepter.mavdb]
}

# ---------------------------------------------------------------------------
# Ingress on mavdb's security group
# ---------------------------------------------------------------------------
#
# `aws_vpc_security_group_ingress_rule` and not an `ingress {}` block on an
# imported `aws_security_group`: the block form makes Terraform the owner of
# every rule on that group, so the first apply would delete whatever else in
# clasher is allowed to reach mavdb. A single rule resource adds one rule and
# leaves the rest of the group alone (R1.2).
resource "aws_vpc_security_group_ingress_rule" "mavdb_from_prospector" {
  provider          = aws.clasher
  security_group_id = local.mavdb_security_group_id
  ip_protocol       = "tcp"
  from_port         = 3306
  to_port           = 3306
  cidr_ipv4         = data.terraform_remote_state.persist.outputs.vpc_cidr
  description       = "prospector box (rogue 10.43.0.0/16) via peering"

  lifecycle {
    precondition {
      condition     = contains(local.mavdb_security_groups, local.mavdb_security_group_id)
      error_message = "Set -var mavdb_security_group_id to one of mavdb's security groups: ${join(", ", local.mavdb_security_groups)}"
    }
  }
}

# ---------------------------------------------------------------------------
# What the other roots read
# ---------------------------------------------------------------------------
#
# A private RDS endpoint resolves to its private address from anywhere, so there
# is nothing to configure about peering DNS: the box resolves this name to a
# 172.x address by itself. Check it there with `getent hosts <address>`.
output "mavdb_address" {
  value = data.aws_db_instance.mavdb.address
}

output "mavdb_port" {
  value = data.aws_db_instance.mavdb.port
}

output "clasher_vpc_cidr" {
  value = data.aws_vpc.clasher.cidr_block
}

# TEMPORARY — delete this file once the network migration is applied.
#
# ## Why it exists
#
# `ec424b1` moved the VPC, subnet, internet gateway and route table from
# terraform/stack to terraform/persist (see network.tf for why). That commit
# changed the *code* only. The live resources were created by stack and are still
# recorded in stack.tfstate, while persist.tfstate has no network at all — so
# without these blocks `terraform apply persist` would create a second VPC beside
# the live one, and the follow-up `apply stack` would delete the original,
# taking the box and EIP 35.154.77.31 with it.
#
# `terraform fmt` and `terraform validate` both pass on that, because neither
# reads state. Only a plan against the real state shows it.
#
# ## What these do
#
# Adopt the resources that already exist instead of creating them. The configs in
# network.tf are the same ones stack applied — same CIDR, same subnet, same AZ,
# same tags — so each import plans as a no-op, not a replacement. Verify that
# before applying: the plan must say "1 to import" per block and must not say
# "must be replaced" for any of them.
#
# ## Order
#
#   1. terraform apply here (persist), which adopts these and publishes the
#      vpc_id / vpc_cidr / subnet_id / route_table_id outputs.
#   2. terraform apply stack, whose `removed` blocks (stack/removed.tf) drop the
#      same resources from stack.tfstate *without* destroying them.
#   3. Delete this file and stack/removed.tf in a follow-up commit, then confirm
#      both roots plan clean.
#
# Step 2 cannot even be planned before step 1: stack/network.tf:15 and box.tf:111
# read persist's vpc_id and subnet_id, which do not exist until this is applied.
#
# The ids below came out of stack.tfstate, which is the authority on what stack
# built — not from a console listing that might name a lookalike.

import {
  to = aws_vpc.main
  id = "vpc-0b00c5d9fc1b89231"
}

import {
  to = aws_subnet.public
  id = "subnet-0b87d9f92d1b588d0"
}

import {
  to = aws_internet_gateway.main
  id = "igw-05240b113c543b98b"
}

import {
  to = aws_route_table.public
  id = "rtb-02df595120a2a98c9"
}

# Six imports, not five, and this is the one that is easy to miss.
#
# stack's route table carried an inline `route {}` block; persist's does not, and
# declares the default route as a standalone `aws_route` instead (network.tf
# explains why — an inline route would make persist the owner of every route in
# the table and delete the peering route terraform/mavdb adds). The route itself
# is the same route in AWS either way, so it has to be adopted too. Left out,
# persist would try to create a route that already exists and the apply would
# fail with RouteAlreadyExists.
#
# An aws_route id is "<route table id>_<destination>".
import {
  to = aws_route.default
  id = "rtb-02df595120a2a98c9_0.0.0.0/0"
}

import {
  to = aws_route_table_association.public
  id = "subnet-0b87d9f92d1b588d0/rtb-02df595120a2a98c9"
}

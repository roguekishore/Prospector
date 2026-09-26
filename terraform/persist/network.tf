# The network, moved here from stack/ so it survives `./p down`.
#
# ## Why it had to move
#
# The VPC peering to mavdb (terraform/mavdb) references this VPC by id. While the
# VPC lived in stack/, `./p down` destroyed it and `./p up` created a new one with
# a new id — which would have left the peering connection pointing at something
# that no longer existed, and its route with nowhere to go. A peering root that
# must survive down/up (R1.4) needs a VPC that survives too (R1.5).
#
# A VPC, a subnet, an internet gateway and a route table cost nothing while idle,
# so there is no bill to weigh against that. The security group, the instance and
# the EIP stay in stack/: those are the box, and the box is what `./p down` is for.

resource "aws_vpc" "main" {
  cidr_block           = "10.43.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "prospector"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.43.1.0/24"
  availability_zone       = "ap-south-1a"
  map_public_ip_on_launch = true

  tags = {
    Name = "prospector-public"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "prospector"
  }
}

# ---------------------------------------------------------------------------
# The route table carries no inline `route {}` block, and that is load-bearing.
#
# An inline route makes Terraform the owner of *every* route in the table: the
# next `terraform apply persist` would compute the table as holding only the
# default route and delete the peering route that terraform/mavdb added. The two
# roots would then fight, alternately adding and removing the route to mavdb,
# and the box would lose the database on whichever apply ran last.
#
# Standalone `aws_route` resources are additive, so each root owns the route it
# created and neither sees the other's as drift.
# ---------------------------------------------------------------------------
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "prospector-public"
  }
}

resource "aws_route" "default" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

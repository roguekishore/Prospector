# The VPC, subnet, internet gateway and route table moved to terraform/persist
# (see persist/network.tf): the peering to mavdb references the VPC by id, and
# `./p down` recreating the VPC with a new id would have broken it. What is left
# here is the part that belongs to the box and dies with it.

# R4.2 — 80 and 443 only. No port 22; shell is Session Manager, over the SSM
# agent's own outbound connection, which needs no inbound rule at all.
#
# Nothing is opened for MySQL either: the connection is outbound from the box
# over the peering, and it is mavdb's own security group in clasher that has the
# matching ingress rule (terraform/mavdb). Egress here is already open.
resource "aws_security_group" "box" {
  name        = "prospector-box"
  description = "Caddy only - no SSH"
  vpc_id      = data.terraform_remote_state.persist.outputs.vpc_id

  ingress {
    description = "HTTP (redirects to HTTPS / ACME challenge)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "prospector-box"
  }
}

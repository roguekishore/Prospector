# TEMPORARY — delete this file once the network migration is applied.
#
# The counterpart to persist/imports.tf. The VPC, subnet, internet gateway and
# route table moved to terraform/persist in `ec424b1`; stack's code no longer
# declares them, but stack.tfstate still manages them, so a plain
# `terraform apply stack` would read that as "these five are gone from the
# configuration" and destroy them — the live VPC, and with it the box inside it
# and EIP 35.154.77.31.
#
# `destroy = false` is the whole point: forget the resource, leave it running.
# persist adopts the same five (plus the default route) so nothing ends up
# unmanaged.
#
# Apply persist FIRST. stack cannot even be planned before that, because
# network.tf:15 and box.tf:111 read persist's vpc_id and subnet_id outputs, which
# do not exist until persist has adopted the resources that produce them.
#
# After applying: this file and persist/imports.tf both go, in a follow-up commit,
# and both roots must then plan clean.
#
# aws_eip.box, aws_security_group.box and aws_ssm_parameter.eip are deliberately
# absent from this list. They belong to the box and stay in stack — that is what
# `./p down` is for. There is no `aws_route` here either: stack's route table
# carried its default route inline, so stack never had a standalone route
# resource to forget.

removed {
  from = aws_vpc.main

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_subnet.public

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_internet_gateway.main

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_route_table.public

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_route_table_association.public

  lifecycle {
    destroy = false
  }
}

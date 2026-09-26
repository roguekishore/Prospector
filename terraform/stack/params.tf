# Where `ship` and `status` learn which box to talk to.
#
# They run under the scoped `prospector-deploy` user (R8.1, and task 7.4 deletes
# the root keys outright), which has no read access to the terraform state
# bucket and should not get any: state holds every attribute of every resource,
# so handing it over to trade for two plain facts would undo the least-privilege
# policy next door in deploy-user.tf.
#
# Both are already covered by that user's existing ssm:GetParameter on
# /prospector/*, so this costs no new permission. `insecure_value` because
# neither is a secret — an instance id and a public IP both show up in `plan`
# with nothing lost. Terraform is the only writer, so unlike
# /prospector/capture-image-tag there is no ignore_changes here: if the box is
# replaced, the parameter should follow it.
resource "aws_ssm_parameter" "instance_id" {
  name           = "/prospector/instance-id"
  type           = "String"
  insecure_value = aws_instance.box.id
}

resource "aws_ssm_parameter" "eip" {
  name           = "/prospector/eip"
  type           = "String"
  insecure_value = aws_eip.box.public_ip
}

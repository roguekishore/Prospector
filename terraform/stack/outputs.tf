output "instance_id" {
  value = aws_instance.box.id
}

output "eip" {
  value = aws_eip.box.public_ip
}

output "capture_function_arn" {
  value = local.capture_function_arn
}

output "capture_image_tag" {
  value     = data.aws_ssm_parameter.capture_image_tag.value
  sensitive = true # SSM parameter values are always sensitive to Terraform, tag or not
}

output "deploy_user_name" {
  value = aws_iam_user.deploy.name
}

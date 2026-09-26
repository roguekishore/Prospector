output "capture_bucket_name" {
  value = aws_s3_bucket.captures.id
}

output "capture_bucket_arn" {
  value = aws_s3_bucket.captures.arn
}

output "deploy_bucket_name" {
  value = aws_s3_bucket.deploy.id
}

output "deploy_bucket_arn" {
  value = aws_s3_bucket.deploy.arn
}

output "ecr_repository_url" {
  value = aws_ecr_repository.capture.repository_url
}

output "ecr_repository_arn" {
  value = aws_ecr_repository.capture.arn
}

output "ecr_repository_name" {
  value = aws_ecr_repository.capture.name
}

output "data_volume_id" {
  value = aws_ebs_volume.data.id
}

output "capture_image_tag_param_name" {
  value = aws_ssm_parameter.capture_image_tag.name
}

# The network. stack/ reads vpc_id and subnet_id; terraform/mavdb reads vpc_id,
# vpc_cidr and route_table_id (the peering, the route back, and the CIDR the
# mavdb security group allows).
output "vpc_id" {
  value = aws_vpc.main.id
}

output "vpc_cidr" {
  value = aws_vpc.main.cidr_block
}

output "subnet_id" {
  value = aws_subnet.public.id
}

output "route_table_id" {
  value = aws_route_table.public.id
}

# ---------------------------------------------------------------------------
# Capture Lambda — staged only (R7). No VPC: a NAT gateway costs ~$32/month
# and this whole design exists to avoid that. 2048 MB because the capture
# settle is a deadline race, not a sleep, and low memory silently degrades
# capture *quality* rather than just slowing it down.
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "capture" {
  name              = "/aws/lambda/prospector-capture"
  retention_in_days = 14
}

resource "aws_sqs_queue" "capture_failed" {
  name                      = "prospector-capture-failed"
  message_retention_seconds = 1209600 # 14 days
}

resource "aws_iam_role" "capture_lambda" {
  name = "prospector-capture-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "capture_lambda" {
  name = "prospector-capture-lambda"
  role = aws_iam_role.capture_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.capture.arn}:*"
      },
      {
        Sid      = "WriteCaptures"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${data.terraform_remote_state.persist.outputs.capture_bucket_arn}/*/captures/*"
      },
      {
        Sid      = "OnFailure"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.capture_failed.arn
      },
    ]
  })
}

# count, not a conditional resource type — Terraform has no "resource that may
# not exist" primitive, so this is the idiom for "the function exists only
# once an image has actually been pushed" (design.md "Image tag without
# drift"). `./p up`'s first `terraform apply stack` runs before any image
# exists, when the SSM parameter is still "none"; the function appears on the
# second apply, after `./p ship` has written a real tag.
resource "aws_lambda_function" "capture" {
  count = data.aws_ssm_parameter.capture_image_tag.value != "none" ? 1 : 0

  function_name = "prospector-capture"
  role          = aws_iam_role.capture_lambda.arn
  package_type  = "Image"
  image_uri     = "${data.terraform_remote_state.persist.outputs.ecr_repository_url}:${data.aws_ssm_parameter.capture_image_tag.value}"

  architectures = ["arm64"]
  memory_size   = 2048
  timeout       = 900

  environment {
    variables = {
      CAPTURE_BUCKET = data.terraform_remote_state.persist.outputs.capture_bucket_name
    }
  }

  depends_on = [aws_cloudwatch_log_group.capture, aws_iam_role_policy.capture_lambda]
}

resource "aws_lambda_function_event_invoke_config" "capture" {
  count = length(aws_lambda_function.capture)

  function_name          = aws_lambda_function.capture[0].function_name
  maximum_retry_attempts = 2

  destination_config {
    on_failure {
      destination = aws_sqs_queue.capture_failed.arn
    }
  }
}

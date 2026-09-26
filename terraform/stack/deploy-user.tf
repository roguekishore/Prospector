# ---------------------------------------------------------------------------
# prospector-deploy — R8.1. `./p ship`, `status`, `logs` and `secrets` run
# under this user so the rogue root keys can be deleted after `./p up`
# finishes. Terraform creates the user and its policy; the access key is
# created out of band by `./p up` with the CLI so the secret never enters
# state (design.md "Auth").
#
# The Lambda's ARN is built from its fixed name rather than referenced off
# `aws_lambda_function.capture` — that resource is `count`-gated and does not
# exist on stack's first apply, before this user does.
# ---------------------------------------------------------------------------
locals {
  capture_function_arn = "arn:aws:lambda:ap-south-1:${data.aws_caller_identity.current.account_id}:function:prospector-capture"
}

resource "aws_iam_user" "deploy" {
  name = "prospector-deploy"
}

resource "aws_iam_user_policy" "deploy" {
  name = "prospector-deploy"
  user = aws_iam_user.deploy.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "PutReleases"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${data.terraform_remote_state.persist.outputs.deploy_bucket_arn}/releases/*"
      },
      {
        Sid    = "RunInstallOnBox"
        Effect = "Allow"
        Action = ["ssm:SendCommand"]
        Resource = [
          "arn:aws:ec2:ap-south-1:${data.aws_caller_identity.current.account_id}:instance/${aws_instance.box.id}",
          "arn:aws:ssm:ap-south-1::document/AWS-RunShellScript",
        ]
      },
      {
        # Neither action supports resource-level scoping in IAM — AWS requires "*".
        Sid      = "WatchCommands"
        Effect   = "Allow"
        Action   = ["ssm:GetCommandInvocation", "ssm:DescribeInstanceInformation"]
        Resource = "*"
      },
      {
        Sid      = "Secrets"
        Effect   = "Allow"
        Action   = ["ssm:PutParameter", "ssm:GetParameter", "ssm:GetParametersByPath"]
        Resource = "arn:aws:ssm:ap-south-1:${data.aws_caller_identity.current.account_id}:parameter/prospector/*"
      },
      {
        Sid      = "UpdateCaptureFunction"
        Effect   = "Allow"
        Action   = ["lambda:UpdateFunctionCode", "lambda:GetFunction"]
        Resource = local.capture_function_arn
      },
      {
        Sid      = "CheckEcrTag"
        Effect   = "Allow"
        Action   = ["ecr:DescribeImages"]
        Resource = data.terraform_remote_state.persist.outputs.ecr_repository_arn
      },
      {
        # R6.3 wants `./p status` to report the failure-queue depth, but the queue
        # lookup was guarded by `|| true` and this user had no SQS access at all,
        # so the line was skipped in silence and status looked complete without it.
        # Read-only, and only this queue.
        Sid      = "ReadFailureQueue"
        Effect   = "Allow"
        Action   = ["sqs:GetQueueUrl", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.capture_failed.arn
      },
    ]
  })
}

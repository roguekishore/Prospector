# ---------------------------------------------------------------------------
# Role — SSM shell (no port 22), read-only on /prospector/*, read the deploy
# bucket's releases, write the capture bucket's places prefixes (backup runs
# under this role, no separate credentials on the box), and push to ECR (the
# image is built on the box itself — see Dockerfile.capture and install.sh).
# ---------------------------------------------------------------------------
resource "aws_iam_role" "box" {
  name = "prospector-box"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "box_ssm" {
  role       = aws_iam_role.box.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "box" {
  name = "prospector-box"
  role = aws_iam_role.box.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadSecrets"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParametersByPath"]
        Resource = "arn:aws:ssm:ap-south-1:${data.aws_caller_identity.current.account_id}:parameter/prospector/*"
      },
      {
        Sid      = "ReadReleases"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${data.terraform_remote_state.persist.outputs.deploy_bucket_arn}/releases/*"
      },
      {
        Sid      = "WritePlacesBackup"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:HeadObject"]
        Resource = "${data.terraform_remote_state.persist.outputs.capture_bucket_arn}/*/places/*"
      },
      {
        Sid      = "EcrAuth"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "EcrPush"
        Effect = "Allow"
        Action = [
          "ecr:DescribeImages",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
        ]
        Resource = data.terraform_remote_state.persist.outputs.ecr_repository_arn
      },
    ]
  })
}

resource "aws_iam_instance_profile" "box" {
  name = "prospector-box"
  role = aws_iam_role.box.name
}

# ---------------------------------------------------------------------------
# The box — t4g.small, Ubuntu 24.04 arm64. IMDSv2 required; standard (not
# unlimited) CPU credits, since a runaway process should throttle rather than
# quietly bill.
# ---------------------------------------------------------------------------
resource "aws_instance" "box" {
  ami                    = data.aws_ami.ubuntu_noble_arm64.id
  instance_type          = "t4g.small"
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.box.id]
  iam_instance_profile   = aws_iam_instance_profile.box.name

  root_block_device {
    volume_type = "gp3"
    volume_size = 20
  }

  credit_specification {
    cpu_credits = "standard"
  }

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  user_data = templatefile("${path.module}/user-data.sh.tpl", {
    deploy_bucket = data.terraform_remote_state.persist.outputs.deploy_bucket_name
  })

  tags = {
    Name = "prospector-box"
  }
}

resource "aws_eip" "box" {
  domain   = "vpc"
  instance = aws_instance.box.id

  tags = {
    Name = "prospector-box"
  }
}

# The data volume lives in persist/ — R5.1, survives `./p down`. Attaching it
# here, not there, is what makes that survival possible: a fresh box created
# by a later `./p up` re-attaches the same volume instead of getting a blank
# one.
resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = data.terraform_remote_state.persist.outputs.data_volume_id
  instance_id = aws_instance.box.id
}

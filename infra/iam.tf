resource "aws_iam_role" "lambda" {
  name = "${var.project_name}-subagent-manager"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda" {
  name = "subagent-manager"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "StateTable"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:TransactWriteItems",
          "dynamodb:UpdateItem",
          "dynamodb:Query"
        ]
        Resource = [
          aws_dynamodb_table.state.arn,
          "${aws_dynamodb_table.state.arn}/index/instance-index"
        ]
      },
      {
        Sid      = "AuditWrites"
        Effect   = "Allow"
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.audit.arn}/*"
      },
      {
        Sid    = "LaunchAndTagInstances"
        Effect = "Allow"
        Action = [
          "ec2:CreateTags",
          "ec2:RunInstances",
          "ec2:TerminateInstances"
        ]
        Resource = "*"
      },
      {
        Sid      = "PassSubagentRole"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = aws_iam_role.subagent.arn
      }
    ]
  })
}

resource "aws_iam_role" "subagent" {
  name = "${var.project_name}-subagent"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_instance_profile" "subagent" {
  name = "${var.project_name}-subagent"
  role = aws_iam_role.subagent.name
}

resource "aws_iam_role_policy" "subagent" {
  name = "audit-bucket"
  role = aws_iam_role.subagent.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "s3:GetObject",
        "s3:PutObject"
      ]
      Resource = "${aws_s3_bucket.audit.arn}/agent-data/*"
    }]
  })
}

resource "aws_iam_role" "stress_test" {
  count = var.create_stress_test_instance ? 1 : 0
  name  = "${var.project_name}-stress-test"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_instance_profile" "stress_test" {
  count = var.create_stress_test_instance ? 1 : 0
  name  = "${var.project_name}-stress-test"
  role  = aws_iam_role.stress_test[0].name
}

resource "aws_iam_role_policy" "stress_test" {
  count = var.create_stress_test_instance ? 1 : 0
  name  = "invoke-and-report"
  role  = aws_iam_role.stress_test[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = aws_lambda_function.subagent_manager.arn
      },
      {
        Effect   = "Allow"
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.audit.arn}/stress-tests/*"
      }
    ]
  })
}

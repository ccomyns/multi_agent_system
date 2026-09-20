locals {
  software_subagent_iam_prefix  = "${substr(var.project_name, 0, 20)}-sw-"
  software_subagent_role_arn    = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${local.software_subagent_iam_prefix}*"
  software_subagent_profile_arn = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:instance-profile/${local.software_subagent_iam_prefix}*"
  codex_auth_parameter_arn      = "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.codex_auth_ssm_parameter_name}"
}

// A ceiling on dynamically created roles. Each role's inline policy further
// restricts all data reads and writes to one literal project/agent prefix.
resource "aws_iam_policy" "software_subagent_boundary" {
  name = "${var.project_name}-software-agent-boundary"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"], Resource = "${aws_s3_bucket.global_memory.arn}/*" },
      { Effect = "Allow", Action = "s3:ListBucket", Resource = aws_s3_bucket.global_memory.arn },
      { Effect = "Allow", Action = "s3:GetObject", Resource = "${aws_s3_bucket.agent_workspace.arn}/${aws_s3_object.software_subagent_runtime.key}" },
      { Effect = "Allow", Action = "ssm:GetParameter", Resource = local.codex_auth_parameter_arn }
    ]
  })
}

resource "aws_iam_role_policy" "software_subagent_manager" {
  name = "software-agents"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "iam:CreateRole", Resource = local.software_subagent_role_arn,
      Condition = { StringEquals = { "iam:PermissionsBoundary" = aws_iam_policy.software_subagent_boundary.arn } } },
      { Effect = "Allow", Action = ["iam:TagRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:DeleteRole", "iam:GetRole"], Resource = local.software_subagent_role_arn },
      { Effect = "Allow", Action = ["iam:CreateInstanceProfile", "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile", "iam:DeleteInstanceProfile", "iam:GetInstanceProfile"], Resource = local.software_subagent_profile_arn },
      { Effect = "Allow", Action = "iam:PassRole", Resource = local.software_subagent_role_arn,
      Condition = { StringEquals = { "iam:PassedToService" = "ec2.amazonaws.com" } } },
      { Effect = "Allow", Action = "ec2:DescribeInstances", Resource = "*" },
      { Effect = "Allow", Action = "dynamodb:Scan", Resource = aws_dynamodb_table.state.arn },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"], Resource = aws_dynamodb_table.jobs.arn },
      { Effect = "Allow", Action = "dynamodb:GetItem", Resource = aws_dynamodb_table.github_repository_assignments.arn },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.global_memory.arn}/*" }
    ]
  })
}

resource "aws_cloudwatch_event_rule" "software_subagent_reconcile" {
  name                = "${var.project_name}-software-agent-reconcile"
  schedule_expression = "rate(1 minute)"
}
resource "aws_cloudwatch_event_target" "software_subagent_reconcile" {
  rule  = aws_cloudwatch_event_rule.software_subagent_reconcile.name
  arn   = aws_lambda_function.subagent_manager.arn
  input = jsonencode({ action = "software_reconcile" })
}
resource "aws_lambda_permission" "software_subagent_reconcile" {
  statement_id  = "SoftwareSubagentReconcile"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.subagent_manager.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.software_subagent_reconcile.arn
}

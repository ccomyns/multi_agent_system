data "archive_file" "subagent_manager" {
  type        = "zip"
  source_file = "${path.module}/../src/subagent_manager/handler.py"
  output_path = "${path.module}/subagent-manager.zip"
}

resource "aws_cloudwatch_log_group" "subagent_manager" {
  name              = "/aws/lambda/${var.project_name}-subagent-manager"
  retention_in_days = 14
}

resource "aws_lambda_function" "subagent_manager" {
  function_name = "${var.project_name}-subagent-manager"
  description   = "Atomically limits and launches EC2-based research subagents."
  role          = aws_iam_role.lambda.arn
  handler       = "handler.lambda_handler"
  runtime       = "python3.13"
  architectures = ["arm64"]
  timeout       = 60
  memory_size   = 256

  filename         = data.archive_file.subagent_manager.output_path
  source_code_hash = data.archive_file.subagent_manager.output_base64sha256

  environment {
    variables = {
      AUDIT_BUCKET_NAME              = aws_s3_bucket.audit.id
      MAX_ACTIVE_SUBAGENTS           = tostring(var.max_active_subagents)
      STATE_TABLE_NAME               = aws_dynamodb_table.state.name
      SUBAGENT_AMI_ID                = local.subagent_ami_id
      SUBAGENT_INSTANCE_PROFILE_NAME = aws_iam_instance_profile.subagent.name
      SUBAGENT_INSTANCE_TYPE         = var.subagent_instance_type
      SUBAGENT_SECURITY_GROUP_ID     = aws_security_group.instances.id
      SUBAGENT_SUBNET_ID             = aws_subnet.public.id
      SUBAGENT_TTL_SECONDS           = tostring(var.subagent_ttl_seconds)
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.subagent_manager,
    aws_iam_role_policy.lambda,
    aws_iam_role_policy_attachment.lambda_logs,
  ]
}

resource "aws_cloudwatch_event_rule" "subagent_terminated" {
  name        = "${var.project_name}-subagent-terminated"
  description = "Reconcile EC2 instance termination with active subagent state."

  event_pattern = jsonencode({
    source      = ["aws.ec2"]
    detail-type = ["EC2 Instance State-change Notification"]
    detail = {
      state = ["terminated"]
    }
  })
}

resource "aws_cloudwatch_event_target" "subagent_terminated" {
  rule      = aws_cloudwatch_event_rule.subagent_terminated.name
  target_id = "subagent-manager"
  arn       = aws_lambda_function.subagent_manager.arn
}

resource "aws_lambda_permission" "eventbridge" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.subagent_manager.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.subagent_terminated.arn
}

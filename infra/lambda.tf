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
      AGENT_WORKSPACE_BUCKET_NAME    = aws_s3_bucket.agent_workspace.id
      AUDIT_BUCKET_NAME              = aws_s3_bucket.audit.id
      CODEX_AUTH_SSM_PARAMETER_NAME  = local.codex_auth_ssm_parameter_name
      GLOBAL_MEMORY_BUCKET_NAME      = aws_s3_bucket.global_memory.id
      MAX_ACTIVE_SUBAGENTS           = tostring(var.max_active_subagents)
      RUNTIME_ARTIFACT_BUCKET        = aws_s3_bucket.agent_workspace.id
      RUNTIME_ARTIFACT_BUCKET_OWNER  = data.aws_caller_identity.current.account_id
      STATE_TABLE_NAME               = aws_dynamodb_table.state.name
      SUBAGENT_AMI_ID                = local.subagent_ami_id
      SUBAGENT_INSTANCE_PROFILE_NAME = aws_iam_instance_profile.subagent.name
      SUBAGENT_INSTANCE_TYPE         = var.subagent_instance_type
      SUBAGENT_SECURITY_GROUP_ID     = aws_security_group.instances.id
      SUBAGENT_SUBNET_ID             = aws_subnet.public.id
      SUBAGENT_TTL_SECONDS           = tostring(var.subagent_ttl_seconds)
      SUBAGENT_MODEL                 = var.subagent_model
      SUBAGENT_RUNTIME_NAME          = "data-mining"
      SUBAGENT_RUNTIME_S3_KEY        = aws_s3_object.subagent_runtime.key
      SUBAGENT_RUNTIME_SHA256        = data.archive_file.subagent_runtime.output_sha256
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.subagent_manager,
    aws_iam_role_policy.lambda,
    aws_iam_role_policy_attachment.lambda_logs,
  ]
}

data "archive_file" "subagent_terminator" {
  type        = "zip"
  source_file = "${path.module}/../src/subagent_terminator/handler.py"
  output_path = "${path.module}/subagent-terminator.zip"
}

resource "aws_cloudwatch_log_group" "subagent_terminator" {
  name              = "/aws/lambda/${var.project_name}-subagent-terminator"
  retention_in_days = 14
}

resource "aws_lambda_function" "subagent_terminator" {
  function_name = "${var.project_name}-subagent-terminator"
  description   = "Terminate a subagent after its durable terminal artifacts reach S3."
  role          = aws_iam_role.subagent_terminator.arn
  handler       = "handler.lambda_handler"
  runtime       = "python3.13"
  architectures = ["arm64"]
  timeout       = 30
  memory_size   = 128

  filename         = data.archive_file.subagent_terminator.output_path
  source_code_hash = data.archive_file.subagent_terminator.output_base64sha256

  environment {
    variables = {
      AGENT_WORKSPACE_BUCKET_NAME = aws_s3_bucket.agent_workspace.id
      STATE_TABLE_NAME            = aws_dynamodb_table.state.name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.subagent_terminator,
    aws_iam_role_policy.subagent_terminator,
    aws_iam_role_policy_attachment.subagent_terminator_logs,
  ]
}

resource "aws_lambda_permission" "agent_workspace_termination_requests" {
  statement_id   = "AllowAgentWorkspaceTerminationRequests"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.subagent_terminator.function_name
  principal      = "s3.amazonaws.com"
  source_arn     = aws_s3_bucket.agent_workspace.arn
  source_account = data.aws_caller_identity.current.account_id
}

data "archive_file" "github_token_broker" {
  type        = "zip"
  source_dir  = "${path.module}/../src/github_token_broker"
  output_path = "${path.module}/github-token-broker.zip"
}

resource "aws_cloudwatch_log_group" "github_token_broker" {
  name              = "/aws/lambda/${var.project_name}-github-token-broker"
  retention_in_days = 14
}

resource "aws_lambda_function" "github_token_broker" {
  function_name = "${var.project_name}-github-token-broker"
  description   = "Issues short-lived GitHub App tokens scoped to a software job's assigned repository."
  role          = aws_iam_role.github_token_broker.arn
  handler       = "handler.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  timeout       = 15
  memory_size   = 256

  filename         = data.archive_file.github_token_broker.output_path
  source_code_hash = data.archive_file.github_token_broker.output_base64sha256

  environment {
    variables = {
      GITHUB_ORGANIZATION                          = var.github_organization
      GITHUB_REPOSITORY_ASSIGNMENTS_TABLE_NAME     = aws_dynamodb_table.github_repository_assignments.name
      GITHUB_WRITER_APP_CLIENT_ID                  = var.github_writer_app_client_id
      GITHUB_WRITER_PRIVATE_KEY_SSM_PARAMETER_NAME = local.github_writer_private_key_ssm_parameter_name
      JOBS_TABLE_NAME                              = aws_dynamodb_table.jobs.name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.github_token_broker,
    aws_iam_role_policy.github_token_broker,
    aws_iam_role_policy_attachment.github_token_broker_logs,
  ]
}

data "archive_file" "project_credentials_broker" {
  type        = "zip"
  source_file = "${path.module}/../src/project_credentials_broker/handler.py"
  output_path = "${path.module}/project-credentials-broker.zip"
}

resource "aws_cloudwatch_log_group" "project_credentials_broker" {
  name              = "/aws/lambda/${var.project_name}-project-credentials-broker"
  retention_in_days = 14
}

resource "aws_lambda_function" "project_credentials_broker" {
  function_name = "${var.project_name}-project-credentials-broker"
  description   = "Issues short-lived AWS credentials scoped to a software job's assigned global-memory project."
  role          = aws_iam_role.project_credentials_broker.arn
  handler       = "handler.lambda_handler"
  runtime       = "python3.13"
  architectures = ["arm64"]
  timeout       = 15
  memory_size   = 128

  filename         = data.archive_file.project_credentials_broker.output_path
  source_code_hash = data.archive_file.project_credentials_broker.output_base64sha256

  environment {
    variables = {
      GITHUB_REPOSITORY_ASSIGNMENTS_TABLE_NAME = aws_dynamodb_table.github_repository_assignments.name
      GLOBAL_MEMORY_BUCKET_NAME                = aws_s3_bucket.global_memory.id
      JOBS_TABLE_NAME                          = aws_dynamodb_table.jobs.name
      PROJECT_WORKSPACE_ROLE_ARN               = aws_iam_role.software_builder_project_workspace.arn
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.project_credentials_broker,
    aws_iam_role_policy.project_credentials_broker,
    aws_iam_role_policy_attachment.project_credentials_broker_logs,
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

output "audit_bucket_name" {
  description = "S3 bucket containing lifecycle audit records."
  value       = aws_s3_bucket.audit.id
}

output "global_memory_bucket_name" {
  description = "S3 bucket containing durable memory shared across multi-agent jobs."
  value       = aws_s3_bucket.global_memory.id
}

output "agent_workspace_bucket_name" {
  description = "S3 bucket containing per-job agent inputs, artifacts, and results."
  value       = aws_s3_bucket.agent_workspace.id
}

output "lambda_function_name" {
  description = "Name to use when invoking the subagent manager."
  value       = aws_lambda_function.subagent_manager.function_name
}

output "subagent_terminator_function_name" {
  description = "Lambda invoked by durable subagent termination requests."
  value       = aws_lambda_function.subagent_terminator.function_name
}

output "state_table_name" {
  description = "DynamoDB table containing counters and active agent state."
  value       = aws_dynamodb_table.state.name
}

output "jobs_table_name" {
  description = "DynamoDB table containing job records and the single active-job lock."
  value       = aws_dynamodb_table.jobs.name
}

output "github_repository_assignments_table_name" {
  description = "DynamoDB table containing trusted software-builder repository and project assignments."
  value       = aws_dynamodb_table.github_repository_assignments.name
}

output "rds_endpoint" {
  description = "Hostname of the public proof-of-concept PostgreSQL RDS instance."
  value       = aws_db_instance.postgresql.address
}

output "rds_port" {
  description = "Port of the proof-of-concept PostgreSQL RDS instance."
  value       = aws_db_instance.postgresql.port
}

output "rds_database_identifier" {
  description = "AWS identifier of the proof-of-concept PostgreSQL RDS instance."
  value       = aws_db_instance.postgresql.identifier
}

output "rds_database_name" {
  description = "Initial database name on the proof-of-concept PostgreSQL RDS instance."
  value       = aws_db_instance.postgresql.db_name
}

output "postgresql_ssm_parameter_prefix" {
  description = "SSM Parameter Store hierarchy containing PostgreSQL connection information."
  value       = local.postgresql_ssm_parameter_prefix
}

output "postgresql_ssm_parameter_names" {
  description = "Names of the SSM parameters containing PostgreSQL connection information."
  value = {
    host          = aws_ssm_parameter.postgresql_host.name
    port          = aws_ssm_parameter.postgresql_port.name
    database_name = aws_ssm_parameter.postgresql_database_name.name
    username      = aws_ssm_parameter.postgresql_username.name
    password      = aws_ssm_parameter.postgresql_password.name
  }
}

output "job_results_prefix" {
  description = "S3 location under which each orchestrator writes its final output."
  value       = "s3://${aws_s3_bucket.agent_workspace.id}/jobs/"
}

output "admin_server_iam_user_name" {
  description = "IAM user the admin server authenticates as. Create access keys locally; do not store them in Terraform state."
  value       = aws_iam_user.admin_server.name
}

output "codex_auth_ssm_parameter_name" {
  description = "Out-of-band SSM SecureString from which real orchestrators load auth.json."
  value       = local.codex_auth_ssm_parameter_name
}

output "github_token_broker_function_name" {
  description = "Lambda function an orchestrator invokes to obtain a repository-scoped GitHub installation token."
  value       = aws_lambda_function.github_token_broker.function_name
}

output "project_credentials_broker_function_name" {
  description = "Lambda function a software-builder orchestrator invokes to obtain project-scoped AWS credentials."
  value       = aws_lambda_function.project_credentials_broker.function_name
}

output "vercel_publisher_function_name" {
  description = "Lambda function invoked by the software-builder Vercel MCP server."
  value       = aws_lambda_function.vercel_publisher.function_name
}

output "vercel_access_token_ssm_parameter_name" {
  description = "Out-of-band SSM SecureString name containing the Vercel access token."
  value       = local.vercel_access_token_ssm_parameter_name
}

output "software_builder_project_workspace_role_arn" {
  description = "Session-tagged IAM role used for access to one assigned global-memory project."
  value       = aws_iam_role.software_builder_project_workspace.arn
}

output "github_writer_private_key_ssm_parameter_name" {
  description = "Out-of-band SSM SecureString name for the GitHub writer App PEM."
  value       = local.github_writer_private_key_ssm_parameter_name
}

output "github_writer_private_key_kms_key_arn" {
  description = "KMS key that must encrypt the GitHub writer private-key SecureString."
  value       = aws_kms_key.github_writer_private_key.arn
}

output "github_writer_private_key_kms_alias" {
  description = "KMS alias for the GitHub writer private-key SecureString."
  value       = aws_kms_alias.github_writer_private_key.name
}

output "orchestrator_ami_id" {
  description = "Prebaked AMI for on-demand orchestrators."
  value       = local.orchestrator_ami_id
}

output "software_builder_orchestrator_ami_id" {
  description = "Independently built AMI used only by software-builder orchestrators."
  value       = local.software_builder_orchestrator_ami_id
}

output "subagent_ami_id" {
  description = "Prebaked browser-enabled AMI used by the subagent manager Lambda."
  value       = local.subagent_ami_id
}

output "orchestrator_launch_template_id" {
  description = "Launch template for a normal on-demand orchestrator run."
  value       = aws_launch_template.orchestrator.id
}

output "orchestrator_launch_template_version" {
  description = "Default version of the normal orchestrator launch template."
  value       = aws_launch_template.orchestrator.default_version
}

output "software_builder_orchestrator_launch_template_id" {
  description = "Launch template used only for software-builder orchestrator runs."
  value       = aws_launch_template.software_builder_orchestrator.id
}

output "software_builder_orchestrator_launch_template_version" {
  description = "Default version of the software-builder orchestrator launch template."
  value       = aws_launch_template.software_builder_orchestrator.default_version
}

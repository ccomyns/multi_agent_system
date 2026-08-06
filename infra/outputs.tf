output "audit_bucket_name" {
  description = "S3 bucket containing lifecycle and stress-test audit records."
  value       = aws_s3_bucket.audit.id
}

output "lambda_function_name" {
  description = "Name to use when invoking the subagent manager."
  value       = aws_lambda_function.subagent_manager.function_name
}

output "state_table_name" {
  description = "DynamoDB table containing counters and active agent state."
  value       = aws_dynamodb_table.state.name
}

output "jobs_table_name" {
  description = "DynamoDB table containing job records and the single active-job lock."
  value       = aws_dynamodb_table.jobs.name
}

output "job_results_prefix" {
  description = "S3 location under which each orchestrator writes its final output."
  value       = "s3://${aws_s3_bucket.audit.id}/jobs/"
}

output "admin_server_iam_user_name" {
  description = "IAM user the admin server authenticates as. Create access keys locally; do not store them in Terraform state."
  value       = aws_iam_user.admin_server.name
}

output "codex_auth_ssm_parameter_name" {
  description = "Out-of-band SSM SecureString from which real orchestrators load auth.json."
  value       = local.codex_auth_ssm_parameter_name
}

output "orchestrator_ami_id" {
  description = "Prebaked AMI for on-demand orchestrators."
  value       = local.orchestrator_ami_id
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

output "orchestrator_stress_test_launch_template_id" {
  description = "Launch template for an on-demand, self-terminating concurrency stress test."
  value       = aws_launch_template.orchestrator_stress_test.id
}

output "orchestrator_stress_test_launch_template_version" {
  description = "Default version of the stress-test orchestrator launch template."
  value       = aws_launch_template.orchestrator_stress_test.default_version
}

output "stress_test_results_prefix" {
  description = "S3 location in which the caller writes its JSON report and boot log."
  value       = "s3://${aws_s3_bucket.audit.id}/stress-tests/"
}

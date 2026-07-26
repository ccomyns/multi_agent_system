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

output "stress_test_instance_id" {
  description = "One-shot stress-test caller instance, when enabled."
  value       = try(aws_instance.stress_test[0].id, null)
}

output "stress_test_results_prefix" {
  description = "S3 location in which the caller writes its JSON report and boot log."
  value       = "s3://${aws_s3_bucket.audit.id}/stress-tests/"
}

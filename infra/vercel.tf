locals {
  vercel_access_token_ssm_parameter_name = coalesce(
    var.vercel_access_token_ssm_parameter_name,
    "/${var.project_name}/vercel/access-token"
  )
  vercel_access_token_ssm_parameter_arn = "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.vercel_access_token_ssm_parameter_name}"
}

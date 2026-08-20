locals {
  github_writer_private_key_ssm_parameter_name = coalesce(
    var.github_writer_private_key_ssm_parameter_name,
    "/${var.project_name}/github/writer-private-key"
  )
  github_writer_private_key_ssm_parameter_arn = "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.github_writer_private_key_ssm_parameter_name}"
}

// Terraform owns the encryption key and every consumer permission, but it does
// not own an aws_ssm_parameter resource. The PEM is populated out of band so
// its plaintext can never be written into Terraform configuration or state.
resource "aws_kms_key" "github_writer_private_key" {
  description             = "Encrypts the GitHub writer App private key in SSM Parameter Store."
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "github_writer_private_key" {
  name          = "alias/${var.project_name}/github-writer-private-key"
  target_key_id = aws_kms_key.github_writer_private_key.key_id
}

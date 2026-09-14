locals {
  vercel_access_token_ssm_parameter_name = coalesce(
    var.vercel_access_token_ssm_parameter_name,
    "/${var.project_name}/vercel/access-token"
  )
  vercel_access_token_ssm_parameter_arn = "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.vercel_access_token_ssm_parameter_name}"
}

# Shared by production websites in this Vercel team. S3_PREFIX is an application
# routing hint; this role intentionally allows reads across the whole bucket.
resource "aws_iam_openid_connect_provider" "vercel" {
  url            = "https://oidc.vercel.com/${var.vercel_team_slug}"
  client_id_list = ["https://vercel.com/${var.vercel_team_slug}"]
}

resource "aws_iam_role" "vercel_global_memory_reader" {
  name = "${var.project_name}-vercel-global-memory-reader"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.vercel.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "oidc.vercel.com/${var.vercel_team_slug}:aud" = "https://vercel.com/${var.vercel_team_slug}"
        }
        StringLike = {
          "oidc.vercel.com/${var.vercel_team_slug}:sub" = "owner:${var.vercel_team_slug}:project:*:environment:production"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "vercel_global_memory_reader" {
  name = "read-global-memory"
  role = aws_iam_role.vercel_global_memory_reader.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:GetBucketLocation"]
        Resource = aws_s3_bucket.global_memory.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.global_memory.arn}/*"
      }
    ]
  })
}

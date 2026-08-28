// Runtime code and documentation are packaged separately from the Image
// Builder component document. The content hash in the key makes each bundle
// immutable and lets the component pin the exact artifact it installs.
data "archive_file" "orchestrator_runtime" {
  type        = "zip"
  source_dir  = "${path.module}/runtime/orchestrator"
  output_path = "${path.module}/orchestrator-runtime.zip"
  excludes    = ["**/__pycache__/**", "**/*.pyc"]
}

resource "aws_s3_object" "orchestrator_runtime" {
  bucket = aws_s3_bucket.agent_workspace.id
  key    = "system/image-build/orchestrator/${filesha256(data.archive_file.orchestrator_runtime.output_path)}/runtime.zip"
  source = data.archive_file.orchestrator_runtime.output_path

  source_hash            = data.archive_file.orchestrator_runtime.output_base64sha256
  content_type           = "application/zip"
  server_side_encryption = "AES256"
}

data "archive_file" "software_builder_runtime" {
  type        = "zip"
  source_dir  = "${path.module}/runtime/orch_software_builder"
  output_path = "${path.module}/software-builder-runtime.zip"
  excludes    = ["**/__pycache__/**", "**/*.pyc"]
}

resource "aws_s3_object" "software_builder_runtime" {
  bucket = aws_s3_bucket.agent_workspace.id
  key    = "system/image-build/orch-software-builder/${filesha256(data.archive_file.software_builder_runtime.output_path)}/runtime.zip"
  source = data.archive_file.software_builder_runtime.output_path

  source_hash            = data.archive_file.software_builder_runtime.output_base64sha256
  content_type           = "application/zip"
  server_side_encryption = "AES256"
}

data "archive_file" "subagent_runtime" {
  type        = "zip"
  source_dir  = "${path.module}/runtime/subagent"
  output_path = "${path.module}/subagent-runtime.zip"
  excludes    = ["**/__pycache__/**", "**/*.pyc"]
}

resource "aws_s3_object" "subagent_runtime" {
  bucket = aws_s3_bucket.agent_workspace.id
  key    = "system/image-build/subagent/${filesha256(data.archive_file.subagent_runtime.output_path)}/runtime.zip"
  source = data.archive_file.subagent_runtime.output_path

  source_hash            = data.archive_file.subagent_runtime.output_base64sha256
  content_type           = "application/zip"
  server_side_encryption = "AES256"
}

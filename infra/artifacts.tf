// Each runtime is a self-contained, content-addressed artifact. AMIs contain
// only slow-changing dependencies and download exactly one pinned runtime at
// launch, so Python, prompt, and documentation changes do not rebuild images.
data "archive_file" "data_mining_orchestrator_runtime" {
  type        = "zip"
  source_dir  = "${path.module}/runtime/orchestrator"
  output_path = "${path.module}/data-mining-orchestrator-runtime.zip"
  excludes    = ["**/__pycache__/**", "**/*.pyc"]
}

resource "aws_s3_object" "data_mining_orchestrator_runtime" {
  bucket = aws_s3_bucket.agent_workspace.id
  key    = "system/runtime/orchestrator-data-mining/${data.archive_file.data_mining_orchestrator_runtime.output_sha256}/runtime.zip"
  source = data.archive_file.data_mining_orchestrator_runtime.output_path

  source_hash            = data.archive_file.data_mining_orchestrator_runtime.output_base64sha256
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
  key    = "system/runtime/software-builder/${data.archive_file.software_builder_runtime.output_sha256}/runtime.zip"
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
  key    = "system/runtime/subagent-data-mining/${data.archive_file.subagent_runtime.output_sha256}/runtime.zip"
  source = data.archive_file.subagent_runtime.output_path

  source_hash            = data.archive_file.subagent_runtime.output_base64sha256
  content_type           = "application/zip"
  server_side_encryption = "AES256"
}

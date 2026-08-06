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
  bucket = aws_s3_bucket.audit.id
  key    = "image-build/orchestrator/${filesha256(data.archive_file.orchestrator_runtime.output_path)}/runtime.zip"
  source = data.archive_file.orchestrator_runtime.output_path

  source_hash            = data.archive_file.orchestrator_runtime.output_base64sha256
  content_type           = "application/zip"
  server_side_encryption = "AES256"
}

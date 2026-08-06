resource "aws_s3_bucket" "audit" {
  bucket        = "${var.project_name}-audit-${data.aws_caller_identity.current.account_id}-${random_id.suffix.hex}"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "audit" {
  bucket = aws_s3_bucket.audit.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "audit" {
  bucket = aws_s3_bucket.audit.id

  versioning_configuration {
    status = "Enabled"
  }
}

// Durable, cross-job memory populated by a separate trusted ingestion workflow.
// Versioning protects the accumulated knowledge base from accidental overwrites.
resource "aws_s3_bucket" "global_memory" {
  bucket        = "${var.project_name}-global-memory-${data.aws_caller_identity.current.account_id}-${random_id.suffix.hex}"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "global_memory" {
  bucket = aws_s3_bucket.global_memory.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "global_memory" {
  bucket = aws_s3_bucket.global_memory.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "global_memory" {
  bucket = aws_s3_bucket.global_memory.id

  versioning_configuration {
    status = "Enabled"
  }
}

// Per-job task specifications, intermediate artifacts, subagent output, final
// results, and versioned runtime packages used by Image Builder.
resource "aws_s3_bucket" "agent_workspace" {
  bucket        = "${var.project_name}-agent-workspace-${data.aws_caller_identity.current.account_id}-${random_id.suffix.hex}"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "agent_workspace" {
  bucket = aws_s3_bucket.agent_workspace.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "agent_workspace" {
  bucket = aws_s3_bucket.agent_workspace.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "agent_workspace" {
  bucket = aws_s3_bucket.agent_workspace.id

  versioning_configuration {
    status = "Enabled"
  }
}

// Holds one item per multi-agent job plus a single lock item. The admin server
// writes both in one transaction so at most one job can ever be active.
resource "aws_dynamodb_table" "jobs" {
  name         = "${var.project_name}-jobs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }
}

resource "aws_dynamodb_table" "state" {
  name         = "${var.project_name}-state"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  global_secondary_index {
    name = "instance-index"

    key_schema {
      attribute_name = "gsi1pk"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "gsi1sk"
      key_type       = "RANGE"
    }

    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }
}

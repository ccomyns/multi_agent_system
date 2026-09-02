resource "aws_iam_role" "lambda" {
  name = "${var.project_name}-subagent-manager"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda" {
  name = "subagent-manager"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "StateTable"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:TransactWriteItems",
          "dynamodb:UpdateItem",
          "dynamodb:Query"
        ]
        Resource = [
          aws_dynamodb_table.state.arn,
          "${aws_dynamodb_table.state.arn}/index/instance-index"
        ]
      },
      {
        Sid      = "AuditWrites"
        Effect   = "Allow"
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.audit.arn}/*"
      },
      {
        Sid    = "ReadTerminalPanelProjection"
        Effect = "Allow"
        Action = "s3:GetObject"
        Resource = [
          "${aws_s3_bucket.agent_workspace.arn}/jobs/*/agents/*/status/*.json",
          "${aws_s3_bucket.agent_workspace.arn}/jobs/*/agents/*/telemetry/latest.json"
        ]
      },
      {
        Sid    = "LaunchAndTagInstances"
        Effect = "Allow"
        Action = [
          "ec2:CreateTags",
          "ec2:RunInstances",
          "ec2:TerminateInstances"
        ]
        Resource = "*"
      },
      {
        Sid      = "PassSubagentRole"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = aws_iam_role.subagent.arn
      }
    ]
  })
}

resource "aws_iam_role" "subagent_terminator" {
  name = "${var.project_name}-subagent-terminator"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "subagent_terminator_logs" {
  role       = aws_iam_role.subagent_terminator.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "subagent_terminator" {
  name = "validate-terminal-artifacts-and-terminate"
  role = aws_iam_role.subagent_terminator.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadAndAnnotateAgentState"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:UpdateItem"
        ]
        Resource = aws_dynamodb_table.state.arn
      },
      {
        Sid    = "ValidateTerminalArtifacts"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion"
        ]
        Resource = [
          "${aws_s3_bucket.agent_workspace.arn}/jobs/*/agents/*/termination/request.json",
          "${aws_s3_bucket.agent_workspace.arn}/jobs/*/agents/*/status/*.json",
          "${aws_s3_bucket.agent_workspace.arn}/jobs/*/agents/*/result/*.md"
        ]
      },
      {
        Sid      = "TerminateManagedSubagents"
        Effect   = "Allow"
        Action   = "ec2:TerminateInstances"
        Resource = "*"
        Condition = {
          StringEquals = {
            "ec2:ResourceTag/ManagedBy" = "subagent-manager"
          }
        }
      }
    ]
  })
}

// This role is the only runtime identity allowed to decrypt the GitHub writer
// App private key. Orchestrators receive repository-scoped installation tokens
// from the broker and never receive this role or its SSM/KMS permissions.
resource "aws_iam_role" "github_token_broker" {
  name = "${var.project_name}-github-token-broker"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "github_token_broker_logs" {
  role       = aws_iam_role.github_token_broker.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "github_token_broker" {
  name = "read-assignment-and-mint-token"
  role = aws_iam_role.github_token_broker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadActiveJob"
        Effect   = "Allow"
        Action   = "dynamodb:GetItem"
        Resource = aws_dynamodb_table.jobs.arn
      },
      {
        Sid      = "ReadTrustedRepositoryAssignment"
        Effect   = "Allow"
        Action   = "dynamodb:GetItem"
        Resource = aws_dynamodb_table.github_repository_assignments.arn
      },
      {
        Sid      = "ReadWriterPrivateKey"
        Effect   = "Allow"
        Action   = "ssm:GetParameter"
        Resource = local.github_writer_private_key_ssm_parameter_arn
      },
      {
        Sid      = "DecryptWriterPrivateKey"
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = aws_kms_key.github_writer_private_key.arn
        Condition = {
          StringEquals = {
            "kms:ViaService"                      = "ssm.${var.aws_region}.amazonaws.com"
            "kms:EncryptionContext:PARAMETER_ARN" = local.github_writer_private_key_ssm_parameter_arn
          }
        }
      }
    ]
  })
}

// The project credential broker validates the active software job and its
// immutable assignment before assuming a session-tagged S3 workspace role.
resource "aws_iam_role" "project_credentials_broker" {
  name = "${var.project_name}-project-credentials-broker"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "project_credentials_broker_logs" {
  role       = aws_iam_role.project_credentials_broker.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "project_credentials_broker" {
  name = "read-assignment-and-issue-project-session"
  role = aws_iam_role.project_credentials_broker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadActiveSoftwareJob"
        Effect   = "Allow"
        Action   = "dynamodb:GetItem"
        Resource = aws_dynamodb_table.jobs.arn
      },
      {
        Sid      = "ReadTrustedProjectAssignment"
        Effect   = "Allow"
        Action   = "dynamodb:GetItem"
        Resource = aws_dynamodb_table.github_repository_assignments.arn
      },
      {
        Sid    = "AssumeProjectWorkspace"
        Effect = "Allow"
        Action = [
          "sts:AssumeRole",
          "sts:TagSession"
        ]
        Resource = aws_iam_role.software_builder_project_workspace.arn
      }
    ]
  })
}

resource "aws_iam_role" "software_builder_project_workspace" {
  name                 = "${var.project_name}-software-builder-project-workspace"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        AWS = aws_iam_role.project_credentials_broker.arn
      }
      Action = [
        "sts:AssumeRole",
        "sts:TagSession"
      ]
    }]
  })
}

resource "aws_iam_role_policy" "software_builder_project_workspace" {
  name = "assigned-global-memory-project"
  role = aws_iam_role.software_builder_project_workspace.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadGlobalMemoryBucketLocation"
        Effect   = "Allow"
        Action   = "s3:GetBucketLocation"
        Resource = aws_s3_bucket.global_memory.arn
      },
      {
        Sid    = "ListAssignedProject"
        Effect = "Allow"
        Action = [
          "s3:ListBucket",
          "s3:ListBucketMultipartUploads",
          "s3:ListBucketVersions"
        ]
        Resource = aws_s3_bucket.global_memory.arn
        Condition = {
          StringLike = {
            "s3:prefix" = [
              "$${aws:PrincipalTag/ProjectName}",
              "$${aws:PrincipalTag/ProjectName}/*"
            ]
          }
        }
      },
      {
        Sid    = "ReadWriteAssignedProjectObjects"
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
          "s3:GetObject",
          "s3:GetObjectAttributes",
          "s3:GetObjectVersion",
          "s3:GetObjectVersionAttributes",
          "s3:ListMultipartUploadParts",
          "s3:PutObject",
          "s3:RestoreObject"
        ]
        Resource = "${aws_s3_bucket.global_memory.arn}/$${aws:PrincipalTag/ProjectName}/*"
      }
    ]
  })
}

resource "aws_iam_role" "subagent" {
  name = "${var.project_name}-subagent"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_instance_profile" "subagent" {
  name = "${var.project_name}-subagent"
  role = aws_iam_role.subagent.name
}

resource "aws_iam_role_policy" "subagent" {
  name = "workspace-and-memory"
  role = aws_iam_role.subagent.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyPrivateJobInputs"
        Effect = "Deny"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:GetObject",
          "s3:PutObject"
        ]
        Resource = "${aws_s3_bucket.agent_workspace.arn}/jobs/*/input/*"
      },
      {
        Sid      = "ListAgentWorkspace"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.agent_workspace.arn
        Condition = {
          StringLike = {
            "s3:prefix" = "jobs/*"
          }
        }
      },
      {
        Sid    = "ReadWriteAgentWorkspace"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject"
        ]
        Resource = "${aws_s3_bucket.agent_workspace.arn}/jobs/*"
      },
      {
        Sid      = "ReadDataMiningSubagentRuntime"
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.agent_workspace.arn}/system/runtime/subagent-data-mining/*"
      },
      {
        Sid      = "ListGlobalMemory"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.global_memory.arn
      },
      {
        Sid      = "ReadGlobalMemory"
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.global_memory.arn}/*"
      },
      {
        Sid      = "ReadCodexAuth"
        Effect   = "Allow"
        Action   = "ssm:GetParameter"
        Resource = "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.codex_auth_ssm_parameter_name}"
      }
    ]
  })
}

resource "aws_iam_role" "orchestrator" {
  name = "${var.project_name}-orchestrator"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_instance_profile" "orchestrator" {
  name = "${var.project_name}-orchestrator"
  role = aws_iam_role.orchestrator.name
}

resource "aws_iam_role_policy_attachment" "orchestrator_ssm" {
  role       = aws_iam_role.orchestrator.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "orchestrator" {
  name = "invoke-subagent-manager-and-report"
  role = aws_iam_role.orchestrator.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "InvokeRuntimeBrokers"
        Effect = "Allow"
        Action = "lambda:InvokeFunction"
        Resource = [
          aws_lambda_function.subagent_manager.arn,
          aws_lambda_function.github_token_broker.arn
        ]
      },
      {
        Sid    = "ReadAndFinishOwnJob"
        Effect = "Allow"
        Action = [
          "dynamodb:DeleteItem",
          "dynamodb:GetItem",
          "dynamodb:TransactWriteItems",
          "dynamodb:UpdateItem"
        ]
        Resource = aws_dynamodb_table.jobs.arn
      },
      {
        Sid    = "ReadAndRefreshCodexAuth"
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:PutParameter"
        ]
        Resource = "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.codex_auth_ssm_parameter_name}"
      },
      {
        Sid      = "ListAgentWorkspace"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.agent_workspace.arn
        Condition = {
          StringLike = {
            "s3:prefix" = "jobs/*"
          }
        }
      },
      {
        Sid    = "ReadWriteAgentWorkspace"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject"
        ]
        Resource = "${aws_s3_bucket.agent_workspace.arn}/jobs/*"
      },
      {
        Sid    = "ReadIsolatedOrchestratorRuntimes"
        Effect = "Allow"
        Action = "s3:GetObject"
        Resource = [
          "${aws_s3_bucket.agent_workspace.arn}/system/runtime/orchestrator-data-mining/*",
          "${aws_s3_bucket.agent_workspace.arn}/system/runtime/software-builder/*"
        ]
      },
      {
        Sid      = "ListGlobalMemory"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.global_memory.arn
      },
      {
        Sid      = "ReadGlobalMemory"
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.global_memory.arn}/*"
      }
    ]
  })
}

// Software builders use a distinct base identity. It deliberately retains the
// existing agent-workspace behavior but has no direct global-memory access;
// project access arrives only through the assignment-validating broker.
resource "aws_iam_role" "software_builder_orchestrator" {
  name = "${var.project_name}-software-builder-orchestrator"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_instance_profile" "software_builder_orchestrator" {
  name = "${var.project_name}-software-builder-orchestrator"
  role = aws_iam_role.software_builder_orchestrator.name
}

resource "aws_iam_role_policy_attachment" "software_builder_orchestrator_ssm" {
  role       = aws_iam_role.software_builder_orchestrator.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "software_builder_orchestrator" {
  name = "software-builder-runtime"
  role = aws_iam_role.software_builder_orchestrator.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "InvokeSoftwareBuilderBrokers"
        Effect = "Allow"
        Action = "lambda:InvokeFunction"
        Resource = [
          aws_lambda_function.github_token_broker.arn,
          aws_lambda_function.project_credentials_broker.arn
        ]
      },
      {
        Sid    = "ReadAndFinishOwnJob"
        Effect = "Allow"
        Action = [
          "dynamodb:DeleteItem",
          "dynamodb:GetItem",
          "dynamodb:TransactWriteItems",
          "dynamodb:UpdateItem"
        ]
        Resource = aws_dynamodb_table.jobs.arn
      },
      {
        Sid    = "ReadAndRefreshCodexAuth"
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:PutParameter"
        ]
        Resource = "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.codex_auth_ssm_parameter_name}"
      },
      {
        Sid    = "ReadPostgresqlCredentials"
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters"
        ]
        Resource = "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.postgresql_ssm_parameter_prefix}/*"
      },
      {
        Sid      = "ListAgentWorkspace"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.agent_workspace.arn
        Condition = {
          StringLike = {
            "s3:prefix" = "jobs/*"
          }
        }
      },
      {
        Sid    = "ReadWriteAgentWorkspace"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject"
        ]
        Resource = "${aws_s3_bucket.agent_workspace.arn}/jobs/*"
      },
      {
        Sid      = "ReadSoftwareBuilderRuntime"
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.agent_workspace.arn}/system/runtime/software-builder/*"
      }
    ]
  })
}

resource "aws_iam_role" "image_builder" {
  name = "${var.project_name}-image-builder"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_instance_profile" "image_builder" {
  name = "${var.project_name}-image-builder"
  role = aws_iam_role.image_builder.name
}

resource "aws_iam_role_policy_attachment" "image_builder" {
  role       = aws_iam_role.image_builder.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/EC2InstanceProfileForImageBuilder"
}

resource "aws_iam_role_policy_attachment" "image_builder_ssm" {
  role       = aws_iam_role.image_builder.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

// Long-lived identity behind the admin server. Its credentials never reach the
// browser: the Next.js server holds them and is the only caller that can claim
// the job lock and launch an orchestrator.
resource "aws_iam_user" "admin_server" {
  name = "${var.project_name}-admin-server"
}

resource "aws_iam_policy" "admin_server" {
  name        = "${var.project_name}-admin-server"
  description = "Permissions used by the admin server to launch and inspect research jobs."
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "UploadPrivateJobInputs"
        Effect   = "Allow"
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.agent_workspace.arn}/jobs/*/input/*"
      },
      {
        Sid    = "JobsTable"
        Effect = "Allow"
        Action = [
          "dynamodb:ConditionCheckItem",
          "dynamodb:DeleteItem",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Scan",
          "dynamodb:TransactWriteItems",
          "dynamodb:UpdateItem"
        ]
        Resource = aws_dynamodb_table.jobs.arn
      },
      {
        Sid    = "RepositoryAssignments"
        Effect = "Allow"
        Action = [
          "dynamodb:DeleteItem",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:TransactWriteItems"
        ]
        Resource = aws_dynamodb_table.github_repository_assignments.arn
      },
      {
        Sid    = "ReadSubagentState"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:Scan"
        ]
        Resource = [
          aws_dynamodb_table.state.arn,
          "${aws_dynamodb_table.state.arn}/index/instance-index"
        ]
      },
      {
        Sid    = "LaunchOrchestrators"
        Effect = "Allow"
        Action = [
          "ec2:CreateTags",
          "ec2:RunInstances"
        ]
        Resource = "*"
      },
      {
        Sid    = "DescribeOrchestrators"
        Effect = "Allow"
        Action = [
          "ec2:DescribeInstances",
          "ec2:DescribeLaunchTemplates",
          "ec2:DescribeLaunchTemplateVersions"
        ]
        Resource = "*"
      },
      {
        Sid      = "StopOrchestrators"
        Effect   = "Allow"
        Action   = "ec2:TerminateInstances"
        Resource = "*"

        Condition = {
          StringEquals = {
            "ec2:ResourceTag/Role" = "orchestrator"
          }
        }
      },
      {
        Sid    = "PassOrchestratorRole"
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = [
          aws_iam_role.orchestrator.arn,
          aws_iam_role.software_builder_orchestrator.arn
        ]

        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ec2.amazonaws.com"
          }
        }
      },
      {
        Sid    = "InspectDataBuckets"
        Effect = "Allow"
        Action = "s3:ListBucket"
        Resource = [
          aws_s3_bucket.agent_workspace.arn,
          aws_s3_bucket.audit.arn,
          aws_s3_bucket.global_memory.arn
        ]
      },
      {
        Sid    = "InspectDataObjects"
        Effect = "Allow"
        Action = "s3:GetObject"
        Resource = [
          "${aws_s3_bucket.agent_workspace.arn}/*",
          "${aws_s3_bucket.audit.arn}/*",
          "${aws_s3_bucket.global_memory.arn}/*"
        ]
      },
      {
        Sid      = "WriteGlobalMemoryProjects"
        Effect   = "Allow"
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.global_memory.arn}/*"
      }
    ]
  })
}

resource "aws_iam_user_policy_attachment" "admin_server" {
  user       = aws_iam_user.admin_server.name
  policy_arn = aws_iam_policy.admin_server.arn
}

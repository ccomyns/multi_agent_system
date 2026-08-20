locals {
  codex_auth_ssm_parameter_name = coalesce(
    var.codex_auth_ssm_parameter_name,
    "/${var.project_name}/codex/auth-json"
  )

  orchestrator_environment_bootstrap = <<-EOT
    #!/bin/bash
    set -euo pipefail

    install -d -m 0755 /etc/multi-agent
    install -d -o root -g multi-agent -m 0750 /var/log/multi-agent
    install -o root -g multi-agent -m 0640 /dev/null \
      /var/log/multi-agent/orchestrator-bootstrap.log
    install -o multi-agent -g multi-agent -m 0600 /dev/null \
      /var/log/multi-agent/orchestrator-codex.log
    install -o multi-agent -g multi-agent -m 0600 /dev/null \
      /var/log/multi-agent/orchestrator-software-codex.log
    exec > >(tee -a /var/log/multi-agent/orchestrator-bootstrap.log \
      | logger -t multi-agent-orchestrator-bootstrap -s 2>/dev/console) 2>&1

    token="$(curl -fsS -X PUT \
      -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600' \
      http://169.254.169.254/latest/api/token)"
    instance_id="$(curl -fsS \
      -H "X-aws-ec2-metadata-token: $token" \
      http://169.254.169.254/latest/meta-data/instance-id)"

    job_id="$(curl -fsS \
      -H "X-aws-ec2-metadata-token: $token" \
      http://169.254.169.254/latest/meta-data/tags/instance/JobId)"

    type_of_job="$(curl -fsS \
      -H "X-aws-ec2-metadata-token: $token" \
      http://169.254.169.254/latest/meta-data/tags/instance/TypeOfJob)"

    cat > /etc/multi-agent/orchestrator.env <<ENV
    AWS_DEFAULT_REGION=${var.aws_region}
    AWS_REGION=${var.aws_region}
    FUNCTION_NAME=${aws_lambda_function.subagent_manager.function_name}
    AGENT_WORKSPACE_BUCKET_NAME=${aws_s3_bucket.agent_workspace.id}
    GLOBAL_MEMORY_BUCKET_NAME=${aws_s3_bucket.global_memory.id}
    JOBS_TABLE_NAME=${aws_dynamodb_table.jobs.name}
    GITHUB_TOKEN_BROKER_FUNCTION_NAME=${aws_lambda_function.github_token_broker.function_name}
    JOB_ID=$job_id
    TYPE_OF_JOB=$type_of_job
    ORCHESTRATOR_INSTANCE_ID=$instance_id
    CODEX_AUTH_SSM_PARAMETER_NAME=${local.codex_auth_ssm_parameter_name}
    ORCHESTRATOR_MODEL=${var.orchestrator_model}
    SUBAGENT_MODEL=${var.subagent_model}
    SPAWN_AGENT_MCP_COMMAND=${var.spawn_agent_mcp_command}
    ORCHESTRATOR_DOCUMENTATION_DIR=/opt/multi-agent/runtime/docs
    BOOTSTRAP_LOG_PATH=/var/log/multi-agent/orchestrator-bootstrap.log
    CODEX_LOG_PATH=/var/log/multi-agent/orchestrator-codex.log
    SOFTWARE_BUILDER_CODEX_LOG_PATH=/var/log/multi-agent/orchestrator-software-codex.log
    ENV
    chown root:multi-agent /etc/multi-agent/orchestrator.env
    chmod 0640 /etc/multi-agent/orchestrator.env
  EOT

  orchestrator_bootstrap = <<-EOT
    ${local.orchestrator_environment_bootstrap}

    systemctl start --no-block multi-agent-orchestrator.service
  EOT
}

resource "aws_launch_template" "orchestrator" {
  name_prefix            = "${var.project_name}-orchestrator-"
  description            = "On-demand orchestrator for multi-agent research runs."
  image_id               = local.orchestrator_ami_id
  instance_type          = var.orchestrator_instance_type
  update_default_version = true

  instance_initiated_shutdown_behavior = "terminate"

  iam_instance_profile {
    name = aws_iam_instance_profile.orchestrator.name
  }

  network_interfaces {
    associate_public_ip_address = true
    delete_on_termination       = true
    device_index                = 0
    security_groups             = [aws_security_group.instances.id]
    subnet_id                   = aws_subnet.public.id
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_protocol_ipv6          = "disabled"
    http_put_response_hop_limit = 1
    http_tokens                 = "required"
    instance_metadata_tags      = "enabled"
  }

  block_device_mappings {
    device_name = data.aws_ami.ubuntu_2404.root_device_name

    ebs {
      delete_on_termination = true
      encrypted             = true
      volume_size           = var.orchestrator_root_volume_size_gb
      volume_type           = "gp3"
    }
  }

  user_data = base64encode(local.orchestrator_bootstrap)

  tag_specifications {
    resource_type = "instance"

    tags = {
      Name = "${var.project_name}-orchestrator"
      Role = "orchestrator"
    }
  }

  tag_specifications {
    resource_type = "volume"

    tags = {
      Role = "orchestrator"
    }
  }
}

locals {
  codex_auth_ssm_parameter_name = coalesce(
    var.codex_auth_ssm_parameter_name,
    "/${var.project_name}/codex/auth-json"
  )

  orchestrator_environment_bootstrap = <<-EOT
    #!/bin/bash
    set -euo pipefail

    install -d -m 0755 /etc/multi-agent

    token="$(curl -fsS -X PUT \
      -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600' \
      http://169.254.169.254/latest/api/token)"
    instance_id="$(curl -fsS \
      -H "X-aws-ec2-metadata-token: $token" \
      http://169.254.169.254/latest/meta-data/instance-id)"

    # Set by the admin server on RunInstances; absent for stress-test launches.
    if ! job_id="$(curl -fsS \
      -H "X-aws-ec2-metadata-token: $token" \
      http://169.254.169.254/latest/meta-data/tags/instance/JobId)"; then
      job_id=""
    fi

    cat > /etc/multi-agent/orchestrator.env <<ENV
    AWS_DEFAULT_REGION=${var.aws_region}
    AWS_REGION=${var.aws_region}
    FUNCTION_NAME=${aws_lambda_function.subagent_manager.function_name}
    AUDIT_BUCKET_NAME=${aws_s3_bucket.audit.id}
    JOBS_TABLE_NAME=${aws_dynamodb_table.jobs.name}
    JOB_ID=$job_id
    ORCHESTRATOR_INSTANCE_ID=$instance_id
    CODEX_AUTH_SSM_PARAMETER_NAME=${local.codex_auth_ssm_parameter_name}
    ORCHESTRATOR_MODEL=${var.orchestrator_model}
    SUBAGENT_MODEL=${var.subagent_model}
    SPAWN_AGENT_MCP_COMMAND=${var.spawn_agent_mcp_command}
    ORCHESTRATOR_DOCUMENTATION_DIR=/opt/multi-agent/runtime/docs
    ENV
    chown root:multi-agent /etc/multi-agent/orchestrator.env
    chmod 0640 /etc/multi-agent/orchestrator.env
  EOT

  orchestrator_bootstrap = <<-EOT
    ${local.orchestrator_environment_bootstrap}

    systemctl start --no-block multi-agent-orchestrator.service
  EOT

  orchestrator_stress_bootstrap = <<-EOT
    ${local.orchestrator_environment_bootstrap}

    exec > >(tee /var/log/orchestrator-stress-test.log | logger -t orchestrator-stress-test -s 2>/dev/console) 2>&1

    if ! stress_orchestrator_id="$(curl -fsS \
      -H "X-aws-ec2-metadata-token: $token" \
      http://169.254.169.254/latest/meta-data/tags/instance/StressOrchestratorId)"; then
      stress_orchestrator_id="orchestrator-$instance_id"
    fi
    if ! stress_invocations="$(curl -fsS \
      -H "X-aws-ec2-metadata-token: $token" \
      http://169.254.169.254/latest/meta-data/tags/instance/StressInvocations)"; then
      stress_invocations="9"
    fi
    if ! stress_expected_limit="$(curl -fsS \
      -H "X-aws-ec2-metadata-token: $token" \
      http://169.254.169.254/latest/meta-data/tags/instance/StressExpectedLimit)"; then
      stress_expected_limit="${var.max_active_subagents}"
    fi

    set +e
    /usr/local/bin/run-subagent-stress-test \
      --orchestrator-id "$stress_orchestrator_id" \
      --invocations "$stress_invocations" \
      --expected-limit "$stress_expected_limit"
    test_exit=$?
    set -e

    echo "stress test exit code: $test_exit"
    shutdown -h now
    exit "$test_exit"
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

resource "aws_launch_template" "orchestrator_stress_test" {
  name_prefix            = "${var.project_name}-orchestrator-stress-"
  description            = "On-demand, self-terminating orchestrator that stress tests the subagent manager."
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

  user_data = base64encode(local.orchestrator_stress_bootstrap)

  tag_specifications {
    resource_type = "instance"

    tags = {
      Name = "${var.project_name}-orchestrator-stress-test"
      Role = "orchestrator"
      Mode = "stress-test"
    }
  }

  tag_specifications {
    resource_type = "volume"

    tags = {
      Role = "orchestrator"
      Mode = "stress-test"
    }
  }
}

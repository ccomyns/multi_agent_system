locals {
  orchestrator_bootstrap = <<-EOT
    #!/bin/bash
    set -euo pipefail

    install -d -m 0755 /etc/multi-agent

    token="$(curl -fsS -X PUT \
      -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600' \
      http://169.254.169.254/latest/api/token)"
    instance_id="$(curl -fsS \
      -H "X-aws-ec2-metadata-token: $token" \
      http://169.254.169.254/latest/meta-data/instance-id)"

    cat > /etc/multi-agent/orchestrator.env <<ENV
    FUNCTION_NAME=${aws_lambda_function.subagent_manager.function_name}
    AUDIT_BUCKET_NAME=${aws_s3_bucket.audit.id}
    ORCHESTRATOR_ID=orchestrator-$instance_id
    ENV
    chmod 0644 /etc/multi-agent/orchestrator.env
  EOT

  orchestrator_stress_bootstrap = <<-EOT
    ${local.orchestrator_bootstrap}

    exec > >(tee /var/log/orchestrator-stress-test.log | logger -t orchestrator-stress-test -s 2>/dev/console) 2>&1

    set +e
    /usr/local/bin/run-subagent-stress-test \
      --invocations 9 \
      --expected-limit ${var.max_active_subagents}
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
  description            = "On-demand, self-terminating orchestrator that invokes the subagent manager nine times."
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

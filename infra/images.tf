data "aws_ami" "ubuntu_2404" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_imagebuilder_component" "agent_core" {
  name        = "${var.project_name}-agent-core"
  description = "Install current Node.js 22, Codex CLI, and DuckDB CLI releases."
  platform    = "Linux"
  version     = var.agent_image_version

  data = yamlencode({
    schemaVersion = 1.0
    phases = [
      {
        name = "build"
        steps = [
          {
            name   = "InstallCoreAgentTools"
            action = "ExecuteBash"
            inputs = {
              commands = [
                <<-EOT
                  set -euo pipefail
                  export DEBIAN_FRONTEND=noninteractive

                  apt-get update
                  apt-get upgrade -y
                  apt-get install -y ca-certificates curl xz-utils python3 python3-venv

                  curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt \
                    -o /tmp/node-shasums.txt
                  node_archive="$(awk '/linux-x64.tar.xz$/ { print $2; exit }' /tmp/node-shasums.txt)"
                  node_checksum="$(awk '/linux-x64.tar.xz$/ { print $1; exit }' /tmp/node-shasums.txt)"
                  test -n "$node_archive"
                  test -n "$node_checksum"
                  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$node_archive" \
                    -o "/tmp/$node_archive"
                  echo "$node_checksum  /tmp/$node_archive" | sha256sum --check
                  tar -xJf "/tmp/$node_archive" -C /usr/local --strip-components=1

                  npm install --global @openai/codex@latest

                  curl -fsSL https://install.duckdb.org -o /tmp/install-duckdb.sh
                  HOME=/root sh /tmp/install-duckdb.sh
                  install -m 0755 /root/.duckdb/cli/latest/duckdb /usr/local/bin/duckdb

                  {
                    echo "built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
                    echo "node=$(node --version)"
                    echo "codex=$(codex --version)"
                    echo "duckdb=$(duckdb --version)"
                  } > /etc/agent-image-manifest

                  rm -f "/tmp/$node_archive" /tmp/node-shasums.txt /tmp/install-duckdb.sh
                  apt-get clean
                  rm -rf /var/lib/apt/lists/*
                EOT
              ]
            }
          }
        ]
      },
      {
        name = "validate"
        steps = [
          {
            name   = "ValidateCoreAgentTools"
            action = "ExecuteBash"
            inputs = {
              commands = [
                "set -euo pipefail",
                "node --version",
                "codex --version",
                "duckdb --version",
              ]
            }
          }
        ]
      }
    ]
  })
}

resource "aws_imagebuilder_component" "orchestrator_stress_tools" {
  name        = "${var.project_name}-orchestrator-stress-tools"
  description = "Install the Python stress-test harness used by on-demand orchestrators."
  platform    = "Linux"
  version     = var.agent_image_version

  data = yamlencode({
    schemaVersion = 1.0
    phases = [
      {
        name = "build"
        steps = [
          {
            name   = "InstallStressTestHarness"
            action = "ExecuteBash"
            inputs = {
              commands = [
                <<-EOT
                  set -euo pipefail
                  install -d -m 0755 /opt/multi-agent
                  python3 -m venv /opt/multi-agent/venv
                  /opt/multi-agent/venv/bin/pip install --no-cache-dir --upgrade pip boto3

                  echo "${filebase64("${path.module}/../scripts/stress_test.py")}" \
                    | base64 --decode > /opt/multi-agent/stress_test.py
                  chmod 0755 /opt/multi-agent/stress_test.py

                  cat > /usr/local/bin/run-subagent-stress-test <<'SCRIPT'
                  #!/bin/bash
                  set -euo pipefail
                  if [ -r /etc/multi-agent/orchestrator.env ]; then
                    set -a
                    source /etc/multi-agent/orchestrator.env
                    set +a
                  fi
                  exec /opt/multi-agent/venv/bin/python \
                    /opt/multi-agent/stress_test.py "$@"
                  SCRIPT
                  chmod 0755 /usr/local/bin/run-subagent-stress-test
                EOT
              ]
            }
          }
        ]
      },
      {
        name = "validate"
        steps = [
          {
            name   = "ValidateStressTestHarness"
            action = "ExecuteBash"
            inputs = {
              commands = [
                "set -euo pipefail",
                "/opt/multi-agent/venv/bin/python -c 'import boto3'",
                "run-subagent-stress-test --help >/dev/null",
              ]
            }
          }
        ]
      }
    ]
  })
}

resource "aws_imagebuilder_component" "orchestrator_runtime" {
  name        = "${var.project_name}-orchestrator-runtime"
  description = "Install the real job runner and its disabled-by-default systemd service."
  platform    = "Linux"
  version     = var.orchestrator_image_version

  data = yamlencode({
    schemaVersion = 1.0
    phases = [
      {
        name = "build"
        steps = [
          {
            name   = "DownloadOrchestratorRuntime"
            action = "S3Download"
            inputs = [
              {
                source              = "s3://${aws_s3_bucket.agent_workspace.id}/${aws_s3_object.orchestrator_runtime.key}"
                destination         = "/tmp/orchestrator-runtime.zip"
                expectedBucketOwner = data.aws_caller_identity.current.account_id
                overwrite           = true
              }
            ]
          },
          {
            name   = "InstallOrchestratorRuntime"
            action = "ExecuteBash"
            inputs = {
              commands = [
                <<-EOT
                  set -euo pipefail

                  if ! id multi-agent >/dev/null 2>&1; then
                    useradd --system --create-home --home-dir /var/lib/multi-agent \
                      --shell /usr/sbin/nologin multi-agent
                  fi
                  install -d -o multi-agent -g multi-agent -m 0700 \
                    /var/lib/multi-agent /var/lib/multi-agent/jobs \
                    /var/lib/multi-agent/codex-home

                  /opt/multi-agent/venv/bin/pip install --no-cache-dir \
                    'mcp>=1.27,<2'

                  echo "${filesha256(data.archive_file.orchestrator_runtime.output_path)}  /tmp/orchestrator-runtime.zip" \
                    | sha256sum --check
                  install -d -o root -g root -m 0755 /opt/multi-agent/runtime
                  python3 -m zipfile --extract \
                    /tmp/orchestrator-runtime.zip /opt/multi-agent/runtime
                  chown -R root:root /opt/multi-agent/runtime
                  find /opt/multi-agent/runtime -type d -exec chmod 0755 {} +
                  find /opt/multi-agent/runtime -type f -exec chmod 0644 {} +
                  chmod 0755 /opt/multi-agent/runtime/bin/orchestrator_runner.py
                  chmod 0755 /opt/multi-agent/runtime/bin/spawn-agent-mcp
                  rm -f /tmp/orchestrator-runtime.zip

                  cat > /etc/systemd/system/multi-agent-orchestrator.service <<'UNIT'
                  [Unit]
                  Description=Multi-agent research orchestrator
                  After=network-online.target cloud-final.service
                  Wants=network-online.target
                  ConditionPathExists=/etc/multi-agent/orchestrator.env

                  [Service]
                  Type=oneshot
                  User=multi-agent
                  Group=multi-agent
                  EnvironmentFile=/etc/multi-agent/orchestrator.env
                  ExecStart=/opt/multi-agent/venv/bin/python /opt/multi-agent/runtime/bin/orchestrator_runner.py
                  ExecStopPost=+/sbin/shutdown -h now
                  TimeoutStartSec=infinity
                  StandardOutput=journal
                  StandardError=journal

                  [Install]
                  WantedBy=multi-user.target
                  UNIT
                  chmod 0644 /etc/systemd/system/multi-agent-orchestrator.service
                  systemctl daemon-reload
                EOT
              ]
            }
          }
        ]
      },
      {
        name = "validate"
        steps = [
          {
            name   = "ValidateOrchestratorRuntime"
            action = "ExecuteBash"
            inputs = {
              commands = [
                "set -euo pipefail",
                "/opt/multi-agent/venv/bin/python -m py_compile /opt/multi-agent/runtime/bin/orchestrator_runner.py",
                "/opt/multi-agent/venv/bin/python -m py_compile /opt/multi-agent/runtime/bin/spawn_agent_mcp.py",
                "/opt/multi-agent/venv/bin/python -c 'from mcp.server.fastmcp import FastMCP'",
                "test -x /opt/multi-agent/runtime/bin/spawn-agent-mcp",
                "systemd-analyze verify /etc/systemd/system/multi-agent-orchestrator.service",
                "test ! -e /etc/systemd/system/multi-user.target.wants/multi-agent-orchestrator.service",
              ]
            }
          }
        ]
      }
    ]
  })
}

resource "aws_imagebuilder_component" "subagent_browser_tools" {
  name        = "${var.project_name}-subagent-browser-tools"
  description = "Install current Playwright and its bundled Chromium browser."
  platform    = "Linux"
  version     = var.agent_image_version

  data = yamlencode({
    schemaVersion = 1.0
    phases = [
      {
        name = "build"
        steps = [
          {
            name   = "InstallBrowserTools"
            action = "ExecuteBash"
            inputs = {
              commands = [
                <<-EOT
                  set -euo pipefail
                  npm install --global playwright@latest

                  export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
                  playwright install --with-deps chromium
                  chmod -R a+rX /opt/ms-playwright

                  chromium_path="$(find /opt/ms-playwright -type f \
                    -path '*/chrome-linux*/chrome' -print -quit)"
                  test -n "$chromium_path"
                  ln -sfn "$chromium_path" /usr/local/bin/chromium

                  echo 'export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright' \
                    > /etc/profile.d/playwright.sh
                  chmod 0644 /etc/profile.d/playwright.sh

                  {
                    echo "playwright=$(playwright --version)"
                    echo "chromium=$(chromium --version)"
                  } >> /etc/agent-image-manifest
                EOT
              ]
            }
          }
        ]
      },
      {
        name = "validate"
        steps = [
          {
            name   = "ValidateBrowserTools"
            action = "ExecuteBash"
            inputs = {
              commands = [
                "set -euo pipefail",
                "PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright playwright --version",
                "chromium --headless --no-sandbox --disable-gpu --dump-dom about:blank >/dev/null",
              ]
            }
          }
        ]
      }
    ]
  })
}

resource "aws_imagebuilder_component" "subagent_runtime" {
  name        = "${var.project_name}-subagent-runtime"
  description = "Install the S3 task runner and self-terminating systemd service."
  platform    = "Linux"
  version     = var.agent_image_version

  data = yamlencode({
    schemaVersion = 1.0
    phases = [
      {
        name = "build"
        steps = [
          {
            name   = "DownloadSubagentRuntime"
            action = "S3Download"
            inputs = [
              {
                source              = "s3://${aws_s3_bucket.agent_workspace.id}/${aws_s3_object.subagent_runtime.key}"
                destination         = "/tmp/subagent-runtime.zip"
                expectedBucketOwner = data.aws_caller_identity.current.account_id
                overwrite           = true
              }
            ]
          },
          {
            name   = "InstallSubagentRuntime"
            action = "ExecuteBash"
            inputs = {
              commands = [
                <<-EOT
                  set -euo pipefail

                  if ! id multi-agent >/dev/null 2>&1; then
                    useradd --system --create-home --home-dir /var/lib/multi-agent \
                      --shell /usr/sbin/nologin multi-agent
                  fi
                  install -d -o multi-agent -g multi-agent -m 0700 \
                    /var/lib/multi-agent /var/lib/multi-agent/codex-home \
                    /work /summary /result

                  if [ ! -x /opt/multi-agent/venv/bin/python ]; then
                    install -d -m 0755 /opt/multi-agent
                    python3 -m venv /opt/multi-agent/venv
                  fi
                  /opt/multi-agent/venv/bin/pip install --no-cache-dir --upgrade pip boto3

                  echo "${filesha256(data.archive_file.subagent_runtime.output_path)}  /tmp/subagent-runtime.zip" \
                    | sha256sum --check
                  install -d -o root -g root -m 0755 /opt/multi-agent/runtime
                  python3 -m zipfile --extract \
                    /tmp/subagent-runtime.zip /opt/multi-agent/runtime
                  chown -R root:root /opt/multi-agent/runtime
                  find /opt/multi-agent/runtime -type d -exec chmod 0755 {} +
                  find /opt/multi-agent/runtime -type f -exec chmod 0644 {} +
                  chmod 0755 /opt/multi-agent/runtime/bin/subagent_runner.py
                  chmod 0755 /opt/multi-agent/runtime/bin/run-subagent
                  rm -f /tmp/subagent-runtime.zip

                  cat > /etc/systemd/system/multi-agent-subagent.service <<'UNIT'
                  [Unit]
                  Description=Multi-agent research subagent
                  After=network-online.target cloud-final.service
                  Wants=network-online.target
                  ConditionPathExists=/etc/multi-agent/subagent.env

                  [Service]
                  Type=oneshot
                  User=multi-agent
                  Group=multi-agent
                  EnvironmentFile=/etc/multi-agent/subagent.env
                  ExecStart=/opt/multi-agent/runtime/bin/run-subagent
                  ExecStopPost=+/sbin/shutdown -h now
                  TimeoutStartSec=infinity
                  KillMode=control-group
                  StandardOutput=journal
                  StandardError=journal

                  [Install]
                  WantedBy=multi-user.target
                  UNIT
                  chmod 0644 /etc/systemd/system/multi-agent-subagent.service
                  systemctl daemon-reload
                EOT
              ]
            }
          }
        ]
      },
      {
        name = "validate"
        steps = [
          {
            name   = "ValidateSubagentRuntime"
            action = "ExecuteBash"
            inputs = {
              commands = [
                "set -euo pipefail",
                "/opt/multi-agent/venv/bin/python -m py_compile /opt/multi-agent/runtime/bin/subagent_runner.py",
                "/opt/multi-agent/venv/bin/python -c 'import boto3'",
                "test -x /opt/multi-agent/runtime/bin/run-subagent",
                "systemd-analyze verify /etc/systemd/system/multi-agent-subagent.service",
                "test ! -e /etc/systemd/system/multi-user.target.wants/multi-agent-subagent.service",
              ]
            }
          }
        ]
      }
    ]
  })
}

resource "aws_imagebuilder_image_recipe" "orchestrator" {
  name         = "${var.project_name}-orchestrator"
  description  = "Ubuntu orchestrator image with Codex CLI, DuckDB, and the stress-test harness."
  parent_image = data.aws_ami.ubuntu_2404.id
  version      = var.orchestrator_image_version

  component {
    component_arn = aws_imagebuilder_component.agent_core.arn
  }

  component {
    component_arn = aws_imagebuilder_component.orchestrator_stress_tools.arn
  }

  component {
    component_arn = aws_imagebuilder_component.orchestrator_runtime.arn
  }

  block_device_mapping {
    device_name = data.aws_ami.ubuntu_2404.root_device_name

    ebs {
      delete_on_termination = true
      encrypted             = true
      volume_size           = var.orchestrator_root_volume_size_gb
      volume_type           = "gp3"
    }
  }

  systems_manager_agent {
    uninstall_after_build = false
  }

  ami_tags = {
    Name = "${var.project_name}-orchestrator"
    Role = "orchestrator"
  }
}

resource "aws_imagebuilder_image_recipe" "subagent" {
  name         = "${var.project_name}-subagent"
  description  = "Ubuntu subagent image with Codex CLI, DuckDB, Playwright, and Chromium."
  parent_image = data.aws_ami.ubuntu_2404.id
  version      = var.agent_image_version

  component {
    component_arn = aws_imagebuilder_component.agent_core.arn
  }

  component {
    component_arn = aws_imagebuilder_component.subagent_browser_tools.arn
  }

  component {
    component_arn = aws_imagebuilder_component.subagent_runtime.arn
  }

  block_device_mapping {
    device_name = data.aws_ami.ubuntu_2404.root_device_name

    ebs {
      delete_on_termination = true
      encrypted             = true
      volume_size           = var.subagent_root_volume_size_gb
      volume_type           = "gp3"
    }
  }

  systems_manager_agent {
    uninstall_after_build = false
  }

  ami_tags = {
    Name = "${var.project_name}-subagent"
    Role = "subagent"
  }
}

resource "aws_imagebuilder_infrastructure_configuration" "agents" {
  name                          = "${var.project_name}-agent-images"
  description                   = "Temporary build infrastructure for orchestrator and subagent AMIs."
  instance_profile_name         = aws_iam_instance_profile.image_builder.name
  instance_types                = [var.image_builder_instance_type]
  security_group_ids            = [aws_security_group.instances.id]
  subnet_id                     = aws_subnet.public.id
  terminate_instance_on_failure = true

  instance_metadata_options {
    http_put_response_hop_limit = 1
    http_tokens                 = "required"
  }

  resource_tags = {
    Role = "ephemeral-image-builder"
  }

  depends_on = [
    aws_iam_role_policy.image_builder_artifacts,
    aws_iam_role_policy_attachment.image_builder,
    aws_iam_role_policy_attachment.image_builder_ssm,
  ]
}

resource "aws_imagebuilder_image" "orchestrator" {
  image_recipe_arn                 = aws_imagebuilder_image_recipe.orchestrator.arn
  infrastructure_configuration_arn = aws_imagebuilder_infrastructure_configuration.agents.arn

  image_tests_configuration {
    image_tests_enabled = true
    timeout_minutes     = 60
  }

  timeouts {
    create = "90m"
  }
}

resource "aws_imagebuilder_image" "subagent" {
  image_recipe_arn                 = aws_imagebuilder_image_recipe.subagent.arn
  infrastructure_configuration_arn = aws_imagebuilder_infrastructure_configuration.agents.arn

  image_tests_configuration {
    image_tests_enabled = true
    timeout_minutes     = 60
  }

  timeouts {
    create = "90m"
  }
}

locals {
  orchestrator_ami_id = one(aws_imagebuilder_image.orchestrator.output_resources[0].amis).image
  subagent_ami_id     = one(aws_imagebuilder_image.subagent.output_resources[0].amis).image
}

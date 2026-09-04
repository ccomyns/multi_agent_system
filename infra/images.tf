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
  description = "Install current Node.js 22, Codex CLI, DuckDB CLI, and Linux sandbox dependencies."
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
                  apt-get install -y \
                    apparmor-profiles apparmor-utils bubblewrap \
                    ca-certificates curl xz-utils python3 python3-venv

                  bwrap_profile_source=/usr/share/apparmor/extra-profiles/bwrap-userns-restrict
                  bwrap_profile_destination=/etc/apparmor.d/bwrap-userns-restrict
                  test -f "$bwrap_profile_source"
                  install -m 0644 "$bwrap_profile_source" "$bwrap_profile_destination"
                  apparmor_parser -r "$bwrap_profile_destination"

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

                  npm install --global "@openai/codex@${var.codex_cli_version}"

                  curl -fsSL https://install.duckdb.org -o /tmp/install-duckdb.sh
                  HOME=/root bash /tmp/install-duckdb.sh
                  install -m 0755 /root/.duckdb/cli/latest/duckdb /usr/local/bin/duckdb

                  {
                    echo "built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
                    echo "node=$(node --version)"
                    echo "codex=$(codex --version)"
                    echo "duckdb=$(duckdb --version)"
                    echo "bubblewrap=$(bwrap --version)"
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
                "bwrap --version",
                "test -f /etc/apparmor.d/bwrap-userns-restrict",
              ]
            }
          }
        ]
      }
    ]
  })
}

resource "aws_imagebuilder_component" "data_mining_orchestrator_base_runtime" {
  name        = "${var.project_name}-data-mining-orchestrator-base-runtime"
  description = "Install data-mining orchestrator dependencies and its launch-time runtime downloader."
  platform    = "Linux"
  version     = var.orchestrator_image_version

  data = yamlencode({
    schemaVersion = 1.0
    phases = [
      {
        name = "build"
        steps = [
          {
            name   = "InstallDataMiningOrchestratorBaseRuntime"
            action = "ExecuteBash"
            inputs = {
              commands = [
                <<-EOT
                  set -euo pipefail
                  export DEBIAN_FRONTEND=noninteractive

                  apt-get update
                  apt-get install -y git

                  if ! id multi-agent >/dev/null 2>&1; then
                    useradd --system --create-home --home-dir /var/lib/multi-agent \
                      --shell /usr/sbin/nologin multi-agent
                  fi
                  install -d -o multi-agent -g multi-agent -m 0700 \
                    /var/lib/multi-agent /var/lib/multi-agent/jobs \
                    /var/lib/multi-agent/codex-home \
                    /var/lib/multi-agent/orchestrator-runtime

                  if [ ! -x /opt/multi-agent/venv/bin/python ]; then
                    install -d -m 0755 /opt/multi-agent
                    python3 -m venv /opt/multi-agent/venv
                  fi
                  /opt/multi-agent/venv/bin/pip install --no-cache-dir \
                    --upgrade pip boto3 'mcp>=1.27,<2' \
                    'openpyxl>=3.1,<4' 'xlrd>=2,<3'

                  cat > /usr/local/bin/run-runtime-orchestrator <<'SCRIPT'
                  #!/bin/bash
                  set -euo pipefail

                  required_variables=(
                    RUNTIME_ARTIFACT_BUCKET
                    RUNTIME_ARTIFACT_BUCKET_OWNER
                    ORCHESTRATOR_RUNTIME_NAME
                    ORCHESTRATOR_RUNTIME_S3_KEY
                    ORCHESTRATOR_RUNTIME_SHA256
                  )
                  for variable_name in "$${required_variables[@]}"; do
                    if [ -z "$${!variable_name:-}" ]; then
                      echo "$variable_name is required" >&2
                      exit 2
                    fi
                  done

                  release_root="/var/lib/multi-agent/orchestrator-runtime/$ORCHESTRATOR_RUNTIME_SHA256"
                  if [ ! -f "$release_root/.ready" ]; then
                    staging_root="$(mktemp -d /var/lib/multi-agent/orchestrator-runtime/.release.XXXXXX)"
                    trap 'rm -rf "$staging_root"' EXIT
                    runtime_zip="$staging_root/runtime.zip"
                    extracted_root="$staging_root/extracted"
                    install -d -m 0700 "$extracted_root"

                    /opt/multi-agent/venv/bin/python - \
                      "$RUNTIME_ARTIFACT_BUCKET" \
                      "$RUNTIME_ARTIFACT_BUCKET_OWNER" \
                      "$ORCHESTRATOR_RUNTIME_S3_KEY" \
                      "$runtime_zip" <<'PY'
                  import shutil
                  import sys

                  import boto3

                  bucket, owner, key, destination = sys.argv[1:]
                  response = boto3.client("s3").get_object(
                      Bucket=bucket,
                      Key=key,
                      ExpectedBucketOwner=owner,
                  )
                  with open(destination, "wb") as output:
                      shutil.copyfileobj(response["Body"], output)
                  PY

                    echo "$ORCHESTRATOR_RUNTIME_SHA256  $runtime_zip" | sha256sum --check
                    /opt/multi-agent/venv/bin/python -m zipfile --extract \
                      "$runtime_zip" "$extracted_root"
                    find "$extracted_root" -type d -exec chmod 0755 {} +
                    find "$extracted_root" -type f -exec chmod 0644 {} +
                    chmod 0755 "$extracted_root/bin/orchestrator_entrypoint.py"
                    chmod 0755 "$extracted_root/bin/spawn-agent-mcp"
                    touch "$extracted_root/.ready"
                    mv "$extracted_root" "$release_root"
                    trap - EXIT
                    rm -rf "$staging_root"
                  fi

                  echo "starting $ORCHESTRATOR_RUNTIME_NAME runtime $ORCHESTRATOR_RUNTIME_SHA256"
                  exec /opt/multi-agent/venv/bin/python \
                    "$release_root/bin/orchestrator_entrypoint.py"
                  SCRIPT
                  chmod 0755 /usr/local/bin/run-runtime-orchestrator

                  cat > /etc/systemd/system/multi-agent-orchestrator.service <<'UNIT'
                  [Unit]
                  Description=Job-type-isolated Codex orchestrator
                  After=network-online.target cloud-final.service
                  Wants=network-online.target
                  ConditionPathExists=/etc/multi-agent/orchestrator.env

                  [Service]
                  Type=oneshot
                  User=multi-agent
                  Group=multi-agent
                  EnvironmentFile=/etc/multi-agent/orchestrator.env
                  ExecStart=/usr/local/bin/run-runtime-orchestrator
                  ExecStopPost=+/sbin/shutdown -h now
                  TimeoutStartSec=infinity
                  StandardOutput=journal
                  StandardError=journal

                  [Install]
                  WantedBy=multi-user.target
                  UNIT
                  chmod 0644 /etc/systemd/system/multi-agent-orchestrator.service
                  systemctl daemon-reload

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
            name   = "ValidateDataMiningOrchestratorBaseRuntime"
            action = "ExecuteBash"
            inputs = {
              commands = [
                "set -euo pipefail",
                "/opt/multi-agent/venv/bin/python -c 'from mcp.server.fastmcp import FastMCP'",
                "/opt/multi-agent/venv/bin/python -c 'import openpyxl, xlrd'",
                "git --version",
                "cd /var/lib/multi-agent && runuser -u multi-agent -- codex sandbox -- /bin/true",
                "test -x /usr/local/bin/run-runtime-orchestrator",
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

// The Software Builder AMI contains only slow-changing dependencies and a
// generic, hash-verifying runtime downloader. Its Python runners are installed
// from immutable S3 artifacts every time an instance starts.
resource "aws_imagebuilder_component" "software_builder_base_runtime" {
  name        = "${var.project_name}-software-builder-base-runtime"
  description = "Install Software Builder dependencies and its launch-time runtime downloader."
  platform    = "Linux"
  version     = var.software_builder_orchestrator_image_version

  data = yamlencode({
    schemaVersion = 1.0
    phases = [
      {
        name = "build"
        steps = [
          {
            name   = "InstallSoftwareBuilderBaseRuntime"
            action = "ExecuteBash"
            inputs = {
              commands = [
                <<-EOT
                  set -euo pipefail
                  export DEBIAN_FRONTEND=noninteractive

                  apt-get update
                  apt-get install -y git

                  if ! id multi-agent >/dev/null 2>&1; then
                    useradd --system --create-home --home-dir /var/lib/multi-agent \
                      --shell /usr/sbin/nologin multi-agent
                  fi
                  install -d -o multi-agent -g multi-agent -m 0700 \
                    /var/lib/multi-agent \
                    /var/lib/multi-agent/orchestrator-runtime

                  if [ ! -x /opt/multi-agent/venv/bin/python ]; then
                    install -d -m 0755 /opt/multi-agent
                    python3 -m venv /opt/multi-agent/venv
                  fi
                  /opt/multi-agent/venv/bin/pip install --no-cache-dir \
                    --upgrade pip boto3 'mcp>=1.27,<2'

                  cat > /usr/local/bin/run-runtime-orchestrator <<'SCRIPT'
                  #!/bin/bash
                  set -euo pipefail

                  required_variables=(
                    RUNTIME_ARTIFACT_BUCKET
                    RUNTIME_ARTIFACT_BUCKET_OWNER
                    ORCHESTRATOR_RUNTIME_NAME
                    ORCHESTRATOR_RUNTIME_S3_KEY
                    ORCHESTRATOR_RUNTIME_SHA256
                  )
                  for variable_name in "$${required_variables[@]}"; do
                    if [ -z "$${!variable_name:-}" ]; then
                      echo "$variable_name is required" >&2
                      exit 2
                    fi
                  done

                  release_root="/var/lib/multi-agent/orchestrator-runtime/$ORCHESTRATOR_RUNTIME_SHA256"
                  if [ ! -f "$release_root/.ready" ]; then
                    staging_root="$(mktemp -d /var/lib/multi-agent/orchestrator-runtime/.release.XXXXXX)"
                    trap 'rm -rf "$staging_root"' EXIT
                    runtime_zip="$staging_root/runtime.zip"
                    extracted_root="$staging_root/extracted"
                    install -d -m 0700 "$extracted_root"

                    /opt/multi-agent/venv/bin/python - \
                      "$RUNTIME_ARTIFACT_BUCKET" \
                      "$RUNTIME_ARTIFACT_BUCKET_OWNER" \
                      "$ORCHESTRATOR_RUNTIME_S3_KEY" \
                      "$runtime_zip" <<'PY'
                  import shutil
                  import sys

                  import boto3

                  bucket, owner, key, destination = sys.argv[1:]
                  response = boto3.client("s3").get_object(
                      Bucket=bucket,
                      Key=key,
                      ExpectedBucketOwner=owner,
                  )
                  with open(destination, "wb") as output:
                      shutil.copyfileobj(response["Body"], output)
                  PY

                    echo "$ORCHESTRATOR_RUNTIME_SHA256  $runtime_zip" | sha256sum --check
                    /opt/multi-agent/venv/bin/python -m zipfile --extract \
                      "$runtime_zip" "$extracted_root"
                    find "$extracted_root" -type d -exec chmod 0755 {} +
                    find "$extracted_root" -type f -exec chmod 0644 {} +
                    chmod 0755 "$extracted_root/bin/orchestrator_entrypoint.py"
                    chmod 0755 "$extracted_root/bin/orchestrator_software_runner.py"
                    chmod 0755 "$extracted_root/bin/github_credential_helper.py"
                    touch "$extracted_root/.ready"
                    mv "$extracted_root" "$release_root"
                    trap - EXIT
                    rm -rf "$staging_root"
                  fi

                  echo "starting $ORCHESTRATOR_RUNTIME_NAME runtime $ORCHESTRATOR_RUNTIME_SHA256"
                  exec /opt/multi-agent/venv/bin/python \
                    "$release_root/bin/orchestrator_entrypoint.py"
                  SCRIPT
                  chmod 0755 /usr/local/bin/run-runtime-orchestrator

                  cat > /etc/systemd/system/multi-agent-orchestrator.service <<'UNIT'
                  [Unit]
                  Description=Launch-time Software Builder Codex orchestrator
                  After=network-online.target cloud-final.service
                  Wants=network-online.target
                  ConditionPathExists=/etc/multi-agent/orchestrator.env

                  [Service]
                  Type=oneshot
                  User=multi-agent
                  Group=multi-agent
                  EnvironmentFile=/etc/multi-agent/orchestrator.env
                  ExecStart=/usr/local/bin/run-runtime-orchestrator
                  ExecStopPost=+/sbin/shutdown -h now
                  TimeoutStartSec=infinity
                  StandardOutput=journal
                  StandardError=journal

                  [Install]
                  WantedBy=multi-user.target
                  UNIT
                  chmod 0644 /etc/systemd/system/multi-agent-orchestrator.service
                  systemctl daemon-reload

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
            name   = "ValidateSoftwareBuilderBaseRuntime"
            action = "ExecuteBash"
            inputs = {
              commands = [
                "set -euo pipefail",
                "/opt/multi-agent/venv/bin/python -c 'import boto3; from mcp.server.fastmcp import FastMCP'",
                "git --version",
                "cd /var/lib/multi-agent && runuser -u multi-agent -- codex sandbox -- /bin/true",
                "test -x /usr/local/bin/run-runtime-orchestrator",
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

resource "aws_imagebuilder_component" "data_mining_subagent_base_runtime" {
  name        = "${var.project_name}-data-mining-subagent-base-runtime"
  description = "Install data-mining subagent dependencies and its launch-time runtime downloader."
  platform    = "Linux"
  version     = var.agent_image_version

  data = yamlencode({
    schemaVersion = 1.0
    phases = [
      {
        name = "build"
        steps = [
          {
            name   = "InstallDataMiningSubagentBaseRuntime"
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
                    /var/lib/multi-agent/subagent-runtime \
                    /work /summary /result

                  if [ ! -x /opt/multi-agent/venv/bin/python ]; then
                    install -d -m 0755 /opt/multi-agent
                    python3 -m venv /opt/multi-agent/venv
                  fi
                  /opt/multi-agent/venv/bin/pip install --no-cache-dir --upgrade pip boto3

                  cat > /usr/local/bin/run-runtime-subagent <<'SCRIPT'
                  #!/bin/bash
                  set -euo pipefail

                  required_variables=(
                    RUNTIME_ARTIFACT_BUCKET
                    RUNTIME_ARTIFACT_BUCKET_OWNER
                    SUBAGENT_RUNTIME_NAME
                    SUBAGENT_RUNTIME_S3_KEY
                    SUBAGENT_RUNTIME_SHA256
                  )
                  for variable_name in "$${required_variables[@]}"; do
                    if [ -z "$${!variable_name:-}" ]; then
                      echo "$variable_name is required" >&2
                      exit 2
                    fi
                  done

                  release_root="/var/lib/multi-agent/subagent-runtime/$SUBAGENT_RUNTIME_SHA256"
                  if [ ! -f "$release_root/.ready" ]; then
                    staging_root="$(mktemp -d /var/lib/multi-agent/subagent-runtime/.release.XXXXXX)"
                    trap 'rm -rf "$staging_root"' EXIT
                    runtime_zip="$staging_root/runtime.zip"
                    extracted_root="$staging_root/extracted"
                    install -d -m 0700 "$extracted_root"

                    /opt/multi-agent/venv/bin/python - \
                      "$RUNTIME_ARTIFACT_BUCKET" \
                      "$RUNTIME_ARTIFACT_BUCKET_OWNER" \
                      "$SUBAGENT_RUNTIME_S3_KEY" \
                      "$runtime_zip" <<'PY'
                  import shutil
                  import sys

                  import boto3

                  bucket, owner, key, destination = sys.argv[1:]
                  response = boto3.client("s3").get_object(
                      Bucket=bucket,
                      Key=key,
                      ExpectedBucketOwner=owner,
                  )
                  with open(destination, "wb") as output:
                      shutil.copyfileobj(response["Body"], output)
                  PY

                    echo "$SUBAGENT_RUNTIME_SHA256  $runtime_zip" | sha256sum --check
                    /opt/multi-agent/venv/bin/python -m zipfile --extract \
                      "$runtime_zip" "$extracted_root"
                    find "$extracted_root" -type d -exec chmod 0755 {} +
                    find "$extracted_root" -type f -exec chmod 0644 {} +
                    chmod 0755 "$extracted_root/bin/subagent_runner.py"
                    chmod 0755 "$extracted_root/bin/run-subagent"
                    touch "$extracted_root/.ready"
                    mv "$extracted_root" "$release_root"
                    trap - EXIT
                    rm -rf "$staging_root"
                  fi

                  echo "starting $SUBAGENT_RUNTIME_NAME runtime $SUBAGENT_RUNTIME_SHA256"
                  exec "$release_root/bin/run-subagent"
                  SCRIPT
                  chmod 0755 /usr/local/bin/run-runtime-subagent

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
                  ExecStart=/usr/local/bin/run-runtime-subagent
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
            name   = "ValidateDataMiningSubagentBaseRuntime"
            action = "ExecuteBash"
            inputs = {
              commands = [
                "set -euo pipefail",
                "/opt/multi-agent/venv/bin/python -c 'import boto3'",
                "cd /var/lib/multi-agent && runuser -u multi-agent -- codex sandbox -- /bin/true",
                "test -x /usr/local/bin/run-runtime-subagent",
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
  description  = "Ubuntu data-mining orchestrator base image with Codex CLI, DuckDB, and a launch-time runtime downloader."
  parent_image = data.aws_ami.ubuntu_2404.id
  version      = var.orchestrator_image_version

  component {
    component_arn = aws_imagebuilder_component.agent_core.arn
  }

  component {
    component_arn = aws_imagebuilder_component.data_mining_orchestrator_base_runtime.arn
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

// Software Builder gets an independently versioned recipe and AMI. The two
// recipes intentionally share hardened components today, but never resolve to
// the same AMI ID and can evolve independently as either runtime changes.
resource "aws_imagebuilder_image_recipe" "software_builder_orchestrator" {
  name         = "${var.project_name}-software-builder-orchestrator"
  description  = "Ubuntu software-builder base image with Codex CLI and a launch-time runtime installer."
  parent_image = data.aws_ami.ubuntu_2404.id
  version      = var.software_builder_orchestrator_image_version

  component {
    component_arn = aws_imagebuilder_component.agent_core.arn
  }

  component {
    component_arn = aws_imagebuilder_component.software_builder_base_runtime.arn
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
    Name     = "${var.project_name}-software-builder-orchestrator"
    Role     = "orchestrator"
    Workload = "software_builder"
  }
}

resource "aws_imagebuilder_image_recipe" "subagent" {
  name         = "${var.project_name}-subagent"
  description  = "Ubuntu data-mining subagent base image with Codex CLI, DuckDB, Playwright, Chromium, and a launch-time runtime downloader."
  parent_image = data.aws_ami.ubuntu_2404.id
  version      = var.agent_image_version

  component {
    component_arn = aws_imagebuilder_component.agent_core.arn
  }

  component {
    component_arn = aws_imagebuilder_component.subagent_browser_tools.arn
  }

  component {
    component_arn = aws_imagebuilder_component.data_mining_subagent_base_runtime.arn
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

resource "aws_imagebuilder_image" "software_builder_orchestrator" {
  image_recipe_arn                 = aws_imagebuilder_image_recipe.software_builder_orchestrator.arn
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
  orchestrator_ami_id                  = one(aws_imagebuilder_image.orchestrator.output_resources[0].amis).image
  software_builder_orchestrator_ami_id = one(aws_imagebuilder_image.software_builder_orchestrator.output_resources[0].amis).image
  subagent_ami_id                      = one(aws_imagebuilder_image.subagent.output_resources[0].amis).image
}

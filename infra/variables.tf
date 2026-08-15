variable "aws_region" {
  description = "AWS region in which all resources are created."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Prefix applied to resource names and tags."
  type        = string
  default     = "financial-research-agents"
}

variable "max_active_subagents" {
  description = "Hard maximum number of active subagents per orchestrator."
  type        = number
  default     = 8

  validation {
    condition     = var.max_active_subagents >= 1 && var.max_active_subagents <= 100
    error_message = "max_active_subagents must be between 1 and 100."
  }
}

variable "subagent_instance_type" {
  description = "EC2 instance type launched for each subagent."
  type        = string
  default     = "t3.large"
}

variable "orchestrator_instance_type" {
  description = "EC2 instance type used by on-demand orchestrator launch templates."
  type        = string
  default     = "t3.large"
}

variable "codex_auth_ssm_parameter_name" {
  description = "Name of the out-of-band SSM SecureString containing Codex auth.json. Null uses /<project_name>/codex/auth-json."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.codex_auth_ssm_parameter_name == null ||
      can(regex("^/[A-Za-z0-9_./-]+$", var.codex_auth_ssm_parameter_name))
    )
    error_message = "codex_auth_ssm_parameter_name must be an absolute SSM parameter name beginning with /."
  }
}

variable "orchestrator_model" {
  description = "Codex model used by the real orchestrator runner."
  type        = string
  default     = "gpt-5.6-terra"
}

variable "subagent_model" {
  description = "Model passed to the custom spawn_agent MCP server for remote subagents."
  type        = string
  default     = "gpt-5.6-luna"
}

variable "codex_cli_version" {
  description = "Exact Codex CLI version baked into orchestrator and subagent AMIs."
  type        = string
  default     = "0.146.0"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.codex_cli_version))
    error_message = "codex_cli_version must be an exact semantic version such as 0.146.0."
  }
}

variable "spawn_agent_mcp_command" {
  description = "Absolute path to the required local spawn_agent MCP server executable on the orchestrator AMI."
  type        = string
  default     = "/opt/multi-agent/runtime/bin/spawn-agent-mcp"

  validation {
    condition     = startswith(var.spawn_agent_mcp_command, "/")
    error_message = "spawn_agent_mcp_command must be an absolute path."
  }
}

variable "subagent_ttl_seconds" {
  description = "Hard runtime limit before a stuck subagent is shut down and terminated. Successful subagents terminate as soon as their outputs are uploaded."
  type        = number
  default     = 1800

  validation {
    condition     = var.subagent_ttl_seconds >= 180 && var.subagent_ttl_seconds <= 86400
    error_message = "subagent_ttl_seconds must be between 180 and 86400."
  }
}

variable "agent_image_version" {
  description = "Semantic version assigned to shared Image Builder components and the subagent recipe. Increment this to rebuild the subagent AMI and shared tools."
  type        = string
  default     = "1.0.7"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.agent_image_version))
    error_message = "agent_image_version must be a semantic version such as 1.0.0."
  }
}

variable "orchestrator_image_version" {
  description = "Semantic version assigned to the orchestrator runtime component and image recipe. Increment this to rebuild only the orchestrator AMI."
  type        = string
  default     = "1.0.10"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.orchestrator_image_version))
    error_message = "orchestrator_image_version must be a semantic version such as 1.0.1."
  }
}

variable "image_builder_instance_type" {
  description = "Temporary EC2 instance type used only while EC2 Image Builder creates and tests the AMIs."
  type        = string
  default     = "t3.large"
}

variable "orchestrator_root_volume_size_gb" {
  description = "Root EBS volume size for orchestrator AMIs and launch templates."
  type        = number
  default     = 20

  validation {
    condition     = var.orchestrator_root_volume_size_gb >= 12
    error_message = "orchestrator_root_volume_size_gb must be at least 12."
  }
}

variable "subagent_root_volume_size_gb" {
  description = "Root EBS volume size for browser-enabled subagent AMIs."
  type        = number
  default     = 30

  validation {
    condition     = var.subagent_root_volume_size_gb >= 20
    error_message = "subagent_root_volume_size_gb must be at least 20."
  }
}

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
  default     = 12

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

variable "github_organization" {
  description = "GitHub organization containing repositories assigned to software-builder jobs."
  type        = string

  validation {
    condition = (
      length(var.github_organization) >= 1 &&
      length(var.github_organization) <= 39 &&
      can(regex("^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$", var.github_organization))
    )
    error_message = "github_organization must be a valid GitHub organization login."
  }
}

variable "github_writer_app_client_id" {
  description = "Non-secret Client ID of the GitHub App that writes software-builder repositories."
  type        = string

  validation {
    condition = (
      length(var.github_writer_app_client_id) >= 10 &&
      length(var.github_writer_app_client_id) <= 100 &&
      can(regex("^[A-Za-z0-9_-]+$", var.github_writer_app_client_id))
    )
    error_message = "github_writer_app_client_id must be the Client ID shown on the GitHub App settings page."
  }
}

variable "github_writer_private_key_ssm_parameter_name" {
  description = "Name of the out-of-band SSM SecureString containing the GitHub writer App PEM. Null uses /<project_name>/github/writer-private-key."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.github_writer_private_key_ssm_parameter_name == null ||
      can(regex("^/[A-Za-z0-9_./-]+$", var.github_writer_private_key_ssm_parameter_name))
    )
    error_message = "github_writer_private_key_ssm_parameter_name must be an absolute SSM parameter name beginning with /."
  }
}

variable "software_builder_git_author_name" {
  description = "Git author name applied to commits created by software-builder jobs so Vercel can associate private-repository commits with a team member."
  type        = string

  validation {
    condition = (
      length(var.software_builder_git_author_name) >= 1 &&
      length(var.software_builder_git_author_name) <= 100 &&
      can(regex("^[A-Za-z0-9][A-Za-z0-9 .'-]*$", var.software_builder_git_author_name))
    )
    error_message = "software_builder_git_author_name must be 1-100 characters and contain only letters, numbers, spaces, periods, apostrophes, or hyphens."
  }
}

variable "software_builder_git_author_email" {
  description = "Verified email associated with the Vercel team member's connected GitHub account; prefer the GitHub no-reply address."
  type        = string

  validation {
    condition = (
      length(var.software_builder_git_author_email) >= 3 &&
      length(var.software_builder_git_author_email) <= 254 &&
      can(regex("^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$", var.software_builder_git_author_email))
    )
    error_message = "software_builder_git_author_email must be a valid email address associated with the GitHub account connected to Vercel."
  }
}

variable "vercel_team_id" {
  description = "Vercel Pro team ID that owns software-builder projects and deployments."
  type        = string

  validation {
    condition     = can(regex("^team_[A-Za-z0-9]+$", var.vercel_team_id))
    error_message = "vercel_team_id must be a Vercel team ID beginning with team_."
  }
}

variable "vercel_access_token_ssm_parameter_name" {
  description = "Name of the out-of-band SSM SecureString containing the Vercel access token. Null uses /<project_name>/vercel/access-token."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.vercel_access_token_ssm_parameter_name == null ||
      can(regex("^/[A-Za-z0-9_./-]+$", var.vercel_access_token_ssm_parameter_name))
    )
    error_message = "vercel_access_token_ssm_parameter_name must be an absolute SSM parameter name beginning with /."
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
  description = "Semantic version assigned to shared Image Builder components and the data-mining subagent base recipe. Increment this only for baked dependency or downloader changes."
  type        = string
  default     = "1.1.5"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.agent_image_version))
    error_message = "agent_image_version must be a semantic version such as 1.0.0."
  }
}

variable "orchestrator_image_version" {
  description = "Semantic version assigned to the data-mining orchestrator base component and recipe. Increment this only for baked dependency or downloader changes."
  type        = string
  default     = "1.1.7"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.orchestrator_image_version))
    error_message = "orchestrator_image_version must be a semantic version such as 1.0.1."
  }
}

variable "software_builder_orchestrator_image_version" {
  description = "Semantic version assigned to the independently built software-builder base AMI and its dependency component. Runner-only changes do not require incrementing it."
  type        = string
  default     = "1.0.2"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.software_builder_orchestrator_image_version))
    error_message = "software_builder_orchestrator_image_version must be a semantic version such as 1.0.0."
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

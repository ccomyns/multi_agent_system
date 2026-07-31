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

variable "subagent_ttl_seconds" {
  description = "Seconds before a subagent shuts down and terminates itself."
  type        = number
  default     = 180

  validation {
    condition     = var.subagent_ttl_seconds >= 180 && var.subagent_ttl_seconds <= 86400
    error_message = "subagent_ttl_seconds must be between 180 and 86400."
  }
}

variable "agent_image_version" {
  description = "Semantic version assigned to the Image Builder components and recipes. Increment this to rebuild both AMIs with current software."
  type        = string
  default     = "1.0.0"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.agent_image_version))
    error_message = "agent_image_version must be a semantic version such as 1.0.0."
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
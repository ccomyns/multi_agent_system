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
  default     = "t3.micro"
}

variable "subagent_ttl_seconds" {
  description = "Seconds before a placeholder subagent shuts down and terminates itself."
  type        = number
  default     = 900

  validation {
    condition     = var.subagent_ttl_seconds >= 180 && var.subagent_ttl_seconds <= 86400
    error_message = "subagent_ttl_seconds must be between 180 and 86400."
  }
}

variable "create_stress_test_instance" {
  description = "Whether Terraform should launch the one-shot EC2 stress-test caller."
  type        = bool
  default     = false
}

variable "audit_bucket_force_destroy" {
  description = "Allow terraform destroy to delete the audit bucket even when it contains records."
  type        = bool
  default     = false
}

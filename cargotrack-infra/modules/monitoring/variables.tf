variable "project_name" {
  description = "Project name"
  type        = string
}

variable "aws_region" {
  description = "AWS region"
  type        = string
}

variable "backend_asg_name" {
  description = "Name of the backend Auto Scaling Group. Leave empty when using EKS (alarms are skipped)."
  type        = string
  default     = ""
}

variable "external_alb_arn_suffix" {
  description = "ARN suffix of the external ALB. Leave empty when using EKS (alarms are skipped)."
  type        = string
  default     = ""
}

variable "db_identifier" {
  description = "RDS instance identifier"
  type        = string
}

variable "alarm_email" {
  description = "Email address to receive CloudWatch alarm notifications. Set to null to skip subscription."
  type        = string
  default     = null
}


variable "kms_key_arn" {
  description = "ARN of the customer managed KMS key for SNS encryption"
  type        = string
}

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

# ── EKS / Container Insights ──────────────────────────────────────────────────

variable "eks_cluster_name" {
  description = "EKS cluster name — used for Container Insights alarms. Leave empty to skip EKS alarms."
  type        = string
  default     = ""
}

# ── SQS ───────────────────────────────────────────────────────────────────────

variable "compliance_queue_name" {
  description = "Name of the SQS compliance trigger queue — used for queue depth alarm. Leave empty to skip."
  type        = string
  default     = ""
}

variable "sqs_depth_threshold" {
  description = "SQS message count threshold before triggering an alarm"
  type        = number
  default     = 100
}

# ── RDS ───────────────────────────────────────────────────────────────────────

variable "rds_storage_threshold_gb" {
  description = "RDS free storage alarm threshold in GB. Alert fires when storage drops below this value."
  type        = number
  default     = 5
}


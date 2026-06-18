variable "project_name" {
  description = "Project name"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnet IDs"
  type        = list(string)
}

variable "web_subnet_ids" {
  description = "Web subnet IDs"
  type        = list(string)
}

variable "app_subnet_ids" {
  description = "App subnet IDs"
  type        = list(string)
}

variable "external_alb_sg_id" {
  description = "External ALB security group"
  type        = string
}

variable "frontend_sg_id" {
  description = "Frontend security group"
  type        = string
}

variable "internal_alb_sg_id" {
  description = "Internal ALB security group"
  type        = string
}

variable "backend_sg_id" {
  description = "Backend security group"
  type        = string
}

variable "db_secret_arn" {
  description = "ARN of the database Secrets Manager secret"
  type        = string
}

variable "app_secret_arn" {
  description = "ARN of the application Secrets Manager secret"
  type        = string
}

variable "kms_key_arn" {
  description = "ARN of the customer managed KMS key"
  type        = string
}

variable "documents_bucket_arn" {
  description = "ARN of the S3 documents bucket"
  type        = string
}

variable "documents_bucket_id" {
  description = "Name of the S3 documents bucket"
  type        = string
}

variable "aws_region" {
  description = "AWS region"
  type        = string
}

variable "event_bus_name" {
  description = "Name of the CargoTrack custom EventBridge event bus"
  type        = string
}

variable "sns_alarm_topic_arn" {
  description = "ARN of the SNS topic for CloudWatch alarm notifications. Leave empty to disable alarm actions."
  type        = string
  default     = ""
}

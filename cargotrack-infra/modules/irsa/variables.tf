variable "project_name" {
  description = "Project name prefix for all IAM resource names"
  type        = string
}

variable "oidc_issuer_url" {
  description = "OIDC issuer URL from the EKS cluster (e.g. https://oidc.eks.us-east-1.amazonaws.com/id/...)"
  type        = string
}

variable "oidc_provider_arn" {
  description = "ARN of the IAM OIDC provider associated with the EKS cluster"
  type        = string
}

variable "cluster_name" {
  description = "EKS cluster name (used to scope ALB controller SG deletion permission)"
  type        = string
}

variable "aws_region" {
  description = "AWS region (used to construct Bedrock model ARNs)"
  type        = string
}

variable "documents_bucket_arn" {
  description = "ARN of the S3 documents bucket"
  type        = string
}

variable "event_bus_arn" {
  description = "ARN of the custom EventBridge event bus"
  type        = string
}

variable "compliance_queue_arn" {
  description = "ARN of the SQS compliance trigger queue"
  type        = string
}

variable "audit_table_arn" {
  description = "ARN of the DynamoDB audit table"
  type        = string
}

variable "kms_key_arn" {
  description = "ARN of the customer-managed KMS key"
  type        = string
}

variable "db_secret_arn" {
  description = "ARN of the Secrets Manager secret for database credentials"
  type        = string
}

variable "app_secret_arn" {
  description = "ARN of the Secrets Manager secret for application credentials (JWT, admin)"
  type        = string
}

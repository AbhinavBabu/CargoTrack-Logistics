variable "project_name" {
  description = "Project name"
  type        = string
}

variable "aws_region" {
  description = "AWS region"
  type        = string
}

variable "kms_key_arn" {
  description = "ARN of the customer managed KMS key for SQS encryption"
  type        = string
}

variable "audit_table_name" {
  description = "Name of the DynamoDB audit table"
  type        = string
}

variable "audit_table_arn" {
  description = "ARN of the DynamoDB audit table — used to scope the Lambda IAM PutItem permission"
  type        = string
}

variable "ec2_role_name" {
  description = "Name of the EC2/ECS role to attach the ai-service SQS consumer policy to. Leave blank to skip attachment."
  type        = string
  default     = ""
}

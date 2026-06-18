variable "project_name" {
  description = "Project name used as prefix for all ECR repository names"
  type        = string
}

variable "eks_node_role_arn" {
  description = "ARN of the EKS node IAM role — granted pull access to all CargoTrack ECR repositories"
  type        = string
}

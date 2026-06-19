variable "project_name" {
  description = "Project name used as prefix for all ECR repository names"
  type        = string
}

variable "eks_node_role_arn" {
  description = "ARN of the EKS node IAM role granted pull access to all CargoTrack ECR repositories"
  type        = string
}

variable "github_repository" {
  description = "GitHub repository in owner/repo format (e.g. AbhinavBabu/cargotrack-v2) — scopes the OIDC trust policy so only this repo can assume the ECR push role"
  type        = string
  default     = "AbhinavBabu/CargoTrack-Logistics"
}


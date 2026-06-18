output "repository_urls" {
  description = "Map of service name → ECR repository URL (use as image registry in Helm values)"
  value       = { for k, repo in aws_ecr_repository.this : k => repo.repository_url }
}

output "repository_arns" {
  description = "Map of service name → ECR repository ARN"
  value       = { for k, repo in aws_ecr_repository.this : k => repo.arn }
}

output "repository_names" {
  description = "Map of service name → ECR repository name"
  value       = { for k, repo in aws_ecr_repository.this : k => repo.name }
}

output "registry_id" {
  description = "AWS account ID — the ECR registry ID (same for all repos in this account)"
  value       = data.aws_caller_identity.current.account_id
}

output "github_actions_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC ECR push — set as GitHub secret AWS_ECR_PUSH_ROLE_ARN"
  value       = aws_iam_role.github_actions_ecr.arn
}


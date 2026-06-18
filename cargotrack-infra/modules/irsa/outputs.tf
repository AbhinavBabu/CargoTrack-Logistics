output "core_service_role_arn" {
  description = "IAM role ARN for the core-service Kubernetes service account"
  value       = aws_iam_role.core_service.arn
}

output "document_service_role_arn" {
  description = "IAM role ARN for the document-service Kubernetes service account"
  value       = aws_iam_role.document_service.arn
}

output "ai_service_role_arn" {
  description = "IAM role ARN for the ai-service Kubernetes service account"
  value       = aws_iam_role.ai_service.arn
}

output "alb_controller_role_arn" {
  description = "IAM role ARN for the AWS Load Balancer Controller service account"
  value       = aws_iam_role.alb_controller.arn
}

output "cluster_autoscaler_role_arn" {
  description = "IAM role ARN for the Cluster Autoscaler service account (kube-system:cluster-autoscaler)"
  value       = aws_iam_role.cluster_autoscaler.arn
}

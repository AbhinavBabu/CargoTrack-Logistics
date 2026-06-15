# \u2500\u2500\u2500 EKS outputs (used for kubectl config and Helm values injection)

output "eks_cluster_name" {
  description = "EKS cluster name — use with: aws eks update-kubeconfig --name <value>"
  value       = module.eks.cluster_name
}

output "eks_cluster_endpoint" {
  description = "EKS API server endpoint"
  value       = module.eks.cluster_endpoint
}

output "eks_oidc_issuer_url" {
  description = "OIDC issuer URL for IRSA verification"
  value       = module.eks.oidc_issuer_url
}

# \u2500\u2500\u2500 IRSA role ARNs (inject into Helm values-dev.yaml for ServiceAccount annotations)

output "irsa_core_service_role_arn" {
  description = "IRSA role ARN for core-service — annotate ServiceAccount in Helm"
  value       = module.irsa.core_service_role_arn
}

output "irsa_document_service_role_arn" {
  description = "IRSA role ARN for document-service — annotate ServiceAccount in Helm"
  value       = module.irsa.document_service_role_arn
}

output "irsa_ai_service_role_arn" {
  description = "IRSA role ARN for ai-service — annotate ServiceAccount in Helm"
  value       = module.irsa.ai_service_role_arn
}

output "irsa_alb_controller_role_arn" {
  description = "IRSA role ARN for AWS Load Balancer Controller"
  value       = module.irsa.alb_controller_role_arn
}

# \u2500\u2500\u2500 AWS resource identifiers (used in Helm values for microservice env vars)

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint"
  value       = module.database.db_endpoint
  sensitive   = true
}

output "s3_bucket_name" {
  description = "S3 documents bucket name"
  value       = module.storage.bucket_id
}

output "event_bus_name" {
  description = "EventBridge custom event bus name"
  value       = module.eventing.event_bus_name
}

output "compliance_queue_url" {
  description = "SQS compliance trigger queue URL"
  value       = module.eventing.compliance_queue_url
}

output "dynamodb_audit_table" {
  description = "DynamoDB audit table name"
  value       = module.audit.table_name
}

output "kms_key_arn" {
  description = "KMS customer-managed key ARN"
  value       = module.database.kms_key_arn
  sensitive   = true
}

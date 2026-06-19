# ── EKS outputs (used for kubectl config and Helm values injection) ───────────

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

# ── IRSA role ARNs (inject into Helm values-dev.yaml for ServiceAccount annotations)

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

output "irsa_cluster_autoscaler_role_arn" {
  description = "IRSA role ARN for Cluster Autoscaler (kube-system:cluster-autoscaler)"
  value       = module.irsa.cluster_autoscaler_role_arn
}

# ── AWS resource identifiers (used in Helm values for microservice env vars) ──

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

output "db_secret_arn" {
  description = "Database secrets ARN"
  value       = module.database.db_secret_arn
}

output "application_secret_arn" {
  description = "Application secrets (JWT and admin creds) ARN"
  value       = module.database.application_secret_arn
}

# ── CDN outputs ───────────────────────────────────────────────────────────────

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain — access the application at https://<value>"
  value       = module.cdn.cloudfront_domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID — use for cache invalidations"
  value       = module.cdn.cloudfront_distribution_id
}

output "waf_web_acl_arn" {
  description = "WAF Web ACL ARN attached to CloudFront"
  value       = module.cdn.waf_web_acl_arn
}

# ── ECR outputs ───────────────────────────────────────────────────────────────

output "ecr_repository_urls" {
  description = <<-EOT
    Map of service name → ECR repository URL.
    Use these as the image registry in Helm values files.
    Example: ecr_repository_urls["frontend"] = "<account>.dkr.ecr.<region>.amazonaws.com/cargotrack-frontend"
  EOT
  value       = module.ecr.repository_urls
}

output "ecr_registry_id" {
  description = "AWS account ID used as the ECR registry — needed for docker login"
  value       = module.ecr.registry_id
}

output "github_actions_ecr_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC ECR push — set as AWS_ECR_PUSH_ROLE_ARN in GitHub secrets"
  value       = module.ecr.github_actions_role_arn
}

# ── DNS outputs (populated only when domain_name is set) ─────────────────────

output "dns_name_servers" {
  description = "Route 53 NS records — configure at your domain registrar to complete DNS delegation (empty when domain_name is not set)"
  value       = module.dns.zone_name_servers
}

output "acm_certificate_arn" {
  description = "ACM certificate ARN for CloudFront HTTPS (empty when domain_name is not set)"
  value       = module.dns.certificate_arn
}

output "dns_enabled" {
  description = "True when a domain was provided and DNS resources were created"
  value       = module.dns.dns_enabled
}

# ── Kubernetes platform outputs ───────────────────────────────────────────────

output "argocd_namespace" {
  description = "Namespace where ArgoCD is installed"
  value       = kubernetes_namespace.argocd.metadata[0].name
}

output "cargotrack_namespace" {
  description = "Namespace where CargoTrack application pods run"
  value       = kubernetes_namespace.cargotrack.metadata[0].name
}

output "platform_note" {
  description = "Post-apply steps required to complete GitOps bootstrap"
  value       = <<-EOT
    ── Post-apply steps ──────────────────────────────────────────────────────
    1. Get ArgoCD initial admin password:
         kubectl -n argocd get secret argocd-initial-admin-secret \
           -o jsonpath="{.data.password}" | base64 -d

    2. Get ArgoCD server URL (LoadBalancer):
         kubectl get svc argocd-server -n argocd \
           -o jsonpath="{.status.loadBalancer.ingress[0].hostname}"

    3. Verify cargotrack-secrets was created by Terraform:
         kubectl get secret cargotrack-secrets -n cargotrack

    4. Once ArgoCD syncs and the Ingress is created, get the ALB DNS name:
         kubectl get ingress -n cargotrack

    5. Wire CloudFront to the ALB:
         ALB DNS is now baked into variables.tf — no -var flag needed.
         Just run: terraform apply

    6. Domain is configured: shopp-novaa.co.in
         After apply, copy the NS records from dns_name_servers output
         to your registrar at shopp-novaa.co.in → change nameservers.
    ─────────────────────────────────────────────────────────────────────────
  EOT
}

output "cargotrack_secrets_note" {
  description = "How cargotrack-secrets is created — no ESO, no manual steps"
  value       = <<-EOT
    cargotrack-secrets is created directly by Terraform as a kubernetes_secret resource.
    Values are sourced from AWS Secrets Manager via data.aws_secretsmanager_secret_version,
    which reads the same random_password values that module.database wrote.
    No External Secrets Operator, no CRD bootstrap issue, single terraform apply.

    Keys in cargotrack-secrets:
      DATABASE_PASSWORD  <- cargotrack-database-secret-v2  .password
      JWT_SECRET         <- cargotrack-application-secret-v2 .jwt_secret
      ADMIN_PASSWORD     <- cargotrack-application-secret-v2 .admin_password
  EOT
}

output "application_url" {
  description = "Primary application URL — https after DNS delegation, http ALB URL otherwise"
  value       = var.domain_name != "" ? "https://${var.domain_name}" : "http://${var.eks_ingress_alb_dns}"
}

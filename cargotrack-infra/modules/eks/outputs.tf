output "cluster_name" {
  description = "EKS cluster name"
  value       = aws_eks_cluster.main.name
}

output "cluster_endpoint" {
  description = "Kubernetes API server endpoint"
  value       = aws_eks_cluster.main.endpoint
}

output "cluster_ca_data" {
  description = "Base64-encoded cluster CA certificate (used by kubectl and Helm provider)"
  value       = aws_eks_cluster.main.certificate_authority[0].data
}

output "cluster_version" {
  description = "Kubernetes version running on the cluster"
  value       = aws_eks_cluster.main.version
}

output "oidc_issuer_url" {
  description = "OIDC issuer URL for the EKS cluster (used to create IRSA trust policies)"
  value       = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

output "oidc_provider_arn" {
  description = "ARN of the IAM OIDC provider (used by IRSA module)"
  value       = aws_iam_openid_connect_provider.eks.arn
}

output "node_role_arn" {
  description = "ARN of the EKS node IAM role"
  value       = aws_iam_role.node.arn
}

output "cluster_role_arn" {
  description = "ARN of the EKS cluster IAM role"
  value       = aws_iam_role.cluster.arn
}

output "cluster_sg_id" {
  description = <<-EOT
    The EKS-managed cluster security group ID.

    AWS automatically creates this SG when the EKS cluster is created and
    attaches it to EVERY managed node ENI. It is distinct from any
    Terraform-managed SG passed to vpc_config.security_group_ids, which is
    only attached to the control plane ENIs.

    This output is consumed by module.security to create the RDS ingress rule
    that actually allows node-to-RDS connectivity.
  EOT
  value       = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
}

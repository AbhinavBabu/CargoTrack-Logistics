output "frontend_sg_id" {
  value = aws_security_group.this["frontend"].id
}

output "backend_sg_id" {
  value = aws_security_group.this["backend"].id
}

output "external_alb_sg_id" {
  value = aws_security_group.this["external_alb"].id
}

output "internal_alb_sg_id" {
  value = aws_security_group.this["internal_alb"].id
}

output "database_sg_id" {
  value = aws_security_group.this["database"].id
}

output "eks_node_sg_id" {
  description = "Security group ID for EKS worker nodes — required by EKS node group and IRSA"
  value       = aws_security_group.this["eks_node"].id
}
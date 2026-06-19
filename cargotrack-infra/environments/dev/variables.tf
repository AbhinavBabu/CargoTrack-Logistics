variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name — used as prefix for all resource names"
  type        = string
  default     = "cargotrack"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "alarm_email" {
  description = "Email address for CloudWatch alarm SNS notifications"
  type        = string
  default     = null
}

# ─── EKS variables ────────────────────────────────────────────────────────────

variable "eks_cluster_version" {
  description = "Kubernetes version for the EKS cluster"
  type        = string
  default     = "1.30"
}

variable "node_instance_types" {
  description = "EC2 instance types for EKS worker nodes"
  type        = list(string)
  default     = ["t3.medium"]
}

variable "node_min_size" {
  description = "Minimum number of EKS worker nodes"
  type        = number
  default     = 1
}

variable "node_max_size" {
  description = "Maximum number of EKS worker nodes"
  type        = number
  default     = 4
}

variable "node_desired_size" {
  description = "Desired number of EKS worker nodes"
  type        = number
  default     = 2
}

variable "eks_ingress_alb_dns" {
  description = <<-EOT
    DNS name of the ALB created by the AWS Load Balancer Controller after Helm/ArgoCD deploys the Ingress.
    This is baked in as the default after the first successful deploy so that future
    terraform apply runs (including after terraform destroy + apply) have the correct origin.

    To update after a new deploy:
      kubectl get ingress -n cargotrack -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}'
    Then update this default value.
  EOT
  type    = string
  # ── Baked-in default: the ALB created by the first successful EKS + ArgoCD deploy ──
  # Update this value if the ALB DNS changes (e.g. after terraform destroy + apply).
  default = "k8s-cargotrack-faafefcd8d-1544623305.us-east-1.elb.amazonaws.com"
}

variable "domain_name" {
  description = <<-EOT
    Custom domain name for the CargoTrack platform.
    Set to "" to skip Route 53, ACM, and custom CloudFront certificate.
    When set, the dns module creates a hosted zone + ACM cert (us-east-1),
    and the cdn module uses the cert for HTTPS with a proper TLS certificate.

    After terraform apply, copy the NS records from the Terraform output
    (dns_name_servers) to your domain registrar to complete DNS delegation.
  EOT
  type    = string
  # ── Domain is now configured — enables Route53 + ACM + CloudFront HTTPS ──
  default = "shopp-novaa.co.in"
}
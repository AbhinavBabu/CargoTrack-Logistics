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
    DNS name of the ALB created by the AWS Load Balancer Controller after Helm deploy.
    Leave empty on first apply (before ArgoCD has deployed the ingress).
    Update with: terraform apply -var="eks_ingress_alb_dns=<alb-dns>" after first deploy.
  EOT
  type        = string
  default     = ""
}

variable "domain_name" {
  description = <<-EOT
    Custom domain name for the CargoTrack platform (e.g. cargotrack.example.com).
    Leave as empty string "" to skip Route 53 hosted zone, ACM certificate, and DNS record creation.
    Infrastructure provisions and validates cleanly without a domain.

    When set, provides:
      - Route 53 public hosted zone
      - ACM certificate (us-east-1, for CloudFront)
      - DNS validation records
      - A-record alias pointing to CloudFront
  EOT
  type        = string
  default     = ""
}
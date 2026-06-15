variable "project_name" {
  description = "Project name — used as prefix for all resource names and tags"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID in which to create the EKS cluster"
  type        = string
}

variable "app_subnet_ids" {
  description = "List of private app-tier subnet IDs for worker nodes and control plane ENIs"
  type        = list(string)
}

variable "node_sg_id" {
  description = "Security group ID for EKS worker nodes (from security module)"
  type        = string
}

variable "cluster_version" {
  description = "Kubernetes version for the EKS cluster (e.g. 1.30)"
  type        = string
  default     = "1.30"
}

variable "node_instance_types" {
  description = "EC2 instance types for worker nodes"
  type        = list(string)
  default     = ["t3.medium"]
}

variable "node_min_size" {
  description = "Minimum number of worker nodes"
  type        = number
  default     = 1
}

variable "node_max_size" {
  description = "Maximum number of worker nodes"
  type        = number
  default     = 4
}

variable "node_desired_size" {
  description = "Desired number of worker nodes"
  type        = number
  default     = 2
}

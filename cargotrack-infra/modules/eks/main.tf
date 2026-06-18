data "aws_caller_identity" "current" {}

# \u2500\u2500\u2500 Local values \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

locals {
  common_tags = {
    Project   = var.project_name
    ManagedBy = "Terraform"
  }

  # Managed node group configuration \u2014 expressed as a map so we can use for_each
  # if additional node groups are needed later (e.g. spot instances, GPU nodes)
  node_groups = {
    general = {
      name           = "${var.project_name}-general"
      instance_types = var.node_instance_types
      min_size       = var.node_min_size
      max_size       = var.node_max_size
      desired_size   = var.node_desired_size
      capacity_type  = "ON_DEMAND"
      disk_size      = 50 # GB
    }
  }
}

# \u2500\u2500\u2500 EKS Cluster IAM Role \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

data "aws_iam_policy_document" "cluster_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${var.project_name}-eks-cluster-role"
  assume_role_policy = data.aws_iam_policy_document.cluster_assume_role.json
  tags               = local.common_tags
}

# Required managed policies for the EKS cluster role
locals {
  cluster_policies = toset([
    "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
    "arn:aws:iam::aws:policy/AmazonEKSVPCResourceController",
  ])
}

resource "aws_iam_role_policy_attachment" "cluster" {
  for_each   = local.cluster_policies
  role       = aws_iam_role.cluster.name
  policy_arn = each.value
}

# \u2500\u2500\u2500 EKS Cluster \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

resource "aws_eks_cluster" "main" {
  name     = var.project_name
  version  = var.cluster_version
  role_arn = aws_iam_role.cluster.arn

  vpc_config {
    subnet_ids              = var.app_subnet_ids
    security_group_ids      = [var.node_sg_id]
    endpoint_private_access = true
    endpoint_public_access  = true # allows kubectl from local machine during dev
  }

  # Enable EKS add-ons logging for troubleshooting
  enabled_cluster_log_types = ["api", "audit", "authenticator"]

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-eks"
  })

  # Ensure cluster role policies are attached before creating cluster
  depends_on = [
    aws_iam_role_policy_attachment.cluster,
  ]

  lifecycle {
    # Prevent accidental cluster version downgrades
    precondition {
      condition     = tonumber(var.cluster_version) >= 1.29
      error_message = "EKS cluster version must be 1.29 or higher."
    }
  }
}

# \u2500\u2500\u2500 OIDC Provider (required for IRSA) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
# IRSA works by: pod presents a Kubernetes-issued token \u2192 AWS STS validates it
# against this OIDC provider \u2192 returns temporary credentials for the IAM role.
# Without this, pods cannot assume IAM roles.

data "tls_certificate" "eks" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "eks" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-oidc-provider"
  })
}

# \u2500\u2500\u2500 Node Group IAM Role \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

data "aws_iam_policy_document" "node_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${var.project_name}-eks-node-role"
  assume_role_policy = data.aws_iam_policy_document.node_assume_role.json
  tags               = local.common_tags
}

# Required managed policies for worker nodes
locals {
  node_policies = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly", # pull ECR images
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",       # SSM Session Manager
    "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",        # Container Insights metrics + logs
  ])
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each   = local.node_policies
  role       = aws_iam_role.node.name
  policy_arn = each.value
}

# ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
# Installs the amazon-cloudwatch-observability EKS add-on.
# This add-on deploys:
#   - CloudWatch Agent DaemonSet  — collects node CPU, memory, network, disk
#   - Fluent Bit DaemonSet        — forwards pod stdout/stderr to CloudWatch Logs
# Log groups created automatically:
#   /aws/containerinsights/<cluster>/application  — pod logs
#   /aws/containerinsights/<cluster>/host         — node OS logs
#   /aws/containerinsights/<cluster>/performance  — Container Insights metrics
#
# The node role already has CloudWatchAgentServerPolicy attached above,
# so no separate IRSA role is needed for this add-on.

resource "aws_eks_addon" "cloudwatch_observability" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "amazon-cloudwatch-observability"
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  # Add-on runs with the node role (CloudWatchAgentServerPolicy is attached above)
  service_account_role_arn = aws_iam_role.node.arn

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-cloudwatch-observability"
  })

  depends_on = [
    aws_iam_role_policy_attachment.node,
    aws_eks_node_group.this,
  ]
}

# ──────────────────────────────────────────────────────────────────────────

resource "aws_eks_node_group" "this" {
  for_each = local.node_groups

  cluster_name    = aws_eks_cluster.main.name
  node_group_name = each.value.name
  node_role_arn   = aws_iam_role.node.arn

  # Place nodes in private app subnets (no direct internet exposure)
  subnet_ids = var.app_subnet_ids

  instance_types = each.value.instance_types
  capacity_type  = each.value.capacity_type
  disk_size      = each.value.disk_size

  scaling_config {
    min_size     = each.value.min_size
    max_size     = each.value.max_size
    desired_size = each.value.desired_size
  }

  update_config {
    # Allow 1 node to be unavailable during rolling updates
    max_unavailable = 1
  }

  # SSH access is intentionally disabled.
  # Node access is via SSM Session Manager — no remote_access block needed.
  # AmazonSSMManagedInstanceCore is already attached to the node IAM role.
  # (Presence of any remote_access{} block — even with ec2_ssh_key = null —
  #  causes AWS to create an SSH security group and forces node group replacement.)

  tags = merge(local.common_tags, {
    Name                                            = each.value.name
    "k8s.io/cluster-autoscaler/enabled"             = "true"
    "k8s.io/cluster-autoscaler/${var.project_name}" = "owned"
  })

  lifecycle {
    # Prevent Terraform from resetting desired_size when cluster autoscaler adjusts it
    ignore_changes = [scaling_config[0].desired_size]
  }

  depends_on = [
    aws_iam_role_policy_attachment.node,
    aws_eks_cluster.main,
  ]
}

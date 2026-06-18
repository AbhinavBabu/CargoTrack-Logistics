provider "aws" {
  region = var.aws_region
}

# ACM certificates for CloudFront must be provisioned in us-east-1,
# regardless of the primary deployment region.
# This provider alias is used only by the dns module.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

# ── EKS authentication data sources ──────────────────────────────────────────
# These are fetched at plan time once the EKS cluster exists.
# On the very first apply (cluster not yet created), Terraform resolves these
# lazily — the helm_release resources depend on module.eks, so they are applied
# only after the cluster is ready.

data "aws_eks_cluster" "main" {
  name = module.eks.cluster_name
}

data "aws_eks_cluster_auth" "main" {
  name = module.eks.cluster_name
}

# ── Helm provider ─────────────────────────────────────────────────────────────
# Wired directly to the EKS cluster using short-lived cluster credentials.
# No kubeconfig file is used — credentials are fetched via the AWS provider.

provider "helm" {
  kubernetes {
    host                   = data.aws_eks_cluster.main.endpoint
    cluster_ca_certificate = base64decode(data.aws_eks_cluster.main.certificate_authority[0].data)
    token                  = data.aws_eks_cluster_auth.main.token
  }
}

# ── Kubernetes provider ───────────────────────────────────────────────────────
# Used to create namespaces (argocd, cargotrack) before Helm releases.

provider "kubernetes" {
  host                   = data.aws_eks_cluster.main.endpoint
  cluster_ca_certificate = base64decode(data.aws_eks_cluster.main.certificate_authority[0].data)
  token                  = data.aws_eks_cluster_auth.main.token
}

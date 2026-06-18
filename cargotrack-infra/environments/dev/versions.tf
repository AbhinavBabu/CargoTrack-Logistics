terraform {

  required_version = ">= 1.5"

  required_providers {

    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0, < 6.50"
    }

    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }

    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }

    # Required by modules/eks to compute the OIDC issuer TLS thumbprint
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }

    # Helm provider — installs ALB Controller, Metrics Server, Cluster Autoscaler, ArgoCD
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.14"
    }

    # Kubernetes provider — manages namespaces and namespace-scoped resources
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.31"
    }

    # Null provider — used for pre-destroy cleanup hooks (local-exec provisioners)
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }
}

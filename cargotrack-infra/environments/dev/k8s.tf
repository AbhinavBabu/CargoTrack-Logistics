# =============================================================================
# k8s.tf — Kubernetes platform layer
#
# Apply order (enforced via depends_on):
#   1. Namespaces (argocd, cargotrack)
#   2. AWS Load Balancer Controller  — kube-system  (needs nodes + IRSA)
#   3. Metrics Server                — kube-system  (needed for HPA)
#   4. Cluster Autoscaler            — kube-system  (least-waste expander)
#   5. External Secrets Operator     — kube-system  (syncs Secrets Manager → K8s Secret)
#   6. ClusterSecretStore            — cluster-wide (configures ESO backend)
#   7. ExternalSecret                — cargotrack   (creates cargotrack-secrets)
#   8. ArgoCD                        — argocd        (last — depends on LBC for NLB)
#   9. ArgoCD App-of-Apps CR         — argocd        (eliminates manual kubectl apply)
#
# Destroy order is automatic: Terraform reverses the dependency graph.
#   App-of-Apps CR → ArgoCD → ExternalSecret → ClusterSecretStore → ESO
#   → Cluster Autoscaler → Metrics Server → LBC → namespaces
# This ensures all ArgoCD-managed Kubernetes resources (Ingress, pods) are
# removed BEFORE the LBC is uninstalled, preventing orphaned ALBs and SGs.
# =============================================================================

# ── Namespaces ────────────────────────────────────────────────────────────────

resource "kubernetes_namespace" "argocd" {
  metadata {
    name = "argocd"
    labels = {
      "app.kubernetes.io/managed-by" = "Terraform"
    }
  }

  depends_on = [module.eks]
}

resource "kubernetes_namespace" "cargotrack" {
  metadata {
    name = "cargotrack"
    labels = {
      "app.kubernetes.io/managed-by" = "Terraform"
    }
  }

  depends_on = [module.eks]
}

# ── AWS Load Balancer Controller ──────────────────────────────────────────────
# Uses the IRSA role created in modules/irsa: cargotrack-irsa-alb-controller
# The service account name MUST match the IRSA trust policy subject:
#   system:serviceaccount:kube-system:aws-load-balancer-controller

resource "helm_release" "aws_load_balancer_controller" {
  name       = "aws-load-balancer-controller"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  version    = "1.8.1" # pin — update deliberately
  namespace  = "kube-system"

  wait            = true
  timeout         = 300 # 5 minutes
  cleanup_on_fail = true

  set {
    name  = "clusterName"
    value = module.eks.cluster_name
  }

  # AL2023 nodes block EC2 Instance Metadata Service (IMDS) by default.
  # Without this, the controller logs: "failed to introspect vpcID from EC2Metadata"
  # Sourced from module.networking — never hardcoded.
  set {
    name  = "vpcId"
    value = module.networking.vpc_id
  }

  set {
    name  = "serviceAccount.create"
    value = "true"
  }

  set {
    name  = "serviceAccount.name"
    value = "aws-load-balancer-controller"
  }

  # Annotate the ServiceAccount with the IRSA role ARN — no static keys
  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.irsa.alb_controller_role_arn
  }

  set {
    name  = "replicaCount"
    value = "2"
  }

  depends_on = [
    module.eks,
    module.irsa,
    kubernetes_namespace.cargotrack,
  ]
}

# ── Metrics Server ────────────────────────────────────────────────────────────
# Required for HPA to read pod CPU/memory metrics.
# No IRSA needed — metrics-server uses in-cluster RBAC permissions.
#
# --kubelet-preferred-address-types=InternalIP
#   Required because nodes are in private subnets (no public hostname).
# --kubelet-insecure-tls
#   Required because EKS managed nodes use self-signed kubelet certificates.
#   Without this flag, metrics-server fails TLS verification and cannot
#   collect node/pod metrics (HPA stops working silently).

resource "helm_release" "metrics_server" {
  name       = "metrics-server"
  repository = "https://kubernetes-sigs.github.io/metrics-server/"
  chart      = "metrics-server"
  version    = "3.12.1" # pin — update deliberately
  namespace  = "kube-system"

  wait            = true
  timeout         = 180
  cleanup_on_fail = true

  set {
    name  = "args[0]"
    value = "--kubelet-preferred-address-types=InternalIP"
  }

  # Needed for EKS managed node self-signed kubelet certs
  set {
    name  = "args[1]"
    value = "--kubelet-insecure-tls"
  }

  depends_on = [
    module.eks,
    helm_release.aws_load_balancer_controller,
  ]
}

# ── Cluster Autoscaler ────────────────────────────────────────────────────────
# Uses the IRSA role created in modules/irsa: cargotrack-irsa-cluster-autoscaler
# The node group in modules/eks already has the required discovery tags:
#   k8s.io/cluster-autoscaler/enabled             = "true"
#   k8s.io/cluster-autoscaler/cargotrack          = "owned"
# The service account name MUST match the IRSA trust policy subject:
#   system:serviceaccount:kube-system:cluster-autoscaler

resource "helm_release" "cluster_autoscaler" {
  name       = "cluster-autoscaler"
  repository = "https://kubernetes.github.io/autoscaler"
  chart      = "cluster-autoscaler"
  version    = "9.37.0" # pin — update deliberately
  namespace  = "kube-system"

  wait            = true
  timeout         = 180
  cleanup_on_fail = true

  set {
    name  = "autoDiscovery.clusterName"
    value = module.eks.cluster_name
  }

  set {
    name  = "awsRegion"
    value = var.aws_region
  }

  set {
    name  = "rbac.serviceAccount.create"
    value = "true"
  }

  set {
    name  = "rbac.serviceAccount.name"
    value = "cluster-autoscaler"
  }

  # Annotate the ServiceAccount with the IRSA role ARN
  set {
    name  = "rbac.serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.irsa.cluster_autoscaler_role_arn
  }

  # least-waste: scale to the node type that wastes fewest resources
  # More predictable than "random" for demos and single-node-group clusters
  set {
    name  = "extraArgs.expander"
    value = "least-waste"
  }

  set {
    name  = "extraArgs.balance-similar-node-groups"
    value = "true"
  }

  set {
    name  = "extraArgs.skip-nodes-with-system-pods"
    value = "false"
  }

  depends_on = [
    module.eks,
    module.irsa,
    helm_release.metrics_server,
  ]
}

# ── ArgoCD ────────────────────────────────────────────────────────────────────
# Installed last — ArgoCD manages the CargoTrack application via GitOps.
#
# Service configuration:
#   server.service.type = LoadBalancer
#     → Triggers the AWS LBC (already installed above) to create an NLB.
#
#   aws-load-balancer-scheme: internet-facing
#     → Forces an internet-facing NLB in public subnets.
#     → Without this, the LBC defaults to internal (private subnets) because
#       the ArgoCD pods run in app-tier subnets tagged for internal-elb.
#
#   aws-load-balancer-type: external
#     → Ensures the NLB is provisioned via the AWS LBC (not the legacy in-tree
#       cloud controller). Required when aws-load-balancer-scheme is set.
#
# Destroy safety:
#   cleanup_on_fail = true: rolls back on partial failure
#   timeout_on_destroy handled by depends_on graph — the App-of-Apps CR
#   is destroyed FIRST (before this release), so ArgoCD still has time to
#   clean up finalizers on Application resources before being uninstalled.

resource "helm_release" "argocd" {
  name       = "argocd"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argo-cd"
  version    = "7.4.4" # pin — update deliberately
  namespace  = kubernetes_namespace.argocd.metadata[0].name

  wait            = true
  timeout         = 600 # 10 minutes — ArgoCD has many components
  cleanup_on_fail = true

  # Expose ArgoCD server via a LoadBalancer
  set {
    name  = "server.service.type"
    value = "LoadBalancer"
  }

  # Force internet-facing NLB via AWS Load Balancer Controller
  # Without this annotation the LBC defaults to internal (private subnets)
  set {
    name  = "server.service.annotations.service\\.beta\\.kubernetes\\.io/aws-load-balancer-scheme"
    value = "internet-facing"
  }

  # Ensure the NLB is created via the AWS LBC (not the legacy cloud controller)
  set {
    name  = "server.service.annotations.service\\.beta\\.kubernetes\\.io/aws-load-balancer-type"
    value = "external"
  }

  # Disable TLS on the ArgoCD server — TLS is terminated at the NLB/CloudFront layer
  set {
    name  = "server.extraArgs[0]"
    value = "--insecure"
  }

  depends_on = [
    module.eks,
    kubernetes_namespace.argocd,
    helm_release.aws_load_balancer_controller,
    helm_release.cluster_autoscaler,
    helm_release.metrics_server,
  ]
}

# ── ArgoCD App-of-Apps Bootstrap ─────────────────────────────────────────────
# Applies the root Application CR that points ArgoCD at gitops/apps/.
# This eliminates the last required manual step (kubectl apply -f root-app.yaml).
#
# IMPORTANT: This resource depends on helm_release.argocd to ensure the
# argoproj.io CRDs are installed before we create the Application CR.
#
# Destroy: Terraform destroys this BEFORE destroying helm_release.argocd,
# giving ArgoCD time to remove finalizers from child Applications.
# The ArgoCD Application CR finalizer (resources-finalizer.argocd.argoproj.io)
# causes ArgoCD to delete all managed Kubernetes resources (Ingress, Pods, etc.)
# when the Application is deleted — this is the desired behaviour on destroy.

resource "kubernetes_manifest" "argocd_root_app" {
  manifest = {
    apiVersion = "argoproj.io/v1alpha1"
    kind       = "Application"
    metadata = {
      name      = "root-app"
      namespace = "argocd"
      finalizers = [
        "resources-finalizer.argocd.argoproj.io"
      ]
    }
    spec = {
      project = "default"
      source = {
        repoURL        = "https://github.com/AbhinavBabu/Cargotrack-Logistics.git"
        targetRevision = "cargotrack-terraform-v2"
        path           = "gitops/apps"
      }
      destination = {
        server    = "https://kubernetes.default.svc"
        namespace = "argocd"
      }
      syncPolicy = {
        automated = {
          prune    = true
          selfHeal = true
        }
        syncOptions = [
          "CreateNamespace=true"
        ]
      }
    }
  }

  field_manager {
    force_conflicts = true
  }

  depends_on = [
    helm_release.argocd,
    kubernetes_namespace.argocd,
  ]
}

# ── External Secrets Operator ─────────────────────────────────────────────────
# ESO watches ExternalSecret CRs and syncs values from AWS Secrets Manager
# into Kubernetes Secrets automatically. No manual kubectl secret creation.
#
# IRSA: The ESO service account (kube-system:external-secrets) is annotated
# with the cargotrack-irsa-external-secrets IAM role, granting least-privilege
# access to GetSecretValue on only the two CargoTrack secrets.
#
# Dependency chain:
#   module.irsa (IAM role) → helm_release.eso (installs CRDs + controller)
#   → kubernetes_manifest.cluster_secret_store (configures backend)
#   → kubernetes_manifest.external_secret (creates cargotrack-secrets)
#   → ArgoCD-managed pods (consume the Secret)

resource "helm_release" "eso" {
  name       = "external-secrets"
  repository = "https://charts.external-secrets.io"
  chart      = "external-secrets"
  version    = "0.9.19" # pin — update deliberately
  namespace  = "kube-system"

  wait            = true
  timeout         = 300
  cleanup_on_fail = true

  # Annotate the ESO service account with the IRSA role ARN.
  # This is the only authentication ESO needs — no static AWS credentials.
  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.irsa.eso_role_arn
  }

  # Fix the service account name to match the IRSA trust policy subject:
  #   system:serviceaccount:kube-system:external-secrets
  set {
    name  = "serviceAccount.name"
    value = "external-secrets"
  }

  depends_on = [
    module.eks,
    module.irsa,
    helm_release.aws_load_balancer_controller,
    kubernetes_namespace.cargotrack,
  ]
}

# ── ClusterSecretStore ───────────────────────────────────────────────────────
# Configures ESO to use AWS Secrets Manager in us-east-1.
# Uses the IRSA credentials already injected into the ESO service account —
# no static credentials or separate SecretStore secret needed.

resource "kubernetes_manifest" "cluster_secret_store" {
  manifest = {
    apiVersion = "external-secrets.io/v1beta1"
    kind       = "ClusterSecretStore"
    metadata = {
      name = "aws-secrets-manager"
    }
    spec = {
      provider = {
        aws = {
          service = "SecretsManager"
          region  = var.aws_region
          auth = {
            # jwt: use the IRSA token projected into the ESO pod.
            # ESO automatically finds the IRSA token from the service account.
            jwt = {
              serviceAccountRef = {
                name      = "external-secrets"
                namespace = "kube-system"
              }
            }
          }
        }
      }
    }
  }

  field_manager {
    force_conflicts = true
  }

  depends_on = [
    helm_release.eso,
  ]
}

# ── ExternalSecret — cargotrack-secrets ───────────────────────────────────────
# Creates and keeps in sync the Kubernetes Secret "cargotrack-secrets" in the
# cargotrack namespace. ESO polls every hour (resyncPeriod) and re-syncs
# whenever the Secrets Manager secret version changes.
#
# Keys mapped into cargotrack-secrets:
#   From cargotrack-database-secret:    DATABASE_PASSWORD
#   From cargotrack-application-secret: JWT_SECRET, ADMIN_PASSWORD
#
# These are the exact keys referenced by secretKeyRef in all three Helm templates:
#   core-service:     DATABASE_PASSWORD, JWT_SECRET, ADMIN_PASSWORD
#   ai-service:       DATABASE_PASSWORD
#   document-service: DATABASE_PASSWORD, JWT_SECRET

resource "kubernetes_manifest" "external_secret" {
  manifest = {
    apiVersion = "external-secrets.io/v1beta1"
    kind       = "ExternalSecret"
    metadata = {
      name      = "cargotrack-secrets"
      namespace = "cargotrack"
    }
    spec = {
      refreshInterval = "1h"
      secretStoreRef = {
        name = "aws-secrets-manager"
        kind = "ClusterSecretStore"
      }
      target = {
        name           = "cargotrack-secrets"
        creationPolicy = "Owner"
        # When the ExternalSecret is deleted, the managed Secret is also deleted.
        # This ensures terraform destroy leaves no orphaned Secrets.
        deletionPolicy = "Delete"
      }
      data = [
        {
          # DATABASE_PASSWORD from the database secret
          secretKey = "DATABASE_PASSWORD"
          remoteRef = {
            key      = "cargotrack-database-secret"
            property = "password"
          }
        },
        {
          # JWT_SECRET from the application secret
          secretKey = "JWT_SECRET"
          remoteRef = {
            key      = "cargotrack-application-secret"
            property = "jwt_secret"
          }
        },
        {
          # ADMIN_PASSWORD from the application secret
          secretKey = "ADMIN_PASSWORD"
          remoteRef = {
            key      = "cargotrack-application-secret"
            property = "admin_password"
          }
        },
      ]
    }
  }

  field_manager {
    force_conflicts = true
  }

  depends_on = [
    kubernetes_manifest.cluster_secret_store,
    kubernetes_namespace.cargotrack,
  ]
}

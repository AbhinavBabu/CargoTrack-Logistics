# =============================================================================
# k8s.tf — Kubernetes platform layer
#
# Apply order (enforced via depends_on):
#   1. Namespaces (argocd, cargotrack)
#   2. AWS Load Balancer Controller  — kube-system  (needs nodes + IRSA)
#   3. Metrics Server                — kube-system  (needed for HPA)
#   4. Cluster Autoscaler            — kube-system  (least-waste expander)
#   5. ArgoCD                        — argocd        (last — depends on LBC for NLB)
#   6. ArgoCD App-of-Apps CR         — argocd        (eliminates manual kubectl apply)
#
# Destroy order is automatic: Terraform reverses the dependency graph.
#   App-of-Apps CR → ArgoCD → Cluster Autoscaler → Metrics Server → LBC → namespaces
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
        targetRevision = "cargotrack-v3-microservices"
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

  depends_on = [
    helm_release.argocd,
    kubernetes_namespace.argocd,
  ]
}

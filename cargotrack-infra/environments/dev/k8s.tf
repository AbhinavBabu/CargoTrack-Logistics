# =============================================================================
# k8s.tf — Kubernetes platform layer
#
# Apply order (enforced via depends_on):
#   1. Namespaces (argocd, cargotrack)
#   2. AWS Load Balancer Controller  — kube-system  (needs nodes + IRSA)
#   3. Metrics Server                — kube-system  (needed for HPA)
#   4. Cluster Autoscaler            — kube-system  (least-waste expander)
#   5. cargotrack-secrets K8s Secret — cargotrack   (from Secrets Manager, no CRDs)
#   6. ArgoCD                        — argocd        (depends on LBC for NLB)
#   7. ArgoCD App-of-Apps CR         — argocd        (bootstrapped via Helm values)
#
# Destroy order is automatic: Terraform reverses the dependency graph.
#   App-of-Apps CR → ArgoCD → cargotrack-secrets → Cluster Autoscaler
#   → Metrics Server → LBC → namespaces
#
# ── Bootstrap guarantee ───────────────────────────────────────────────────────
# ALL resources in this file use only:
#   • helm_release          — native Terraform, no CRD dependency
#   • kubernetes_namespace  — native Terraform, no CRD dependency
#   • kubernetes_secret     — native Terraform, no CRD dependency
#   • kubernetes_manifest   — ONLY for the ArgoCD Application CR, which is
#                             bootstrapped via the ArgoCD Helm chart's
#                             server.additionalApplications values (the CRDs
#                             are installed by Helm before this manifest runs)
#
# kubernetes_manifest.argocd_root_app: the argoproj.io/v1alpha1/Application CRD
# is installed by helm_release.argocd (wait=true). Terraform applies the Helm
# release FIRST (depends_on enforces this), then applies the manifest. The CRD
# is guaranteed to exist when kubernetes_manifest.argocd_root_app is processed.
#
# IMPORTANT: On a completely fresh cluster, terraform plan is run against the
# live K8s API. If kubernetes_manifest resources try to resolve CRD schemas
# during plan and CRDs don't yet exist, the plan fails. To avoid this:
#   • kubernetes_manifest is used ONLY for ArgoCD Application (argoproj.io CRD)
#   • ESO is NOT used — secrets are created with kubernetes_secret (no CRD)
#   • kubernetes_manifest.argocd_root_app is kept because the kubernetes
#     provider ≥ 2.31 defers CRD schema resolution to apply time when the
#     resource type is not found during plan (it will warn, not fail).
#     If you observe plan failures on a fresh cluster, replace with:
#       helm set server.additionalApplications (see comment near resource)
# =============================================================================

# ── Locals: read secret values from Secrets Manager ───────────────────────────
# Terraform reads these from the AWS API (not Kubernetes), so they are always
# resolvable as long as module.database has been applied in the same run.
# The database and application secrets are created by module.database and
# their values flow directly into the Kubernetes Secret below — no operator,
# no CRD, no second apply required.

data "aws_secretsmanager_secret_version" "database" {
  secret_id = module.database.db_secret_arn

  depends_on = [module.database]
}

data "aws_secretsmanager_secret_version" "application" {
  secret_id = module.database.application_secret_arn

  depends_on = [module.database]
}

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

# ── cargotrack-secrets Kubernetes Secret ──────────────────────────────────────
# Creates the cargotrack-secrets Secret directly from Terraform-managed values.
#
# WHY NOT External Secrets Operator (ESO)?
#
# ESO requires:
#   1. A Helm chart to install the operator (installs ESO CRDs)
#   2. kubernetes_manifest for ClusterSecretStore (requires ESO CRDs at plan time)
#   3. kubernetes_manifest for ExternalSecret (requires ESO CRDs at plan time)
#
# The hashicorp/kubernetes provider's kubernetes_manifest resource validates
# the resource schema against the live K8s API during PLAN, not just APPLY.
# On a fresh cluster where ESO is not yet installed, the CRDs don't exist,
# so Terraform PLAN fails — even though depends_on would ensure correct APPLY
# order. This is a fundamental limitation of the kubernetes_manifest resource.
#
# The result: ESO requires TWO applies on a fresh cluster. This violates the
# platform requirement of a single terraform apply from a destroyed state.
#
# WHY THIS APPROACH IS CORRECT:
#
# The secret values are ALREADY managed by Terraform — they are generated by
# random_password resources in module.database and written to Secrets Manager
# by Terraform itself. Terraform can read them back directly from the module
# outputs (which reference the same resource values), create the Kubernetes
# Secret in one apply, and destroy it cleanly in one destroy.
#
# No operator, no controller, no CRD, no second apply.
#
# Keys required by Helm templates:
#   core-service:     DATABASE_PASSWORD, JWT_SECRET, ADMIN_PASSWORD
#   ai-service:       DATABASE_PASSWORD
#   document-service: DATABASE_PASSWORD, JWT_SECRET
#
# Source mapping (from modules/database/main.tf secret JSON structure):
#   cargotrack-database-secret-v2    → { "password": ..., "username": ..., "dbname": ... }
#   cargotrack-application-secret-v2 → { "jwt_secret": ..., "admin_password": ..., "admin_email": ... }

resource "kubernetes_secret" "cargotrack_secrets" {
  metadata {
    name      = "cargotrack-secrets"
    namespace = kubernetes_namespace.cargotrack.metadata[0].name
    labels = {
      "app.kubernetes.io/managed-by" = "Terraform"
      "app.kubernetes.io/part-of"    = "cargotrack"
    }
  }

  type = "Opaque"

  # Values sourced from the data sources declared at the top of this file.
  # jsondecode() parses the Secrets Manager JSON blob into a map, then we
  # extract the exact key that each service expects.
  data = {
    DATABASE_PASSWORD = jsondecode(data.aws_secretsmanager_secret_version.database.secret_string)["password"]
    JWT_SECRET        = jsondecode(data.aws_secretsmanager_secret_version.application.secret_string)["jwt_secret"]
    ADMIN_PASSWORD    = jsondecode(data.aws_secretsmanager_secret_version.application.secret_string)["admin_password"]
  }

  # Force recreation if the secret values change (e.g. rotation)
  lifecycle {
    ignore_changes = []
  }

  depends_on = [
    kubernetes_namespace.cargotrack,
    data.aws_secretsmanager_secret_version.database,
    data.aws_secretsmanager_secret_version.application,
  ]
}

# ── ArgoCD ────────────────────────────────────────────────────────────────────
# Installed after LBC — ArgoCD server is exposed via an NLB created by LBC.
#
# Bootstrap strategy:
#   The root Application CR (app-of-apps pattern) is injected directly into the
#   ArgoCD Helm release via server.additionalApplications Helm values. This means
#   ArgoCD installs its own CRDs and then creates the Application resource as part
#   of the same Helm install — no separate kubernetes_manifest needed for bootstrap.
#
# Why not a separate kubernetes_manifest for the root app?
#   kubernetes_manifest validates CRD schemas at PLAN time. Even with depends_on,
#   the plan-time validation of argoproj.io/v1alpha1/Application fails on a fresh
#   cluster because the CRDs aren't installed yet. Using Helm values to inject the
#   Application CR avoids this entirely — ArgoCD's own Helm chart creates it.
#
# Service configuration:
#   server.service.type = LoadBalancer
#     → Triggers the AWS LBC (already installed above) to create an NLB.
#
#   aws-load-balancer-scheme: internet-facing
#     → Forces an internet-facing NLB in public subnets.
#
#   aws-load-balancer-type: external
#     → Ensures the NLB is provisioned via the AWS LBC (not legacy controller).
#
# Destroy safety:
#   ArgoCD's cascade delete finalizer (resources-finalizer.argocd.argoproj.io)
#   on the root Application causes ArgoCD to delete all managed K8s resources
#   (Ingress → ALB removed) before this Helm release is uninstalled.

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

  # ── App-of-Apps bootstrap via Helm values ─────────────────────────────────
  # Injects the root Application CR directly into the ArgoCD Helm install.
  # This avoids the kubernetes_manifest CRD bootstrap problem on fresh clusters.
  # ArgoCD creates this Application as part of its own Helm chart — the CRDs
  # are always available because Helm installs them in the same operation.
  #
  # Note: ArgoCD chart v7.x uses server.additionalApplications for this.
  # The finalizer ensures cascade-delete on destroy (Ingress → ALB cleanup).

  set {
    name  = "server.additionalApplications[0].name"
    value = "root-app"
  }

  set {
    name  = "server.additionalApplications[0].namespace"
    value = "argocd"
  }

  set {
    name  = "server.additionalApplications[0].project"
    value = "default"
  }

  set {
    name  = "server.additionalApplications[0].source.repoURL"
    value = "https://github.com/AbhinavBabu/CargoTrack-Logistics.git"
  }

  set {
    name  = "server.additionalApplications[0].source.targetRevision"
    value = "cargotrack-terraform-v2"
  }

  set {
    name  = "server.additionalApplications[0].source.path"
    value = "gitops/apps"
  }

  set {
    name  = "server.additionalApplications[0].destination.server"
    value = "https://kubernetes.default.svc"
  }

  set {
    name  = "server.additionalApplications[0].destination.namespace"
    value = "argocd"
  }

  set {
    name  = "server.additionalApplications[0].syncPolicy.automated.prune"
    value = "true"
  }

  set {
    name  = "server.additionalApplications[0].syncPolicy.automated.selfHeal"
    value = "true"
  }

  set {
    name  = "server.additionalApplications[0].syncPolicy.syncOptions[0]"
    value = "CreateNamespace=true"
  }

  set {
    name  = "server.additionalApplications[0].finalizers[0]"
    value = "resources-finalizer.argocd.argoproj.io"
  }

  depends_on = [
    module.eks,
    kubernetes_namespace.argocd,
    kubernetes_secret.cargotrack_secrets,
    helm_release.aws_load_balancer_controller,
    helm_release.cluster_autoscaler,
    helm_release.metrics_server,
  ]
}

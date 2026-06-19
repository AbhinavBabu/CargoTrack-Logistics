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
#   7. null_resource pre-destroy     — (no-op on apply; cleans Ingress on destroy)
#   8. ArgoCD App-of-Apps CR         — argocd        (kubernetes_manifest, no finalizer)
#
# Destroy order (reversed dependency graph):
#   argocd_root_app → null_resource (ingress cleanup) → argocd → cargotrack_secrets
#   → cluster_autoscaler → metrics_server → aws_load_balancer_controller → namespaces
#
# Single-apply guarantee:
#   All resources use native K8s types or Helm releases — no ESO CRDs.
#   kubernetes_manifest for the ArgoCD Application CR depends on helm_release.argocd
#   (wait=true), which installs the argoproj.io CRDs before the manifest is applied.
# =============================================================================

# ── Read secret values from Secrets Manager ───────────────────────────────────
# Resolved from the AWS API (not Kubernetes) — always available in a single apply.
# The database and application secrets are created and populated by module.database
# in the same apply. No operator, no CRD, no second apply.

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
# Uses IRSA role cargotrack-irsa-alb-controller.
# ServiceAccount must match IRSA trust policy subject:
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

  # AL2023 nodes block IMDS by default — pass VPC ID explicitly.
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
# Required for HPA. --kubelet-insecure-tls needed for EKS self-signed certs.
# --kubelet-preferred-address-types=InternalIP needed for private-subnet nodes.

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
# Uses IRSA role cargotrack-irsa-cluster-autoscaler.
# Node group in modules/eks has the required auto-discovery tags.

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

  set {
    name  = "rbac.serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.irsa.cluster_autoscaler_role_arn
  }

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
# Created directly by Terraform using values from AWS Secrets Manager.
# No External Secrets Operator (avoids CRD bootstrap / two-apply problem).
# Secret JSON key names from modules/database/main.tf:
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

  data = {
    DATABASE_PASSWORD = jsondecode(data.aws_secretsmanager_secret_version.database.secret_string)["password"]
    JWT_SECRET        = jsondecode(data.aws_secretsmanager_secret_version.application.secret_string)["jwt_secret"]
    ADMIN_PASSWORD    = jsondecode(data.aws_secretsmanager_secret_version.application.secret_string)["admin_password"]
  }

  lifecycle {
    ignore_changes = []
  }

  depends_on = [
    kubernetes_namespace.cargotrack,
    data.aws_secretsmanager_secret_version.database,
    data.aws_secretsmanager_secret_version.application,
  ]
}

# ── cargotrack-aws-config ConfigMap ───────────────────────────────────────────
# WHY TERRAFORM (not Helm) creates this ConfigMap:
#
#   The Helm chart's configmap.yaml template renders DATABASE_HOST and other
#   AWS resource identifiers from values-dev.yaml. Those values are empty in
#   Git (they are Terraform outputs, not static values). ArgoCD deploys from
#   Git — whatever is in the file at commit time is what gets deployed.
#   Result: DATABASE_HOST = "" → init container fails: nc: bad address ''.
#
#   There is no way to make ArgoCD inject dynamic Terraform output values into
#   a Helm values file without a commit/push cycle after apply, which violates
#   the platform requirement.
#
#   SOLUTION: Terraform creates the ConfigMap directly using native Terraform
#   resource outputs. This is identical to how kubernetes_secret.cargotrack_secrets
#   is created. The Helm chart's configmap.yaml template is removed — ArgoCD
#   no longer owns or manages this ConfigMap.
#
# DEPENDENCY CHAIN:
#   module.database (RDS endpoint available)
#   module.eventing (EventBridge + SQS URLs available)
#   module.audit (DynamoDB table name available)
#   module.storage (S3 bucket name available)
#     → kubernetes_config_map.cargotrack_aws_config (created with real values)
#       → ArgoCD syncs Deployments → pods read ConfigMap → DATABASE_HOST populated
#
# DESTROY: Terraform destroys this ConfigMap when `terraform destroy` is run.
# No orphaned ConfigMaps after destroy.

resource "kubernetes_config_map" "cargotrack_aws_config" {
  metadata {
    name      = "cargotrack-aws-config"
    namespace = kubernetes_namespace.cargotrack.metadata[0].name
    labels = {
      "app.kubernetes.io/managed-by" = "Terraform"
      "app.kubernetes.io/part-of"    = "cargotrack"
    }
  }

  # module.database.db_endpoint returns "hostname:port" — strip the port suffix
  # with split() so DATABASE_HOST contains only the hostname (required by nc -z
  # and by Prisma which constructs its own connection string).
  data = {
    AWS_DEFAULT_REGION       = var.aws_region
    DATABASE_HOST            = split(":", module.database.db_endpoint)[0]
    DATABASE_PORT            = "5432"
    DATABASE_NAME            = "cargotrack"
    DATABASE_USER            = "cargotrack"
    S3_BUCKET                = module.storage.bucket_id
    EVENT_BUS_NAME           = module.eventing.event_bus_name
    SQS_COMPLIANCE_QUEUE_URL = module.eventing.compliance_queue_url
    DYNAMO_AUDIT_TABLE       = module.audit.table_name
    DB_SECRET_ARN            = module.database.db_secret_arn
    APP_SECRET_ARN           = module.database.application_secret_arn
  }

  depends_on = [
    kubernetes_namespace.cargotrack,
    module.database,
    module.storage,
    module.eventing,
    module.audit,
  ]
}

# ── cargotrack-dev ArgoCD Application (IRSA role ARN injection) ───────────────
# WHY THIS EXISTS:
#
#   The cargotrack-dev ArgoCD Application deploys the Helm chart from Git.
#   The Helm chart ServiceAccount manifests require IRSA role ARNs in their
#   eks.amazonaws.com/role-arn annotations. These ARNs are Terraform outputs
#   and cannot be committed to values-dev.yaml without a post-apply edit cycle.
#
#   This kubernetes_manifest patches the cargotrack-dev Application to inject
#   helm.parameters that override the serviceAccount.roleArn values for each
#   service. ArgoCD passes these parameters to Helm at sync time, exactly as
#   if they were present in values-dev.yaml — with no commit required.
#
#   This is the ArgoCD-native way to inject dynamic values into a Helm
#   release managed by ArgoCD. It is idempotent and survives re-apply.
#
# DESTROY: This manifest is destroyed before ArgoCD is uninstalled (via
# depends_on graph reversal), so the Application CR is cleaned up correctly.

resource "kubernetes_manifest" "cargotrack_dev_app" {
  manifest = {
    apiVersion = "argoproj.io/v1alpha1"
    kind       = "Application"
    metadata = {
      name      = "cargotrack-dev"
      namespace = "argocd"
      # finalizers intentionally omitted (same reasoning as argocd_root_app)
    }
    spec = {
      project = "default"
      source = {
        repoURL        = "https://github.com/AbhinavBabu/CargoTrack-Logistics.git"
        targetRevision = "cargotrack-terraform-v2"
        path           = "helm/cargotrack"
        helm = {
          valueFiles = [
            "values.yaml",
            "values-dev.yaml",
          ]
          # IRSA role ARNs injected by Terraform — these override the empty
          # roleArn fields in values-dev.yaml without requiring a file edit.
          # MOCK_AGENT and TEXTRACT_ENABLED are also injected here so that
          # enabling/disabling real Bedrock is a Terraform variable change,
          # not a Git commit to values-dev.yaml.
          parameters = [
            {
              name  = "coreService.serviceAccount.roleArn"
              value = module.irsa.core_service_role_arn
            },
            {
              name  = "documentService.serviceAccount.roleArn"
              value = module.irsa.document_service_role_arn
            },
            {
              name  = "aiService.serviceAccount.roleArn"
              value = module.irsa.ai_service_role_arn
            },
            {
              # Set to "false" to use real Amazon Bedrock (Nova Lite / Pro).
              # Set to "true" to fall back to mock responses (no AWS calls).
              # Requires model access enabled in AWS Console → Bedrock → Model access.
              name  = "aiService.env.MOCK_AGENT"
              value = "false"
            },
            {
              # Set to "true" to enable Amazon Textract for document field extraction.
              # Requires Textract permissions on the ai-service IRSA role (already granted).
              name  = "aiService.env.TEXTRACT_ENABLED"
              value = "true"
            },
            {
              # Force Bedrock as the LLM provider for both compliance agent and Copilot.
              # Without this, config.ts falls back to mock if LLM_PROVIDER is unset.
              name  = "aiService.env.LLM_PROVIDER"
              value = "bedrock"
            },
          ]

        }
      }
      destination = {
        server    = "https://kubernetes.default.svc"
        namespace = "cargotrack"
      }
      syncPolicy = {
        automated = {
          prune    = true
          selfHeal = true
        }
        syncOptions = [
          "CreateNamespace=true",
          "ServerSideApply=true",
        ]
        retry = {
          limit = 3
          backoff = {
            duration    = "5s"
            maxDuration = "3m"
            factor      = 2
          }
        }
      }
    }
  }

  field_manager {
    force_conflicts = true
  }

  depends_on = [
    helm_release.argocd,
    kubernetes_namespace.cargotrack,
    kubernetes_config_map.cargotrack_aws_config,
    kubernetes_secret.cargotrack_secrets,
    module.irsa,
  ]
}


# Installed after LBC — ArgoCD server NLB is created by the LBC.
#
# The root Application CR is created by a SEPARATE kubernetes_manifest resource
# below. This gives Terraform explicit lifecycle control and avoids the
# server.additionalApplications Helm pattern (which has its own timeout problem
# when the Application CR has a finalizer and Helm tries to upgrade/uninstall).

resource "helm_release" "argocd" {
  name       = "argocd"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argo-cd"
  version    = "7.4.4" # pin — update deliberately
  namespace  = kubernetes_namespace.argocd.metadata[0].name

  wait            = true
  timeout         = 600 # 10 minutes — ArgoCD has many components
  cleanup_on_fail = true

  # Expose ArgoCD server via an internet-facing NLB
  set {
    name  = "server.service.type"
    value = "LoadBalancer"
  }

  set {
    name  = "server.service.annotations.service\\.beta\\.kubernetes\\.io/aws-load-balancer-scheme"
    value = "internet-facing"
  }

  set {
    name  = "server.service.annotations.service\\.beta\\.kubernetes\\.io/aws-load-balancer-type"
    value = "external"
  }

  # TLS terminated at NLB/CloudFront — run ArgoCD server in insecure mode
  set {
    name  = "server.extraArgs[0]"
    value = "--insecure"
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

# ── Pre-destroy ingress cleanup ───────────────────────────────────────────────
# PURPOSE: Ensure the ALB is deprovisioned before the LBC is uninstalled.
#
# WHY NEEDED:
#   The root Application CR (below) has NO cascade-delete finalizer.
#   Without the finalizer, deleting the Application CR does NOT trigger ArgoCD
#   to garbage-collect its child resources (Deployment, Service, Ingress, etc.).
#   If the Ingress remains when the LBC is uninstalled, the ALB is orphaned.
#
#   The finalizer was deliberately removed because:
#   - Terraform's kubernetes_manifest has NO configurable delete timeout
#   - A full CargoTrack deploy has 20+ managed objects → cascade delete takes
#     5-10 min → Terraform times out every time
#
# WHAT IT DOES ON DESTROY (local-exec, automated by Terraform — not manual):
#   1. Configures kubectl using aws eks update-kubeconfig
#   2. Deletes all Ingress resources in the cargotrack namespace
#   3. Waits 30 s for the LBC to finish deprovisioning the ALB
#   The LBC is still running at this point (see destroy sequence below).
#
# DESTROY SEQUENCE (enforced by depends_on graph):
#
#   kubernetes_manifest.argocd_root_app  ← destroyed FIRST (depends on this null_resource)
#         ↓
#   null_resource.pre_destroy_ingress_cleanup  ← local-exec deletes Ingress
#         ↓                                      LBC still alive → ALB removed ✅
#   helm_release.argocd                  ← ArgoCD uninstalled
#         ↓
#   [cargotrack_secrets, autoscaler, metrics]
#         ↓
#   helm_release.aws_load_balancer_controller  ← LBC uninstalled (ALB already gone)
#         ↓
#   kubernetes_namespace.*               ← Namespaces deleted (already empty)
#
# APPLY: The local-exec provisioner is tagged `when = destroy` — it does NOT
# run on apply. The triggers block is set from module outputs so this resource
# is re-created (and the new triggers stored) whenever the cluster changes.

resource "null_resource" "pre_destroy_ingress_cleanup" {
  triggers = {
    cluster_name = module.eks.cluster_name
    aws_region   = var.aws_region
    namespace    = "cargotrack"
  }

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["bash", "-c"]
    command     = <<-EOT
      set -e
      echo "[pre-destroy] Configuring kubectl for ${self.triggers.cluster_name}..."
      aws eks update-kubeconfig \
        --name "${self.triggers.cluster_name}" \
        --region "${self.triggers.aws_region}" \
        --kubeconfig "/tmp/cargotrack-kube-destroy.conf" 2>/dev/null

      echo "[pre-destroy] Deleting Ingress resources in ${self.triggers.namespace}..."
      KUBECONFIG="/tmp/cargotrack-kube-destroy.conf" \
        kubectl delete ingress --all \
          -n "${self.triggers.namespace}" \
          --timeout=120s \
          --ignore-not-found=true 2>/dev/null || true

      echo "[pre-destroy] Waiting 30s for ALB deprovisioning..."
      sleep 30

      echo "[pre-destroy] Ingress cleanup complete."
    EOT
  }

  # Must be destroyed AFTER helm_release.argocd so ArgoCD is still running
  # during the local-exec (ArgoCD is not needed for the cleanup itself, but
  # the LBC is — and LBC is destroyed after ArgoCD in the graph).
  depends_on = [
    helm_release.argocd,
  ]
}

# ── ArgoCD App-of-Apps Bootstrap ─────────────────────────────────────────────
# Creates the root Application CR (app-of-apps pattern) that points ArgoCD
# at gitops/apps/ on the cargotrack-terraform-v2 branch.
#
# DESIGN DECISIONS:
#
# 1. kubernetes_manifest (not server.additionalApplications):
#    A separate resource gives Terraform explicit lifecycle control.
#    field_manager { force_conflicts = true } resolves field-ownership
#    conflicts with argocd-controller without requiring manual patching.
#
# 2. NO cascade-delete finalizer (resources-finalizer.argocd.argoproj.io):
#    The finalizer causes kubernetes_manifest deletion to block until ArgoCD
#    cascade-deletes every child resource. Terraform has no configurable
#    delete timeout for kubernetes_manifest → always times out.
#    ALB cleanup is handled by null_resource.pre_destroy_ingress_cleanup.
#
# 3. No CRD bootstrap issue:
#    depends_on = [helm_release.argocd] ensures the Helm chart (which
#    installs the argoproj.io CRDs with wait=true) runs BEFORE this manifest.
#    Terraform applies resources in dependency order — CRDs exist by the time
#    this manifest is applied.
#
# 4. Migration safety:
#    If this resource exists in state WITH the old cascade-delete finalizer,
#    Terraform will UPDATE (patch) the Application CR to remove the finalizer.
#    This patch is instant — no deletion, no timeout, no manual intervention.
#    The Application continues running; ArgoCD continues syncing.
#
# 5. Destroy sequence guarantee:
#    kubernetes_manifest.argocd_root_app depends on null_resource.pre_destroy_ingress_cleanup.
#    On destroy, Terraform reverses the graph:
#      argocd_root_app is destroyed FIRST (instant, no finalizer)
#      null_resource cleanup runs SECOND (deletes Ingress, ALB removed)
#      argocd is destroyed THIRD
#      LBC is destroyed LAST (ALB already gone) ✅

resource "kubernetes_manifest" "argocd_root_app" {
  manifest = {
    apiVersion = "argoproj.io/v1alpha1"
    kind       = "Application"
    metadata = {
      name      = "root-app"
      namespace = "argocd"
      # finalizers intentionally omitted:
      #   Setting finalizers = [] causes a provider inconsistency error because
      #   the K8s API returns null for empty finalizers, not []. Omitting the key
      #   tells the kubernetes SSA field manager not to manage this field at all.
      #   The cascade-delete finalizer was already removed from the live resource.
    }
    spec = {
      project = "default"
      source = {
        repoURL        = "https://github.com/AbhinavBabu/CargoTrack-Logistics.git"
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
          "CreateNamespace=true",
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
    kubernetes_manifest.cargotrack_dev_app,
    # This dependency ensures that on DESTROY, the null_resource is destroyed
    # BEFORE this Application CR is deleted (Terraform reverses the graph).
    # Destroy order: argocd_root_app → null_resource (cleanup) → argocd → LBC
    null_resource.pre_destroy_ingress_cleanup,
  ]
}

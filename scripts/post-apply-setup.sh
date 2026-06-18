#!/usr/bin/env bash
# =============================================================================
# post-apply-setup.sh
# Run ONCE after `terraform apply` to wire up the full EKS deployment stack:
#   1. Reads all Terraform outputs
#   2. Configures kubectl
#   3. Creates the cargotrack-secrets Kubernetes Secret from AWS Secrets Manager
#   4. Installs AWS Load Balancer Controller via Helm
#   5. Installs ArgoCD via Helm
#   6. Injects all Terraform outputs (including ECR registry) into values-dev.yaml
#   7. Applies ArgoCD root Application (App-of-Apps)
#
# Usage:
#   cd /path/to/CargoTrack-Logistics
#   bash scripts/post-apply-setup.sh
#
# Prerequisites:
#   - terraform apply completed (127 resources)
#   - aws cli configured with sufficient IAM permissions
#   - kubectl, helm, jq installed
# =============================================================================
set -euo pipefail

INFRA_DIR="cargotrack-infra/environments/dev"
VALUES_FILE="helm/cargotrack/values-dev.yaml"
CLUSTER_NAME="cargotrack"
REGION="us-east-1"

# ── Colour helpers ─────────────────────────────────────────────────────────
GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${BLUE}==>${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }

# ── Step 1: Read all Terraform outputs ────────────────────────────────────
info "Reading terraform outputs..."
cd "$INFRA_DIR"

EKS_CLUSTER_NAME=$(terraform output -raw eks_cluster_name)
S3_BUCKET=$(terraform output -raw s3_bucket_name)
EVENT_BUS=$(terraform output -raw event_bus_name)
COMPLIANCE_QUEUE=$(terraform output -raw compliance_queue_url)
AUDIT_TABLE=$(terraform output -raw dynamodb_audit_table)
CORE_ROLE=$(terraform output -raw irsa_core_service_role_arn)
DOCS_ROLE=$(terraform output -raw irsa_document_service_role_arn)
AI_ROLE=$(terraform output -raw irsa_ai_service_role_arn)
ALB_ROLE=$(terraform output -raw irsa_alb_controller_role_arn)
DB_SECRET_ARN=$(terraform output -raw db_secret_arn)
APP_SECRET_ARN=$(terraform output -raw application_secret_arn)
RDS_ENDPOINT=$(terraform output -raw rds_endpoint)

# ECR registry — format: <account_id>.dkr.ecr.<region>.amazonaws.com
ECR_REGISTRY_ID=$(terraform output -raw ecr_registry_id)
ECR_REGISTRY="${ECR_REGISTRY_ID}.dkr.ecr.${REGION}.amazonaws.com"

success "Terraform outputs read"
info "  EKS Cluster:   ${EKS_CLUSTER_NAME}"
info "  ECR Registry:  ${ECR_REGISTRY}"
info "  S3 Bucket:     ${S3_BUCKET}"
info "  Event Bus:     ${EVENT_BUS}"
echo ""

# ── Step 2: Configure kubectl ──────────────────────────────────────────────
info "Configuring kubectl..."
aws eks update-kubeconfig --name "$EKS_CLUSTER_NAME" --region "$REGION"
success "kubectl configured"

info "Verifying cluster nodes..."
kubectl get nodes
echo ""

# ── Step 3: Create cargotrack namespace and Kubernetes Secrets ────────────
info "Creating namespace and Kubernetes Secrets from AWS Secrets Manager..."

kubectl create namespace cargotrack --dry-run=client -o yaml | kubectl apply -f -

# Retrieve database credentials
DB_SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$DB_SECRET_ARN" \
  --region "$REGION" \
  --query "SecretString" --output text)
DB_PASS=$(echo "$DB_SECRET_JSON" | jq -r '.password')

# Retrieve application secrets (JWT, admin password)
APP_SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$APP_SECRET_ARN" \
  --region "$REGION" \
  --query "SecretString" --output text)
JWT_SEC=$(echo "$APP_SECRET_JSON" | jq -r '.jwt_secret')
ADMIN_PASS=$(echo "$APP_SECRET_JSON" | jq -r '.admin_password')

# Create/update cargotrack-secrets (idempotent via --dry-run=client | kubectl apply)
kubectl create secret generic cargotrack-secrets \
  -n cargotrack \
  --from-literal=DATABASE_PASSWORD="$DB_PASS" \
  --from-literal=JWT_SECRET="$JWT_SEC" \
  --from-literal=ADMIN_PASSWORD="$ADMIN_PASS" \
  --dry-run=client -o yaml | kubectl apply -f -

success "Kubernetes Secret 'cargotrack-secrets' created/updated"
echo ""

# ── Step 4: Install AWS Load Balancer Controller ───────────────────────────
info "Installing AWS Load Balancer Controller..."
helm repo add eks https://aws.github.io/eks-charts --force-update
helm repo update

# Install LBC CRDs (idempotent)
kubectl apply -k \
  "github.com/aws/eks-charts/stable/aws-load-balancer-controller/crds?ref=master" \
  2>/dev/null || true

helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName="$EKS_CLUSTER_NAME" \
  --set serviceAccount.create=true \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set "serviceAccount.annotations.eks\.amazonaws\.com/role-arn=${ALB_ROLE}" \
  --set replicaCount=2 \
  --wait --timeout=5m

success "AWS Load Balancer Controller installed"
echo ""

# ── Step 5: Install metrics-server (required for HPA) ─────────────────────
info "Installing metrics-server (required for HPA)..."
kubectl apply -f \
  https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
success "metrics-server applied"
echo ""

# ── Step 6: Install ArgoCD ─────────────────────────────────────────────────
info "Installing ArgoCD..."
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
helm repo add argo https://argoproj.github.io/argo-helm --force-update
helm repo update

helm upgrade --install argocd argo/argo-cd \
  -n argocd \
  --set server.service.type=LoadBalancer \
  --wait --timeout=8m

success "ArgoCD installed"

echo ""
info "ArgoCD admin password:"
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d
echo ""

info "ArgoCD server URL:"
kubectl get svc argocd-server -n argocd \
  -o jsonpath="{.status.loadBalancer.ingress[0].hostname}"
echo ""
echo ""

# ── Step 7: Inject all Terraform outputs into values-dev.yaml ─────────────
info "Updating ${VALUES_FILE} with all Terraform outputs..."
cd -  # back to project root

cat > "$VALUES_FILE" << EOF
# CargoTrack Dev Environment Values
# Auto-generated by scripts/post-apply-setup.sh — DO NOT edit manually.
# Re-run this script after any terraform apply to refresh values.
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

global:
  environment: dev
  region: ${REGION}
  namespace: cargotrack

image:
  # ECR registry injected from: terraform output ecr_registry_id
  registry: "${ECR_REGISTRY}"
  pullPolicy: Always

coreService:
  tag: latest
  serviceAccount:
    roleArn: "${CORE_ROLE}"

documentService:
  tag: latest
  serviceAccount:
    roleArn: "${DOCS_ROLE}"

aiService:
  tag: latest
  serviceAccount:
    roleArn: "${AI_ROLE}"
  env:
    MOCK_AGENT: "true"          # Set to "false" when Bedrock access confirmed
    TEXTRACT_ENABLED: "false"   # Set to "true" when Textract permissions verified

frontend:
  tag: latest

hpa:
  enabled: true

aws:
  region: ${REGION}
  rdsEndpoint: "${RDS_ENDPOINT}"
  rdsDatabase: cargotrack
  rdsUsername: cargotrack
  s3BucketName: "${S3_BUCKET}"
  eventBusName: "${EVENT_BUS}"
  complianceQueueUrl: "${COMPLIANCE_QUEUE}"
  auditTableName: "${AUDIT_TABLE}"
  dbSecretArn: "${DB_SECRET_ARN}"
  appSecretArn: "${APP_SECRET_ARN}"
EOF

success "${VALUES_FILE} written with all Terraform outputs"
echo ""

# ── Step 8: Apply ArgoCD root Application (App-of-Apps) ───────────────────
info "Applying ArgoCD root Application..."
kubectl apply -f gitops/apps/root-app.yaml
success "ArgoCD root Application applied"

echo ""
echo "════════════════════════════════════════════"
success "Setup Complete!"
echo ""
echo "ArgoCD is now watching: helm/cargotrack/"
echo ""
echo "Next steps:"
echo "  1. Push a git commit to trigger GitHub Actions (build + ECR push)"
echo "     The workflow will update values-dev.yaml image tags automatically."
echo "  2. ArgoCD will detect the values-dev.yaml change and deploy."
echo ""
echo "Monitor ArgoCD sync:"
echo "  kubectl get applications -n argocd -w"
echo ""
echo "Monitor pods:"
echo "  kubectl get pods -n cargotrack -w"
echo ""
echo "Get ALB DNS (after Ingress is synced):"
echo "  kubectl get ingress -n cargotrack"
echo "════════════════════════════════════════════"

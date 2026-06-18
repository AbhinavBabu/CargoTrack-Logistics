#!/usr/bin/env bash
# =============================================================================
# CargoTrack — Build & Push All Images to ECR
# =============================================================================
# Usage:
#   chmod +x scripts/build-and-push.sh
#   ./scripts/build-and-push.sh
#
# Prerequisites:
#   - AWS CLI configured with credentials (or running on EC2/CodeBuild with IAM role)
#   - Docker daemon running
#   - Terraform already applied (state must exist with ECR repos)
#   - jq installed (for parsing Terraform outputs)
#
# The script reads ECR repo URLs from Terraform outputs automatically.
# No hardcoded account IDs.
# =============================================================================
set -euo pipefail

# ── Colour helpers ─────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Configuration ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_DIR="${PROJECT_ROOT}/cargotrack-infra/environments/dev"
IMAGE_TAG="${IMAGE_TAG:-latest}"
AWS_REGION="${AWS_REGION:-us-east-1}"

echo ""
echo "=================================================="
echo "  CargoTrack ECR Build & Push"
echo "  Tag: ${IMAGE_TAG}"
echo "  Region: ${AWS_REGION}"
echo "=================================================="
echo ""

# ── Step 1: Get ECR URLs from Terraform ───────────────────────────────────
info "Reading ECR repository URLs from Terraform outputs..."
cd "${INFRA_DIR}"

if ! terraform output -json ecr_repository_urls > /dev/null 2>&1; then
  error "Cannot read terraform outputs. Run 'terraform apply' first."
fi

ECR_REGISTRY_ID=$(terraform output -raw ecr_registry_id)
ECR_FRONTEND=$(terraform output -json ecr_repository_urls | jq -r '.frontend')
ECR_CORE=$(terraform output -json ecr_repository_urls | jq -r '.core')
ECR_AI=$(terraform output -json ecr_repository_urls | jq -r '.ai')
ECR_DOCS=$(terraform output -json ecr_repository_urls | jq -r '.docs')

info "ECR Registry: ${ECR_REGISTRY_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
info "Frontend repo: ${ECR_FRONTEND}"
info "Core repo:     ${ECR_CORE}"
info "AI repo:       ${ECR_AI}"
info "Docs repo:     ${ECR_DOCS}"
echo ""

# ── Step 2: Docker login to ECR ────────────────────────────────────────────
info "Authenticating Docker to ECR..."
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin \
    "${ECR_REGISTRY_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
success "Docker authenticated to ECR"
echo ""

# ── Step 3: Build and push each service ───────────────────────────────────
build_and_push() {
  local SERVICE_NAME="$1"
  local CONTEXT_DIR="$2"
  local IMAGE_URI="$3"

  info "Building ${SERVICE_NAME}..."
  docker build \
    --platform linux/amd64 \
    --tag "${IMAGE_URI}:${IMAGE_TAG}" \
    --file "${CONTEXT_DIR}/Dockerfile" \
    "${CONTEXT_DIR}"

  info "Pushing ${SERVICE_NAME}:${IMAGE_TAG} → ECR..."
  docker push "${IMAGE_URI}:${IMAGE_TAG}"
  success "${SERVICE_NAME} pushed: ${IMAGE_URI}:${IMAGE_TAG}"
  echo ""
}

cd "${PROJECT_ROOT}"

# Frontend
build_and_push \
  "frontend" \
  "frontend" \
  "${ECR_FRONTEND}"

# Core Service
build_and_push \
  "core-service" \
  "services/core-service" \
  "${ECR_CORE}"

# AI Service
build_and_push \
  "ai-service" \
  "services/ai-service" \
  "${ECR_AI}"

# Document Service
build_and_push \
  "document-service" \
  "services/document-service" \
  "${ECR_DOCS}"

# ── Step 4: Update k8s manifests with account ID ─────────────────────────
echo ""
info "Updating Kubernetes manifests with ECR account ID..."
ACCOUNT_ID="${ECR_REGISTRY_ID}"

for MANIFEST in \
  "${PROJECT_ROOT}/k8s/frontend/deployment.yaml" \
  "${PROJECT_ROOT}/k8s/core-service/deployment.yaml" \
  "${PROJECT_ROOT}/k8s/ai-service/deployment.yaml" \
  "${PROJECT_ROOT}/k8s/document-service/deployment.yaml"; do
  if grep -q "<ACCOUNT_ID>" "${MANIFEST}"; then
    sed -i "s|<ACCOUNT_ID>|${ACCOUNT_ID}|g" "${MANIFEST}"
    success "Updated: $(basename $(dirname ${MANIFEST}))/$(basename ${MANIFEST})"
  fi
done

echo ""
echo "=================================================="
success "All images built and pushed to ECR successfully!"
echo ""
echo "Next steps:"
echo "  1. Populate k8s/secrets/ with values from AWS Secrets Manager"
echo "  2. Update k8s/configmaps/cargotrack-config.yaml with Terraform outputs"
echo "  3. kubectl apply -f k8s/namespace.yaml"
echo "  4. kubectl apply -f k8s/secrets/"
echo "  5. kubectl apply -f k8s/configmaps/"
echo "  6. kubectl apply -f k8s/core-service/"
echo "  7. kubectl apply -f k8s/document-service/ k8s/ai-service/ k8s/frontend/"
echo "  8. kubectl apply -f k8s/ingress/"
echo "  9. kubectl apply -f k8s/hpa/"
echo "=================================================="

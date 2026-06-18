#!/usr/bin/env bash
# =============================================================================
# CargoTrack — Generate k8s ConfigMap from Terraform Outputs
# =============================================================================
# Usage: ./scripts/generate-k8s-config.sh
# Run after terraform apply to populate k8s/configmaps/cargotrack-config.yaml
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_DIR="${PROJECT_ROOT}/cargotrack-infra/environments/dev"
CONFIG_FILE="${PROJECT_ROOT}/k8s/configmaps/cargotrack-config.yaml"
AWS_REGION="${AWS_REGION:-us-east-1}"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }

info "Reading Terraform outputs from ${INFRA_DIR}..."
cd "${INFRA_DIR}"

S3_BUCKET=$(terraform output -raw s3_bucket_name)
DYNAMO_TABLE=$(terraform output -raw dynamodb_audit_table)
EVENT_BUS=$(terraform output -raw event_bus_name)
SQS_URL=$(terraform output -raw compliance_queue_url)
CF_DOMAIN=$(terraform output -raw cloudfront_domain_name)

success "Terraform outputs read successfully"
info "  S3 Bucket:         ${S3_BUCKET}"
info "  DynamoDB Table:    ${DYNAMO_TABLE}"
info "  EventBridge Bus:   ${EVENT_BUS}"
info "  SQS Compliance:    ${SQS_URL}"
info "  CloudFront Domain: ${CF_DOMAIN}"
echo ""

info "Patching ${CONFIG_FILE}..."
sed -i \
  -e "s|<BUCKET_NAME>|${S3_BUCKET}|g" \
  -e "s|<DYNAMO_AUDIT_TABLE>|${DYNAMO_TABLE}|g" \
  -e "s|<EVENT_BUS_NAME>|${EVENT_BUS}|g" \
  -e "s|<SQS_COMPLIANCE_QUEUE_URL>|${SQS_URL}|g" \
  -e "s|<CLOUDFRONT_DOMAIN>|${CF_DOMAIN}|g" \
  "${CONFIG_FILE}"

success "ConfigMap updated with Terraform outputs"
echo ""
echo "Apply with: kubectl apply -f k8s/configmaps/"

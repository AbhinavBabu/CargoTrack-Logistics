# rebuild-frontend.ps1
# ─────────────────────────────────────────────────────────────────────────────
# Rebuilds the frontend Docker image with the fixed nginx.conf and pushes
# it to ECR as both :v1 and :latest.
#
# Run from the CargoTrack-Logistics directory:
#   .\scripts\rebuild-frontend.ps1
#
# Prerequisites:
#   - AWS CLI configured with ECR push permissions
#   - Docker Desktop running
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

$ACCOUNT_ID = "692828329130"
$REGION     = "us-east-1"
$REGISTRY   = "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
$REPO       = "cargotrack-frontend"
$TAG        = "v1"

Write-Host "==> Authenticating to ECR..." -ForegroundColor Cyan
aws ecr get-login-password --region $REGION |
    docker login --username AWS --password-stdin $REGISTRY

Write-Host "==> Building frontend image with fixed nginx.conf..." -ForegroundColor Cyan
docker build `
    --platform linux/amd64 `
    -t "$REGISTRY/${REPO}:${TAG}" `
    -t "$REGISTRY/${REPO}:latest" `
    ./frontend

Write-Host "==> Pushing $REGISTRY/${REPO}:${TAG}..." -ForegroundColor Cyan
docker push "$REGISTRY/${REPO}:${TAG}"

Write-Host "==> Pushing $REGISTRY/${REPO}:latest..." -ForegroundColor Cyan
docker push "$REGISTRY/${REPO}:latest"

Write-Host ""
Write-Host "Done. ArgoCD will pick up the new image on next sync." -ForegroundColor Green
Write-Host "Force sync if needed: argocd app sync cargotrack-dev" -ForegroundColor Yellow

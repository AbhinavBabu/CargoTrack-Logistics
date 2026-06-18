# =============================================================================
# CargoTrack — Build & Push All Images to ECR (PowerShell)
# =============================================================================
# Usage:
#   .\scripts\build-and-push.ps1
#
# Prerequisites:
#   - AWS CLI configured (aws configure) or IAM role attached
#   - Docker Desktop running
#   - Terraform already applied with ECR repositories created
#   - jq for Windows (optional, fallback uses PowerShell JSON parsing)
#
# Reads ECR URLs from Terraform outputs — no hardcoded account IDs.
# =============================================================================
param(
    [string]$ImageTag = "latest",
    [string]$AwsRegion = "us-east-1"
)

$ErrorActionPreference = "Stop"

# ── Colour helpers ─────────────────────────────────────────────────────────
function Write-Info    { param($msg) Write-Host "[INFO]  $msg" -ForegroundColor Cyan }
function Write-Ok      { param($msg) Write-Host "[OK]    $msg" -ForegroundColor Green }
function Write-Warn    { param($msg) Write-Host "[WARN]  $msg" -ForegroundColor Yellow }
function Write-Err     { param($msg) Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

# ── Resolve paths ──────────────────────────────────────────────────────────
$ScriptDir   = $PSScriptRoot
$ProjectRoot = Split-Path $ScriptDir -Parent
$InfraDir    = Join-Path $ProjectRoot "cargotrack-infra\environments\dev"

Write-Host ""
Write-Host "==================================================" -ForegroundColor Blue
Write-Host "  CargoTrack ECR Build & Push (PowerShell)"
Write-Host "  Tag: $ImageTag"
Write-Host "  Region: $AwsRegion"
Write-Host "==================================================" -ForegroundColor Blue
Write-Host ""

# ── Step 1: Read ECR URLs from Terraform ──────────────────────────────────
Write-Info "Reading ECR repository URLs from Terraform outputs..."
Push-Location $InfraDir

try {
    $ecrRegistryId = terraform output -raw ecr_registry_id
    $ecrUrlsJson   = terraform output -json ecr_repository_urls | ConvertFrom-Json

    $ecrFrontend = $ecrUrlsJson.frontend
    $ecrCore     = $ecrUrlsJson.core
    $ecrAi       = $ecrUrlsJson.ai
    $ecrDocs     = $ecrUrlsJson.docs
} catch {
    Write-Err "Failed to read Terraform outputs. Run 'terraform apply' first. Error: $_"
}

Pop-Location

Write-Info "ECR Registry ID: $ecrRegistryId"
Write-Info "Frontend repo:   $ecrFrontend"
Write-Info "Core repo:       $ecrCore"
Write-Info "AI repo:         $ecrAi"
Write-Info "Docs repo:       $ecrDocs"
Write-Host ""

# ── Step 2: ECR Docker Login ────────────────────────────────────────────────
Write-Info "Authenticating Docker to ECR..."
$loginCmd = aws ecr get-login-password --region $AwsRegion
$loginCmd | docker login --username AWS --password-stdin "$ecrRegistryId.dkr.ecr.$AwsRegion.amazonaws.com"
Write-Ok "Docker authenticated to ECR"
Write-Host ""

# ── Step 3: Build & Push helper ─────────────────────────────────────────────
function BuildAndPush {
    param(
        [string]$ServiceName,
        [string]$ContextPath,
        [string]$ImageUri
    )

    $fullTag = "${ImageUri}:${ImageTag}"
    Write-Info "Building $ServiceName..."

    docker build `
        --platform linux/amd64 `
        --tag $fullTag `
        --file "$ContextPath\Dockerfile" `
        $ContextPath

    if ($LASTEXITCODE -ne 0) { Write-Err "Build failed for $ServiceName" }

    Write-Info "Pushing $fullTag → ECR..."
    docker push $fullTag

    if ($LASTEXITCODE -ne 0) { Write-Err "Push failed for $ServiceName" }
    Write-Ok "$ServiceName pushed: $fullTag"
    Write-Host ""
}

Push-Location $ProjectRoot

# Frontend
BuildAndPush "frontend"         "frontend"                  $ecrFrontend

# Core Service
BuildAndPush "core-service"     "services\core-service"     $ecrCore

# AI Service
BuildAndPush "ai-service"       "services\ai-service"       $ecrAi

# Document Service
BuildAndPush "document-service" "services\document-service" $ecrDocs

Pop-Location

# ── Step 4: Patch k8s deployment manifests ─────────────────────────────────
Write-Info "Updating Kubernetes deployment manifests with ECR account ID..."

$manifests = @(
    "k8s\frontend\deployment.yaml",
    "k8s\core-service\deployment.yaml",
    "k8s\ai-service\deployment.yaml",
    "k8s\document-service\deployment.yaml"
)

foreach ($rel in $manifests) {
    $fullPath = Join-Path $ProjectRoot $rel
    if (Test-Path $fullPath) {
        $content = Get-Content $fullPath -Raw
        if ($content -match "<ACCOUNT_ID>") {
            $content = $content -replace "<ACCOUNT_ID>", $ecrRegistryId
            Set-Content -Path $fullPath -Value $content -Encoding UTF8
            Write-Ok "Updated: $rel"
        }
    }
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Ok "All images built and pushed to ECR successfully!"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Run .\scripts\generate-k8s-secrets.ps1 to populate secrets"
Write-Host "  2. Update k8s\configmaps\cargotrack-config.yaml with Terraform outputs"
Write-Host "  3. kubectl apply -f k8s\namespace.yaml"
Write-Host "  4. kubectl apply -f k8s\secrets\"
Write-Host "  5. kubectl apply -f k8s\configmaps\"
Write-Host "  6. kubectl apply -f k8s\core-service\"
Write-Host "  7. kubectl apply -f k8s\document-service\ ; kubectl apply -f k8s\ai-service\ ; kubectl apply -f k8s\frontend\"
Write-Host "  8. kubectl apply -f k8s\ingress\"
Write-Host "  9. kubectl apply -f k8s\hpa\"
Write-Host "==================================================" -ForegroundColor Green

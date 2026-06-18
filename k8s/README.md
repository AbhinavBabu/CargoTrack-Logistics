# CargoTrack — Kubernetes Manifests

## Directory Structure

```
k8s/
├── namespace.yaml              # cargotrack namespace
├── configmaps/
│   └── cargotrack-config.yaml  # Non-secret env vars (populate from terraform outputs)
├── secrets/
│   ├── db-credentials.yaml     # DB host/port/name/user/pass (populate from Secrets Manager)
│   └── app-secrets.yaml        # JWT, admin creds, internal API secret
├── frontend/
│   ├── serviceaccount.yaml     # No IRSA (nginx makes no AWS calls)
│   ├── deployment.yaml         # nginx, port 80, /health probe
│   └── service.yaml            # NodePort (ALB target-type: ip)
├── core-service/
│   ├── serviceaccount.yaml     # IRSA: S3, EventBridge, SQS, Secrets Manager, KMS
│   ├── deployment.yaml         # Port 4000, /api/health probe, runs Prisma migrations
│   └── service.yaml            # ClusterIP
├── ai-service/
│   ├── serviceaccount.yaml     # IRSA: SQS, Bedrock, Textract, S3, DynamoDB, KMS
│   ├── deployment.yaml         # Port 4002, /api/health probe, SQS polling background
│   └── service.yaml            # ClusterIP
├── document-service/
│   ├── serviceaccount.yaml     # IRSA: S3, Textract, KMS
│   ├── deployment.yaml         # Port 4001, /api/health probe
│   └── service.yaml            # ClusterIP
├── ingress/
│   └── ingress.yaml            # AWS ALB Ingress (internet-facing, ip mode)
├── hpa/
│   └── hpa.yaml                # HPA for all 4 services (CPU 70%, min 2, max 10)
└── README.md                   # This file
```

## Traffic Architecture

```
Internet
  ↓ HTTPS
CloudFront (WAF + CDN)
  ↓ HTTP
AWS ALB (internet-facing, managed by ALB Controller)
  ↓ HTTP
frontend:80 (nginx pod — acts as API gateway)
  ├── /api/documents/* → document-service:4001 (in-cluster)
  ├── /api/*           → core-service:4000 (in-cluster)
  └── /                → React SPA (static files in nginx)

core-service → ai-service (copilot proxy, internal SQS trigger)
ai-service → Bedrock, DynamoDB, S3, SQS (via IRSA)
document-service → S3, Textract (via IRSA)
core-service → EventBridge, SQS, S3, Secrets Manager (via IRSA)
```

## Service Ports

| Service          | Port | Protocol | Health Endpoint |
|------------------|------|----------|-----------------|
| frontend         | 80   | HTTP     | GET /health     |
| core-service     | 4000 | HTTP     | GET /api/health |
| document-service | 4001 | HTTP     | GET /api/health |
| ai-service       | 4002 | HTTP     | GET /api/health |

## Prerequisites Before Applying

1. `terraform apply` completed successfully
2. `scripts/build-and-push.sh` (or `.ps1`) completed — images in ECR
3. `scripts/generate-k8s-config.sh` run — ConfigMap has real values
4. `scripts/generate-k8s-secrets.sh` run — Secrets have real values
5. AWS LBC installed in kube-system (see EKS_DEPLOYMENT_GUIDE.md)
6. metrics-server installed (for HPA)

## Quick Deploy Order

```bash
# Namespace first
kubectl apply -f k8s/namespace.yaml

# Secrets and config
kubectl apply -f k8s/secrets/
kubectl apply -f k8s/configmaps/

# Core-service first (runs Prisma migrations — must succeed before others)
kubectl apply -f k8s/core-service/
kubectl rollout status deployment/core-service -n cargotrack

# Remaining services (after migrations complete)
kubectl apply -f k8s/document-service/
kubectl apply -f k8s/ai-service/
kubectl apply -f k8s/frontend/

# Ingress (ALB will be provisioned — takes 2-5 minutes)
kubectl apply -f k8s/ingress/

# HPA (requires metrics-server)
kubectl apply -f k8s/hpa/
```

## IRSA Annotation Reference

After `terraform apply`, get the role ARNs and update ServiceAccount yamls:

```bash
# Get all IRSA ARNs
terraform -chdir=cargotrack-infra/environments/dev output irsa_core_service_role_arn
terraform -chdir=cargotrack-infra/environments/dev output irsa_document_service_role_arn
terraform -chdir=cargotrack-infra/environments/dev output irsa_ai_service_role_arn
terraform -chdir=cargotrack-infra/environments/dev output irsa_alb_controller_role_arn
```

Replace `<IRSA_*_ROLE_ARN>` placeholders in the serviceaccount.yaml files.

## Secrets Strategy

| Secret | Source | Kubernetes Object | Key |
|--------|--------|-------------------|-----|
| DB host | RDS endpoint (Secrets Manager) | db-credentials | DATABASE_HOST |
| DB password | Secrets Manager (cargotrack-db-secret) | db-credentials | DATABASE_PASSWORD |
| JWT secret | Secrets Manager (cargotrack-application-secret) | app-secrets | JWT_SECRET |
| Admin credentials | Secrets Manager | app-secrets | ADMIN_EMAIL, ADMIN_PASSWORD |
| Internal API secret | Secrets Manager or generated | app-secrets | INTERNAL_API_SECRET |
| AWS credentials | IRSA (pod identity, no env vars needed) | ServiceAccount annotation | N/A |

# CargoTrack — EKS Deployment Guide

## Overview

This guide covers the complete end-to-end deployment of CargoTrack to AWS EKS.

**Architecture:**
```
Internet → CloudFront (WAF) → AWS ALB → nginx frontend → core/doc/ai services → RDS/S3/Bedrock/DynamoDB
```

**Key Decisions:**
- AWS Load Balancer Controller (NOT NGINX, NOT KGateway)
- IRSA (IAM Roles for Service Accounts) for zero-credential AWS access
- Single frontend nginx acts as API gateway (matches Docker Compose)
- ECR for all 4 service images
- Secrets Manager + SSM for secret management (no secrets in manifests)

---

## Phase 0: Prerequisites

### Tools Required

```bash
# Check all tools are installed
aws --version          # AWS CLI v2
terraform --version    # >= 1.5
docker --version       # Docker Desktop or Docker Engine
kubectl version        # Kubernetes CLI
helm version           # Helm 3.x
jq --version           # JSON parser
```

### AWS Credentials

```bash
# Configure AWS credentials
aws configure
# Enter: Access Key ID, Secret Access Key, Region (us-east-1), output (json)

# Verify
aws sts get-caller-identity
```

---

## Phase 1: Infrastructure Deployment (Terraform)

### Step 1.1: Bootstrap Remote State

```bash
cd cargotrack-infra/bootstrap

terraform init
terraform apply

# Creates:
#   - S3 bucket: cargotrack-terraform-state
#   - DynamoDB table: cargotrack-terraform-locks
```

### Step 1.2: Deploy Main Infrastructure

```bash
cd cargotrack-infra/environments/dev

# Initialize with remote backend
terraform init

# Plan and review (127 resources)
terraform plan -out=tfplan
terraform show tfplan | less

# Apply
terraform apply tfplan
```

**Resources Created (127 total):**

| Category | Resources |
|----------|-----------|
| Networking | VPC, 8 subnets, IGW, NAT GW, 4 route tables |
| Security | 6 Security Groups |
| Database | RDS PostgreSQL, KMS CMK, Secrets Manager, SSM params |
| Storage | S3 documents bucket |
| Audit | DynamoDB audit table |
| Eventing | EventBridge bus, 4 SQS queues, Lambda document processor |
| Monitoring | SNS topic, 4 CloudWatch alarms, dashboard |
| Endpoints | S3 gateway + 5 interface VPC endpoints |
| CDN | CloudFront distribution, WAFv2 WebACL (4 rule groups) |
| EKS | Cluster 1.30, OIDC provider, node group (t3.medium × 2) |
| IRSA | 4 IAM roles (core, document, ai, alb-controller) |
| ECR | 4 repositories (frontend, core, ai, docs) |
| DNS | (skipped — domain_name="" by default) |

### Step 1.3: Save Terraform Outputs

```bash
# Save all outputs for reference
terraform output -json > ~/cargotrack-tf-outputs.json

# Key outputs for next phases:
terraform output eks_cluster_name
terraform output eks_cluster_endpoint
terraform output irsa_core_service_role_arn
terraform output irsa_document_service_role_arn
terraform output irsa_ai_service_role_arn
terraform output irsa_alb_controller_role_arn
terraform output ecr_repository_urls
terraform output ecr_registry_id
terraform output cloudfront_domain_name
```

---

## Phase 2: Cluster Access Setup

### Step 2.1: Configure kubectl

```bash
# Update kubeconfig for the EKS cluster
aws eks update-kubeconfig \
  --name cargotrack \
  --region us-east-1

# Verify cluster access
kubectl cluster-info
kubectl get nodes
```

### Step 2.2: Verify Node Group

```bash
kubectl get nodes -o wide
# Expected: 2 nodes, status Ready, across 2 availability zones

kubectl describe nodes | grep -A5 "Allocatable:"
# Ensure sufficient CPU/memory for 8 pods minimum (2 × 4 services)
```

---

## Phase 3: AWS Load Balancer Controller Installation

The ALB Controller is installed via Helm and uses the IRSA role created by Terraform.

### Step 3.1: Install ALB Controller

```bash
# Get IRSA role ARN from Terraform
LBC_ROLE=$(terraform -chdir=cargotrack-infra/environments/dev output -raw irsa_alb_controller_role_arn)
echo "LBC IRSA Role: ${LBC_ROLE}"

# Add EKS Helm chart repo
helm repo add eks https://aws.github.io/eks-charts
helm repo update

# Install AWS Load Balancer Controller
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  --namespace kube-system \
  --set clusterName=cargotrack \
  --set serviceAccount.create=true \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set "serviceAccount.annotations.eks\.amazonaws\.com/role-arn=${LBC_ROLE}" \
  --set replicaCount=2 \
  --wait
```

### Step 3.2: Verify ALB Controller

```bash
kubectl get deployment -n kube-system aws-load-balancer-controller
# Expected: 2/2 replicas Ready

kubectl logs -n kube-system deployment/aws-load-balancer-controller --tail=20
# Should see: "Starting leader election" and no errors
```

---

## Phase 4: Install metrics-server (Required for HPA)

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# Verify
kubectl top nodes
# Expected: CPU and memory usage displayed for each node
```

---

## Phase 5: ECR Image Push

### Step 5.1: Build and Push All Images

```bash
# Linux/Mac
./scripts/build-and-push.sh

# Windows (PowerShell)
.\scripts\build-and-push.ps1

# To push a specific tag:
IMAGE_TAG=v1.0.0 ./scripts/build-and-push.sh
```

### Step 5.2: Verify Images in ECR

```bash
for repo in cargotrack-frontend cargotrack-core cargotrack-ai cargotrack-docs; do
  echo "=== ${repo} ==="
  aws ecr list-images --repository-name "${repo}" \
    --query 'imageIds[*].imageTag' --output text
done
```

---

## Phase 6: Kubernetes Configuration Setup

### Step 6.1: Generate ConfigMap from Terraform Outputs

```bash
# Auto-populate ConfigMap with Terraform outputs
./scripts/generate-k8s-config.sh

# Verify the configmap has real values
cat k8s/configmaps/cargotrack-config.yaml
# Should NOT contain any <PLACEHOLDER> values
```

### Step 6.2: Generate Secrets from AWS Secrets Manager

```bash
# Auto-populate secrets from Secrets Manager
./scripts/generate-k8s-secrets.sh

# Verify (values should be base64-encoded real data)
kubectl create --dry-run=client -o yaml -f k8s/secrets/db-credentials.yaml
```

### Step 6.3: Update IRSA Annotations

```bash
# Get IRSA role ARNs
CORE_ROLE=$(terraform -chdir=cargotrack-infra/environments/dev output -raw irsa_core_service_role_arn)
DOC_ROLE=$(terraform -chdir=cargotrack-infra/environments/dev output -raw irsa_document_service_role_arn)
AI_ROLE=$(terraform -chdir=cargotrack-infra/environments/dev output -raw irsa_ai_service_role_arn)

# Update service account manifests
sed -i "s|<IRSA_CORE_SERVICE_ROLE_ARN>|${CORE_ROLE}|g" k8s/core-service/serviceaccount.yaml
sed -i "s|<IRSA_DOCUMENT_SERVICE_ROLE_ARN>|${DOC_ROLE}|g" k8s/document-service/serviceaccount.yaml
sed -i "s|<IRSA_AI_SERVICE_ROLE_ARN>|${AI_ROLE}|g" k8s/ai-service/serviceaccount.yaml
```

---

## Phase 7: Kubernetes Deployment

### Step 7.1: Deploy Namespace

```bash
kubectl apply -f k8s/namespace.yaml
kubectl get namespace cargotrack
```

### Step 7.2: Deploy Secrets and Config

```bash
kubectl apply -f k8s/secrets/
kubectl apply -f k8s/configmaps/

# Verify
kubectl get secrets -n cargotrack
kubectl get configmaps -n cargotrack
```

### Step 7.3: Deploy Core Service (FIRST — runs Prisma migrations)

```bash
kubectl apply -f k8s/core-service/

# Wait for migrations to complete before proceeding
kubectl rollout status deployment/core-service -n cargotrack --timeout=180s

# Check migration logs
kubectl logs -n cargotrack deployment/core-service --tail=30 | grep -i migrat
# Expected: [core-service] Running Prisma migrations...
#           [core-service] Migrations applied successfully
```

### Step 7.4: Deploy Remaining Services

```bash
kubectl apply -f k8s/document-service/
kubectl apply -f k8s/ai-service/
kubectl apply -f k8s/frontend/

# Wait for all rollouts
kubectl rollout status deployment/document-service -n cargotrack
kubectl rollout status deployment/ai-service -n cargotrack
kubectl rollout status deployment/frontend -n cargotrack

# Verify all pods running
kubectl get pods -n cargotrack
# Expected: 8 pods Running (2 per service)
```

### Step 7.5: Deploy Ingress (ALB Provisioning)

```bash
kubectl apply -f k8s/ingress/

# Watch ALB provisioning (takes 2-5 minutes)
kubectl get ingress -n cargotrack -w

# When ADDRESS column shows the ALB DNS name, provisioning is complete:
# NAME                CLASS   HOSTS   ADDRESS                    PORTS   AGE
# cargotrack-ingress  alb     *       k8s-cargotr...elb.amazonaws.com   80   5m
```

### Step 7.6: Wire ALB DNS to CloudFront

```bash
# Get ALB DNS name
ALB_DNS=$(kubectl get ingress -n cargotrack cargotrack-ingress \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
echo "ALB DNS: ${ALB_DNS}"

# Update Terraform to wire CloudFront → ALB
terraform -chdir=cargotrack-infra/environments/dev apply \
  -var="eks_ingress_alb_dns=${ALB_DNS}"
```

### Step 7.7: Deploy HPA

```bash
kubectl apply -f k8s/hpa/
kubectl get hpa -n cargotrack
```

---

## Phase 8: Verification

```bash
# Full status check
CF_DOMAIN=$(terraform -chdir=cargotrack-infra/environments/dev output -raw cloudfront_domain_name)
echo "Application URL: https://${CF_DOMAIN}"

# Test health
curl -s "https://${CF_DOMAIN}/health"         # nginx frontend
curl -s "https://${CF_DOMAIN}/api/health"      # core-service via proxy

# All pods should be Running
kubectl get pods -n cargotrack
kubectl get hpa -n cargotrack
kubectl get ingress -n cargotrack
```

---

## Phase 9: Rollback Procedure

### Rollback a Single Service

```bash
# View rollout history
kubectl rollout history deployment/core-service -n cargotrack

# Rollback to previous version
kubectl rollout undo deployment/core-service -n cargotrack

# Rollback to a specific revision
kubectl rollout undo deployment/core-service -n cargotrack --to-revision=2

# Monitor rollback
kubectl rollout status deployment/core-service -n cargotrack
```

### Rollback Infrastructure (Terraform)

```bash
# Revert to previous state
cd cargotrack-infra/environments/dev
git checkout <previous-commit> -- .
terraform plan
terraform apply
```

### Emergency: Delete All Kubernetes Resources

```bash
# Removes all CargoTrack pods/services/ingress (does NOT affect AWS infra)
kubectl delete namespace cargotrack

# Recreate
kubectl apply -f k8s/namespace.yaml
# ... then redeploy
```

---

## Useful Commands

```bash
# Cluster status
kubectl get all -n cargotrack

# Pod logs
kubectl logs -n cargotrack deploy/core-service -f
kubectl logs -n cargotrack deploy/ai-service -f
kubectl logs -n cargotrack deploy/document-service -f
kubectl logs -n cargotrack deploy/frontend -f

# Exec into a pod
kubectl exec -n cargotrack deploy/core-service -it -- sh

# Port-forward for local testing (bypass CloudFront/ALB)
kubectl port-forward -n cargotrack svc/frontend 8080:80
kubectl port-forward -n cargotrack svc/core-service 4000:4000

# Scale manually
kubectl scale deployment/ai-service --replicas=4 -n cargotrack

# Get events
kubectl get events -n cargotrack --sort-by='.lastTimestamp'

# View resource usage
kubectl top pods -n cargotrack
kubectl top nodes

# Describe pod for troubleshooting
kubectl describe pod -n cargotrack <pod-name>
```

---

## Remaining Gaps Before Full Production

| Item | Status | Action Required |
|------|--------|-----------------|
| Domain name | ⬜ Optional | Set `domain_name` Terraform var → enables Route53/ACM |
| HTTPS on ALB | ⬜ Optional | Enable after domain + ACM cert provisioned |
| metrics-server | ⬜ Post-apply | Install for HPA to function |
| ALB Controller | ⬜ Post-apply | Install via Helm after EKS ready |
| Image push to ECR | ⬜ Post-apply | Run `scripts/build-and-push.sh` |
| ConfigMap values | ⬜ Post-apply | Run `scripts/generate-k8s-config.sh` |
| K8s Secret values | ⬜ Post-apply | Run `scripts/generate-k8s-secrets.sh` |
| IRSA ARNs in SA | ⬜ Post-apply | Update serviceaccount.yaml files |
| CloudFront ↔ ALB | ⬜ Post-Ingress | Re-apply Terraform with `eks_ingress_alb_dns` |
| Alarm email subscr. | ⬜ Optional | Confirm SNS email subscription |
| KMS deletion window | ℹ️ By design | 7-day wait on destroy (AWS limitation) |

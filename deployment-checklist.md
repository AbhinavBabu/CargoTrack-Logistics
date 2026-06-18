# CargoTrack — Deployment Checklist

## Pre-Apply (Terraform)

| # | Task | Command | Status |
|---|------|---------|--------|
| 1 | Run terraform fmt | `terraform fmt -recursive` | ✅ Passing |
| 2 | Run terraform validate | `terraform validate` | ✅ Passing |
| 3 | Run terraform plan | `terraform plan -out=tfplan` | ✅ 127 resources planned |
| 4 | Review plan output | Verify 127 resources | ⬜ |
| 5 | Bootstrap (state backend) | `cd bootstrap && terraform apply` | ⬜ |
| 6 | Apply infrastructure | `terraform apply tfplan` | ⬜ |

---

## Post-Apply Verification

### Cluster Verification

```bash
# Update kubeconfig
aws eks update-kubeconfig --name cargotrack --region us-east-1

# Verify cluster is ACTIVE
aws eks describe-cluster --name cargotrack --query 'cluster.status'

# Verify nodes are Ready
kubectl get nodes -o wide

# Expected: 2+ nodes in Ready state across 2 AZs
```

| Check | Command | Expected |
|-------|---------|----------|
| Cluster active | `aws eks describe-cluster --name cargotrack` | `"ACTIVE"` |
| Nodes ready | `kubectl get nodes` | 2+ `Ready` nodes |
| Node IAM role | `aws iam get-role --role-name cargotrack-eks-node-role` | Exists |
| OIDC provider | `aws iam list-open-id-connect-providers` | cargotrack OIDC listed |

### IRSA Verification

```bash
# Verify all 4 IRSA roles exist
aws iam list-roles --query "Roles[?starts_with(RoleName, 'cargotrack-irsa')].[RoleName]" --output table

# Expected roles:
#   cargotrack-irsa-core-service
#   cargotrack-irsa-document-service
#   cargotrack-irsa-ai-service
#   cargotrack-irsa-alb-controller
```

### ECR Verification

```bash
# Verify all 4 repos exist
aws ecr describe-repositories --query 'repositories[*].repositoryName' --output table

# Expected:
#   cargotrack-frontend
#   cargotrack-core
#   cargotrack-ai
#   cargotrack-docs
```

---

## ECR Image Push

```bash
# Build and push all images
./scripts/build-and-push.sh  # Linux/Mac
.\scripts\build-and-push.ps1  # Windows

# Verify images are in ECR
aws ecr list-images --repository-name cargotrack-frontend --query 'imageIds' --output table
aws ecr list-images --repository-name cargotrack-core --query 'imageIds' --output table
aws ecr list-images --repository-name cargotrack-ai --query 'imageIds' --output table
aws ecr list-images --repository-name cargotrack-docs --query 'imageIds' --output table
```

---

## AWS Load Balancer Controller Installation

```bash
# Install ALB Controller
LBC_ROLE=$(terraform -chdir=cargotrack-infra/environments/dev output -raw irsa_alb_controller_role_arn)

helm repo add eks https://aws.github.io/eks-charts
helm repo update

helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  --namespace kube-system \
  --set clusterName=cargotrack \
  --set serviceAccount.create=true \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set "serviceAccount.annotations.eks\.amazonaws\.com/role-arn=${LBC_ROLE}"

# Verify ALB controller pods are running
kubectl get pods -n kube-system | grep aws-load-balancer-controller
# Expected: 2 pods Running
```

---

## Kubernetes Deployment

```bash
# Generate config and secrets from AWS
./scripts/generate-k8s-config.sh
./scripts/generate-k8s-secrets.sh

# Update IRSA ARNs in service account files
CORE_ROLE=$(terraform -chdir=cargotrack-infra/environments/dev output -raw irsa_core_service_role_arn)
DOC_ROLE=$(terraform -chdir=cargotrack-infra/environments/dev output -raw irsa_document_service_role_arn)
AI_ROLE=$(terraform -chdir=cargotrack-infra/environments/dev output -raw irsa_ai_service_role_arn)
# Manually paste these into k8s/*/serviceaccount.yaml OR use the sed commands below:
sed -i "s|<IRSA_CORE_SERVICE_ROLE_ARN>|${CORE_ROLE}|" k8s/core-service/serviceaccount.yaml
sed -i "s|<IRSA_DOCUMENT_SERVICE_ROLE_ARN>|${DOC_ROLE}|" k8s/document-service/serviceaccount.yaml
sed -i "s|<IRSA_AI_SERVICE_ROLE_ARN>|${AI_ROLE}|" k8s/ai-service/serviceaccount.yaml

# Deploy
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/secrets/
kubectl apply -f k8s/configmaps/

# Core service first (runs Prisma migrations)
kubectl apply -f k8s/core-service/
kubectl rollout status deployment/core-service -n cargotrack --timeout=120s

# Remaining services
kubectl apply -f k8s/ai-service/ k8s/document-service/ k8s/frontend/

# Ingress (ALB provisioning takes 2-5 minutes)
kubectl apply -f k8s/ingress/

# HPA
kubectl apply -f k8s/hpa/
```

---

## ALB Verification

```bash
# Wait for ALB to be provisioned (2-5 minutes after ingress apply)
kubectl get ingress -n cargotrack cargotrack-ingress

# Get ALB DNS name
ALB_DNS=$(kubectl get ingress -n cargotrack cargotrack-ingress \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
echo "ALB DNS: ${ALB_DNS}"

# Test ALB directly
curl -I "http://${ALB_DNS}/health"
# Expected: HTTP/1.1 200 OK

# Update CloudFront origin with ALB DNS
terraform -chdir=cargotrack-infra/environments/dev apply \
  -var="eks_ingress_alb_dns=${ALB_DNS}"
```

---

## Application Verification

### Frontend Reachable

```bash
CF_DOMAIN=$(terraform -chdir=cargotrack-infra/environments/dev output -raw cloudfront_domain_name)
curl -I "https://${CF_DOMAIN}"
# Expected: HTTP/2 200
```

### API Health Checks

```bash
# Core service via nginx proxy
curl "https://${CF_DOMAIN}/api/health"
# Expected: {"status":"ok","service":"core-service","database":"connected"}

# Document service via nginx proxy
curl "https://${CF_DOMAIN}/api/documents/health"
# Expected: {"status":"ok","service":"document-service"}

# AI service health (internal — check via pod exec)
kubectl exec -n cargotrack deploy/ai-service -- wget -qO- http://localhost:4002/api/health
# Expected: {"status":"ok","service":"ai-service"}
```

### Login Works

```bash
ADMIN_EMAIL=$(kubectl get secret -n cargotrack app-secrets -o jsonpath='{.data.ADMIN_EMAIL}' | base64 -d)
curl -X POST "https://${CF_DOMAIN}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"admin_password_here\"}"
# Expected: {"token":"eyJ...","user":{"role":"ADMIN"}}
```

### Shipment Creation Works

```bash
# Replace $TOKEN with the JWT from login
curl -X POST "https://${CF_DOMAIN}/api/shipments" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"origin":"New York","destination":"London","cargo":"Electronics"}'
# Expected: {"id":"...","status":"PENDING"}
```

### AI Copilot Works (Bedrock)

```bash
# Get a shipment ID first, then test copilot
curl -X POST "https://${CF_DOMAIN}/api/admin/copilot/summary" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"shipmentId":"<SHIPMENT_ID>"}'
# Expected: {"summary":"...","generatedBy":"amazon.nova-lite-v1:0"}
```

### Bedrock Model Invocation

```bash
# Check ai-service logs for Bedrock activity
kubectl logs -n cargotrack deploy/ai-service --tail=50 | grep -i bedrock
# Expected: [ai-service] Bedrock invoke: amazon.nova-lite-v1:0 completed
```

### Textract Works

```bash
# Upload a document first, then check ai-service logs
kubectl logs -n cargotrack deploy/ai-service --tail=50 | grep -i textract
# Expected: [ai-service] Textract analysis complete for document ...
```

### S3 Uploads Work

```bash
# Test document upload
curl -X POST "https://${CF_DOMAIN}/api/documents/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@test-document.pdf" \
  -F "shipmentId=<SHIPMENT_ID>"
# Expected: {"documentId":"...","s3Key":"...","url":"..."}
```

### EventBridge Works

```bash
# Check core-service logs for EventBridge events
kubectl logs -n cargotrack deploy/core-service --tail=50 | grep -i eventbridge
# Expected: [core-service] Event published to cargotrack-events
```

### SQS Works

```bash
# Check ai-service SQS polling
kubectl logs -n cargotrack deploy/ai-service --tail=50 | grep -i sqs
# Expected: [ai-service] SQS poll: received 1 messages

# Check queue attributes
SQS_URL=$(terraform -chdir=cargotrack-infra/environments/dev output -raw compliance_queue_url)
aws sqs get-queue-attributes --queue-url "${SQS_URL}" \
  --attribute-names ApproximateNumberOfMessages
```

### Lambda Works (Document Processor)

```bash
# Check Lambda invocations
aws logs filter-log-events \
  --log-group-name "/aws/lambda/cargotrack-document-processor" \
  --start-time $(date -d "1 hour ago" +%s000) \
  --query 'events[*].message' --output text
```

### DynamoDB Audit Works

```bash
DYNAMO_TABLE=$(terraform -chdir=cargotrack-infra/environments/dev output -raw dynamodb_audit_table)
aws dynamodb scan --table-name "${DYNAMO_TABLE}" \
  --max-items 5 \
  --query 'Items[*].{id:id.S,event:eventType.S,ts:timestamp.S}'
# Expected: compliance audit events with timestamps
```

---

## Autoscaling Verification

### Deploy metrics-server (required for HPA)

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl top nodes
kubectl top pods -n cargotrack
```

### Load Testing (Scale-Out Trigger)

```bash
# Install hey (HTTP load generator)
# macOS: brew install hey
# Windows: choco install hey

# Test frontend scale-out (CPU > 70% → new pods)
ALB_DNS=$(kubectl get ingress -n cargotrack cargotrack-ingress -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
hey -n 50000 -c 200 -q 100 "http://${ALB_DNS}/"

# Watch HPA in real-time
kubectl get hpa -n cargotrack -w
# Expected output when load exceeds 70% CPU:
#   NAME              REFERENCE             TARGETS         MINPODS   MAXPODS   REPLICAS
#   frontend-hpa      Deployment/frontend   82%/70%         2         10        4
```

### Expected Scale-Out Behavior

| Trigger | Response | Time |
|---------|----------|------|
| CPU > 70% for 60s | New pods added (max 2 per 60s) | ~90s |
| 4 replicas stable | HPA stops scaling | Immediate |
| Pod assigned to ALB | Traffic distributed | ~30s |

### Expected Scale-In Behavior

| Trigger | Response | Time |
|---------|----------|------|
| CPU < 70% for 300s | 1 pod removed per 120s | ~5-10 min |
| Draining connections | ALB deregisters pod | ~30s |
| Pod terminated | Rolling termination | ~30s |

### Load Test Commands

```bash
# Frontend (static + API proxy)
hey -n 10000 -c 100 "http://${ALB_DNS}/"

# Core service API (via nginx proxy)
hey -n 5000 -c 50 -m POST \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"wrong"}' \
  "http://${ALB_DNS}/api/auth/login"

# Watch all HPAs
watch kubectl get hpa -n cargotrack

# Watch pod count changes
watch kubectl get pods -n cargotrack
```

# \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
# CargoTrack v3 \u2014 Dev Environment
# Migrated from EC2/ASG \u2192 EKS microservices architecture
# \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

# ── NETWORKING ────────────────────────────────────────────────────────────────
# VPC, 8 subnets (public/web/app/db), NAT gateway, route tables
# Now includes EKS subnet discovery tags (kubernetes.io/role/*)

module "networking" {

  source = "../../modules/networking"

  project_name = var.project_name
  vpc_cidr     = var.vpc_cidr
}

# ── SECURITY ──────────────────────────────────────────────────────────────────
# Security groups for all tiers including new eks_node SG
# database SG now allows connections from eks_node SG (port 5432)

module "security" {

  source = "../../modules/security"

  project_name = var.project_name

  vpc_id = module.networking.vpc_id
}

# ── DATABASE ─────────────────────────────────────────────────────────────────
# RDS PostgreSQL, KMS key, Secrets Manager secrets, SSM parameters
# Unchanged from v2 — fully decoupled from compute model

module "database" {

  source = "../../modules/database"

  project_name = var.project_name

  db_subnet_ids = module.networking.db_subnet_ids

  database_sg_id = module.security.database_sg_id
}

# ── STORAGE ───────────────────────────────────────────────────────────────────
# S3 document bucket with KMS encryption, versioning, lifecycle rules
# Unchanged from v2

module "storage" {

  source = "../../modules/storage"

  project_name = var.project_name

  kms_key_arn = module.database.kms_key_arn
}

# ── AUDIT ─────────────────────────────────────────────────────────────────────
# DynamoDB audit table — stores compliance and shipment event records
# Unchanged from v2

module "audit" {

  source = "../../modules/audit"

  project_name = var.project_name
  kms_key_arn  = module.database.kms_key_arn
}

# ── EVENTING ─────────────────────────────────────────────────────────────────
# EventBridge custom bus, SQS queues (main + compliance DLQ/queue),
# Lambda document processor, EventBridge rules
# Phase 3 compliance queue additions included

module "eventing" {

  source = "../../modules/eventing"

  project_name = var.project_name
  aws_region   = var.aws_region

  kms_key_arn      = module.database.kms_key_arn
  audit_table_name = module.audit.table_name
  audit_table_arn  = module.audit.table_arn
}

# ── MONITORING ────────────────────────────────────────────────────────────────
# SNS alarms topic, CloudWatch alarms, dashboard
# ASG/ALB-specific alarms omitted (vars default to "" \u2014 handled in module)
# RDS alarm always active

module "monitoring" {

  source = "../../modules/monitoring"

  project_name = var.project_name
  aws_region   = var.aws_region

  # EC2/ASG references removed — module will skip those alarms
  # backend_asg_name        = (not set — defaults to "")
  # external_alb_arn_suffix = (not set — defaults to "")

  db_identifier = module.database.db_identifier
  alarm_email   = var.alarm_email
  kms_key_arn   = module.database.kms_key_arn

  # EKS Container Insights alarms — enabled now that EKS is the compute platform
  eks_cluster_name = module.eks.cluster_name

  # SQS compliance queue depth alarm — reuses existing queue name from eventing module
  compliance_queue_name = module.eventing.compliance_queue_name
}

# ── VPC ENDPOINTS ────────────────────────────────────────────────────────────
# Private connectivity to AWS services (S3 Gateway, SSM, Secrets Manager, KMS)
# Endpoints SG updated to allow from eks_node SG

module "endpoints" {

  source = "../../modules/endpoints"

  project_name   = var.project_name
  vpc_id         = module.networking.vpc_id
  aws_region     = var.aws_region
  app_subnet_ids = module.networking.app_subnet_ids
  backend_sg_id  = module.security.eks_node_sg_id # eks_node replaces old backend SG here

  private_route_table_ids = [
    module.networking.web_route_table_id,
    module.networking.app_route_table_id,
    module.networking.db_route_table_id,
  ]
}

# ── CDN ───────────────────────────────────────────────────────────────────────
# CDN: CloudFront + WAF
# alb_dns_name is set after first Helm deploy when AWS LBC creates the Ingress ALB.
# On first apply: set to a placeholder (CloudFront will exist but origin unreachable until ALB is ready).
# Update with: terraform apply -var="eks_ingress_alb_dns=<alb-dns-from-kubectl-get-ingress>"

module "cdn" {

  source = "../../modules/cdn"

  project_name = var.project_name
  alb_dns_name = var.eks_ingress_alb_dns != "" ? var.eks_ingress_alb_dns : "pending.example.com"
}

# ── EKS CLUSTER ─────────────────────────────────────────────────────────────
# EKS control plane + managed node group + OIDC provider for IRSA
# Replaces the EC2/ASG-based compute module

module "eks" {

  source = "../../modules/eks"

  project_name   = var.project_name
  vpc_id         = module.networking.vpc_id
  app_subnet_ids = module.networking.app_subnet_ids
  node_sg_id     = module.security.eks_node_sg_id

  cluster_version     = var.eks_cluster_version
  node_instance_types = var.node_instance_types
  node_min_size       = var.node_min_size
  node_max_size       = var.node_max_size
  node_desired_size   = var.node_desired_size
}

# ── IRSA (IAM Roles for Service Accounts) ─────────────────────────────────────
# Per-service IAM roles scoped to exact Kubernetes service account names.
# Each microservice gets only the permissions it needs (least privilege).
# Role ARNs are passed into Helm values for ServiceAccount annotations.

module "irsa" {

  source = "../../modules/irsa"

  project_name      = var.project_name
  oidc_issuer_url   = module.eks.oidc_issuer_url
  oidc_provider_arn = module.eks.oidc_provider_arn
  cluster_name      = module.eks.cluster_name
  aws_region        = var.aws_region

  documents_bucket_arn = module.storage.bucket_arn
  event_bus_arn        = module.eventing.event_bus_arn
  compliance_queue_arn = module.eventing.compliance_queue_arn
  audit_table_arn      = module.audit.table_arn
  kms_key_arn          = module.database.kms_key_arn
  db_secret_arn        = module.database.db_secret_arn
  app_secret_arn       = module.database.application_secret_arn
}

# ── ECR ───────────────────────────────────────────────────────────────────────
# Provision 4 ECR repositories for CargoTrack microservice images.
# The EKS node role is granted pull access via repository policies.
# Images must be pushed before pods can be scheduled (CI/CD responsibility).

module "ecr" {

  source = "../../modules/ecr"

  project_name      = var.project_name
  eks_node_role_arn = module.eks.node_role_arn
}

# ── DNS (OPTIONAL) ───────────────────────────────────────────────────────────
# Route 53 + ACM certificate support.
# Set domain_name = "" (the default) to skip all DNS resource creation.
# Set domain_name = "your-domain.com" to enable full DNS + TLS setup.
#
# After apply with a domain, copy the NS records from the Terraform output
# to your domain registrar to complete DNS delegation.

module "dns" {

  source = "../../modules/dns"

  project_name           = var.project_name
  domain_name            = var.domain_name
  cloudfront_domain_name = module.cdn.cloudfront_domain_name

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
}

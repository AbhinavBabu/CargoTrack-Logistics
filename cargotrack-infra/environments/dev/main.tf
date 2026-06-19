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
# CloudFront + WAF v2.
#
# Dependency order:
#   1. module.dns  → creates ACM cert (us-east-1) + validates it via Route53
#   2. module.cdn  → creates CloudFront, using the validated ACM cert ARN
#   3. aws_route53_record (below) → A-records pointing to the CF domain
#
# Why A-records are at env level (not inside module.dns):
#   If A-records were inside dns, dns would depend on cdn (for cf domain name)
#   AND cdn would depend on dns (for cert ARN) → circular dependency.
#   Moving A-records to env level gives both outputs without a cycle.

module "cdn" {

  source = "../../modules/cdn"

  project_name = var.project_name

  # ALB DNS is baked into the variable default — no manual -var needed.
  alb_dns_name = var.eks_ingress_alb_dns

  # Pass the validated ACM cert from the dns module.
  # When domain_name = "", dns.certificate_arn = "" and CF uses its default cert.
  acm_certificate_arn = module.dns.certificate_arn

  # CloudFront aliases must exactly match the ACM cert's domain names.
  domain_aliases = var.domain_name != "" ? [var.domain_name, "www.${var.domain_name}"] : []

  # dns module must complete (cert validated) before CF is created with the cert.
  depends_on = [module.dns]
}

# ── DNS (Route53 + ACM) ───────────────────────────────────────────────────────
# Conditional on domain_name being set. All resources inside use count = 0
# when domain_name = "", so this is completely safe to always include.
# The cloudfront_domain_name variable is removed from this module — A-records
# now live at environment level (see aws_route53_record blocks below).

module "dns" {

  source = "../../modules/dns"

  project_name = var.project_name
  domain_name  = var.domain_name

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
}

# ── Route 53 A-records → CloudFront ──────────────────────────────────────────
# These live at environment level (not inside module.dns) to break the
# circular dependency: module.cdn needs dns.certificate_arn, and the A-records
# need cdn.cloudfront_domain_name. Placing both in the same module would create
# a cycle. At env level, all outputs are available without any cycle.

resource "aws_route53_record" "cloudfront_apex" {
  count = var.domain_name != "" ? 1 : 0

  zone_id = module.dns.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = module.cdn.cloudfront_domain_name
    zone_id                = "Z2FDTNDATAQYW2" # CloudFront global zone ID (constant)
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "cloudfront_www" {
  count = var.domain_name != "" ? 1 : 0

  zone_id = module.dns.zone_id
  name    = "www.${var.domain_name}"
  type    = "CNAME"
  ttl     = 300
  records = [module.cdn.cloudfront_domain_name]
}

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

# ── RDS ingress from EKS worker nodes ─────────────────────────────────────────
#
# WHY THIS IS AT THE ENVIRONMENT LEVEL (not inside module.security):
#
#   EKS managed node groups receive security groups from TWO sources:
#
#   1. cargotrack-eks_node-sg  (Terraform-managed, created by module.security)
#      Passed to aws_eks_cluster.vpc_config.security_group_ids.
#      AWS attaches this to CONTROL PLANE ENIs only — the cross-account ENIs
#      EKS creates in your VPC to enable cluster-to-node communication.
#      Worker node EC2 instances do NOT carry this SG.
#
#   2. eks-cluster-sg-cargotrack-* (auto-created by AWS at cluster creation time)
#      Exposed as: aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
#      module.eks output: module.eks.cluster_sg_id
#      AWS automatically attaches this to EVERY managed node ENI. This is the
#      SG that controls actual inbound/outbound traffic on the worker nodes.
#
#   Consequence: Any RDS ingress rule that references cargotrack-eks_node-sg (#1)
#   has NO effect because the worker nodes never carry that SG. The previous rule
#   `database_from_eks_node` in module.security was wrong — it referenced #1.
#
# WHY IT CANNOT LIVE IN module.security:
#   module.security is instantiated before module.eks (EKS needs the eks_node SG).
#   cluster_sg_id (#2) is only known after the EKS cluster is created.
#   Putting this rule inside module.security would create a circular dependency.
#
#   At the environment level, both outputs are available with no cycle:
#     module.security.database_sg_id  ← security group to protect (RDS)
#     module.eks.cluster_sg_id        ← source of the traffic (worker nodes)
#
# DESTROY SAFETY:
#   Terraform destroys this rule before either module (dependency graph reversal).
#   No dangling SG rules after destroy.

resource "aws_vpc_security_group_ingress_rule" "database_from_cluster_sg" {

  security_group_id            = module.security.database_sg_id
  referenced_security_group_id = module.eks.cluster_sg_id

  from_port   = 5432
  to_port     = 5432
  ip_protocol = "tcp"

  tags = {
    Name      = "cargotrack-rds-from-eks-cluster-sg"
    ManagedBy = "Terraform"
    Purpose   = "Allow EKS worker nodes to reach RDS PostgreSQL on port 5432"
  }
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

# ──────────────────────────────────────────────────────────────────────────────
# CargoTrack v3 — Dev Environment
# Migrated from EC2/ASG → EKS microservices architecture
# CI/CD managed by GitHub Actions (see .github/workflows/infra.yml)
# ──────────────────────────────────────────────────────────────────────────────

# Images must be pushed before pods can be scheduled (CI/CD responsibility).

module "ecr" {

  source = "../../modules/ecr"

  project_name      = var.project_name
  eks_node_role_arn = module.eks.node_role_arn
}



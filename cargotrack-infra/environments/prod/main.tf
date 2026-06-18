module "networking" {

  source = "../../modules/networking"

  project_name = var.project_name
  vpc_cidr     = var.vpc_cidr
}

module "security" {

  source = "../../modules/security"

  project_name = var.project_name

  vpc_id = module.networking.vpc_id
}

module "compute" {

  source = "../../modules/compute"

  project_name = var.project_name

  vpc_id = module.networking.vpc_id

  public_subnet_ids = module.networking.public_subnet_ids
  web_subnet_ids    = module.networking.web_subnet_ids
  app_subnet_ids    = module.networking.app_subnet_ids

  external_alb_sg_id = module.security.external_alb_sg_id
  frontend_sg_id     = module.security.frontend_sg_id
  internal_alb_sg_id = module.security.internal_alb_sg_id
  backend_sg_id      = module.security.backend_sg_id

  db_secret_arn  = module.database.db_secret_arn
  app_secret_arn = module.database.application_secret_arn
  kms_key_arn    = module.database.kms_key_arn

  documents_bucket_arn = module.storage.bucket_arn
  documents_bucket_id  = module.storage.bucket_id

  aws_region     = var.aws_region
  event_bus_name = module.eventing.event_bus_name
}

module "database" {

  source = "../../modules/database"

  project_name = var.project_name

  db_subnet_ids = module.networking.db_subnet_ids

  database_sg_id = module.security.database_sg_id
}

module "storage" {

  source = "../../modules/storage"

  project_name = var.project_name

  kms_key_arn = module.database.kms_key_arn
}

module "monitoring" {

  source = "../../modules/monitoring"

  project_name = var.project_name
  aws_region   = var.aws_region

  backend_asg_name        = module.compute.backend_asg_name
  external_alb_arn_suffix = module.compute.external_alb_arn_suffix
  db_identifier           = module.database.db_identifier

  alarm_email = var.alarm_email
  kms_key_arn = module.database.kms_key_arn
}

module "audit" {

  source = "../../modules/audit"

  project_name = var.project_name
  kms_key_arn  = module.database.kms_key_arn
}

module "eventing" {

  source = "../../modules/eventing"

  project_name = var.project_name
  aws_region   = var.aws_region

  kms_key_arn      = module.database.kms_key_arn
  audit_table_name = module.audit.table_name
  audit_table_arn  = module.audit.table_arn
}

module "cdn" {

  source = "../../modules/cdn"

  project_name = var.project_name
  alb_dns_name = module.compute.external_alb_dns_name
}

module "endpoints" {

  source = "../../modules/endpoints"

  project_name   = var.project_name
  vpc_id         = module.networking.vpc_id
  aws_region     = var.aws_region
  app_subnet_ids = module.networking.app_subnet_ids
  backend_sg_id  = module.security.backend_sg_id

  private_route_table_ids = [
    module.networking.web_route_table_id,
    module.networking.app_route_table_id,
    module.networking.db_route_table_id,
  ]
}

module "lambda_errors_alarm" {

  source  = "terraform-aws-modules/cloudwatch/aws//modules/metric-alarm"
  version = "~> 5.0"

  alarm_name        = "${var.project_name}-lambda-errors"
  alarm_description = "Document processor Lambda errors — audit records may not be written to DynamoDB"
  actions_enabled   = true

  alarm_actions             = [module.monitoring.sns_topic_arn]
  ok_actions                = [module.monitoring.sns_topic_arn]
  insufficient_data_actions = []

  namespace   = "AWS/Lambda"
  metric_name = "Errors"
  statistic   = "Sum"

  dimensions = {
    FunctionName = module.eventing.lambda_function_name
  }

  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"

  treat_missing_data = "notBreaching"

  tags = {
    Project     = var.project_name
    ManagedBy   = "Terraform"
    Environment = "prod"
    Purpose     = "Document processing pipeline integrity"
  }
}

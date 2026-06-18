locals {
  common_tags = {
    Project   = var.project_name
    ManagedBy = "Terraform"
  }
}

resource "random_password" "db_password" {

  length = 20

  special = false
}

resource "random_password" "jwt_secret" {

  length = 32

  special = true

  override_special = "!#$%^&*()-_=+[]{}<>?"
}

resource "random_password" "admin_password" {

  length = 20

  special = false
}

resource "aws_secretsmanager_secret" "database" {

  name                    = "${var.project_name}-database-secret-v2"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 0

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "database" {

  secret_id = aws_secretsmanager_secret.database.id

  secret_string = jsonencode({
    username = "cargotrack"
    password = random_password.db_password.result
    dbname   = "cargotrack"
  })
}

resource "aws_secretsmanager_secret" "application" {

  name                    = "${var.project_name}-application-secret-v2"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 0

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "application" {

  secret_id = aws_secretsmanager_secret.application.id

  secret_string = jsonencode({
    jwt_secret     = random_password.jwt_secret.result
    admin_email    = "admin@cargotrack.com"
    admin_password = random_password.admin_password.result
  })
}

resource "aws_ssm_parameter" "db_name" {

  name  = "/${var.project_name}/database/name"
  type  = "String"
  value = "cargotrack"
}

resource "aws_ssm_parameter" "db_host" {

  name  = "/${var.project_name}/database/host"
  type  = "String"
  value = aws_db_instance.database.address
}

resource "aws_ssm_parameter" "db_user" {

  name  = "/${var.project_name}/database/user"
  type  = "String"
  value = "cargotrack"
}

resource "aws_ssm_parameter" "db_port" {

  name  = "/${var.project_name}/database/port"
  type  = "String"
  value = "5432"
}

resource "aws_ssm_parameter" "node_env" {

  name  = "/${var.project_name}/application/node-env"
  type  = "String"
  value = "production"
}

resource "aws_db_subnet_group" "database" {

  name = "${var.project_name}-db-subnet-group"

  subnet_ids = var.db_subnet_ids

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-db-subnet-group"
    }
  )
}

resource "aws_db_instance" "database" {

  identifier = "${var.project_name}-db"

  engine = "postgres"

  engine_version = "17.10"

  instance_class = "db.t3.micro"

  allocated_storage = 20

  storage_type = "gp3"

  storage_encrypted = true

  kms_key_id = aws_kms_key.main.arn

  backup_retention_period = 7

  deletion_protection = false

  db_name = "cargotrack"

  username = "cargotrack"

  password = random_password.db_password.result

  publicly_accessible = false

  multi_az = false

  skip_final_snapshot = true

  auto_minor_version_upgrade = true

  db_subnet_group_name = aws_db_subnet_group.database.name

  vpc_security_group_ids = [
    var.database_sg_id
  ]

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-database"
    }
  )

}
locals {
  common_tags = {
    Project   = var.project_name
    ManagedBy = "Terraform"
  }

  interface_endpoints = {
    secretsmanager = "com.amazonaws.${var.aws_region}.secretsmanager"
    ssm            = "com.amazonaws.${var.aws_region}.ssm"
    ssmmessages    = "com.amazonaws.${var.aws_region}.ssmmessages"
    ec2messages    = "com.amazonaws.${var.aws_region}.ec2messages"
    kms            = "com.amazonaws.${var.aws_region}.kms"
  }
}

resource "aws_security_group" "endpoints" {

  name        = "${var.project_name}-endpoints-sg"
  description = "Allow HTTPS from backend instances to VPC interface endpoints"
  vpc_id      = var.vpc_id

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-endpoints-sg"
    }
  )
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_backend" {

  security_group_id            = aws_security_group.endpoints.id
  referenced_security_group_id = var.backend_sg_id

  from_port   = 443
  to_port     = 443
  ip_protocol = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "endpoints_all" {

  security_group_id = aws_security_group.endpoints.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_endpoint" "s3" {

  vpc_id            = var.vpc_id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"

  route_table_ids = var.private_route_table_ids

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-s3-endpoint"
    }
  )
}

resource "aws_vpc_endpoint" "interface" {

  for_each = local.interface_endpoints

  vpc_id              = var.vpc_id
  service_name        = each.value
  vpc_endpoint_type   = "Interface"
  subnet_ids          = var.app_subnet_ids
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-${each.key}-endpoint"
    }
  )
}

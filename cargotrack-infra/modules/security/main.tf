locals {
  common_tags = {
    Project   = var.project_name
    ManagedBy = "Terraform"
  }

  security_groups = {
    external_alb = {
      description = "External ALB security group"
    }

    frontend = {
      description = "Frontend instances"
    }

    internal_alb = {
      description = "Internal ALB"
    }

    backend = {
      description = "Backend instances"
    }

    database = {
      description = "Database"
    }

    eks_node = {
      description = "EKS worker nodes"
    }
  }
}

resource "aws_security_group" "this" {

  for_each = local.security_groups

  name        = "${var.project_name}-${each.key}-sg"
  description = each.value.description
  vpc_id      = var.vpc_id

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-${each.key}-sg"
    }
  )
}

resource "aws_vpc_security_group_ingress_rule" "external_alb_http" {

  security_group_id = aws_security_group.this["external_alb"].id

  cidr_ipv4 = "0.0.0.0/0"

  from_port = 80
  to_port   = 80

  ip_protocol = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "external_alb_https" {

  security_group_id = aws_security_group.this["external_alb"].id

  cidr_ipv4 = "0.0.0.0/0"

  from_port = 443
  to_port   = 443

  ip_protocol = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "external_alb_all" {

  security_group_id = aws_security_group.this["external_alb"].id

  cidr_ipv4 = "0.0.0.0/0"

  ip_protocol = "-1"
}

resource "aws_vpc_security_group_ingress_rule" "frontend_from_external_alb" {

  security_group_id = aws_security_group.this["frontend"].id

  referenced_security_group_id = aws_security_group.this["external_alb"].id

  from_port = 80
  to_port   = 80

  ip_protocol = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "frontend_all" {

  security_group_id = aws_security_group.this["frontend"].id

  cidr_ipv4 = "0.0.0.0/0"

  ip_protocol = "-1"
}

resource "aws_vpc_security_group_ingress_rule" "internal_alb_from_frontend" {

  security_group_id = aws_security_group.this["internal_alb"].id

  referenced_security_group_id = aws_security_group.this["frontend"].id

  from_port = 80
  to_port   = 80

  ip_protocol = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "internal_alb_all" {

  security_group_id = aws_security_group.this["internal_alb"].id

  cidr_ipv4 = "0.0.0.0/0"

  ip_protocol = "-1"
}

resource "aws_vpc_security_group_ingress_rule" "backend_from_internal_alb" {

  security_group_id = aws_security_group.this["backend"].id

  referenced_security_group_id = aws_security_group.this["internal_alb"].id

  from_port = 4000
  to_port   = 4000

  ip_protocol = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "backend_all" {

  security_group_id = aws_security_group.this["backend"].id

  cidr_ipv4 = "0.0.0.0/0"

  ip_protocol = "-1"
}

resource "aws_vpc_security_group_ingress_rule" "database_from_backend" {

  security_group_id = aws_security_group.this["database"].id

  referenced_security_group_id = aws_security_group.this["backend"].id

  from_port = 5432
  to_port   = 5432

  ip_protocol = "tcp"
}

# EKS Node Security Group rules

# Allow all egress from EKS nodes (required for pulling images, AWS API calls via NAT)
resource "aws_vpc_security_group_egress_rule" "eks_node_all" {

  security_group_id = aws_security_group.this["eks_node"].id

  cidr_ipv4   = "0.0.0.0/0"
  ip_protocol = "-1"
}

# Allow EKS nodes to communicate with each other (required for pod-to-pod traffic)
resource "aws_vpc_security_group_ingress_rule" "eks_node_self" {

  security_group_id            = aws_security_group.this["eks_node"].id
  referenced_security_group_id = aws_security_group.this["eks_node"].id

  ip_protocol = "-1"
}

# Allow EKS control plane to reach nodes on HTTPS (kubelet API, metrics)
resource "aws_vpc_security_group_ingress_rule" "eks_node_from_control_plane" {

  security_group_id = aws_security_group.this["eks_node"].id

  cidr_ipv4 = "10.0.0.0/8"

  from_port   = 443
  to_port     = 443
  ip_protocol = "tcp"
}

# Critical: allows microservice pods to reach RDS PostgreSQL
resource "aws_vpc_security_group_ingress_rule" "database_from_eks_node" {

  security_group_id            = aws_security_group.this["database"].id
  referenced_security_group_id = aws_security_group.this["eks_node"].id

  from_port   = 5432
  to_port     = 5432
  ip_protocol = "tcp"
}
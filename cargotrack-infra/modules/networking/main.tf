data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  common_tags = {
    Project   = var.project_name
    ManagedBy = "Terraform"
  }

  # EKS subnet discovery — maps tier to the required kubernetes.io tags.
  # AWS Load Balancer Controller uses these to find subnets when creating ALBs.
  # "elb"          = public subnets  (external-facing ALBs / NLBs)
  # "internal-elb" = web/app subnets (internal ALBs)
  eks_elb_role = {
    public = "1"
    web    = "0"
    app    = "0"
    db     = "0"
  }

  eks_internal_elb_role = {
    public = "0"
    web    = "1"
    app    = "1"
    db     = "0"
  }

  subnets = {
    public_a = {
      cidr = "10.0.1.0/24"
      az   = data.aws_availability_zones.available.names[0]
      tier = "public"
    }

    public_b = {
      cidr = "10.0.2.0/24"
      az   = data.aws_availability_zones.available.names[1]
      tier = "public"
    }

    web_a = {
      cidr = "10.0.11.0/24"
      az   = data.aws_availability_zones.available.names[0]
      tier = "web"
    }

    web_b = {
      cidr = "10.0.12.0/24"
      az   = data.aws_availability_zones.available.names[1]
      tier = "web"
    }

    app_a = {
      cidr = "10.0.21.0/24"
      az   = data.aws_availability_zones.available.names[0]
      tier = "app"
    }

    app_b = {
      cidr = "10.0.22.0/24"
      az   = data.aws_availability_zones.available.names[1]
      tier = "app"
    }

    db_a = {
      cidr = "10.0.31.0/24"
      az   = data.aws_availability_zones.available.names[0]
      tier = "db"
    }

    db_b = {
      cidr = "10.0.32.0/24"
      az   = data.aws_availability_zones.available.names[1]
      tier = "db"
    }
  }
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-vpc"
    }
  )
}

resource "aws_subnet" "subnets" {

  for_each = local.subnets

  vpc_id = aws_vpc.main.id

  cidr_block = each.value.cidr

  availability_zone = each.value.az

  map_public_ip_on_launch = each.value.tier == "public"

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-${each.key}"
      Tier = each.value.tier

      # EKS subnet discovery tags (required for AWS Load Balancer Controller)
      "kubernetes.io/cluster/${var.project_name}" = "shared"
      "kubernetes.io/role/elb"                    = local.eks_elb_role[each.value.tier]
      "kubernetes.io/role/internal-elb"           = local.eks_internal_elb_role[each.value.tier]
    }
  )
}

resource "aws_internet_gateway" "main" {

  vpc_id = aws_vpc.main.id

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-igw"
    }
  )
}

resource "aws_eip" "nat" {

  domain = "vpc"

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-nat-eip"
    }
  )
}

resource "aws_nat_gateway" "main" {

  allocation_id = aws_eip.nat.id

  subnet_id = aws_subnet.subnets["public_a"].id

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-nat"
    }
  )

  depends_on = [
    aws_internet_gateway.main
  ]
}

resource "aws_route_table" "public" {

  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-public-rt"
    }
  )
}

resource "aws_route_table" "web" {

  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-web-rt"
    }
  )
}

resource "aws_route_table" "app" {

  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-app-rt"
    }
  )
}

resource "aws_route_table" "db" {

  vpc_id = aws_vpc.main.id

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-db-rt"
    }
  )
}

locals {
  route_table_ids = {
    public = aws_route_table.public.id
    web    = aws_route_table.web.id
    app    = aws_route_table.app.id
    db     = aws_route_table.db.id
  }
}

resource "aws_route_table_association" "all" {

  for_each = local.subnets

  subnet_id = aws_subnet.subnets[each.key].id

  route_table_id = local.route_table_ids[each.value.tier]

}

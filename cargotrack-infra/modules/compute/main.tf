data "aws_caller_identity" "current" {}

data "aws_ami" "ubuntu" {

  most_recent = true

  owners = [
    "099720109477"
  ]

  filter {
    name = "name"

    values = [
      "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"
    ]
  }

  filter {
    name = "virtualization-type"

    values = [
      "hvm"
    ]
  }
}

locals {
  common_tags = {
    Project   = var.project_name
    ManagedBy = "Terraform"
  }

  asg_tags = {
    Project   = var.project_name
    ManagedBy = "Terraform"
  }

  frontend_user_data = <<-EOF
#!/bin/bash

apt-get update -y

apt-get install -y docker.io

systemctl enable --now docker

usermod -aG docker ubuntu

cat > /etc/frontend.env <<ENVFILE
BACKEND_URL=http://${aws_lb.internal.dns_name}
ENVFILE

chmod 600 /etc/frontend.env

docker pull abhinavbabu33/cargotrack-frontend:v1

docker run -d \
  --name frontend \
  --restart unless-stopped \
  --env-file /etc/frontend.env \
  -p 80:80 \
  abhinavbabu33/cargotrack-frontend:v1
EOF

  backend_user_data = <<-EOF
#!/bin/bash

apt-get update -y

apt-get install -y docker.io jq unzip curl

systemctl enable --now docker

usermod -aG docker ubuntu

curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install
rm -rf /tmp/awscliv2.zip /tmp/aws

export AWS_DEFAULT_REGION="${var.aws_region}"

DB_HOST=$(aws ssm get-parameter \
  --name "/${var.project_name}/database/host" \
  --query "Parameter.Value" \
  --output text)

DB_PORT=$(aws ssm get-parameter \
  --name "/${var.project_name}/database/port" \
  --query "Parameter.Value" \
  --output text)

DB_NAME=$(aws ssm get-parameter \
  --name "/${var.project_name}/database/name" \
  --query "Parameter.Value" \
  --output text)

DB_USER=$(aws ssm get-parameter \
  --name "/${var.project_name}/database/user" \
  --query "Parameter.Value" \
  --output text)

NODE_ENV=$(aws ssm get-parameter \
  --name "/${var.project_name}/application/node-env" \
  --query "Parameter.Value" \
  --output text)

DB_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id "${var.db_secret_arn}" \
  --query "SecretString" \
  --output text)

DB_PASSWORD=$(echo "$DB_SECRET" | jq -r '.password')

APP_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id "${var.app_secret_arn}" \
  --query "SecretString" \
  --output text)

JWT_SECRET=$(echo "$APP_SECRET" | jq -r '.jwt_secret')
ADMIN_EMAIL=$(echo "$APP_SECRET" | jq -r '.admin_email')
ADMIN_PASSWORD=$(echo "$APP_SECRET" | jq -r '.admin_password')

cat > /etc/cargotrack.env <<ENVFILE
PORT=4000
NODE_ENV=$NODE_ENV
DATABASE_HOST=$DB_HOST
DATABASE_PORT=$DB_PORT
DATABASE_NAME=$DB_NAME
DATABASE_USER=$DB_USER
DATABASE_PASSWORD=$DB_PASSWORD
JWT_SECRET=$JWT_SECRET
JWT_EXPIRES_IN=7d
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD
UPLOAD_DIR=/uploads
CORS_ORIGIN=*
AWS_DEFAULT_REGION=${var.aws_region}
S3_BUCKET=${var.documents_bucket_id}
EVENT_BUS_NAME=${var.event_bus_name}
ENVFILE

chmod 600 /etc/cargotrack.env

docker pull abhinavbabu33/cargotrack-backend:v2

docker run -d \
  --name backend \
  --restart unless-stopped \
  --env-file /etc/cargotrack.env \
  -p 4000:4000 \
  abhinavbabu33/cargotrack-backend:v2
EOF
}

resource "aws_lb" "external" {

  name               = "${var.project_name}-external-alb"
  internal           = false
  load_balancer_type = "application"

  security_groups = [
    var.external_alb_sg_id
  ]

  subnets = var.public_subnet_ids

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-external-alb"
    }
  )
}

resource "aws_lb" "internal" {

  name               = "${var.project_name}-internal-alb"
  internal           = true
  load_balancer_type = "application"

  security_groups = [
    var.internal_alb_sg_id
  ]

  subnets = var.web_subnet_ids

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-internal-alb"
    }
  )
}

resource "aws_lb_target_group" "frontend" {

  name     = "${var.project_name}-frontend-tg"
  port     = 80
  protocol = "HTTP"

  vpc_id = var.vpc_id

  health_check {
    path = "/"
  }

  tags = local.common_tags
}

resource "aws_lb_target_group" "backend" {

  name     = "${var.project_name}-backend-tg"
  port     = 4000
  protocol = "HTTP"

  vpc_id = var.vpc_id

  health_check {
    path = "/api/health"
  }

  tags = local.common_tags
}

data "aws_iam_policy_document" "ec2_assume_role" {

  statement {

    actions = [
      "sts:AssumeRole"
    ]

    principals {

      type = "Service"

      identifiers = [
        "ec2.amazonaws.com"
      ]
    }
  }
}

resource "aws_iam_role" "ec2_role" {

  name = "${var.project_name}-ec2-role"

  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ssm" {

  role = aws_iam_role.ec2_role.name

  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "cloudwatch" {

  role = aws_iam_role.ec2_role.name

  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_instance_profile" "ec2_profile" {

  name = "${var.project_name}-instance-profile"

  role = aws_iam_role.ec2_role.name
}

resource "aws_launch_template" "frontend" {

  name_prefix = "${var.project_name}-frontend-"

  image_id = data.aws_ami.ubuntu.id

  instance_type = "t3.micro"

  vpc_security_group_ids = [
    var.frontend_sg_id
  ]

  iam_instance_profile {
    name = aws_iam_instance_profile.ec2_profile.name
  }

  user_data = base64encode(
    local.frontend_user_data
  )

  tag_specifications {

    resource_type = "instance"

    tags = merge(
      local.common_tags,
      {
        Name = "${var.project_name}-frontend"
      }
    )
  }
}

resource "aws_launch_template" "backend" {

  name_prefix = "${var.project_name}-backend-"

  image_id = data.aws_ami.ubuntu.id

  instance_type = "t3.micro"

  vpc_security_group_ids = [
    var.backend_sg_id
  ]

  iam_instance_profile {
    name = aws_iam_instance_profile.ec2_profile.name
  }

  user_data = base64encode(
    local.backend_user_data
  )

  tag_specifications {

    resource_type = "instance"

    tags = merge(
      local.common_tags,
      {
        Name = "${var.project_name}-backend"
      }
    )
  }
}

data "aws_iam_policy_document" "ec2_secrets" {

  statement {

    actions = [
      "secretsmanager:GetSecretValue"
    ]

    resources = [
      var.db_secret_arn,
      var.app_secret_arn
    ]
  }

  statement {

    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters"
    ]

    resources = [
      "arn:aws:ssm:*:*:parameter/${var.project_name}/*"
    ]
  }

  statement {

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey"
    ]

    resources = [
      var.kms_key_arn
    ]
  }

  statement {

    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject"
    ]

    resources = [
      "${var.documents_bucket_arn}/*"
    ]
  }

  statement {

    actions = [
      "s3:ListBucket"
    ]

    resources = [
      var.documents_bucket_arn
    ]
  }

  statement {

    sid = "EventBridgePublish"

    actions = [
      "events:PutEvents"
    ]

    resources = [
      "arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:event-bus/${var.event_bus_name}"
    ]
  }
}

resource "aws_iam_role_policy" "ec2_secrets" {

  name = "${var.project_name}-ec2-secrets-policy"

  role = aws_iam_role.ec2_role.id

  policy = data.aws_iam_policy_document.ec2_secrets.json
}

resource "aws_autoscaling_group" "frontend" {

  name = "${var.project_name}-frontend-asg"

  min_size         = 1
  max_size         = 2
  desired_capacity = 1

  force_delete = true

  vpc_zone_identifier = var.web_subnet_ids

  target_group_arns = [
    aws_lb_target_group.frontend.arn
  ]

  health_check_type         = "ELB"
  health_check_grace_period = 120

  launch_template {
    id      = aws_launch_template.frontend.id
    version = "$Latest"
  }

  dynamic "tag" {
    for_each = local.asg_tags

    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = true
    }
  }

  lifecycle {
    ignore_changes = [desired_capacity]
  }

  timeouts {
    delete = "10m"
  }
}

resource "aws_autoscaling_group" "backend" {

  name = "${var.project_name}-backend-asg"

  min_size         = 1
  max_size         = 2
  desired_capacity = 1

  force_delete = true

  vpc_zone_identifier = var.app_subnet_ids

  target_group_arns = [
    aws_lb_target_group.backend.arn
  ]

  health_check_type         = "ELB"
  health_check_grace_period = 120

  launch_template {
    id      = aws_launch_template.backend.id
    version = "$Latest"
  }

  dynamic "tag" {
    for_each = local.asg_tags

    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = true
    }
  }

  lifecycle {
    ignore_changes = [desired_capacity]
  }

  timeouts {
    delete = "10m"
  }
}

resource "aws_lb_listener" "external_http" {

  load_balancer_arn = aws_lb.external.arn

  port     = 80
  protocol = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend.arn
  }
}

resource "aws_lb_listener" "internal_http" {

  load_balancer_arn = aws_lb.internal.arn

  port     = 80
  protocol = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# AUTO SCALING — Target Tracking Policies
# Target: 50% average CPU utilisation across the ASG.
# AWS automatically creates and manages the underlying CloudWatch alarms
# for scale-out (CPU > 50%) and scale-in (CPU < 50%) via target tracking.
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_autoscaling_policy" "frontend_cpu" {

  name                   = "${var.project_name}-frontend-cpu-tracking"
  autoscaling_group_name = aws_autoscaling_group.frontend.name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {

    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }

    target_value = 50.0

    # Allow 5 minutes for a new instance to become healthy before scaling in
    disable_scale_in = false
  }
}

resource "aws_autoscaling_policy" "backend_cpu" {

  name                   = "${var.project_name}-backend-cpu-tracking"
  autoscaling_group_name = aws_autoscaling_group.backend.name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {

    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }

    target_value = 50.0

    disable_scale_in = false
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# CLOUDWATCH ALARMS — CPU Monitoring (supplemental / for SNS notifications)
# The target-tracking policies above already fire alarms internally.
# These explicit alarms send notifications to an SNS topic so operators
# are alerted when scaling events occur.
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_metric_alarm" "frontend_cpu_high" {

  alarm_name          = "${var.project_name}-frontend-cpu-high"
  alarm_description   = "Frontend ASG CPU utilization exceeded 80% — scale-out may be needed"
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"

  dimensions = {
    AutoScalingGroupName = aws_autoscaling_group.frontend.name
  }

  alarm_actions = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []
  ok_actions    = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []

  treat_missing_data = "notBreaching"

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "frontend_cpu_low" {

  alarm_name          = "${var.project_name}-frontend-cpu-low"
  alarm_description   = "Frontend ASG CPU utilization below 20% — scale-in may occur"
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 20
  comparison_operator = "LessThanThreshold"

  dimensions = {
    AutoScalingGroupName = aws_autoscaling_group.frontend.name
  }

  alarm_actions = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []
  ok_actions    = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []

  treat_missing_data = "notBreaching"

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "backend_cpu_high" {

  alarm_name          = "${var.project_name}-backend-cpu-high"
  alarm_description   = "Backend ASG CPU utilization exceeded 80% — scale-out may be needed"
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"

  dimensions = {
    AutoScalingGroupName = aws_autoscaling_group.backend.name
  }

  alarm_actions = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []
  ok_actions    = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []

  treat_missing_data = "notBreaching"

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "backend_cpu_low" {

  alarm_name          = "${var.project_name}-backend-cpu-low"
  alarm_description   = "Backend ASG CPU utilization below 20% — scale-in may occur"
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 20
  comparison_operator = "LessThanThreshold"

  dimensions = {
    AutoScalingGroupName = aws_autoscaling_group.backend.name
  }

  alarm_actions = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []
  ok_actions    = var.sns_alarm_topic_arn != "" ? [var.sns_alarm_topic_arn] : []

  treat_missing_data = "notBreaching"

  tags = local.common_tags
}

locals {
  common_tags = {
    Project   = var.project_name
    ManagedBy = "Terraform"
  }

  # EC2/ASG-specific alarms — only created when backend_asg_name is provided.
  # When running on EKS, these are omitted (var defaults to "").
  asg_alarms = var.backend_asg_name != "" ? {
    backend_cpu_high = {
      alarm_name          = "${var.project_name}-backend-cpu-high"
      alarm_description   = "Backend ASG CPU utilization exceeded 80%"
      metric_name         = "CPUUtilization"
      namespace           = "AWS/EC2"
      statistic           = "Average"
      period              = 300
      evaluation_periods  = 2
      threshold           = 80
      comparison_operator = "GreaterThanThreshold"
      dimensions = {
        AutoScalingGroupName = var.backend_asg_name
      }
    }
  } : {}

  # ALB-specific alarms — only created when external_alb_arn_suffix is provided.
  alb_alarms = var.external_alb_arn_suffix != "" ? {
    alb_5xx_errors = {
      alarm_name          = "${var.project_name}-alb-5xx-errors"
      alarm_description   = "External ALB 5XX error count exceeded threshold"
      metric_name         = "HTTPCode_Target_5XX_Count"
      namespace           = "AWS/ApplicationELB"
      statistic           = "Sum"
      period              = 300
      evaluation_periods  = 2
      threshold           = 10
      comparison_operator = "GreaterThanThreshold"
      dimensions = {
        LoadBalancer = var.external_alb_arn_suffix
      }
    }

    alb_unhealthy_hosts = {
      alarm_name          = "${var.project_name}-alb-unhealthy-hosts"
      alarm_description   = "External ALB has unhealthy target hosts"
      metric_name         = "UnHealthyHostCount"
      namespace           = "AWS/ApplicationELB"
      statistic           = "Average"
      period              = 60
      evaluation_periods  = 2
      threshold           = 0
      comparison_operator = "GreaterThanThreshold"
      dimensions = {
        LoadBalancer = var.external_alb_arn_suffix
      }
    }
  } : {}

  # RDS alarm — always active regardless of compute model
  rds_alarms = {
    rds_cpu_high = {
      alarm_name          = "${var.project_name}-rds-cpu-high"
      alarm_description   = "RDS CPU utilization exceeded 80%"
      metric_name         = "CPUUtilization"
      namespace           = "AWS/RDS"
      statistic           = "Average"
      period              = 300
      evaluation_periods  = 2
      threshold           = 80
      comparison_operator = "GreaterThanThreshold"
      dimensions = {
        DBInstanceIdentifier = var.db_identifier
      }
    }
  }

  # Merge all alarm maps — only non-empty maps contribute entries
  alarms = merge(local.asg_alarms, local.alb_alarms, local.rds_alarms)

  # Dashboard widgets — built conditionally to avoid empty-string metric dimensions
  # CloudWatch rejects widgets whose dimension values are empty strings.
  asg_widgets = var.backend_asg_name != "" ? [
    {
      type   = "metric"
      x      = 0
      y      = 0
      width  = 12
      height = 6
      properties = {
        title  = "Backend ASG CPU Utilization"
        region = var.aws_region
        metrics = [["AWS/EC2", "CPUUtilization", "AutoScalingGroupName", var.backend_asg_name]]
        period = 300
        stat   = "Average"
        view   = "timeSeries"
      }
    }
  ] : []

  alb_widgets = var.external_alb_arn_suffix != "" ? [
    {
      type   = "metric"
      x      = 12
      y      = 0
      width  = 12
      height = 6
      properties = {
        title  = "External ALB Request Count"
        region = var.aws_region
        metrics = [["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.external_alb_arn_suffix]]
        period = 300
        stat   = "Sum"
        view   = "timeSeries"
      }
    },
    {
      type   = "metric"
      x      = 0
      y      = 6
      width  = 12
      height = 6
      properties = {
        title  = "External ALB Target Response Time"
        region = var.aws_region
        metrics = [["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", var.external_alb_arn_suffix]]
        period = 300
        stat   = "Average"
        view   = "timeSeries"
      }
    }
  ] : []

  rds_widgets = [
    {
      type   = "metric"
      x      = 12
      y      = 6
      width  = 12
      height = 6
      properties = {
        title  = "RDS CPU Utilization"
        region = var.aws_region
        metrics = [["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", var.db_identifier]]
        period = 300
        stat   = "Average"
        view   = "timeSeries"
      }
    },
    {
      type   = "metric"
      x      = 0
      y      = 12
      width  = 12
      height = 6
      properties = {
        title  = "RDS Database Connections"
        region = var.aws_region
        metrics = [["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", var.db_identifier]]
        period = 300
        stat   = "Average"
        view   = "timeSeries"
      }
    }
  ]

  dashboard_widgets = concat(local.asg_widgets, local.alb_widgets, local.rds_widgets)
}

resource "aws_sns_topic" "alarms" {

  name = "${var.project_name}-alarms"

  tags = local.common_tags
}

resource "aws_sns_topic_subscription" "email" {

  count = var.alarm_email != null ? 1 : 0

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_metric_alarm" "this" {

  for_each = local.alarms

  alarm_name          = each.value.alarm_name
  alarm_description   = each.value.alarm_description
  metric_name         = each.value.metric_name
  namespace           = each.value.namespace
  statistic           = each.value.statistic
  period              = each.value.period
  evaluation_periods  = each.value.evaluation_periods
  threshold           = each.value.threshold
  comparison_operator = each.value.comparison_operator
  dimensions          = each.value.dimensions

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  treat_missing_data = "notBreaching"

  tags = local.common_tags
}

resource "aws_cloudwatch_dashboard" "main" {

  dashboard_name = "${var.project_name}-overview"

  dashboard_body = jsonencode({
    widgets = local.dashboard_widgets
  })
}


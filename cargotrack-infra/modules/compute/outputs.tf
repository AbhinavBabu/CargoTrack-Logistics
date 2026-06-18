output "external_alb_arn" {
  value = aws_lb.external.arn
}

output "external_alb_arn_suffix" {
  value = aws_lb.external.arn_suffix
}

output "external_alb_dns_name" {
  value = aws_lb.external.dns_name
}

output "internal_alb_arn" {
  value = aws_lb.internal.arn
}

output "internal_alb_dns_name" {
  value = aws_lb.internal.dns_name
}

output "frontend_target_group_arn" {
  value = aws_lb_target_group.frontend.arn
}

output "backend_target_group_arn" {
  value = aws_lb_target_group.backend.arn
}

output "backend_asg_name" {
  value = aws_autoscaling_group.backend.name
}

output "frontend_asg_name" {
  description = "Name of the frontend Auto Scaling Group"
  value       = aws_autoscaling_group.frontend.name
}

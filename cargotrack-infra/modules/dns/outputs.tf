output "zone_id" {
  description = "Route 53 hosted zone ID (empty string when domain_name is not set)"
  value       = local.enabled ? aws_route53_zone.main[0].zone_id : ""
}

output "zone_name_servers" {
  description = "NS records for the hosted zone — configure these at your domain registrar"
  value       = local.enabled ? aws_route53_zone.main[0].name_servers : []
}

output "certificate_arn" {
  description = "ARN of the ACM certificate (empty string when domain_name is not set)"
  value       = local.enabled ? aws_acm_certificate_validation.main[0].certificate_arn : ""
}

output "domain_name" {
  description = "The configured domain name (passthrough)"
  value       = var.domain_name
}

output "dns_enabled" {
  description = "True when a domain was provided and DNS resources were created"
  value       = local.enabled
}

# ─────────────────────────────────────────────────────────────────────────────
# CargoTrack — Optional DNS + ACM Module
#
# All resources in this module are conditional on var.domain_name != "".
# When domain_name = "" (the default), no hosted zone, certificate, or DNS
# record is created. Infrastructure provisions and validates cleanly without
# a domain.
#
# When a domain is provided later:
#   terraform apply -var="domain_name=cargotrack.example.com"
#
# Resources created when domain_name is set:
#   1. Route 53 public hosted zone
#   2. ACM certificate (us-east-1 — required for CloudFront)
#   3. Route 53 DNS validation CNAME records
#   4. ACM certificate validation waiter
#   5. Route 53 A-record alias pointing to the CloudFront distribution
# ─────────────────────────────────────────────────────────────────────────────

locals {
  common_tags = {
    Project   = var.project_name
    ManagedBy = "Terraform"
  }

  # Gate: all resources in this module use this flag
  enabled = var.domain_name != ""
}

# ─── Route 53 Hosted Zone ────────────────────────────────────────────────────
# Created only when a domain name is provided.
# After apply, delegate NS records from your registrar to AWS.

resource "aws_route53_zone" "main" {
  count = local.enabled ? 1 : 0

  name = var.domain_name

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-hosted-zone"
    }
  )
}

# ─── ACM Certificate ─────────────────────────────────────────────────────────
# CloudFront requires certificates to be provisioned in us-east-1 regardless
# of the AWS region used for the rest of the infrastructure.
# We use the aws.us_east_1 provider alias for this resource.

resource "aws_acm_certificate" "main" {
  count = local.enabled ? 1 : 0

  provider = aws.us_east_1

  domain_name               = var.domain_name
  subject_alternative_names = ["*.${var.domain_name}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-certificate"
    }
  )
}

# ─── DNS Validation CNAME Records ────────────────────────────────────────────
# ACM issues CNAME validation challenges that must be added to Route 53.

resource "aws_route53_record" "cert_validation" {
  for_each = local.enabled ? {
    for dvo in aws_acm_certificate.main[0].domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  zone_id = aws_route53_zone.main[0].zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.record]

  # allow_overwrite = true is required when the certificate covers both the apex
  # domain (shopp-novaa.co.in) and the wildcard (*.shopp-novaa.co.in).
  # ACM issues the same CNAME validation record for both, so the for_each loop
  # would otherwise fail with "record already exists" on the second iteration.
  allow_overwrite = true
}

# ─── Certificate Validation Completion ───────────────────────────────────────

resource "aws_acm_certificate_validation" "main" {
  count = local.enabled ? 1 : 0

  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.main[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}


# ─── Note on Route53 A-records ───────────────────────────────────────────────
# The Route53 A-record and www CNAME pointing to CloudFront are intentionally
# NOT in this module. They live in environments/dev/main.tf because:
#   - module.cdn needs module.dns.certificate_arn (cdn depends on dns)
#   - A-records need module.cdn.cloudfront_domain_name (records depend on cdn)
#   - Putting both inside dns would create a cycle with cdn
# At environment level, all outputs are available without a cycle.

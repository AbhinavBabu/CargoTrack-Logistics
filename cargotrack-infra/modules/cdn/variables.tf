variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
}

variable "alb_dns_name" {
  description = "DNS name of the EKS ALB Ingress (CloudFront origin). Set by terraform apply after first Helm deploy."
  type        = string
}

variable "acm_certificate_arn" {
  description = <<-EOT
    ARN of an ACM certificate in us-east-1 to attach to the CloudFront distribution.
    Leave as empty string "" to use the CloudFront default certificate (*.cloudfront.net).
    Set this to the certificate_arn output of the dns module when a custom domain is configured.
  EOT
  type    = string
  default = ""
}

variable "domain_aliases" {
  description = <<-EOT
    List of custom domain aliases for CloudFront (e.g. ["shopp-novaa.co.in", "www.shopp-novaa.co.in"]).
    Required when acm_certificate_arn is set. Leave empty when using the CloudFront default cert.
  EOT
  type    = list(string)
  default = []
}

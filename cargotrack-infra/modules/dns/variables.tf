variable "project_name" {
  description = "Project name used for resource naming and tagging"
  type        = string
}

variable "domain_name" {
  description = <<-EOT
    Custom domain name for the CargoTrack application (e.g. cargotrack.example.com).
    Leave as empty string "" to skip all DNS and certificate creation.
    Infrastructure validates and applies cleanly without a domain.

    When provided:
      - A Route 53 hosted zone is created
      - An ACM certificate is issued (in us-east-1 for CloudFront)
      - DNS validation CNAME records are added
      - An A-record alias is created pointing to CloudFront

    After apply, copy the NS records from the Terraform output and
    configure them at your domain registrar.
  EOT
  type        = string
  default     = ""
}

variable "cloudfront_domain_name" {
  description = "CloudFront distribution domain name (*.cloudfront.net) — used as the alias target for the Route 53 A-record"
  type        = string
  default     = ""
}

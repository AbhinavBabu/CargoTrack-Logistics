variable "project_name" {
  description = "Project name used for resource naming and tagging"
  type        = string
}

variable "domain_name" {
  description = <<-EOT
    Custom domain name for the CargoTrack application (e.g. shopp-novaa.co.in).
    Leave as empty string "" to skip all DNS and certificate creation.
    Infrastructure validates and applies cleanly without a domain.

    When provided:
      - A Route 53 hosted zone is created
      - An ACM certificate is issued (in us-east-1 for CloudFront)
      - DNS validation CNAME records are added
      - Route 53 A-record + www CNAME created at environment level (→ CloudFront)

    After apply, copy the NS records from the Terraform output (zone_name_servers)
    and configure them at your domain registrar to complete DNS delegation.
  EOT
  type    = string
  default = ""
}

provider "aws" {
  region = var.aws_region
}

# ACM certificates for CloudFront must be provisioned in us-east-1,
# regardless of the primary deployment region.
# This provider alias is used only by the dns module.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

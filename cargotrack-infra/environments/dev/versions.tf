terraform {

  required_version = ">= 1.5"

  required_providers {

    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }

    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }

    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }

    # Required by modules/eks to compute the OIDC issuer TLS thumbprint
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}


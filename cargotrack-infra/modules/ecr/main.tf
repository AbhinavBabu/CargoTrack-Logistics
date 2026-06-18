locals {
  common_tags = {
    Project   = var.project_name
    ManagedBy = "Terraform"
  }

  # Repositories to create — one per microservice image
  repositories = {
    frontend = {
      name        = "${var.project_name}-frontend"
      description = "CargoTrack frontend (Next.js / nginx)"
    }
    core = {
      name        = "${var.project_name}-core"
      description = "CargoTrack core service (auth, shipments, admin)"
    }
    ai = {
      name        = "${var.project_name}-ai"
      description = "CargoTrack AI service (Bedrock, compliance, risk)"
    }
    docs = {
      name        = "${var.project_name}-docs"
      description = "CargoTrack document service (S3, Textract)"
    }
  }
}

resource "aws_ecr_repository" "this" {

  for_each = local.repositories

  name                 = each.value.name
  image_tag_mutability = "MUTABLE" # allow :latest overwrites during dev; switch to IMMUTABLE for prod

  image_scanning_configuration {
    scan_on_push = true # automatically scan for known CVEs on every push
  }

  force_delete = true # allow destroy even when images exist (safe for dev/CI)

  tags = merge(
    local.common_tags,
    {
      Name        = each.value.name
      Description = each.value.description
    }
  )
}

# Lifecycle policy — keep only the 10 most-recent tagged images per repository.
# Untagged images (layer cache blobs) are expired after 1 day to control storage costs.
resource "aws_ecr_lifecycle_policy" "this" {

  for_each = aws_ecr_repository.this

  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images older than 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the 10 most recent tagged images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["v"]
          countType     = "imageCountMoreThan"
          countNumber   = 10
        }
        action = { type = "expire" }
      }
    ]
  })
}

# ─── ECR Pull-through / cross-account access (optional) ───────────────────────
# Grants EKS node role permission to pull images from all CargoTrack repos.
# This supplements the AmazonEC2ContainerRegistryReadOnly managed policy
# already attached in modules/eks/main.tf, and explicitly scopes it to this
# account's CargoTrack repositories.

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "ecr_pull" {

  statement {

    sid = "AllowEKSNodePull"

    principals {
      type = "AWS"
      identifiers = [
        var.eks_node_role_arn,
      ]
    }

    actions = [
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:BatchCheckLayerAvailability",
    ]
  }
}

resource "aws_ecr_repository_policy" "this" {

  for_each = aws_ecr_repository.this

  repository = each.value.name

  policy = data.aws_iam_policy_document.ecr_pull.json
}

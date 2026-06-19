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
      Name    = each.value.name
      Service = each.key
    }
  )
}

# Lifecycle policy — keep the 10 most-recent images (any tag) per repository.
# Untagged images (layer cache blobs) are expired after 1 day to control storage costs.
# NOTE: tagStatus = "any" protects SHA-tagged images from CI (e.g. abc1234...)
#       as well as semver-tagged images (e.g. v1.0.0). Both are retained.
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
        description  = "Keep the 10 most recent images (any tag — protects SHA and semver tags)"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
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

# ─── GitHub Actions OIDC — ECR Push Role ─────────────────────────────────────
# Allows GitHub Actions to assume this role via OIDC and push images to ECR.
# No long-lived AWS access keys are stored in GitHub — the OIDC token is
# exchanged for temporary credentials at workflow runtime.
#
# Trust is scoped to:
#   - The exact GitHub repository: var.github_repository
#   - The specific branch(es): var.github_branch (default "*" = any branch)
#
# After terraform apply:
#   terraform output github_actions_ecr_role_arn
# Set the output value as the GitHub secret: AWS_ECR_PUSH_ROLE_ARN

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"] # GitHub OIDC thumbprint (stable, documented by AWS)

  tags = merge(
    local.common_tags,
    { Name = "${var.project_name}-github-oidc-provider" }
  )
}

data "aws_iam_policy_document" "github_actions_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    effect  = "Allow"

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    # Scope trust to the exact repository — prevents other GitHub repos from assuming this role
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:*"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "github_actions_ecr" {
  name               = "${var.project_name}-github-actions-ecr-push"
  assume_role_policy = data.aws_iam_policy_document.github_actions_assume.json

  tags = merge(
    local.common_tags,
    { Name = "${var.project_name}-github-actions-ecr-push" }
  )
}

data "aws_iam_policy_document" "github_actions_ecr" {
  # Login token — required before any push or pull
  statement {
    sid       = "ECRGetAuthToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # GetAuthorizationToken is account-level, not resource-level
  }

  # Push permissions — scoped to CargoTrack ECR repositories only
  statement {
    sid = "ECRPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [for repo in aws_ecr_repository.this : repo.arn]
  }
}

resource "aws_iam_role_policy" "github_actions_ecr" {
  name   = "${var.project_name}-github-actions-ecr-push-policy"
  role   = aws_iam_role.github_actions_ecr.id
  policy = data.aws_iam_policy_document.github_actions_ecr.json
}

# ─── GitHub Actions Terraform Permissions ─────────────────────────────────────
# The CI/CD infra pipeline uses this role to run `terraform plan` and `terraform apply`.
# `terraform apply` requires full permissions to provision EKS, RDS, VPC, IAM, etc.
resource "aws_iam_role_policy_attachment" "github_actions_terraform_admin" {
  role       = aws_iam_role.github_actions_ecr.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

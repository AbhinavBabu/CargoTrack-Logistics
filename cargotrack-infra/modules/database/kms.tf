data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "kms_key_policy" {

  statement {

    sid = "EnableRootAccess"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {

    sid = "AllowSecretsManager"

    principals {
      type        = "Service"
      identifiers = ["secretsmanager.amazonaws.com"]
    }

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey"
    ]

    resources = ["*"]
  }

  statement {

    sid = "AllowSSM"

    principals {
      type        = "Service"
      identifiers = ["ssm.amazonaws.com"]
    }

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey"
    ]

    resources = ["*"]
  }

  statement {

    sid = "AllowRDS"

    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "kms:CreateGrant",
      "kms:DescribeKey"
    ]

    resources = ["*"]
  }

  statement {

    sid = "AllowEventBridge"

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    actions = [
      "kms:GenerateDataKey",
      "kms:Decrypt"
    ]

    resources = ["*"]
  }

  statement {

    sid = "AllowSQS"

    principals {
      type        = "Service"
      identifiers = ["sqs.amazonaws.com"]
    }

    actions = [
      "kms:GenerateDataKey",
      "kms:Decrypt"
    ]

    resources = ["*"]
  }

  statement {

    sid = "AllowDynamoDB"

    principals {
      type        = "Service"
      identifiers = ["dynamodb.amazonaws.com"]
    }

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:CreateGrant"
    ]

    resources = ["*"]
  }

  statement {

    sid = "AllowSNS"

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    actions = [
      "kms:GenerateDataKey",
      "kms:Decrypt"
    ]

    resources = ["*"]
  }
}

resource "aws_kms_key" "main" {

  description             = "${var.project_name} customer managed key"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  policy = data.aws_iam_policy_document.kms_key_policy.json

  tags = merge(
    local.common_tags,
    {
      Name = "${var.project_name}-cmk"
    }
  )
}

resource "aws_kms_alias" "main" {

  name          = "alias/${var.project_name}-cmk"
  target_key_id = aws_kms_key.main.key_id
}

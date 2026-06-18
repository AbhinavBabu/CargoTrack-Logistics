locals {
  common_tags = {
    Project   = var.project_name
    ManagedBy = "Terraform"
  }
}

data "aws_caller_identity" "current" {}

resource "aws_sqs_queue" "dlq" {

  name                      = "${var.project_name}-document-processor-dlq"
  message_retention_seconds = 1209600

  kms_master_key_id = var.kms_key_arn

  tags = local.common_tags
}

resource "aws_sqs_queue" "main" {

  name                       = "${var.project_name}-document-processor"
  visibility_timeout_seconds = 300
  message_retention_seconds  = 86400

  kms_master_key_id = var.kms_key_arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 3
  })

  tags = local.common_tags
}

data "aws_iam_policy_document" "sqs_policy" {

  statement {

    sid = "AllowEventBridgeSend"

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    actions = [
      "sqs:SendMessage"
    ]

    resources = [
      aws_sqs_queue.main.arn
    ]

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.document_upload.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "main" {

  queue_url = aws_sqs_queue.main.id
  policy    = data.aws_iam_policy_document.sqs_policy.json
}

data "aws_iam_policy_document" "lambda_assume_role" {

  statement {

    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {

  name               = "${var.project_name}-document-processor-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = local.common_tags
}

data "aws_iam_policy_document" "lambda_policy" {

  statement {

    sid = "SQSAccess"

    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes"
    ]

    resources = [
      aws_sqs_queue.main.arn
    ]
  }

  statement {

    sid = "CloudWatchLogs"

    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]

    resources = [
      "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-document-processor:*"
    ]
  }

  statement {

    sid = "KMSDecrypt"

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey"
    ]

    resources = [
      var.kms_key_arn
    ]
  }

  statement {

    sid = "DynamoDBWrite"

    actions = [
      "dynamodb:PutItem"
    ]

    resources = [
      var.audit_table_arn
    ]
  }
}

resource "aws_iam_role_policy" "lambda" {

  name   = "${var.project_name}-document-processor-policy"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_policy.json
}

resource "aws_cloudwatch_log_group" "lambda" {

  name              = "/aws/lambda/${var.project_name}-document-processor"
  retention_in_days = 14

  tags = local.common_tags
}

data "archive_file" "lambda" {

  type        = "zip"
  source_file = "${path.module}/lambda/index.js"
  output_path = "${path.module}/lambda/document_processor.zip"
}

resource "aws_lambda_function" "document_processor" {

  function_name = "${var.project_name}-document-processor"
  role          = aws_iam_role.lambda.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 60
  memory_size   = 128

  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256

  environment {
    variables = {
      PROJECT_NAME     = var.project_name
      AWS_REGION_NAME  = var.aws_region
      AUDIT_TABLE_NAME = var.audit_table_name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda
  ]

  tags = local.common_tags
}

resource "aws_lambda_event_source_mapping" "sqs" {

  event_source_arn = aws_sqs_queue.main.arn
  function_name    = aws_lambda_function.document_processor.arn
  batch_size       = 10

  scaling_config {
    maximum_concurrency = 5
  }
}

resource "aws_cloudwatch_event_bus" "main" {

  name = "${var.project_name}-events"

  tags = local.common_tags
}

resource "aws_cloudwatch_event_rule" "document_upload" {

  name           = "${var.project_name}-document-upload"
  description    = "Routes CargoTrack document upload events to SQS"
  event_bus_name = aws_cloudwatch_event_bus.main.name

  event_pattern = jsonencode({
    source      = ["cargotrack.documents"]
    detail-type = ["DocumentUploaded"]
  })

  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "sqs" {

  event_bus_name = aws_cloudwatch_event_bus.main.name
  rule           = aws_cloudwatch_event_rule.document_upload.name
  target_id      = "SendToSQS"
  arn            = aws_sqs_queue.main.arn
}

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 3: Compliance Pipeline
# EventBridge rule: shipment.status_updated → compliance SQS queue → ai-service
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_sqs_queue" "compliance_dlq" {

  name                      = "${var.project_name}-compliance-trigger-dlq"
  message_retention_seconds = 1209600 # 14 days

  kms_master_key_id = var.kms_key_arn

  tags = local.common_tags
}

resource "aws_sqs_queue" "compliance" {

  name                       = "${var.project_name}-compliance-trigger"
  visibility_timeout_seconds = 300   # 5 minutes — matches ai-service consumer timeout
  message_retention_seconds  = 86400 # 24 hours

  kms_master_key_id = var.kms_key_arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.compliance_dlq.arn
    maxReceiveCount     = 3
  })

  tags = local.common_tags
}

# SQS queue policy: allow EventBridge to publish to the compliance queue
data "aws_iam_policy_document" "compliance_sqs_policy" {

  statement {
    sid = "AllowEventBridgeComplianceTrigger"

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    actions = ["sqs:SendMessage"]

    resources = [aws_sqs_queue.compliance.arn]

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.compliance_trigger.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "compliance" {
  queue_url = aws_sqs_queue.compliance.id
  policy    = data.aws_iam_policy_document.compliance_sqs_policy.json
}

# EventBridge rule: route shipment status updates to compliance queue
# Triggers when admin updates a shipment to IN_TRANSIT or DELIVERED status
resource "aws_cloudwatch_event_rule" "compliance_trigger" {

  name           = "${var.project_name}-compliance-trigger"
  description    = "Routes shipment status updates to the compliance check SQS queue"
  event_bus_name = aws_cloudwatch_event_bus.main.name

  event_pattern = jsonencode({
    source      = ["cargotrack"]
    detail-type = ["shipment.status_updated"]
    detail = {
      newStatus = ["IN_TRANSIT", "DELIVERED"]
    }
  })

  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "compliance_sqs" {
  event_bus_name = aws_cloudwatch_event_bus.main.name
  rule           = aws_cloudwatch_event_rule.compliance_trigger.name
  target_id      = "SendToComplianceSQS"
  arn            = aws_sqs_queue.compliance.arn
}

# IAM policy allowing the EC2/ECS ai-service role to consume from compliance queue
# Attach to the compute module EC2 role via var.ec2_role_name
data "aws_iam_policy_document" "ai_service_sqs" {

  statement {
    sid = "ComplianceSQSConsume"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility",
    ]
    resources = [aws_sqs_queue.compliance.arn]
  }

  statement {
    sid = "ComplianceSQSKMS"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
    ]
    resources = [var.kms_key_arn]
  }

  statement {
    sid       = "ComplianceSQSPublish"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.compliance.arn]
    # core-service publishes to this queue when SQS_COMPLIANCE_QUEUE_URL is set
  }
}

resource "aws_iam_policy" "ai_service_sqs" {
  count       = var.ec2_role_name != "" ? 1 : 0
  name        = "${var.project_name}-ai-service-sqs-policy"
  description = "Allows ai-service to consume from the compliance trigger SQS queue"
  policy      = data.aws_iam_policy_document.ai_service_sqs.json

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ai_service_sqs" {
  count      = var.ec2_role_name != "" ? 1 : 0
  role       = var.ec2_role_name
  policy_arn = aws_iam_policy.ai_service_sqs[0].arn
}

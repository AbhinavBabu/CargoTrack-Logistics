output "sqs_queue_url" {
  description = "URL of the main SQS document processor queue"
  value       = aws_sqs_queue.main.id
}

output "sqs_queue_arn" {
  description = "ARN of the main SQS document processor queue"
  value       = aws_sqs_queue.main.arn
}

output "dlq_url" {
  description = "URL of the dead-letter queue"
  value       = aws_sqs_queue.dlq.id
}

output "dlq_arn" {
  description = "ARN of the dead-letter queue"
  value       = aws_sqs_queue.dlq.arn
}

output "lambda_function_arn" {
  description = "ARN of the document processor Lambda function"
  value       = aws_lambda_function.document_processor.arn
}

output "lambda_function_name" {
  description = "Name of the document processor Lambda function"
  value       = aws_lambda_function.document_processor.function_name
}

output "event_bus_name" {
  description = "Name of the CargoTrack custom EventBridge event bus"
  value       = aws_cloudwatch_event_bus.main.name
}

output "event_bus_arn" {
  description = "ARN of the CargoTrack custom EventBridge event bus"
  value       = aws_cloudwatch_event_bus.main.arn
}

output "compliance_queue_url" {
  description = "URL of the compliance trigger SQS queue (for ai-service SQS_COMPLIANCE_QUEUE_URL)"
  value       = aws_sqs_queue.compliance.id
}

output "compliance_queue_arn" {
  description = "ARN of the compliance trigger SQS queue"
  value       = aws_sqs_queue.compliance.arn
}

output "compliance_dlq_url" {
  description = "URL of the compliance trigger dead-letter queue"
  value       = aws_sqs_queue.compliance_dlq.id
}

output "compliance_queue_name" {
  description = "Name of the compliance trigger SQS queue — used as CloudWatch metric dimension"
  value       = aws_sqs_queue.compliance.name
}


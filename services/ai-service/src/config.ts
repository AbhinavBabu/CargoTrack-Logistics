import dotenv from 'dotenv';
dotenv.config();

if (!process.env.DATABASE_URL) {
  const host = process.env.DATABASE_HOST || 'localhost';
  const port = process.env.DATABASE_PORT || '5432';
  const name = process.env.DATABASE_NAME || 'cargotrack';
  const user = process.env.DATABASE_USER || 'cargotrack';
  const password = process.env.DATABASE_PASSWORD || 'cargotrack123';
  process.env.DATABASE_URL = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}?schema=public`;
}

export const config = {
  port: parseInt(process.env.PORT || '4002', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  serviceName: 'ai-service',

  // AWS
  region: process.env.AWS_DEFAULT_REGION || 'us-east-1',

  // SQS — compliance trigger queue (EventBridge → SQS → this service)
  sqsQueueUrl: process.env.SQS_COMPLIANCE_QUEUE_URL || '',

  // Bedrock — model ID.
  // Amazon Nova models use the Converse API, which is also compatible
  // with Claude models. Switch by changing BEDROCK_MODEL_ID env var only.
  // Supported:
  //   Nova Pro:   amazon.nova-pro-v1:0
  //   Nova Lite:  amazon.nova-lite-v1:0
  //   Claude 3.5: anthropic.claude-3-5-sonnet-20241022-v2:0
  bedrockModelId: process.env.BEDROCK_MODEL_ID || 'amazon.nova-pro-v1:0',

  // S3 — for fetching document files for Textract
  s3Bucket: process.env.S3_BUCKET || '',

  // DynamoDB — audit trail table
  dynamoAuditTable: process.env.DYNAMO_AUDIT_TABLE || 'cargotrack-audit',

  // SQS polling interval (ms) — how long to wait between empty polls
  sqsPollIntervalMs: parseInt(process.env.SQS_POLL_INTERVAL_MS || '5000', 10),

  // Max messages per SQS receive call
  sqsMaxMessages: parseInt(process.env.SQS_MAX_MESSAGES || '5', 10),

  // Whether to skip real Bedrock calls (use mock agent runner).
  // Automatically true if AWS_DEFAULT_REGION is not set.
  mockAgent: process.env.MOCK_AGENT === 'true' || !process.env.AWS_DEFAULT_REGION,

  // Whether to use AWS Textract for document extraction.
  // Requires: AWS_DEFAULT_REGION + S3_BUCKET + valid IAM permissions.
  // When false, falls back to PdfTextExtractor (pdf-parse) or OcrExtractor (tesseract).
  textractEnabled: process.env.TEXTRACT_ENABLED !== 'false' &&
    !!process.env.AWS_DEFAULT_REGION &&
    !!process.env.S3_BUCKET &&
    process.env.MOCK_AGENT !== 'true',

  // Local upload directory — used by PdfTextExtractor and OcrExtractor
  // when documents are stored on the local filesystem (not S3)
  uploadDir: process.env.UPLOAD_DIR || '/uploads',

  // Shared secret for service-to-service /api/compliance/trigger calls.
  // When blank (local dev), the check is skipped.
  // In production set INTERNAL_API_SECRET in both core-service and ai-service.
  internalApiSecret: process.env.INTERNAL_API_SECRET || '',
};

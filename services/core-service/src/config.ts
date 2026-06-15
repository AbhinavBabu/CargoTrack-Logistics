import dotenv from 'dotenv';
import type { SignOptions } from 'jsonwebtoken';
dotenv.config();

// Build DATABASE_URL from individual env vars if not explicitly set.
if (!process.env.DATABASE_URL) {
  const host = process.env.DATABASE_HOST || 'localhost';
  const port = process.env.DATABASE_PORT || '5432';
  const name = process.env.DATABASE_NAME || 'cargotrack';
  const user = process.env.DATABASE_USER || 'cargotrack';
  const password = process.env.DATABASE_PASSWORD || 'cargotrack123';
  process.env.DATABASE_URL = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}?schema=public`;
  console.log(`[core-service][config] DATABASE_URL built (host: ${host}:${port})`);
}

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  jwtSecret: process.env.JWT_SECRET || 'cargotrack-secret-key-change-in-production',
  jwtExpiresIn: (process.env.JWT_EXPIRES_IN || '7d') as SignOptions['expiresIn'],
  uploadDir: process.env.UPLOAD_DIR || '/uploads',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  nodeEnv: process.env.NODE_ENV || 'development',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@cargotrack.com',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  eventBusName: process.env.EVENT_BUS_NAME,
  serviceName: 'core-service',

  // AI service base URL for internal compliance triggers (Docker Compose: http://ai-service:4002)
  aiServiceUrl: process.env.AI_SERVICE_URL || 'http://localhost:4002',

  // Shared secret for service-to-service calls to ai-service
  internalApiSecret: process.env.INTERNAL_API_SECRET || '',

  // SQS compliance queue URL — when set, admin trigger publishes to SQS
  // instead of calling ai-service directly (live AWS mode)
  sqsComplianceQueueUrl: process.env.SQS_COMPLIANCE_QUEUE_URL || '',
};

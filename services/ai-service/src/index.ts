import express from 'express';
import cors from 'cors';
import { config } from './config';
import healthRoutes from './routes/health';
import triggerRoutes from './routes/trigger';
import { complianceHandler } from './handlers/complianceHandler';

const app = express();
app.use(cors());
app.use(express.json());

// Health check — used by Docker healthcheck and future EKS liveness probe
app.use('/api/health', healthRoutes);

// Compliance trigger — internal service-to-service endpoint
// Allows core-service admin panel to start a compliance check directly
// without needing SQS/EventBridge in local dev.
app.use('/api/compliance', triggerRoutes);

// Start the SQS compliance polling loop (non-blocking)
// In mock mode, this is a no-op.
// In live mode, this starts polling the compliance trigger queue.
complianceHandler.start();

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[ai-service] Running on port ${config.port} (${config.nodeEnv})`);
  console.log(`[ai-service] Mode: ${config.mockAgent ? 'mock (no AWS)' : 'live (Bedrock)'}`);
  console.log(`[ai-service] Model: ${config.bedrockModelId}`);
  console.log(`[ai-service] SQS queue: ${config.sqsQueueUrl || '(not configured)'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[ai-service] SIGTERM received — shutting down');
  complianceHandler.stop();
  server.close(() => {
    console.log('[ai-service] Closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[ai-service] SIGINT received — shutting down');
  complianceHandler.stop();
  server.close(() => process.exit(0));
});

export default app;

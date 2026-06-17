import express from 'express';
import cors from 'cors';
import { config } from './config';
import healthRoutes from './routes/health';
import triggerRoutes from './routes/trigger';
import copilotRoutes from './routes/copilot';
import briefingRoutes from './routes/briefing';
import { complianceHandler } from './handlers/complianceHandler';
import KnowledgeBase from './knowledge/knowledge-base';

const app = express();
app.use(cors());
app.use(express.json());

// Initialize logistics intelligence knowledge base at startup
// Loads all 5 catalogs synchronously — fast (files are small JSON, <500KB total)
KnowledgeBase.initialize();

// Health check — used by Docker healthcheck and future EKS liveness probe
app.use('/api/health', healthRoutes);

// Compliance trigger — internal service-to-service endpoint
app.use('/api/compliance', triggerRoutes);

// Copilot — Shipment Intelligence Copilot endpoints (7 capabilities)
app.use('/api/copilot', copilotRoutes);

// Briefing — Route Intelligence Briefing (generated on shipment create)
app.use('/api/briefing', briefingRoutes);


// Start the SQS compliance polling loop (non-blocking)
// In mock mode, this is a no-op.
// In live mode, this starts polling the compliance trigger queue.
complianceHandler.start();

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[ai-service] Running on port ${config.port} (${config.nodeEnv})`);
  console.log(`[ai-service] Compliance runner: ${config.mockAgent ? 'mock' : 'live (Bedrock)'}`);
  console.log(`[ai-service] LLM provider: ${config.llmProvider} / model: ${config.bedrockModelId}`);
  console.log(`[ai-service] SQS queue: ${config.sqsQueueUrl || '(not configured)'}`);
  console.log(`[ai-service] Copilot capabilities: summary, explain-risk, recommendations, ask, similar, timeline`);
  console.log(`[ai-service] Knowledge Base: route-intelligence, dangerous-goods, hs-intelligence, incoterms, sanctions-watch`);
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

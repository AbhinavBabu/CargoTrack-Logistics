import { Router, Request, Response } from 'express';
import { config } from '../config';
import { extractorFactory } from '../services/extractor/factory';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'ai-service',
    version: '3.0.0',
    mode: config.mockAgent ? 'mock' : 'live',
    model: config.bedrockModelId,
    sqsEnabled: Boolean(config.sqsQueueUrl),
    textractEnabled: config.textractEnabled,
    // Shows which extractor backends are currently available
    extractors: extractorFactory.status(),
  });
});

export default router;

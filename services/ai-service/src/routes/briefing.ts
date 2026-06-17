//
// CargoTrack — Route Intelligence Briefing Routes (ai-service)
//
// POST /api/briefing/generate/:shipmentId  — generate & persist a briefing
// GET  /api/briefing/:shipmentId           — retrieve existing briefing
//
// These endpoints are called internally by core-service (not directly by frontend).
// Protected by x-internal-secret header.
//

import { Router, Request, Response } from 'express';
import { agentTools } from '../agent/tools';
import { BriefingEngine } from '../copilot/briefing';
import { config } from '../config';

const router = Router();
const engine = new BriefingEngine(agentTools);

// ─── Internal auth middleware ─────────────────────────────────────────────────

function requireInternalSecret(req: Request, res: Response, next: () => void): void {
  if (config.internalApiSecret) {
    const provided = req.headers['x-internal-secret'];
    if (provided !== config.internalApiSecret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }
  next();
}

// ─── POST /api/briefing/generate/:shipmentId ──────────────────────────────────

router.post('/generate/:shipmentId', requireInternalSecret, async (req: Request, res: Response) => {
  const { shipmentId } = req.params;

  // Respond immediately — briefing runs async (fire-and-forget for fast shipment create response)
  res.status(202).json({ message: 'Briefing generation started', shipmentId });

  // Generate in background — non-blocking
  engine.generateBriefing(shipmentId).catch((err) => {
    console.error(`[briefing-route] Generation failed for ${shipmentId}:`, err);
  });
});

// ─── GET /api/briefing/:shipmentId ───────────────────────────────────────────

router.get('/:shipmentId', requireInternalSecret, async (req: Request, res: Response) => {
  try {
    const briefing = await engine.getBriefing(req.params.shipmentId);
    if (!briefing) {
      res.status(404).json({ error: 'No briefing found for this shipment' });
      return;
    }
    res.json(briefing);
  } catch (err: any) {
    console.error('[briefing-route] GET error:', err);
    res.status(500).json({ error: 'Failed to retrieve briefing' });
  }
});

export default router;

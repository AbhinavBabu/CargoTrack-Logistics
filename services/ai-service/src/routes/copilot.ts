//
// CargoTrack — Copilot Routes (ai-service)
//
// Internal routes consumed by the core-service copilot proxy.
// Protected by INTERNAL_API_SECRET (same as /api/compliance/trigger).
//
// All routes are POST (except /similar which is GET) and respond with
// the typed response from the CopilotEngine.
//
// Route layout:
//   POST /api/copilot/:shipmentId/summary          — Executive summary
//   POST /api/copilot/:shipmentId/explain-risk     — Plain-English risk explanation
//   POST /api/copilot/:shipmentId/recommendations  — Operational action plan
//   POST /api/copilot/:shipmentId/ask              — Stateless Q&A
//   GET  /api/copilot/:shipmentId/similar          — Similar shipment analysis
//   GET  /api/copilot/:shipmentId/timeline         — Timeline narrative
//

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { agentTools } from '../agent/tools';
import { CopilotEngine } from '../copilot/engine';
import { config } from '../config';

const router = Router();
const engine = new CopilotEngine(agentTools);

// ─── Auth ─────────────────────────────────────────────────────────────────────

function checkInternalSecret(req: Request, res: Response): boolean {
  const expectedSecret = config.internalApiSecret;
  if (!expectedSecret) return true; // open in local dev

  const providedSecret = req.headers['x-internal-secret'];
  if (providedSecret !== expectedSecret) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

// ─── POST /api/copilot/:shipmentId/summary ────────────────────────────────────

router.post('/:shipmentId/summary', async (req: Request, res: Response) => {
  if (!checkInternalSecret(req, res)) return;

  try {
    console.log(`[copilot] Executive summary requested — shipment: ${req.params.shipmentId}`);
    const result = await engine.generateExecutiveSummary(req.params.shipmentId);
    res.json(result);
  } catch (err: any) {
    console.error('[copilot] Summary error:', err);
    if (err.message?.includes('not found')) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: 'Failed to generate executive summary', detail: err.message });
    }
  }
});

// ─── POST /api/copilot/:shipmentId/explain-risk ───────────────────────────────

router.post('/:shipmentId/explain-risk', async (req: Request, res: Response) => {
  if (!checkInternalSecret(req, res)) return;

  try {
    console.log(`[copilot] Explain risk requested — shipment: ${req.params.shipmentId}`);
    const result = await engine.explainRisk(req.params.shipmentId);
    res.json(result);
  } catch (err: any) {
    console.error('[copilot] Explain risk error:', err);
    if (err.message?.includes('not found')) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: 'Failed to explain risk', detail: err.message });
    }
  }
});

// ─── POST /api/copilot/:shipmentId/recommendations ───────────────────────────

router.post('/:shipmentId/recommendations', async (req: Request, res: Response) => {
  if (!checkInternalSecret(req, res)) return;

  try {
    console.log(`[copilot] Recommendations requested — shipment: ${req.params.shipmentId}`);
    const result = await engine.getRecommendations(req.params.shipmentId);
    res.json(result);
  } catch (err: any) {
    console.error('[copilot] Recommendations error:', err);
    if (err.message?.includes('not found')) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: 'Failed to generate recommendations', detail: err.message });
    }
  }
});

// ─── POST /api/copilot/:shipmentId/ask ───────────────────────────────────────

const askSchema = z.object({
  question: z.string().min(3).max(500),
});

router.post('/:shipmentId/ask', async (req: Request, res: Response) => {
  if (!checkInternalSecret(req, res)) return;

  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.errors });
    return;
  }

  try {
    console.log(`[copilot] Q&A asked — shipment: ${req.params.shipmentId} — "${parsed.data.question.slice(0, 50)}"`);
    const result = await engine.askQuestion(req.params.shipmentId, parsed.data.question);
    res.json(result);
  } catch (err: any) {
    console.error('[copilot] Q&A error:', err);
    if (err.message?.includes('not found')) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: 'Failed to answer question', detail: err.message });
    }
  }
});

// ─── GET /api/copilot/:shipmentId/similar ────────────────────────────────────

router.get('/:shipmentId/similar', async (req: Request, res: Response) => {
  if (!checkInternalSecret(req, res)) return;

  try {
    console.log(`[copilot] Similar analysis requested — shipment: ${req.params.shipmentId}`);
    const result = await engine.analyzeSimilarShipments(req.params.shipmentId);
    res.json(result);
  } catch (err: any) {
    console.error('[copilot] Similar analysis error:', err);
    if (err.message?.includes('not found')) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: 'Failed to analyze similar shipments', detail: err.message });
    }
  }
});

// ─── GET /api/copilot/:shipmentId/timeline ────────────────────────────────────

router.get('/:shipmentId/timeline', async (req: Request, res: Response) => {
  if (!checkInternalSecret(req, res)) return;

  try {
    console.log(`[copilot] Timeline narrative requested — shipment: ${req.params.shipmentId}`);
    const result = await engine.generateTimelineNarrative(req.params.shipmentId);
    res.json(result);
  } catch (err: any) {
    console.error('[copilot] Timeline error:', err);
    if (err.message?.includes('not found')) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: 'Failed to generate timeline narrative', detail: err.message });
    }
  }
});

export default router;

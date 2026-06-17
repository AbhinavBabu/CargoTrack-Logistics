import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate, requireAdmin } from '../middleware/auth';
import { config } from '../config';

//
// CargoTrack — Copilot Proxy (core-service)
//
// Acts as the authenticated gateway from the frontend to the ai-service copilot.
// All requests are:
//   1. Authenticated via JWT (authenticate + requireAdmin)
//   2. Forwarded to ai-service with the x-internal-secret header
//
// This keeps the ai-service entirely internal (not reachable from the internet).
// The frontend only talks to core-service, which knows the AI service URL.
//

const router = Router();

// ─── Shared proxy helper ──────────────────────────────────────────────────────

async function proxyToAI(
  method: 'GET' | 'POST',
  path: string,
  body: unknown | undefined,
  res: Response,
  label: string,
): Promise<void> {
  const url = `${config.aiServiceUrl}/api/copilot${path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.internalApiSecret) {
    headers['x-internal-secret'] = config.internalApiSecret;
  }

  try {
    const fetchOptions: RequestInit = {
      method,
      headers,
      ...(body !== undefined && method === 'POST'
        ? { body: JSON.stringify(body) }
        : {}),
    };

    // Use global fetch (Node 18+) or fall back to http module pattern
    const aiRes = await fetch(url, fetchOptions);
    const data = await aiRes.json();

    res.status(aiRes.status).json(data);
  } catch (err: any) {
    console.error(`[copilot-proxy] ${label} error:`, err.message);
    res.status(503).json({
      error: 'AI service unavailable',
      detail: err.message,
    });
  }
}

// ─── POST /api/admin/copilot/:shipmentId/summary ──────────────────────────────

/**
 * @swagger
 * /api/admin/copilot/{shipmentId}/summary:
 *   post:
 *     summary: Generate AI executive summary for a shipment (admin)
 *     tags: [Copilot]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shipmentId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Executive summary
 */
router.post(
  '/:shipmentId/summary',
  authenticate,
  requireAdmin,
  async (req: Request, res: Response) => {
    await proxyToAI('POST', `/${req.params.shipmentId}/summary`, {}, res, 'summary');
  }
);

// ─── POST /api/admin/copilot/:shipmentId/explain-risk ─────────────────────────

router.post(
  '/:shipmentId/explain-risk',
  authenticate,
  requireAdmin,
  async (req: Request, res: Response) => {
    await proxyToAI('POST', `/${req.params.shipmentId}/explain-risk`, {}, res, 'explain-risk');
  }
);

// ─── POST /api/admin/copilot/:shipmentId/recommendations ─────────────────────

router.post(
  '/:shipmentId/recommendations',
  authenticate,
  requireAdmin,
  async (req: Request, res: Response) => {
    await proxyToAI('POST', `/${req.params.shipmentId}/recommendations`, {}, res, 'recommendations');
  }
);

// ─── POST /api/admin/copilot/:shipmentId/ask ─────────────────────────────────

const askSchema = z.object({
  question: z.string().min(3).max(500),
});

router.post(
  '/:shipmentId/ask',
  authenticate,
  requireAdmin,
  async (req: Request, res: Response) => {
    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.errors });
      return;
    }
    await proxyToAI('POST', `/${req.params.shipmentId}/ask`, parsed.data, res, 'ask');
  }
);

// ─── GET /api/admin/copilot/:shipmentId/similar ───────────────────────────────

router.get(
  '/:shipmentId/similar',
  authenticate,
  requireAdmin,
  async (req: Request, res: Response) => {
    await proxyToAI('GET', `/${req.params.shipmentId}/similar`, undefined, res, 'similar');
  }
);

// ─── GET /api/admin/copilot/:shipmentId/timeline ─────────────────────────────

router.get(
  '/:shipmentId/timeline',
  authenticate,
  requireAdmin,
  async (req: Request, res: Response) => {
    await proxyToAI('GET', `/${req.params.shipmentId}/timeline`, undefined, res, 'timeline');
  }
);

export default router;

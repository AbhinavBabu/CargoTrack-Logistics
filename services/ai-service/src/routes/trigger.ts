import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { runComplianceAgent } from '../agent/runner';
import { agentTools } from '../agent/tools';
import { ComplianceTriggerMessage } from '../agent/contracts';
import { config } from '../config';

// ─── Compliance Trigger Route ─────────────────────────────────────────────────
//
// POST /api/compliance/trigger
//
// Purpose: Allows the admin panel (core-service) and manual testing to
// directly invoke a compliance check without going through SQS/EventBridge.
//
// This is essential for:
//   1. Local development (no SQS available)
//   2. Manual re-runs from the admin UI
//   3. Integration testing in CI
//
// Security: requires INTERNAL_API_SECRET header matching the shared secret.
// In Docker Compose, both core-service and ai-service share the secret via env.
// In production (EKS), this will be a VPC-internal service-to-service call
// protected by security group rules (no internet exposure).

const router = Router();

const triggerSchema = z.object({
  shipmentId: z.string().uuid(),
  trackingNumber: z.string().min(1),
  newStatus: z.string().min(1),
  triggeredAt: z.string().optional(),
});

// Shared secret check — prevents unauthenticated external callers.
// When INTERNAL_API_SECRET is not set (local dev), the check is skipped.
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

/**
 * POST /api/compliance/trigger
 *
 * Body:
 * {
 *   "shipmentId": "uuid",
 *   "trackingNumber": "CT-2026-123456",
 *   "newStatus": "IN_TRANSIT",
 *   "triggeredAt": "2026-06-15T..."   (optional, defaults to now)
 * }
 *
 * Response:
 * {
 *   "message": "Compliance check started",
 *   "shipmentId": "uuid",
 *   "mode": "mock" | "live"
 * }
 *
 * The check runs asynchronously — the response is returned immediately
 * and the agent runs in the background. Poll GET /api/admin/compliance/:shipmentId
 * on core-service to get the results.
 */
router.post('/trigger', async (req: Request, res: Response) => {
  if (!checkInternalSecret(req, res)) return;

  const parsed = triggerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.errors });
    return;
  }

  const trigger: ComplianceTriggerMessage = {
    shipmentId: parsed.data.shipmentId,
    trackingNumber: parsed.data.trackingNumber,
    newStatus: parsed.data.newStatus,
    triggeredAt: parsed.data.triggeredAt ?? new Date().toISOString(),
  };

  console.log(`[trigger] Compliance check requested — shipment: ${trigger.shipmentId}, status: ${trigger.newStatus}`);

  // Respond immediately — the agent runs in the background
  res.json({
    message: 'Compliance check started',
    shipmentId: trigger.shipmentId,
    mode: config.mockAgent ? 'mock' : 'live',
  });

  // Run agent asynchronously (non-blocking)
  setImmediate(async () => {
    try {
      await runComplianceAgent(trigger, agentTools);
      console.log(`[trigger] Compliance check complete — shipment: ${trigger.shipmentId}`);
    } catch (err) {
      console.error(`[trigger] Compliance check failed — shipment: ${trigger.shipmentId}:`, err);
    }
  });
});

export default router;

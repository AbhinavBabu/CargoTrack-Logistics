import { Router, Request, Response } from 'express';
import { PrismaClient, ShipmentStatus } from '@prisma/client';
import { z } from 'zod';
import { authenticate, requireAdmin } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { notificationProvider } from '../providers/notification';
import { eventPublisher } from '../providers/event';
import { config } from '../config';

const prisma = new PrismaClient();
const router = Router();

const updateStatusSchema = z.object({
  status: z.nativeEnum(ShipmentStatus),
  location: z.string().optional(),
  description: z.string().optional(),
});

// ─── Internal AI service proxy helper ─────────────────────────────────────────

async function proxyToAIInternal(
  method: 'GET' | 'POST',
  path: string,
  body: unknown | undefined,
  res: Response,
  label: string,
): Promise<void> {
  const url = `${config.aiServiceUrl}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.internalApiSecret) headers['x-internal-secret'] = config.internalApiSecret;

  try {
    const aiRes = await fetch(url, {
      method,
      headers,
      ...(body !== undefined && method === 'POST' ? { body: JSON.stringify(body) } : {}),
    });
    const data = await aiRes.json();
    res.status(aiRes.status).json(data);
  } catch (err: any) {
    console.error(`[admin-proxy] ${label} error:`, err.message);
    res.status(503).json({ error: 'AI service unavailable', detail: err.message });
  }
}

// ─── GET /api/admin/briefing/:shipmentId ─────────────────────────────────────

router.get('/briefing/:shipmentId', authenticate, requireAdmin, async (req: Request, res: Response) => {
  await proxyToAIInternal('GET', `/api/briefing/${req.params.shipmentId}`, undefined, res, 'briefing');
});

// ─── POST /api/admin/briefing/generate/:shipmentId ────────────────────────────

router.post('/briefing/generate/:shipmentId', authenticate, requireAdmin, async (req: Request, res: Response) => {
  await proxyToAIInternal('POST', `/api/briefing/generate/${req.params.shipmentId}`, {}, res, 'briefing-generate');
});

// ─── GET /api/admin/stats ─────────────────────────────────────────────────────
/**
 * @swagger
 * /api/admin/stats:
 *   get:
 *     summary: Platform-wide shipment statistics + risk distribution (admin)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Aggregate counts by status + risk distribution
 */
router.get('/stats', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const [total, byStatus, totalDocuments, recentShipments, riskCounts] = await Promise.all([
      prisma.shipment.count(),
      prisma.shipment.groupBy({ by: ['status'], _count: { id: true } }),
      prisma.shipmentDocument.count(),
      prisma.shipment.count({ where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } }),
      // Risk distribution — count shipments by AI risk level
      prisma.shipment.groupBy({ by: ['aiRiskLevel'], _count: { id: true } }),
    ]);

    const statusCounts = Object.fromEntries(Object.values(ShipmentStatus).map((s) => [s, 0]));
    for (const row of byStatus) statusCounts[row.status] = row._count.id;

    // Build risk distribution map
    const riskMap: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNASSESSED: 0 };
    for (const row of riskCounts) {
      const level = row.aiRiskLevel ?? 'UNASSESSED';
      riskMap[level] = (riskMap[level] || 0) + row._count.id;
    }

    res.json({
      total,
      totalDocuments,
      recentShipments,
      byStatus: statusCounts,
      // vNext: Risk intelligence distribution
      riskDistribution: riskMap,
      criticalCount: riskMap.CRITICAL,
      highCount: riskMap.HIGH,
      mediumCount: riskMap.MEDIUM,
      clearCount: riskMap.LOW,
      unassessedCount: riskMap.UNASSESSED,
    });
  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});


// ─── GET /api/admin/shipments ─────────────────────────────────────────────────
/**
 * @swagger
 * /api/admin/shipments:
 *   get:
 *     summary: List all shipments (admin)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of all shipments
 */
router.get('/shipments', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const status = req.query.status as ShipmentStatus | undefined;
    const search = req.query.search as string | undefined;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { trackingNumber: { contains: search, mode: 'insensitive' } },
        { title: { contains: search, mode: 'insensitive' } },
        { senderName: { contains: search, mode: 'insensitive' } },
        { receiverName: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [shipments, total] = await Promise.all([
      prisma.shipment.findMany({
        where,
        skip,
        take: limit,
        orderBy: [
          // Sort by risk level severity first (CRITICAL first), then by date
          { aiRiskLevel: 'desc' },
          { createdAt: 'desc' },
        ],
        include: {
          user: { select: { id: true, name: true, email: true } },
          trackingEvents: { orderBy: { timestamp: 'desc' }, take: 1 },
          complianceReport: {
            select: {
              status: true,
              riskLevel: true,
              overallRiskScore: true,
              executiveSummary: true,
              recommendedDisposition: true,
              modelId: true,
              updatedAt: true,
            },
          },
          aiBriefing: {
            select: {
              corridor: true,
              riskSummary: true,
              customsComplexity: true,
              sanctionsStatus: true,
              delayProbability: true,
              generatedAt: true,
            },
          },
          _count: { select: { documents: true } },
        },
      }),
      prisma.shipment.count({ where }),
    ]);

    res.json({
      data: shipments,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });

  } catch (error) {
    console.error('Admin list shipments error:', error);
    res.status(500).json({ error: 'Failed to fetch shipments' });
  }
});

// ─── PUT /api/admin/shipments/:id/status ──────────────────────────────────────
/**
 * @swagger
 * /api/admin/shipments/{id}/status:
 *   put:
 *     summary: Update shipment status (admin)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string }
 *               location: { type: string }
 *               description: { type: string }
 *     responses:
 *       200:
 *         description: Status updated
 */
router.put('/shipments/:id/status', authenticate, requireAdmin, validate(updateStatusSchema), async (req: Request, res: Response) => {
  try {
    const { status, location, description } = req.body;

    const shipment = await prisma.shipment.findUnique({ where: { id: req.params.id } });
    if (!shipment) {
      res.status(404).json({ error: 'Shipment not found' });
      return;
    }

    const updated = await prisma.shipment.update({
      where: { id: req.params.id },
      data: { status },
    });

    await prisma.trackingEvent.create({
      data: {
        shipmentId: shipment.id,
        status,
        location: location || null,
        description: description || `Shipment status updated to ${status}`,
      },
    });

    // Notify shipment owner
    await notificationProvider.send(
      shipment.userId,
      'Shipment Status Updated',
      `Your shipment ${shipment.trackingNumber} status has been updated to ${status}.`
    );

    if (status === ShipmentStatus.DELIVERED) {
      await notificationProvider.send(
        shipment.userId,
        'Shipment Delivered',
        `Your shipment ${shipment.trackingNumber} has been delivered successfully!`
      );
    }

    // Publish status_updated event to EventBridge.
    // The Terraform EventBridge rule routes this to the compliance SQS queue
    // when status is IN_TRANSIT or DELIVERED.
    await eventPublisher.publish('shipment.status_updated', {
      shipmentId: shipment.id,
      trackingNumber: shipment.trackingNumber,
      oldStatus: shipment.status,
      newStatus: status,
    });

    // Auto-trigger compliance check for statuses that indicate
    // documents should have been uploaded by now.
    // Non-blocking: fire-and-forget. Status update response is returned first.
    const COMPLIANCE_TRIGGER_STATUSES: ShipmentStatus[] = [
      ShipmentStatus.IN_TRANSIT,
      ShipmentStatus.DELIVERED,
    ];
    if (COMPLIANCE_TRIGGER_STATUSES.includes(status as ShipmentStatus)) {
      triggerComplianceCheck(shipment.id, shipment.trackingNumber, status).catch((err) =>
        console.error(`[admin] Failed to trigger compliance for ${shipment.id}:`, err)
      );
    }

    res.json(updated);
  } catch (error) {
    console.error('Admin update status error:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ─── Internal: Compliance Trigger ────────────────────────────────────────────
// Non-blocking helper — fires and forgets the compliance agent invocation.
// Two modes:
//   LOCAL (no SQS_COMPLIANCE_QUEUE_URL): calls ai-service HTTP trigger directly
//   LIVE  (SQS_COMPLIANCE_QUEUE_URL set): publishes message to SQS queue

async function triggerComplianceCheck(
  shipmentId: string,
  trackingNumber: string,
  newStatus: string
): Promise<void> {
  const payload = {
    shipmentId,
    trackingNumber,
    newStatus,
    triggeredAt: new Date().toISOString(),
  };

  if (config.sqsComplianceQueueUrl) {
    // Live AWS mode: publish directly to SQS compliance queue
    // (ai-service SQS consumer will pick this up)
    const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');
    const sqs = new SQSClient({ region: process.env.AWS_DEFAULT_REGION || 'us-east-1' });
    await sqs.send(new SendMessageCommand({
      QueueUrl: config.sqsComplianceQueueUrl,
      MessageBody: JSON.stringify(payload),
    }));
    console.log(`[admin] Compliance trigger published to SQS — shipment: ${shipmentId}`);
  } else {
    // Local Docker mode: call ai-service HTTP trigger directly
    const url = `${config.aiServiceUrl}/api/compliance/trigger`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.internalApiSecret) {
      headers['x-internal-secret'] = config.internalApiSecret;
    }
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ai-service trigger failed (${response.status}): ${text}`);
    }
    console.log(`[admin] Compliance trigger sent to ai-service — shipment: ${shipmentId}`);
  }
}

// ─── GET /api/admin/documents ─────────────────────────────────────────────────
// NEW: Platform-wide document listing for admin.
// Allows admin to see all documents across all shipments — not just one shipment.
/**
 * @swagger
 * /api/admin/documents:
 *   get:
 *     summary: List all documents across all shipments (admin)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: documentType
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated list of all documents
 */
router.get('/documents', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const documentType = req.query.documentType as string | undefined;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (documentType) where.documentType = documentType;

    const [documents, total] = await Promise.all([
      prisma.shipmentDocument.findMany({
        where,
        skip,
        take: limit,
        orderBy: { uploadedAt: 'desc' },
        include: {
          shipment: {
            select: {
              id: true,
              trackingNumber: true,
              title: true,
              status: true,
              user: { select: { name: true, email: true } },
            },
          },
        },
      }),
      prisma.shipmentDocument.count({ where }),
    ]);

    res.json({
      data: documents,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Admin list all documents error:', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// ─── GET /api/admin/documents/:shipmentId ─────────────────────────────────────
/**
 * @swagger
 * /api/admin/documents/{shipmentId}:
 *   get:
 *     summary: View documents for a specific shipment (admin)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shipmentId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of documents for the shipment
 */
router.get('/documents/:shipmentId', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const documents = await prisma.shipmentDocument.findMany({
      where: { shipmentId: req.params.shipmentId },
      orderBy: { uploadedAt: 'desc' },
    });

    res.json(documents);
  } catch (error) {
    console.error('Admin view documents error:', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// ─── GET /api/admin/compliance/:shipmentId ────────────────────────────────────
// NEW: Returns the compliance report and all findings for a shipment.
// AI service writes here; admin UI reads from here.
/**
 * @swagger
 * /api/admin/compliance/{shipmentId}:
 *   get:
 *     summary: Get compliance report for a shipment (admin)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shipmentId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Compliance report with findings
 */
router.get('/compliance/:shipmentId', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const report = await prisma.complianceReport.findUnique({
      where: { shipmentId: req.params.shipmentId },
      include: {
        // Order CRITICAL → HIGH → MEDIUM → LOW
        findings: {
          orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });

    if (!report) {
      res.status(404).json({ error: 'No compliance report found for this shipment' });
      return;
    }

    // Explicit response shape — includes all v3.1 risk intelligence fields
    res.json({
      id: report.id,
      shipmentId: report.shipmentId,
      status: report.status,
      agentRunId: report.agentRunId,
      // Legacy summary (backward compat)
      summary: report.summary,
      // v3.1: Risk Intelligence fields
      overallRiskScore: report.overallRiskScore,
      riskLevel: report.riskLevel,
      executiveSummary: report.executiveSummary,
      recommendedDisposition: report.recommendedDisposition,
      modelId: report.modelId,
      modelConfidence: report.modelConfidence,
      processingTimeMs: report.processingTimeMs,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
      findings: report.findings.map((f) => ({
        id: f.id,
        findingType: f.findingType,
        severity: f.severity,
        description: f.description,
        // v3.1: Risk Intelligence fields
        evidence: f.evidence,
        reasoning: f.reasoning,
        confidenceScore: f.confidenceScore,
        recommendedAction: f.recommendedAction,
        documentId: f.documentId,
        detail: f.detail,
        resolvedAt: f.resolvedAt,
        createdAt: f.createdAt,
      })),
    });
  } catch (error) {
    console.error('Admin compliance report error:', error);
    res.status(500).json({ error: 'Failed to fetch compliance report' });
  }
});

// ─── POST /api/admin/compliance/trigger/:shipmentId ──────────────────────────
// Manual compliance trigger for the admin UI.
// Allows re-running the compliance agent for any shipment on demand.
/**
 * @swagger
 * /api/admin/compliance/trigger/{shipmentId}:
 *   post:
 *     summary: Manually trigger compliance check for a shipment (admin)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shipmentId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       202:
 *         description: Compliance check started
 */
router.post('/compliance/trigger/:shipmentId', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const shipment = await prisma.shipment.findUnique({
      where: { id: req.params.shipmentId },
      select: { id: true, trackingNumber: true, status: true },
    });

    if (!shipment) {
      res.status(404).json({ error: 'Shipment not found' });
      return;
    }

    // Non-blocking — respond immediately, run agent in background
    res.status(202).json({
      message: 'Compliance check triggered',
      shipmentId: shipment.id,
    });

    triggerComplianceCheck(
      shipment.id,
      shipment.trackingNumber,
      shipment.status
    ).catch((err) =>
      console.error(`[admin] Manual compliance trigger failed for ${shipment.id}:`, err)
    );
  } catch (error) {
    console.error('Admin compliance trigger error:', error);
    res.status(500).json({ error: 'Failed to trigger compliance check' });
  }
});

export default router;

import { Router, Request, Response } from 'express';
import { PrismaClient, ShipmentStatus } from '@prisma/client';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { notificationProvider } from '../providers/notification';
import { eventPublisher } from '../providers/event';
import { config } from '../config';

const prisma = new PrismaClient();
const router = Router();

function generateTrackingNumber(): string {
  const year = new Date().getFullYear();
  const random = Math.floor(100000 + Math.random() * 900000);
  return `CT-${year}-${random}`;
}

// ─── Internal call helper ──────────────────────────────────────────────────────
// Reuse across briefing + compliance triggers from the shipment create path.

async function callAiService(path: string, method: 'POST' | 'GET' = 'POST', body?: unknown): Promise<void> {
  const url = `${config.aiServiceUrl}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.internalApiSecret) headers['x-internal-secret'] = config.internalApiSecret;

  const res = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ai-service ${path} failed (${res.status}): ${text}`);
  }
}

const createShipmentSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  senderName: z.string().min(1, 'Sender name is required'),
  receiverName: z.string().min(1, 'Receiver name is required'),
  origin: z.string().min(1, 'Origin is required'),
  destination: z.string().min(1, 'Destination is required'),
  shipmentType: z.string().min(1, 'Shipment type is required'),
  weight: z.number().positive('Weight must be positive'),
  description: z.string().optional(),
  estimatedDeliveryDate: z.string().optional(),
  // ── vNext: extended intelligence fields ────────────────────────────────────
  carrierName: z.string().optional(),
  commodityType: z.string().optional(),
  hsCodeHint: z.string().optional(),
  isDangerousGoods: z.boolean().optional().default(false),
  dangerousGoodsClass: z.string().optional(),
  incoterms: z.string().optional(),
  declaredValue: z.number().positive().optional(),
  currencyCode: z.string().optional().default('USD'),
});

const updateShipmentSchema = z.object({
  title: z.string().min(1).optional(),
  senderName: z.string().min(1).optional(),
  receiverName: z.string().min(1).optional(),
  origin: z.string().min(1).optional(),
  destination: z.string().min(1).optional(),
  shipmentType: z.string().min(1).optional(),
  weight: z.number().positive().optional(),
  description: z.string().optional(),
  estimatedDeliveryDate: z.string().optional(),
  carrierName: z.string().optional(),
  commodityType: z.string().optional(),
  incoterms: z.string().optional(),
  declaredValue: z.number().positive().optional(),
});

/**
 * @swagger
 * /api/shipments:
 *   get:
 *     summary: List user's shipments
 *     tags: [Shipments]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of shipments
 */
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const status = req.query.status as ShipmentStatus | undefined;
    const search = req.query.search as string | undefined;
    const skip = (page - 1) * limit;

    const where: any = { userId: req.user!.userId };
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
        orderBy: { createdAt: 'desc' },
        include: {
          trackingEvents: { orderBy: { timestamp: 'desc' }, take: 1 },
          complianceReport: { select: { status: true, riskLevel: true, overallRiskScore: true } },
          aiBriefing: { select: { sanctionsStatus: true, customsComplexity: true, delayProbability: true } },
        },
      }),
      prisma.shipment.count({ where }),
    ]);

    res.json({
      data: shipments,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('List shipments error:', error);
    res.status(500).json({ error: 'Failed to fetch shipments' });
  }
});

/**
 * @swagger
 * /api/shipments:
 *   post:
 *     summary: Create a new shipment (auto-triggers AI briefing + compliance)
 *     tags: [Shipments]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Shipment created
 */
router.post('/', authenticate, validate(createShipmentSchema), async (req: Request, res: Response) => {
  try {
    const trackingNumber = generateTrackingNumber();
    const {
      title, senderName, receiverName, origin, destination, shipmentType,
      weight, description, estimatedDeliveryDate,
      carrierName, commodityType, hsCodeHint, isDangerousGoods, dangerousGoodsClass,
      incoterms, declaredValue, currencyCode,
    } = req.body;

    const shipment = await prisma.shipment.create({
      data: {
        trackingNumber,
        userId: req.user!.userId,
        title,
        senderName,
        receiverName,
        origin,
        destination,
        shipmentType,
        weight: parseFloat(weight),
        description: description || null,
        estimatedDeliveryDate: estimatedDeliveryDate ? new Date(estimatedDeliveryDate) : null,
        // vNext fields
        carrierName: carrierName || null,
        commodityType: commodityType || null,
        hsCodeHint: hsCodeHint || null,
        isDangerousGoods: isDangerousGoods || false,
        dangerousGoodsClass: dangerousGoodsClass || null,
        incoterms: incoterms || null,
        declaredValue: declaredValue || null,
        currencyCode: currencyCode || 'USD',
      },
    });

    // Create initial tracking event
    await prisma.trackingEvent.create({
      data: {
        shipmentId: shipment.id,
        status: ShipmentStatus.CREATED,
        description: 'Shipment created — AI route intelligence briefing initiated',
        location: origin,
      },
    });

    // Respond immediately — don't block on AI calls
    res.status(201).json(shipment);

    // ── Fire-and-forget: Route Intelligence Briefing (fast, ~3s) ────────────
    callAiService(`/api/briefing/generate/${shipment.id}`)
      .catch((err) => console.error(`[shipments] Briefing trigger failed for ${shipment.id}:`, err));

    // ── Fire-and-forget: Initial Compliance Assessment ───────────────────────
    // Run immediately on create — no documents yet, but Nova assesses route
    // risk, DG risk from cargo type, and produces a preliminary briefing.
    callAiService('/api/compliance/trigger', 'POST', {
      shipmentId: shipment.id,
      trackingNumber,
      newStatus: ShipmentStatus.CREATED,
      triggeredAt: new Date().toISOString(),
    }).catch((err) => console.error(`[shipments] Initial compliance trigger failed for ${shipment.id}:`, err));

    // Notify + publish event (also fire-and-forget after response)
    notificationProvider.send(
      req.user!.userId,
      'Shipment Created',
      `Your shipment ${trackingNumber} has been created. AI is analyzing the route now.`
    ).catch(() => {});
    eventPublisher.publish('shipment.created', { trackingNumber, shipmentId: shipment.id }).catch(() => {});

  } catch (error) {
    console.error('Create shipment error:', error);
    res.status(500).json({ error: 'Failed to create shipment' });
  }
});


/**
 * @swagger
 * /api/shipments/{id}:
 *   get:
 *     summary: Get shipment details
 *     tags: [Shipments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Shipment details
 */
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const shipment = await prisma.shipment.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      include: {
        trackingEvents: { orderBy: { timestamp: 'asc' } },
        documents: true,
      },
    });

    if (!shipment) {
      res.status(404).json({ error: 'Shipment not found' });
      return;
    }

    res.json(shipment);
  } catch (error) {
    console.error('Get shipment error:', error);
    res.status(500).json({ error: 'Failed to fetch shipment' });
  }
});

/**
 * @swagger
 * /api/shipments/{id}:
 *   put:
 *     summary: Update a shipment
 *     tags: [Shipments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Shipment updated
 */
router.put('/:id', authenticate, validate(updateShipmentSchema), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.shipment.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });

    if (!existing) {
      res.status(404).json({ error: 'Shipment not found' });
      return;
    }

    if (existing.status === ShipmentStatus.DELIVERED || existing.status === ShipmentStatus.CANCELLED) {
      res.status(400).json({ error: 'Cannot update a delivered or cancelled shipment' });
      return;
    }

    const data: any = { ...req.body };
    if (data.weight) data.weight = parseFloat(data.weight);
    if (data.estimatedDeliveryDate) data.estimatedDeliveryDate = new Date(data.estimatedDeliveryDate);

    const shipment = await prisma.shipment.update({
      where: { id: req.params.id },
      data,
    });

    res.json(shipment);
  } catch (error) {
    console.error('Update shipment error:', error);
    res.status(500).json({ error: 'Failed to update shipment' });
  }
});

/**
 * @swagger
 * /api/shipments/{id}:
 *   delete:
 *     summary: Cancel a shipment
 *     tags: [Shipments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Shipment cancelled
 */
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const existing = await prisma.shipment.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });

    if (!existing) {
      res.status(404).json({ error: 'Shipment not found' });
      return;
    }

    if (existing.status === ShipmentStatus.DELIVERED) {
      res.status(400).json({ error: 'Cannot cancel a delivered shipment' });
      return;
    }

    const shipment = await prisma.shipment.update({
      where: { id: req.params.id },
      data: { status: ShipmentStatus.CANCELLED },
    });

    await prisma.trackingEvent.create({
      data: {
        shipmentId: shipment.id,
        status: ShipmentStatus.CANCELLED,
        description: 'Shipment has been cancelled',
      },
    });

    await notificationProvider.send(
      req.user!.userId,
      'Shipment Cancelled',
      `Your shipment ${shipment.trackingNumber} has been cancelled.`
    );

    await eventPublisher.publish('shipment.cancelled', { trackingNumber: shipment.trackingNumber });

    res.json(shipment);
  } catch (error) {
    console.error('Cancel shipment error:', error);
    res.status(500).json({ error: 'Failed to cancel shipment' });
  }
});

export default router;

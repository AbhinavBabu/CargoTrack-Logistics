//
// CargoTrack Risk Intelligence Agent — Tool Implementations
//
// This module implements AgentDataAccess — the concrete tools that the
// Shipment Risk Intelligence Agent calls during its analysis.
//
// v3.1: Redesigned for Shipment Risk Intelligence Engine.
//   - extractDocumentText() returns raw text for LLM reasoning
//   - createFinding() stores evidence, reasoning, confidence, recommendedAction
//   - finalizeReport() stores overallRiskScore, riskLevel, executiveSummary, disposition
//   - getRouteRiskContext() provides corridor-specific risk intelligence
//

import { PrismaClient } from '@prisma/client';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { config } from '../config';
import {
  AgentDataAccess,
  ShipmentRecord,
  DocumentRecord,
  ExtractedDocumentText,
  RouteRiskContext,
  CreateFindingInput,
  CreateReportInput,
  FinalizeReportInput,
  AuditEventInput,
} from './contracts';
import { extractorFactory } from '../services/extractor/factory';

// ─── DynamoDB client (optional audit trail) ───────────────────────────────────

const dynamo = config.region
  ? new DynamoDBClient({ region: config.region })
  : null;

// ─── Pre-computed route risk context ─────────────────────────────────────────
// Used by get_route_risk_context tool. This is deterministic context that
// helps Nova calibrate its risk assessment without needing to infer it.
// Nova applies judgment on top of this context.

interface RouteRiskEntry {
  patterns: { origin: string[]; destination: string[] };
  regulatoryNotes: string;
  commonFindings: string[];
  sanctionsStatus: 'CLEAR' | 'WATCH' | 'BLOCKED';
  riskMultiplier: number;
}

const ROUTE_RISK_DATA: RouteRiskEntry[] = [
  {
    patterns: { origin: ['US', 'USA', 'United States'], destination: ['DE', 'Germany', 'Hamburg', 'Berlin'] },
    regulatoryNotes:
      'US–Germany is a high-volume transatlantic corridor under EU Customs Union rules. ' +
      'Electronics require CE marking for EU market entry. Dual-use goods (encryption, ' +
      'RF equipment) may require export authorization under EAR. Customs declarations ' +
      'must use EU Harmonized System codes. German customs (Zoll) average clearance ' +
      'time: 1–3 business days for standard shipments.',
    commonFindings: [
      'HS code mismatch between invoice goods description and customs declaration',
      'Missing CE marking declaration for electronics',
      'Dual-use item classification check required',
      'Consignee EORI number not present on commercial invoice',
    ],
    sanctionsStatus: 'CLEAR',
    riskMultiplier: 1.0,
  },
  {
    patterns: { origin: ['CN', 'China', 'Shenzhen', 'Shanghai', 'Guangzhou'], destination: ['US', 'USA', 'United States'] },
    regulatoryNotes:
      'China–US corridor is subject to heightened customs scrutiny under Section 301 tariffs. ' +
      'Many electronics and machinery categories carry additional 7.5%–25% tariff surcharges. ' +
      'ISF (Importer Security Filing) must be submitted 24 hours before cargo loading. ' +
      'CBP random examination rates are elevated for this corridor.',
    commonFindings: [
      'Section 301 tariff applicability not assessed',
      'ISF filing timestamp verification required',
      'Undervaluation risk — declared value vs. market price discrepancy',
      'Country of origin marking (Made in China) requirement on goods and packaging',
    ],
    sanctionsStatus: 'WATCH',
    riskMultiplier: 1.4,
  },
  {
    patterns: { origin: ['AE', 'UAE', 'Dubai', 'Abu Dhabi'], destination: ['US', 'USA', 'United States', 'EU', 'Europe'] },
    regulatoryNotes:
      'UAE is a significant transshipment hub. Goods originating outside UAE but ' +
      'transshipping through Dubai require careful origin documentation. ' +
      'Sanctions screening for Iranian-origin goods is mandatory for all UAE transshipments.',
    commonFindings: [
      'Transshipment origin documentation incomplete',
      'Iranian origin goods screening required',
      'Certificate of origin must specify manufacturing country not transshipment hub',
    ],
    sanctionsStatus: 'WATCH',
    riskMultiplier: 1.3,
  },
  {
    patterns: { origin: ['RU', 'Russia', 'Moscow'], destination: [] },
    regulatoryNotes:
      'Russia is subject to comprehensive export controls and sanctions (OFAC, EU, UK). ' +
      'The vast majority of dual-use goods, electronics, and technology exports to Russia ' +
      'are prohibited. Verify all parties against OFAC SDN list.',
    commonFindings: [
      'OFAC SDN screening required for all parties',
      'Export Control Classification Number (ECCN) assessment mandatory',
      'Financial transaction sanctions risk assessment required',
    ],
    sanctionsStatus: 'BLOCKED',
    riskMultiplier: 2.5,
  },
];

const DEFAULT_ROUTE_CONTEXT: RouteRiskContext = {
  corridor: 'GENERAL',
  regulatoryNotes:
    'Standard international shipping corridor. Verify all parties against sanctions lists. ' +
    'Ensure HS codes, declared values, and goods descriptions are consistent across all documents. ' +
    'Check import/export license requirements for the specific goods category.',
  commonFindings: [
    'Document consistency check (invoice, B/L, customs declaration)',
    'Sanctions screening for all named parties',
    'HS code validation against goods description',
  ],
  sanctionsStatus: 'CLEAR',
  riskMultiplier: 1.0,
};

function matchesPattern(value: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const normalized = value.toLowerCase();
  return patterns.some((p) => normalized.includes(p.toLowerCase()));
}

// ─── Tool implementation class ────────────────────────────────────────────────

export class AgentTools implements AgentDataAccess {
  constructor(private prisma: PrismaClient) {}

  // ─── get_shipment_profile ─────────────────────────────────────────────────

  async getShipment(shipmentId: string): Promise<ShipmentRecord | null> {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
    });

    if (!shipment) return null;

    return {
      id: shipment.id,
      trackingNumber: shipment.trackingNumber,
      senderName: shipment.senderName,
      receiverName: shipment.receiverName,
      origin: shipment.origin,
      destination: shipment.destination,
      shipmentType: shipment.shipmentType,
      carrierName: shipment.carrierName ?? null,
      weight: shipment.weight,
      status: shipment.status,
      description: shipment.description ?? null,
      // ── vNext: Extended intelligence fields ─────────────────────────────────
      commodityType: shipment.commodityType ?? null,
      hsCodeHint: shipment.hsCodeHint ?? null,
      isDangerousGoods: shipment.isDangerousGoods,
      dangerousGoodsClass: shipment.dangerousGoodsClass ?? null,
      incoterms: shipment.incoterms ?? null,
      declaredValue: shipment.declaredValue ?? null,
      currencyCode: shipment.currencyCode ?? null,
    };
  }

  // ─── get_uploaded_documents ───────────────────────────────────────────────

  async getDocuments(shipmentId: string): Promise<DocumentRecord[]> {
    const docs = await this.prisma.shipmentDocument.findMany({
      where: { shipmentId },
      orderBy: { uploadedAt: 'asc' },
    });

    return docs.map((d) => ({
      id: d.id,
      originalName: d.originalName,
      fileName: d.fileName,
      documentType: d.documentType,
      fileType: d.fileType,
      fileSize: d.fileSize,
      uploadedAt: d.uploadedAt,
    }));
  }

  // ─── extract_document_text ────────────────────────────────────────────────
  //
  // v3.1: Returns raw document text for LLM analysis.
  // The extractor chain (Textract → pdf-parse → tesseract → mock) extracts
  // readable text. The LLM then reasons over the full text content.
  //
  // This is the core change from v3.0: we no longer pre-parse fields.
  // Nova reads the document as a human analyst would.

  async extractDocumentText(doc: DocumentRecord): Promise<ExtractedDocumentText> {
    const result = await extractorFactory.extract(doc);
    console.log(
      `[AgentTools] Extracted text via ${result.extractionMethod}: ` +
      `${result.rawText.length} chars, confidence: ${result.confidence.toFixed(2)}`
    );
    return result;
  }

  // ─── get_route_risk_context ───────────────────────────────────────────────
  //
  // Returns pre-computed risk context for the shipping corridor.
  // This is deterministic data — not LLM-generated. It gives Nova the
  // regulatory background to calibrate its risk assessment.

  getRouteRiskContext(origin: string, destination: string, _cargoType: string): RouteRiskContext {
    for (const entry of ROUTE_RISK_DATA) {
      const originMatch = matchesPattern(origin, entry.patterns.origin);
      const destMatch =
        entry.patterns.destination.length === 0 || matchesPattern(destination, entry.patterns.destination);

      if (originMatch && destMatch) {
        const corridor = `${origin} → ${destination}`;
        console.log(`[AgentTools] Route risk context matched: ${corridor} (multiplier: ${entry.riskMultiplier})`);
        return {
          corridor,
          regulatoryNotes: entry.regulatoryNotes,
          commonFindings: entry.commonFindings,
          sanctionsStatus: entry.sanctionsStatus,
          riskMultiplier: entry.riskMultiplier,
        };
      }
    }

    const corridor = `${origin} → ${destination}`;
    console.log(`[AgentTools] No specific route context for ${corridor} — using defaults`);
    return { ...DEFAULT_ROUTE_CONTEXT, corridor };
  }

  // ─── record_risk_finding ──────────────────────────────────────────────────

  async createFinding(input: CreateFindingInput): Promise<{ id: string }> {
    const finding = await this.prisma.complianceFinding.create({
      data: {
        reportId: input.reportId,
        documentId: input.documentId ?? null,
        findingType: input.findingType,
        severity: input.severity,
        description: input.description,
        detail: input.detail as any ?? null,
        // v3.1: Risk intelligence fields
        evidence: input.evidence ?? null,
        reasoning: input.reasoning ?? null,
        confidenceScore: input.confidenceScore ?? null,
        recommendedAction: input.recommendedAction ?? null,
      },
    });

    console.log(`[AgentTools] Created finding: ${input.findingType} / ${input.severity} (id: ${finding.id})`);
    return { id: finding.id };
  }

  // ─── create_compliance_report ─────────────────────────────────────────────

  async createReport(input: CreateReportInput): Promise<{ id: string }> {
    // Upsert: if a report already exists for this shipment, update it
    const report = await this.prisma.complianceReport.upsert({
      where: { shipmentId: input.shipmentId },
      create: {
        shipmentId: input.shipmentId,
        agentRunId: input.agentRunId,
        status: 'PENDING',
      },
      update: {
        agentRunId: input.agentRunId,
        status: 'PENDING',
        summary: null,
        executiveSummary: null,
        overallRiskScore: null,
        riskLevel: null,
        recommendedDisposition: null,
        modelConfidence: null,
      },
    });

    // Delete any stale findings from a previous run
    await this.prisma.complianceFinding.deleteMany({
      where: { reportId: report.id },
    });

    console.log(`[AgentTools] Created/reset report for shipment ${input.shipmentId} (id: ${report.id})`);
    return { id: report.id };
  }

  // ─── finalize_risk_assessment ─────────────────────────────────────────────

  async finalizeReport(input: FinalizeReportInput): Promise<void> {
    await this.prisma.complianceReport.update({
      where: { id: input.reportId },
      data: {
        status: input.status,
        summary: input.summary,
        // v3.1: Risk intelligence output
        executiveSummary: input.executiveSummary ?? null,
        overallRiskScore: input.overallRiskScore ?? null,
        riskLevel: input.riskLevel ?? null,
        recommendedDisposition: input.recommendedDisposition ?? null,
        modelId: input.modelId ?? null,
        modelConfidence: input.modelConfidence ?? null,
        processingTimeMs: input.processingTimeMs ?? null,
      },
    });

    console.log(
      `[AgentTools] Finalized report ${input.reportId}: ` +
      `status=${input.status}, riskLevel=${input.riskLevel ?? 'N/A'}, ` +
      `riskScore=${input.overallRiskScore?.toFixed(2) ?? 'N/A'}`
    );

    // ── Write-back: replicate risk score/level to Shipment for fast list queries ──
    // This avoids a JOIN to ComplianceReport every time we list shipments.
    if (input.overallRiskScore !== undefined || input.riskLevel !== undefined) {
      try {
        const report = await this.prisma.complianceReport.findUnique({
          where: { id: input.reportId },
          select: { shipmentId: true },
        });
        if (report) {
          await this.prisma.shipment.update({
            where: { id: report.shipmentId },
            data: {
              aiRiskScore: input.overallRiskScore ?? null,
              aiRiskLevel: input.riskLevel ?? null,
            },
          });
          console.log(`[AgentTools] Risk written back to Shipment ${report.shipmentId}: ${input.riskLevel}`);
        }
      } catch (err) {
        console.warn('[AgentTools] Failed to write risk back to Shipment:', err);
      }
    }
  }

  // ─── Internal: read findings for report (used by mock runner) ────────────

  async getReportFindings(reportId: string): Promise<Array<{
    id: string;
    severity: string;
    description: string;
    recommendedAction: string | null;
  }>> {
    return this.prisma.complianceFinding.findMany({
      where: { reportId },
      select: {
        id: true,
        severity: true,
        description: true,
        recommendedAction: true,
      },
    });
  }

  // ─── generate_audit_event (DynamoDB) ─────────────────────────────────────

  async publishAuditEvent(input: AuditEventInput): Promise<void> {
    if (!dynamo || !config.dynamoAuditTable) {
      console.log('[AgentTools] DynamoDB not configured — skipping audit event');
      return;
    }

    try {
      await dynamo.send(
        new PutItemCommand({
          TableName: config.dynamoAuditTable,
          Item: {
            pk: { S: `SHIPMENT#${input.shipmentId}` },
            sk: { S: `COMPLIANCE#${input.timestamp}` },
            eventType: { S: input.eventType },
            summary: { S: input.summary },
            agentRunId: { S: input.agentRunId },
            timestamp: { S: input.timestamp },
          },
        })
      );
    } catch (err) {
      // Audit events are best-effort — don't fail the compliance run
      console.warn('[AgentTools] Failed to publish audit event to DynamoDB:', err);
    }
  }

  // ─── Copilot: full report + findings (read-only) ──────────────────────────
  //
  // Used by the Copilot Engine to build context for explain-risk,
  // recommendations, and Q&A capabilities.

  async getExistingReport(shipmentId: string): Promise<{
    id: string;
    status: string;
    summary: string | null;
    executiveSummary: string | null;
    overallRiskScore: number | null;
    riskLevel: string | null;
    recommendedDisposition: string | null;
    modelId: string | null;
    processingTimeMs: number | null;
    findings: Array<{
      id: string;
      findingType: string;
      severity: string;
      description: string;
      evidence: string | null;
      reasoning: string | null;
      confidenceScore: number | null;
      recommendedAction: string | null;
    }>;
  } | null> {
    const report = await this.prisma.complianceReport.findUnique({
      where: { shipmentId },
      include: {
        findings: {
          orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            findingType: true,
            severity: true,
            description: true,
            evidence: true,
            reasoning: true,
            confidenceScore: true,
            recommendedAction: true,
          },
        },
      },
    });

    if (!report) return null;

    return {
      id: report.id,
      status: report.status,
      summary: report.summary,
      executiveSummary: report.executiveSummary,
      overallRiskScore: report.overallRiskScore,
      riskLevel: report.riskLevel,
      recommendedDisposition: report.recommendedDisposition,
      modelId: report.modelId,
      processingTimeMs: report.processingTimeMs,
      findings: report.findings,
    };
  }

  // ─── Copilot: tracking events (read-only) ─────────────────────────────────
  //
  // Used by Timeline Narrative capability to build the journey story.

  async getTrackingEvents(shipmentId: string): Promise<Array<{
    status: string;
    location: string | null;
    description: string;
    timestamp: Date;
  }>> {
    return this.prisma.trackingEvent.findMany({
      where: { shipmentId },
      orderBy: { timestamp: 'asc' },
      select: {
        status: true,
        location: true,
        description: true,
        timestamp: true,
      },
    });
  }

  // ─── Copilot: similar shipments (read-only, SQL-based) ───────────────────
  //
  // Finds historically similar shipments by matching:
  //   1. Same shipmentType
  //   2. Overlapping corridor (origin OR destination country/city)
  //   3. Has a ComplianceReport (so patterns are available)
  //
  // Returns up to 8 similar shipments with their risk outcomes.
  // No vector DB or embeddings required.

  async getSimilarShipments(shipmentId: string): Promise<Array<{
    trackingNumber: string;
    origin: string;
    destination: string;
    shipmentType: string;
    riskLevel: string | null;
    status: string;
    findingTypes: string[];
    createdAt: Date;
  }>> {
    // First get the current shipment
    const current = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: { shipmentType: true, origin: true, destination: true },
    });

    if (!current) return [];

    // Extract first word of origin/destination for corridor matching
    // e.g. "New York, USA" → "New"... too granular; use last comma-segment
    const originKey = current.origin.split(',').pop()?.trim() ?? current.origin;
    const destKey = current.destination.split(',').pop()?.trim() ?? current.destination;

    const similar = await this.prisma.shipment.findMany({
      where: {
        id: { not: shipmentId },
        shipmentType: current.shipmentType,
        complianceReport: { isNot: null },
        OR: [
          { origin: { contains: originKey, mode: 'insensitive' } },
          { destination: { contains: destKey, mode: 'insensitive' } },
          { origin: { contains: current.origin.split(',')[0], mode: 'insensitive' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: {
        trackingNumber: true,
        origin: true,
        destination: true,
        shipmentType: true,
        status: true,
        createdAt: true,
        complianceReport: {
          select: {
            riskLevel: true,
            findings: {
              select: { findingType: true },
              orderBy: { severity: 'desc' },
              take: 3,
            },
          },
        },
      },
    });

    return similar.map((s) => ({
      trackingNumber: s.trackingNumber,
      origin: s.origin,
      destination: s.destination,
      shipmentType: s.shipmentType,
      status: s.status,
      riskLevel: s.complianceReport?.riskLevel ?? null,
      findingTypes: s.complianceReport?.findings.map((f) => f.findingType) ?? [],
      createdAt: s.createdAt,
    }));
  }

  // ─── Copilot: update executive summary (write) ────────────────────────────
  //
  // Allows the copilot engine to overwrite executiveSummary with a richer
  // version after the compliance agent has written its initial summary.
  // Only called from the auto-trigger post-compliance flow.

  async updateExecutiveSummary(shipmentId: string, copilotSummary: string): Promise<void> {
    await this.prisma.complianceReport.update({
      where: { shipmentId },
      data: { executiveSummary: copilotSummary },
    });
  }
  // ─── Briefing: save or update AI route briefing for a shipment ────────────────────

  async saveBriefing(shipmentId: string, briefing: {
    corridor: string;
    riskSummary: string;
    requiredDocuments: string[];
    customsComplexity: string;
    sanctionsStatus: string;
    estimatedClearanceHours: number;
    delayProbability: number;
    keyRisks: string[];
    regulatoryNotes: string;
    modelId: string;
  }): Promise<void> {
    await this.prisma.shipmentAIBriefing.upsert({
      where: { shipmentId },
      create: {
        shipmentId,
        ...briefing,
        requiredDocuments: briefing.requiredDocuments as any,
        keyRisks: briefing.keyRisks as any,
      },
      update: {
        ...briefing,
        requiredDocuments: briefing.requiredDocuments as any,
        keyRisks: briefing.keyRisks as any,
        updatedAt: new Date(),
      },
    });
    console.log(`[AgentTools] Briefing saved for shipment ${shipmentId}`);
  }

  async getBriefing(shipmentId: string): Promise<{
    corridor: string;
    riskSummary: string;
    requiredDocuments: string[];
    customsComplexity: string | null;
    sanctionsStatus: string | null;
    estimatedClearanceHours: number | null;
    delayProbability: number | null;
    keyRisks: string[];
    regulatoryNotes: string | null;
    modelId: string | null;
    generatedAt: Date;
  } | null> {
    const b = await this.prisma.shipmentAIBriefing.findUnique({ where: { shipmentId } });
    if (!b) return null;
    return {
      corridor: b.corridor,
      riskSummary: b.riskSummary,
      requiredDocuments: (b.requiredDocuments as string[]) ?? [],
      customsComplexity: b.customsComplexity,
      sanctionsStatus: b.sanctionsStatus,
      estimatedClearanceHours: b.estimatedClearanceHours,
      delayProbability: b.delayProbability,
      keyRisks: (b.keyRisks as string[]) ?? [],
      regulatoryNotes: b.regulatoryNotes,
      modelId: b.modelId,
      generatedAt: b.generatedAt,
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────────────────────
const _prisma = new PrismaClient();
export const agentTools = new AgentTools(_prisma);

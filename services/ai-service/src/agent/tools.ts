import { PrismaClient, Prisma, DocumentType, ComplianceSeverity, FindingType } from '@prisma/client';
import {
  AgentDataAccess,
  ShipmentRecord,
  DocumentRecord,
  ExtractedDocumentFields,
  CreateFindingInput,
  CreateReportInput,
  AuditEventInput,
} from './contracts';
import { dynamoAuditService } from '../services/dynamodb';

const prisma = new PrismaClient();

// ─── Required Documents Matrix ────────────────────────────────────────────────
// Business rule: what documents are required for a given shipment profile.
// Phase 3 can make this a database-backed configurable policy table.

const INTERNATIONAL_ORIGINS = ['US', 'USA', 'UK', 'EU', 'DE', 'FR', 'CN', 'IN', 'SG'];
const COLD_CHAIN_TYPES = ['PHARMACEUTICAL', 'PERISHABLE', 'MEDICAL', 'FOOD'];

function isInternational(origin: string, destination: string): boolean {
  // Simple heuristic: if origin and destination are in different known country codes
  const originUpper = origin.toUpperCase();
  const destUpper = destination.toUpperCase();
  return INTERNATIONAL_ORIGINS.some(c => originUpper.includes(c)) &&
    INTERNATIONAL_ORIGINS.some(c => destUpper.includes(c)) &&
    originUpper !== destUpper;
}

// ─── Concrete Tools Implementation ───────────────────────────────────────────

export class ComplianceAgentTools implements AgentDataAccess {

  /** Tool: get_shipment_record */
  async getShipment(shipmentId: string): Promise<ShipmentRecord | null> {
    const s = await prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: {
        id: true,
        trackingNumber: true,
        senderName: true,
        receiverName: true,
        origin: true,
        destination: true,
        shipmentType: true,
        carrierName: true,
        weight: true,
        status: true,
      },
    });

    if (!s) return null;

    return {
      id: s.id,
      trackingNumber: s.trackingNumber,
      senderName: s.senderName,
      receiverName: s.receiverName,
      origin: s.origin,
      destination: s.destination,
      shipmentType: s.shipmentType,
      carrierName: s.carrierName,
      weight: s.weight,
      status: s.status,
    };
  }

  /** Tool: get_uploaded_documents */
  async getDocuments(shipmentId: string): Promise<DocumentRecord[]> {
    const docs = await prisma.shipmentDocument.findMany({
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

  /** Tool: determine_required_documents (pure business logic — no DB) */
  getRequiredDocumentTypes(
    shipmentType: string,
    origin: string,
    destination: string
  ): DocumentType[] {
    const required: DocumentType[] = ['INVOICE'];

    const international = isInternational(origin, destination);
    if (international) {
      required.push('CUSTOMS');
      required.push('BILL_OF_LADING');
    } else {
      required.push('SHIPPING_LABEL');
    }

    const isColdChain = COLD_CHAIN_TYPES.some(t =>
      shipmentType.toUpperCase().includes(t)
    );
    if (isColdChain) {
      required.push('SHIPPING_MANIFEST');
    }

    return required;
  }

  /**
   * Tool: extract_document_fields
   *
   * Phase 2 implementation: returns mock extracted fields.
   * This is designed so the agent can exercise the full compliance
   * check loop locally without AWS credentials.
   *
   * Phase 3: replace the mock block with a real Textract call:
   *   const textract = new TextractClient({ region });
   *   const response = await textract.send(new AnalyzeDocumentCommand({...}));
   *   // parse response.Blocks into key-value fields
   */
  async extractDocumentFields(doc: DocumentRecord): Promise<ExtractedDocumentFields> {
    // ── Phase 3: Textract integration point ──
    // TODO: Replace this mock with:
    //   import { TextractClient, AnalyzeDocumentCommand } from '@aws-sdk/client-textract';
    //   const s3Object = { Bucket: config.s3Bucket, Name: doc.fileName };
    //   const result = await textract.send(new AnalyzeDocumentCommand({
    //     Document: { S3Object: s3Object },
    //     FeatureTypes: ['FORMS'],
    //   }));
    //   return parseTextractBlocks(result.Blocks ?? []);

    // Mock: simulate realistic extracted fields for the document type
    const mockFields: Record<DocumentType, Record<string, string>> = {
      INVOICE: {
        invoice_number: `INV-${Date.now()}`,
        sender: 'Mock Sender Corp',
        amount: '1500.00',
        currency: 'USD',
        date: new Date().toISOString().split('T')[0],
      },
      CUSTOMS: {
        hs_code: '8471.30',
        declared_value: '1500.00',
        origin_country: 'US',
        destination_country: 'DE',
        description: 'Electronic equipment',
      },
      BILL_OF_LADING: {
        bol_number: `BOL-${Date.now()}`,
        carrier: 'Mock Shipping Lines',
        vessel: 'MV CargoTrack',
        port_of_loading: 'New York',
        port_of_discharge: 'Hamburg',
      },
      SHIPPING_LABEL: {
        tracking_number: `TRK-${Date.now()}`,
        service_type: 'EXPRESS',
        weight: '5.2',
        dimensions: '30x20x15',
      },
      SHIPPING_MANIFEST: {
        manifest_number: `MAN-${Date.now()}`,
        total_packages: '1',
        total_weight: '5.2',
        special_handling: 'FRAGILE',
      },
      PROOF_OF_DELIVERY: {
        delivered_to: 'Mock Receiver',
        delivery_date: new Date().toISOString(),
        signature_obtained: 'true',
      },
      OTHER: {
        document_type: 'UNKNOWN',
        content: 'Unrecognized document type',
      },
    };

    return {
      documentId: doc.id,
      documentType: doc.documentType,
      fields: mockFields[doc.documentType] ?? mockFields.OTHER,
      confidence: 0.92,
    };
  }

  /** Tool: create_compliance_finding */
  async createFinding(input: CreateFindingInput): Promise<{ id: string }> {
    const finding = await prisma.complianceFinding.create({
      data: {
        reportId: input.reportId,
        documentId: input.documentId ?? null,
        findingType: input.findingType as FindingType,
        severity: input.severity as ComplianceSeverity,
        description: input.description,
        // Prisma's Json field requires Prisma.InputJsonValue — plain objects
        // must be cast explicitly. null is handled via Prisma.DbNull.
        detail: input.detail
          ? (input.detail as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
      },
    });

    return { id: finding.id };
  }

  /** Tool: create_compliance_report */
  async createReport(input: CreateReportInput): Promise<{ id: string }> {
    // Upsert: if a report already exists (re-run), update it back to PENDING
    const existing = await prisma.complianceReport.findUnique({
      where: { shipmentId: input.shipmentId },
    });

    if (existing) {
      const updated = await prisma.complianceReport.update({
        where: { id: existing.id },
        data: { status: 'PENDING', agentRunId: input.agentRunId, summary: null },
      });
      // Delete old findings for a fresh run
      await prisma.complianceFinding.deleteMany({ where: { reportId: existing.id } });
      return { id: updated.id };
    }

    const report = await prisma.complianceReport.create({
      data: {
        shipmentId: input.shipmentId,
        agentRunId: input.agentRunId,
        status: 'PENDING',
      },
    });

    return { id: report.id };
  }

  /** Tool: finalize_report */
  async finalizeReport(
    reportId: string,
    status: 'PASSED' | 'FAILED' | 'PARTIAL',
    summary: string
  ): Promise<void> {
    await prisma.complianceReport.update({
      where: { id: reportId },
      data: { status, summary },
    });
  }

  /** Tool: generate_audit_event */
  async publishAuditEvent(input: AuditEventInput): Promise<void> {
    await dynamoAuditService.writeAuditEvent({
      pk: `SHIPMENT#${input.shipmentId}`,
      sk: `COMPLIANCE#${input.timestamp}`,
      eventType: input.eventType,
      shipmentId: input.shipmentId,
      agentRunId: input.agentRunId,
      summary: input.summary,
      timestamp: input.timestamp,
    });
  }
}

// Singleton instance — shared by the compliance handler
export const agentTools = new ComplianceAgentTools();

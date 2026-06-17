//
// CargoTrack AI Service — Risk Intelligence Agent Contracts
//
// Defines the tool interfaces the Shipment Risk Intelligence Agent uses.
// Implementations are in tools.ts. The runner (runner.ts) only
// depends on these interfaces — never on implementations directly.
// This enables easy mocking in tests and future provider swaps.
//
// v3.1: Redesigned from Document Compliance Agent to
//       Shipment Risk Intelligence Engine.
//       Key change: extract_document_text replaces extract_document_fields.
//       The LLM now reads raw document text and reasons over it —
//       not pre-parsed key-value pairs.
//

import { DocumentType, ComplianceSeverity, FindingType } from '@prisma/client';

// ─── Input types (what the agent reads) ──────────────────────────────────────

export interface ShipmentRecord {
  id: string;
  trackingNumber: string;
  senderName: string;
  receiverName: string;
  origin: string;
  destination: string;
  shipmentType: string;
  carrierName: string | null;
  weight: number;
  status: string;
  description: string | null;
  // ── vNext: Extended intelligence fields ───────────────────────────────────
  commodityType: string | null;       // e.g. "Electronics", "Pharmaceuticals"
  hsCodeHint: string | null;          // user-provided HS code hint
  isDangerousGoods: boolean;          // DG flag
  dangerousGoodsClass: string | null; // IATA/IMDG class if DG
  incoterms: string | null;           // EXW, FOB, CIF, DDP, etc.
  declaredValue: number | null;       // declared customs value
  currencyCode: string | null;        // currency for declared value
}

export interface DocumentRecord {
  id: string;
  originalName: string;
  fileName: string;
  documentType: DocumentType;
  fileType: string;
  fileSize: number;
  uploadedAt: Date;
}

/**
 * The output of document extraction — raw readable text.
 *
 * v3.1 CHANGE: Replaces ExtractedDocumentFields (key-value map).
 * The LLM now reads rawText directly and applies its own reasoning.
 * This is the critical difference: the intelligence comes from Nova,
 * not from the extractor's regex/parsing layer.
 */
export interface ExtractedDocumentText {
  documentId: string;
  documentType: DocumentType;
  /** Full readable text content extracted from the document */
  rawText: string;
  /** Which extractor backend produced this text */
  extractionMethod: 'textract' | 'pdf-parse' | 'tesseract' | 'mock';
  /** Extraction quality confidence 0.0–1.0 */
  confidence: number;
  /** Number of pages (if known) */
  pageCount?: number;
}

/** Route risk context returned by get_route_risk_context tool */
export interface RouteRiskContext {
  corridor: string;
  regulatoryNotes: string;
  commonFindings: string[];
  sanctionsStatus: 'CLEAR' | 'WATCH' | 'BLOCKED';
  riskMultiplier: number;
}

// ─── Output types (what the agent writes) ────────────────────────────────────

export interface CreateFindingInput {
  reportId: string;
  documentId?: string;
  findingType: FindingType;
  severity: ComplianceSeverity;
  description: string;
  // v3.1: Intelligence fields — required for genuine AI assessment
  evidence?: string;          // specific text from document(s) that triggered this
  reasoning?: string;         // LLM analytical chain explaining the risk
  confidenceScore?: number;   // LLM confidence in this finding (0.0–1.0)
  recommendedAction?: string; // actionable next step for compliance team
  detail?: {
    field?: string;
    expected?: string;
    found?: string;
    [key: string]: unknown;
  };
}

export interface CreateReportInput {
  shipmentId: string;
  agentRunId: string;
}

export interface FinalizeReportInput {
  reportId: string;
  status: 'PASSED' | 'FAILED' | 'PARTIAL';
  // v3.1: Rich intelligence output
  summary: string;                   // legacy one-liner (backward compat)
  executiveSummary?: string;         // multi-paragraph narrative
  overallRiskScore?: number;         // 0.0–1.0 continuous risk score
  riskLevel?: string;                // LOW | MEDIUM | HIGH | CRITICAL
  recommendedDisposition?: string;   // operational recommendation
  modelId?: string;                  // which model produced this
  modelConfidence?: number;          // overall model confidence
  processingTimeMs?: number;         // agent run duration
}

export interface AuditEventInput {
  shipmentId: string;
  eventType: string;
  summary: string;
  agentRunId: string;
  timestamp: string;
}

// ─── Tool interfaces — the agent's tool-use surface ──────────────────────────
// Each method maps 1:1 to a Bedrock Converse tool definition.
// Amazon Nova and Claude both support the same Converse API tool format.

export interface AgentDataAccess {
  /** Tool: get_shipment_profile */
  getShipment(shipmentId: string): Promise<ShipmentRecord | null>;

  /** Tool: get_uploaded_documents */
  getDocuments(shipmentId: string): Promise<DocumentRecord[]>;

  /**
   * Tool: extract_document_text
   * v3.1: Returns raw text for LLM reasoning (not structured fields).
   * Extraction chain: Textract → pdf-parse → tesseract → mock
   */
  extractDocumentText(doc: DocumentRecord): Promise<ExtractedDocumentText>;

  /**
   * Tool: get_route_risk_context
   * Returns pre-computed risk context for the shipping corridor.
   * Provides regulatory notes, known common findings, and sanctions status.
   */
  getRouteRiskContext(
    origin: string,
    destination: string,
    cargoType: string
  ): RouteRiskContext;

  /** Tool: record_risk_finding */
  createFinding(input: CreateFindingInput): Promise<{ id: string }>;

  /** Tool: create_compliance_report */
  createReport(input: CreateReportInput): Promise<{ id: string }>;

  /** Tool: finalize_risk_assessment */
  finalizeReport(input: FinalizeReportInput): Promise<void>;

  /** Tool: generate_audit_event */
  publishAuditEvent(input: AuditEventInput): Promise<void>;
}

// ─── SQS trigger message shape ────────────────────────────────────────────────

export interface ComplianceTriggerMessage {
  shipmentId: string;
  trackingNumber: string;
  newStatus: string;
  triggeredAt: string;
}

// ─── Bedrock tool definitions ─────────────────────────────────────────────────

export interface BedrockToolSpec {
  name: string;
  description: string;
  inputSchema: {
    json: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

/**
 * Risk Intelligence Agent tool set.
 *
 * v3.1 KEY CHANGES vs v3.0:
 *   - extract_document_fields → extract_document_text (raw text)
 *   - determine_required_documents REMOVED (Nova determines what it needs)
 *   - get_route_risk_context ADDED (corridor risk context)
 *   - record_risk_finding EXPANDS (adds evidence, reasoning, confidence, action)
 *   - finalize_report → finalize_risk_assessment EXPANDS (adds risk score,
 *     risk level, executive narrative, disposition, model confidence)
 */
export const COMPLIANCE_AGENT_TOOLS: BedrockToolSpec[] = [
  {
    name: 'get_shipment_profile',
    description:
      'Retrieve the full shipment profile: sender, receiver, origin, destination, cargo type, weight, carrier, current status, and shipment description. Use this first to understand the risk context.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          shipment_id: { type: 'string', description: 'The unique shipment ID (UUID).' },
        },
        required: ['shipment_id'],
      },
    },
  },
  {
    name: 'get_uploaded_documents',
    description:
      'Retrieve all documents uploaded for a shipment. Returns document types, file names, upload timestamps, and document IDs. Use this to understand what evidence is available before reading document content.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          shipment_id: { type: 'string', description: 'The shipment ID.' },
        },
        required: ['shipment_id'],
      },
    },
  },
  {
    name: 'extract_document_text',
    description:
      'Extract and return the full readable text content of a document. The text is suitable for direct analysis — read it as you would read a shipping document. You may call this for each document you wish to analyze. The text comes from Textract, PDF parsing, OCR, or structured mock data depending on availability.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          document_id: {
            type: 'string',
            description: 'The document ID to read text from.',
          },
        },
        required: ['document_id'],
      },
    },
  },
  {
    name: 'get_route_risk_context',
    description:
      'Get risk intelligence for the shipping corridor. Returns regulatory requirements, known common compliance findings for this route, sanctions screening status, and any route-specific risk factors. Use this to calibrate your risk assessment.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          origin: { type: 'string', description: 'Shipment origin location or country.' },
          destination: { type: 'string', description: 'Shipment destination location or country.' },
          cargo_type: {
            type: 'string',
            description: 'The type of cargo (shipmentType from the shipment profile).',
          },
        },
        required: ['origin', 'destination', 'cargo_type'],
      },
    },
  },
  {
    name: 'record_risk_finding',
    description:
      'Record a specific risk finding with your evidence, reasoning, confidence, and recommended action. Call this for each distinct risk you identify during document analysis.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          report_id: { type: 'string' },
          document_id: {
            type: 'string',
            description: 'Optional: the document ID that contains the evidence for this finding.',
          },
          finding_type: {
            type: 'string',
            enum: [
              'MISSING_DOCUMENT',
              'DATA_MISMATCH',
              'COMPLIANCE_RISK',
              'VALIDATION_ERROR',
              'DANGEROUS_GOODS_RISK',
              'PARTY_SCREENING_FLAG',
              'HS_CODE_MISMATCH',
              'VALUE_DISCREPANCY',
              'ROUTE_RESTRICTION',
            ],
          },
          severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
          description: {
            type: 'string',
            description: 'Clear description of the risk. Be specific about what was found.',
          },
          evidence: {
            type: 'string',
            description:
              'The specific text or data from the document(s) that triggered this finding. Quote directly from the document text where possible.',
          },
          reasoning: {
            type: 'string',
            description:
              'Your analytical reasoning: why is this a risk? What is the compliance or business implication? What could go wrong?',
          },
          confidence_score: {
            type: 'number',
            description: 'Your confidence in this finding (0.0 = very uncertain, 1.0 = highly certain).',
          },
          recommended_action: {
            type: 'string',
            description:
              'Specific, actionable next step for the compliance or operations team to resolve this finding.',
          },
          detail: {
            type: 'object',
            description: 'Optional structured detail (e.g. field, expected, found).',
          },
        },
        required: ['report_id', 'finding_type', 'severity', 'description'],
      },
    },
  },
  {
    name: 'create_compliance_report',
    description: 'Create a new risk intelligence report record for this shipment. Call this once before recording any findings.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          shipment_id: { type: 'string' },
          agent_run_id: { type: 'string' },
        },
        required: ['shipment_id', 'agent_run_id'],
      },
    },
  },
  {
    name: 'finalize_risk_assessment',
    description:
      'Complete and submit the risk intelligence report. Provide an overall risk score, executive summary narrative, and operational recommendation. This is your final output — the intelligence brief for the compliance team.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          report_id: { type: 'string' },
          status: {
            type: 'string',
            enum: ['PASSED', 'FAILED', 'PARTIAL'],
            description: 'PASSED: no HIGH/CRITICAL findings. FAILED: one or more HIGH/CRITICAL findings. PARTIAL: analysis incomplete.',
          },
          overall_risk_score: {
            type: 'number',
            description:
              'Continuous risk score from 0.0 (no risk) to 1.0 (critical risk). Consider the number, severity, and nature of findings when scoring.',
          },
          risk_level: {
            type: 'string',
            enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
            description: 'Categorical risk level for this shipment.',
          },
          executive_summary: {
            type: 'string',
            description:
              'Multi-paragraph executive narrative for the compliance officer. Explain the overall risk profile, key findings, and business implications in plain language. This is the primary output of your analysis.',
          },
          recommended_disposition: {
            type: 'string',
            description:
              'Clear operational recommendation: what should the compliance team do with this shipment right now?',
          },
          model_confidence: {
            type: 'number',
            description: 'Your overall confidence in this assessment (0.0–1.0).',
          },
          summary: {
            type: 'string',
            description: 'One-sentence summary for notification purposes.',
          },
        },
        required: ['report_id', 'status', 'summary'],
      },
    },
  },
];

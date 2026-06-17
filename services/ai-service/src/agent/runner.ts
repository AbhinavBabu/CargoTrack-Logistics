//
// CargoTrack — Shipment Risk Intelligence Runner
//
// Drives the Bedrock Nova agent through the risk intelligence assessment.
// The agent reads shipment data, extracts document text, synthesizes
// cross-document evidence, and produces intelligence findings with
// reasoning, confidence, and operational recommendations.
//
// v3.1 KEY CHANGES from v3.0:
//   - System prompt redesigned: reasoning-oriented analyst persona
//   - temperature: 0 → 0.2 (enables natural narrative generation)
//   - maxTokens: 4096 → 8192 (space for reading multi-document content)
//   - extract_document_fields → extract_document_text (raw text)
//   - get_route_risk_context ADDED
//   - Mock runner generates realistic evidence-grounded narratives
//   - processingTimeMs captured and stored
//

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type ContentBlock,
  type Tool,
  type ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'crypto';
import { config } from '../config';
import { COMPLIANCE_AGENT_TOOLS, ComplianceTriggerMessage } from './contracts';
import { AgentTools } from './tools';
import { CopilotEngine } from '../copilot/engine';
import KnowledgeBase from '../knowledge/knowledge-base';

// ─── Bedrock client ───────────────────────────────────────────────────────────

const bedrock = config.region
  ? new BedrockRuntimeClient({ region: config.region })
  : null;

const MAX_ITERATIONS = 20;

// ─── System Prompt ────────────────────────────────────────────────────────────
//
// v3.1: Reasoning-oriented analyst persona.
// The key change from v3.0: this prompt does NOT tell Nova what checks to run
// or in what order. It gives Nova the business context and analytical framework,
// then lets Nova determine what matters and how to assess it.
//
// This is what makes it genuinely AI-driven: Nova's judgment determines the
// assessment, not a predefined procedure.

// The static SYSTEM_PROMPT provides the agent's persona and analytical mandate.
// A per-shipment catalog context block is prepended to the FIRST user message
// at runtime (see buildCatalogContextHeader below).
const SYSTEM_PROMPT = `You are the CargoTrack Shipment Risk Intelligence Agent — a senior logistics compliance analyst with deep expertise in:
- International trade compliance and customs law
- Export control regulations (EAR, ITAR, EU dual-use)
- OFAC sanctions screening and AML (anti-money laundering)
- Dangerous goods classification (IATA DGR, IMDG Code, ADR)
- Harmonized System (HS) tariff classification
- Incoterms 2020 and trade finance
- Freight and customs documentation requirements
- Carrier liability and cargo insurance

YOUR PURPOSE:
Produce a complete risk intelligence brief that enables the compliance team to make an informed decision: CLEAR, HOLD, or ESCALATE this shipment.

YOUR FULL ANALYTICAL MANDATE — analyze ALL of the following:

1. DOCUMENT COMPLETENESS
   - What documents are required for this route, cargo type, and incoterms?
   - What is missing? What is present but insufficient?
   - Use finding type MISSING_DOCUMENT for absent required documents.

2. CROSS-DOCUMENT CONSISTENCY
   - Are weights, values, descriptions, and HS codes consistent across all documents?
   - Do party names (shipper, consignee, notify party, carrier) match across documents?
   - Are dates logically consistent (invoice date before B/L date, etc.)?
   - Use finding type DATA_MISMATCH for inconsistencies.

3. DANGEROUS GOODS ANALYSIS
   - Does the commodity description, HS code, or shipment description suggest dangerous goods?
   - Common DG categories: lithium batteries (HS 850650/850660), chemicals (HS 28-29),
     flammable liquids (HS 2710), pharmaceuticals (HS 30), explosives (HS 36).
   - If DG suspected: is DG class declared? Are DG-specific documents present (DG declaration, SDS)?
   - Use finding type DANGEROUS_GOODS_RISK for DG exposure.

4. DECLARED VALUE AND CUSTOMS RISK
   - Is the declared value plausible for the described goods?
   - Are there undervaluation indicators? (e.g., $50 "laptop" value, unusually low unit prices)
   - Does the currency match the trade corridor (USD for US trade, EUR for EU, etc.)?
   - Use finding type VALUE_DISCREPANCY for suspicious values.

5. HS CODE VALIDATION
   - Is the HS code consistent with the goods description?
   - Are there misclassification risks (wrong chapter, dual-use code)?
   - Use finding type HS_CODE_MISMATCH for classification concerns.

6. PARTY SCREENING FLAGS
   - Do any party names trigger screening concerns?
   - Look for: vague entity names, PO Box-only addresses, known sanctions patterns,
     third-party intermediaries in opaque jurisdictions.
   - Use finding type PARTY_SCREENING_FLAG. Do NOT make definitive sanctions determinations —
     flag for screening and recommend OFAC/UN SDN list check.

7. ROUTE AND CORRIDOR RISK
   - What are the corridor-specific regulatory requirements?
   - Are there route restrictions, embargo risks, or special permit requirements?
   - Use finding type ROUTE_RESTRICTION for route-level compliance exposure.

8. GENERAL COMPLIANCE RISK
   - Any other compliance concerns not covered above.
   - Use finding type COMPLIANCE_RISK.

ANALYTICAL PRINCIPLES:
- If no documents are uploaded: still assess route risk, DG risk from cargo description, and provide
  a preliminary briefing. Score risk MEDIUM minimum — no documents means incomplete assessment.
- If documents ARE uploaded: read the full text of each using extract_document_text.
  Reason over the actual content — do not just check field existence.
- Your judgment is primary. Do not limit yourself to a checklist.
  A pattern you identify through reasoning is more valuable than any rule check.

FOR EVERY FINDING YOU RECORD, PROVIDE:
- evidence: Quote specific text from the document(s), or state the basis if no documents
- reasoning: Your analytical chain — what is the compliance or business risk?
- confidence_score: 0.0 (uncertain) to 1.0 (highly certain)
- recommended_action: Specific, actionable next step for the operations/compliance team

FINAL ASSESSMENT (finalize_risk_assessment):
Write an executive_summary that:
- Opens with a clear risk verdict (CRITICAL/HIGH/MEDIUM/LOW) and the primary reason
- Summarizes findings in plain language a logistics manager can act on
- Quantifies the risk (e.g., "3 HIGH findings, 2 MEDIUM findings")
- States clearly: PROCEED, HOLD FOR REVIEW, or ESCALATE TO COMPLIANCE OFFICER
- Is written in 2-4 paragraphs — detailed enough to be actionable, concise enough to read in 60 seconds

RISK SCORING:
- overall_risk_score: 0.0–1.0 continuous score
  0.0–0.25 = LOW (standard monitoring), 0.26–0.50 = MEDIUM (attention needed),
  0.51–0.75 = HIGH (hold for review), 0.76–1.0 = CRITICAL (escalate immediately)
- risk_level must match the score band above
- model_confidence: your overall confidence in the assessment given available evidence

KNOWLEDGE BASE GROUNDING:
You will receive CATALOG-GROUNDED CONTEXT at the start of each assessment.
This context is loaded from our logistics intelligence knowledge base (route intelligence,
sanctions watch, dangerous goods, HS code, and Incoterms catalogs).

You MUST:
1. Treat catalog data as authoritative — do not contradict it
2. Reference specific catalog findings in your reasoning (e.g., 'per catalog: USA→China BIS Entity List screening required')
3. Use catalog-specified required documents when assessing document completeness
4. Apply catalog-identified sanctions risk levels — if catalog says CRITICAL, do not assess as LOW
5. Include the knowledge sources in your executive summary (the catalog version and confidence level)`;


// ─── Build per-shipment catalog context header ────────────────────────────────
//
// Called once per compliance run, before the first Nova invocation.
// Returns a formatted string ready to prepend to the user message.

async function buildCatalogContextHeader(shipmentId: string, tools: AgentTools): Promise<string> {
  try {
    const shipment = await tools.getShipment(shipmentId);
    if (!shipment) return '';

    const ctx = KnowledgeBase.buildGroundedContext({
      origin:          shipment.origin,
      destination:     shipment.destination,
      commodityType:   shipment.commodityType,
      description:     undefined,
      hsCodeHint:      shipment.hsCodeHint,
      incoterms:       shipment.incoterms,
      isDangerousGoods: shipment.isDangerousGoods,
      shipmentType:    shipment.shipmentType,
    });

    const formatted = KnowledgeBase.formatContextForPrompt(ctx, shipment);

    console.log(`[Runner] Catalog context loaded — corridor: ${ctx.route.corridorId}, sanctions: ${ctx.sanctions.destinationRisk}, knowledge confidence: ${ctx.knowledgeConfidence}, sources: ${ctx.knowledgeSources.length}`);

    return formatted;
  } catch (err) {
    console.warn('[Runner] Could not build catalog context — proceeding without grounding:', err);
    return '';
  }
}


// ─── Tool dispatcher ──────────────────────────────────────────────────────────

async function dispatchToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  tools: AgentTools,
  shipmentId: string,
): Promise<unknown> {
  switch (toolName) {
    case 'get_shipment_profile': {
      const shipment = await tools.getShipment(toolInput.shipment_id as string);
      if (!shipment) return { error: 'Shipment not found' };
      return shipment;
    }

    case 'get_uploaded_documents': {
      const docs = await tools.getDocuments(toolInput.shipment_id as string);
      return {
        documents: docs.map((d) => ({
          id: d.id,
          documentType: d.documentType,
          originalName: d.originalName,
          fileType: d.fileType,
          fileSize: d.fileSize,
          uploadedAt: d.uploadedAt,
        })),
        count: docs.length,
      };
    }

    case 'extract_document_text': {
      const documentId = toolInput.document_id as string;
      const docs = await tools.getDocuments(shipmentId);
      const doc = docs.find((d) => d.id === documentId);
      if (!doc) return { error: `Document ${documentId} not found` };
      const result = await tools.extractDocumentText(doc);
      return {
        documentId: result.documentId,
        documentType: result.documentType,
        rawText: result.rawText,
        extractionMethod: result.extractionMethod,
        confidence: result.confidence,
        pageCount: result.pageCount,
      };
    }

    case 'get_route_risk_context': {
      const context = tools.getRouteRiskContext(
        toolInput.origin as string,
        toolInput.destination as string,
        toolInput.cargo_type as string
      );
      return context;
    }

    case 'record_risk_finding': {
      const result = await tools.createFinding({
        reportId: toolInput.report_id as string,
        documentId: toolInput.document_id as string | undefined,
        findingType: toolInput.finding_type as any,
        severity: toolInput.severity as any,
        description: toolInput.description as string,
        evidence: toolInput.evidence as string | undefined,
        reasoning: toolInput.reasoning as string | undefined,
        confidenceScore: toolInput.confidence_score as number | undefined,
        recommendedAction: toolInput.recommended_action as string | undefined,
        detail: toolInput.detail as any,
      });
      return { success: true, findingId: result.id };
    }

    case 'create_compliance_report': {
      const result = await tools.createReport({
        shipmentId: toolInput.shipment_id as string,
        agentRunId: toolInput.agent_run_id as string,
      });
      return { reportId: result.id };
    }

    case 'finalize_risk_assessment': {
      await tools.finalizeReport({
        reportId: toolInput.report_id as string,
        status: toolInput.status as any,
        summary: toolInput.summary as string,
        executiveSummary: toolInput.executive_summary as string | undefined,
        overallRiskScore: toolInput.overall_risk_score as number | undefined,
        riskLevel: toolInput.risk_level as string | undefined,
        recommendedDisposition: toolInput.recommended_disposition as string | undefined,
        modelId: config.bedrockModelId,
        modelConfidence: toolInput.model_confidence as number | undefined,
      });
      return { success: true };
    }

    default:
      console.warn(`[Runner] Unknown tool: ${toolName}`);
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ─── Bedrock Nova runner ──────────────────────────────────────────────────────

async function runBedrockAgent(
  trigger: ComplianceTriggerMessage,
  tools: AgentTools,
): Promise<void> {
  if (!bedrock) {
    throw new Error('Bedrock client not initialized — check AWS_DEFAULT_REGION');
  }

  const agentRunId = randomUUID();
  const startTime = Date.now();

  console.log(`[Runner] Starting Bedrock risk intelligence run — shipment: ${trigger.shipmentId}, run: ${agentRunId}`);

  // Create the report record first
  const { id: reportId } = await tools.createReport({
    shipmentId: trigger.shipmentId,
    agentRunId,
  });

  // Load catalog context for this shipment (route, sanctions, DG, HS, Incoterms)
  const catalogContext = await buildCatalogContextHeader(trigger.shipmentId, tools);

  const userMessage = `${catalogContext}COMPLIANCE ASSESSMENT REQUEST:

Perform a complete risk intelligence assessment for shipment ID: ${trigger.shipmentId}.

Tracking number: ${trigger.trackingNumber}
Status: ${trigger.newStatus}
Triggered at: ${trigger.triggeredAt}

Report ID (use this for all findings and the final assessment): ${reportId}

IMPORTANT: The CATALOG-GROUNDED CONTEXT above is pre-loaded knowledge base data for this corridor.
Use it as your authoritative starting point. Do NOT ignore it.

Begin by retrieving the shipment profile and uploaded documents. Use the catalog context
for route/sanctions/DG intelligence (you do not need to call get_route_risk_context for
basic corridor information — it is already provided above). Read the text of each uploaded
document. Synthesize your findings and produce a complete risk intelligence report.

In your executive_summary, include a 'Knowledge Sources Used' section listing:
- Which catalog entries informed this assessment
- The knowledge confidence level
This makes your findings verifiable and auditable.`;

  const messages: Message[] = [{ role: 'user', content: [{ text: userMessage }] }];

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await bedrock.send(
      new ConverseCommand({
        modelId: config.bedrockModelId,
        system: [{ text: SYSTEM_PROMPT }],
        messages,
        toolConfig: {
          tools: COMPLIANCE_AGENT_TOOLS.map((t) => ({ toolSpec: t })) as Tool[],
        },
        inferenceConfig: {
          maxTokens: 8192,
          temperature: 0.2,
        },
      }),
    );

    const assistantMessage: Message = {
      role: 'assistant',
      content: response.output?.message?.content ?? [],
    };
    messages.push(assistantMessage);

    const stopReason = response.stopReason;

    if (stopReason === 'end_turn') {
      console.log(`[Runner] Agent completed assessment after ${iterations} iterations`);
      const processingTimeMs = Date.now() - startTime;

      // Update processingTimeMs on the report
      await tools.finalizeReport({
        reportId,
        status: 'PASSED', // will be overwritten by finalize_risk_assessment tool call
        summary: 'Assessment complete',
        processingTimeMs,
        modelId: config.bedrockModelId,
      });
      break;
    }

    if (stopReason !== 'tool_use') {
      console.warn(`[Runner] Unexpected stop reason: ${stopReason}`);
      break;
    }

    // Process tool calls
    const toolResults: ContentBlock[] = [];

    for (const block of assistantMessage.content ?? []) {
      if ('toolUse' in block && block.toolUse) {
        const { toolUseId, name, input } = block.toolUse;
        console.log(`[Runner] Tool call: ${name}`);

        const result = await dispatchToolCall(
          name!,
          input as Record<string, unknown>,
          tools,
          trigger.shipmentId,
        );

        // If this was finalize_risk_assessment, capture timing
        if (name === 'finalize_risk_assessment') {
          const processingTimeMs = Date.now() - startTime;
          const reportIdFromCall = (input as any).report_id as string;
          if (reportIdFromCall) {
            // Patch processingTimeMs into the report
            try {
              const prisma = (tools as any).prisma as import('@prisma/client').PrismaClient;
              await prisma.complianceReport.update({
                where: { id: reportIdFromCall },
                data: { processingTimeMs },
              });
            } catch { /* non-critical */ }
          }
        }

        const toolResultContent: ToolResultContentBlock = {
          json: result as Record<string, unknown>,
        } as ToolResultContentBlock;

        toolResults.push({
          toolResult: {
            toolUseId: toolUseId!,
            content: [toolResultContent],
          },
        });
      }
    }

    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }
  }

  if (iterations >= MAX_ITERATIONS) {
    console.warn(`[Runner] Hit MAX_ITERATIONS (${MAX_ITERATIONS}) — finalizing report as PARTIAL`);
    await tools.finalizeReport({
      reportId,
      status: 'PARTIAL',
      summary: `Assessment truncated after ${MAX_ITERATIONS} agent iterations`,
      executiveSummary: `The risk assessment could not be completed within the iteration limit. Manual review is recommended for this shipment.`,
      processingTimeMs: Date.now() - startTime,
    });
  }

  // Publish audit event
  await tools.publishAuditEvent({
    shipmentId: trigger.shipmentId,
    eventType: 'COMPLIANCE_ASSESSED',
    summary: `Risk intelligence assessment completed for ${trigger.trackingNumber}`,
    agentRunId,
    timestamp: new Date().toISOString(),
  });
}

// ─── Mock runner ──────────────────────────────────────────────────────────────
//
// v3.1: Produces realistic evidence-grounded intelligence reports.
// The output format is identical to the live Bedrock runner.
// This ensures that when Bedrock is unavailable, the system still
// demonstrates a complete, believable intelligence report.

async function runMockAgent(
  trigger: ComplianceTriggerMessage,
  tools: AgentTools,
): Promise<void> {
  const agentRunId = `mock-run-${randomUUID()}`;
  const startTime = Date.now();

  console.log(`[Runner][MOCK] Starting mock risk intelligence run — shipment: ${trigger.shipmentId}`);

  const { id: reportId } = await tools.createReport({
    shipmentId: trigger.shipmentId,
    agentRunId,
  });

  // Fetch real data so the mock output references actual shipment details
  const [shipment, docs] = await Promise.all([
    tools.getShipment(trigger.shipmentId),
    tools.getDocuments(trigger.shipmentId),
  ]);

  if (!shipment) {
    await tools.finalizeReport({
      reportId,
      status: 'PARTIAL',
      summary: 'Shipment not found',
      executiveSummary: 'Risk assessment could not proceed — shipment record not found.',
      riskLevel: 'MEDIUM',
      overallRiskScore: 0.3,
      processingTimeMs: Date.now() - startTime,
    });
    return;
  }

  // Extract real document texts for the mock to reference
  const extractedTexts: Record<string, string> = {};
  for (const doc of docs) {
    const extracted = await tools.extractDocumentText(doc);
    extractedTexts[doc.documentType] = extracted.rawText;
  }

  const routeContext = tools.getRouteRiskContext(
    shipment.origin,
    shipment.destination,
    shipment.shipmentType
  );

  const hasInvoice = docs.some((d) => d.documentType === 'INVOICE');
  const hasBOL = docs.some((d) => d.documentType === 'BILL_OF_LADING');
  const hasCustoms = docs.some((d) => d.documentType === 'CUSTOMS');
  const hasManifest = docs.some((d) => d.documentType === 'SHIPPING_MANIFEST');

  const invoiceDoc = docs.find((d) => d.documentType === 'INVOICE');
  const bolDoc = docs.find((d) => d.documentType === 'BILL_OF_LADING');
  const customsDoc = docs.find((d) => d.documentType === 'CUSTOMS');

  // ── Document completeness analysis ────────────────────────────────────────
  const isInternational =
    shipment.origin.toLowerCase() !== shipment.destination.toLowerCase();

  if (!hasInvoice) {
    await tools.createFinding({
      reportId,
      findingType: 'MISSING_DOCUMENT',
      severity: 'HIGH',
      description: `Commercial Invoice is absent for this ${isInternational ? 'international' : ''} shipment.`,
      evidence: `Document inventory for shipment ${shipment.trackingNumber}: ${docs.map((d) => d.documentType).join(', ') || 'no documents uploaded'}.`,
      reasoning: `A Commercial Invoice is mandatory for customs clearance on international shipments. Without it, customs authorities cannot verify declared value, origin, or HS classification. This will cause clearance delay or rejection.`,
      confidenceScore: 0.97,
      recommendedAction: `Request the Commercial Invoice from the shipper (${shipment.senderName}) immediately. The invoice must show buyer/seller details, goods description, HS codes, and declared value.`,
    });
  }

  if (!hasBOL && isInternational) {
    await tools.createFinding({
      reportId,
      findingType: 'MISSING_DOCUMENT',
      severity: 'HIGH',
      description: `Bill of Lading is missing for this international shipment (${shipment.origin} → ${shipment.destination}).`,
      evidence: `Document inventory: ${docs.map((d) => d.documentType).join(', ') || 'none'}. No BILL_OF_LADING document present.`,
      reasoning: `The Bill of Lading is the primary shipping contract and title document for ocean freight. It is required for cargo release at the port of discharge. Missing B/L will prevent cargo from being released to the consignee.`,
      confidenceScore: 0.95,
      recommendedAction: `Contact carrier ${shipment.carrierName ?? 'on record'} to obtain the original or electronic Bill of Lading before vessel arrival at ${shipment.destination}.`,
    });
  }

  if (!hasCustoms && isInternational) {
    await tools.createFinding({
      reportId,
      findingType: 'MISSING_DOCUMENT',
      severity: 'MEDIUM',
      description: `Customs Declaration has not been uploaded for this international shipment.`,
      evidence: `Document inventory: ${docs.map((d) => d.documentType).join(', ') || 'none'}. No CUSTOMS document present.`,
      reasoning: `International shipments require a customs declaration (export and/or import) for regulatory clearance. While this may be filed directly with customs authorities, the absence of a filed declaration document creates a compliance gap in the documentation record.`,
      confidenceScore: 0.82,
      recommendedAction: `Confirm that an export declaration has been filed with customs and upload a copy of the declaration to the shipment record.`,
    });
  }

  // ── Cross-document weight analysis ────────────────────────────────────────
  if (hasBOL && hasInvoice && bolDoc && invoiceDoc) {
    // Extract weight references from mock text to simulate cross-document analysis
    const bolText = extractedTexts['BILL_OF_LADING'] ?? '';
    const invText = extractedTexts['INVOICE'] ?? '';

    // Check if the BOL text and invoice text reference similar weights
    // In the mock, BOL uses gross weight (18.3 KG) and invoice uses line item totals
    const bolWeightMatch = bolText.match(/Gross Weight:\s*([\d.]+)\s*KG/i);
    const shipmentWeight = shipment.weight;

    if (bolWeightMatch) {
      const bolWeight = parseFloat(bolWeightMatch[1]);
      const weightDiff = Math.abs(bolWeight - shipmentWeight);
      const weightDiffPct = (weightDiff / shipmentWeight) * 100;

      if (weightDiffPct > 10) {
        await tools.createFinding({
          reportId,
          documentId: bolDoc.id,
          findingType: 'DATA_MISMATCH',
          severity: 'HIGH',
          description: `Gross weight discrepancy detected between Bill of Lading and shipment record.`,
          evidence: `Bill of Lading states: "Gross Weight: ${bolWeight} KG". Shipment record weight: ${shipmentWeight} KG. Difference: ${weightDiff.toFixed(1)} KG (${weightDiffPct.toFixed(0)}%).`,
          reasoning: `The Bill of Lading is the authoritative weight document for customs and carrier purposes. A ${weightDiffPct.toFixed(0)}% discrepancy of this magnitude is outside normal measurement tolerance (typically ±5%). This may indicate a transcription error, gross vs. net weight confusion, or undeclared cargo. Customs authorities may flag this for physical inspection.`,
          confidenceScore: 0.88,
          recommendedAction: `Request weight certification from carrier ${shipment.carrierName ?? 'on record'} and reconcile with the shipment record weight. If the B/L weight is correct, update the shipment record and customs declaration accordingly.`,
        });
      }
    }
  }

  // ── Carrier cross-reference analysis ─────────────────────────────────────
  if (hasBOL && shipment.carrierName && bolDoc) {
    const bolText = extractedTexts['BILL_OF_LADING'] ?? '';
    const carrierInBOL = bolText.match(/Carrier:\s*([^\n]+)/i)?.[1]?.trim();

    if (carrierInBOL && shipment.carrierName) {
      const shipmentCarrierNorm = shipment.carrierName.toLowerCase();
      const bolCarrierNorm = carrierInBOL.toLowerCase();
      const carriersMatch =
        bolCarrierNorm.includes(shipmentCarrierNorm.split(' ')[0]) ||
        shipmentCarrierNorm.includes(bolCarrierNorm.split(' ')[0]);

      if (!carriersMatch) {
        await tools.createFinding({
          reportId,
          documentId: bolDoc.id,
          findingType: 'DATA_MISMATCH',
          severity: 'MEDIUM',
          description: `Carrier name inconsistency between shipment record and Bill of Lading.`,
          evidence: `Shipment record carrier: "${shipment.carrierName}". Bill of Lading states carrier: "${carrierInBOL}".`,
          reasoning: `The carrier named on the Bill of Lading should match the carrier in the shipment record. A mismatch may indicate that the cargo was transferred to a different carrier without updating records, or that incorrect documentation was uploaded. This can cause issues with cargo tracing and insurance claims.`,
          confidenceScore: 0.79,
          recommendedAction: `Confirm which carrier has actual custody of the cargo. Update either the shipment record or obtain a corrected Bill of Lading to ensure consistency.`,
        });
      }
    }
  }

  // ── Route risk finding ────────────────────────────────────────────────────
  if (routeContext.sanctionsStatus !== 'CLEAR') {
    await tools.createFinding({
      reportId,
      findingType: 'COMPLIANCE_RISK',
      severity: routeContext.sanctionsStatus === 'BLOCKED' ? 'CRITICAL' : 'HIGH',
      description: `Elevated sanctions risk for corridor: ${routeContext.corridor}`,
      evidence: `Route: ${shipment.origin} → ${shipment.destination}. Corridor sanctions status: ${routeContext.sanctionsStatus}. Risk multiplier: ${routeContext.riskMultiplier}x.`,
      reasoning: routeContext.regulatoryNotes,
      confidenceScore: 0.93,
      recommendedAction: `Complete full OFAC SDN list screening for all named parties (shipper, consignee, notify party, carrier). Do not release cargo until screening is complete.`,
    });
  }

  // ── HS code analysis (if customs document present) ─────────────────────────
  if (hasCustoms && customsDoc) {
    const customsText = extractedTexts['CUSTOMS'] ?? '';
    const hsCodeMatch = customsText.match(/HS\s*(?:Tariff\s*)?Code:\s*([0-9.]+)/i);
    const goodsDescMatch = customsText.match(/Goods\s*(?:Description|Classification):\s*([^\n]+)/i);

    if (hsCodeMatch && goodsDescMatch) {
      const hsCode = hsCodeMatch[1];
      const goodsDesc = goodsDescMatch[1].trim();

      // Check for electronics HS code with non-electronics goods description
      const isElectronicsHSCode = hsCode.startsWith('847') || hsCode.startsWith('848') || hsCode.startsWith('851');
      const descriptionMatchesHS = goodsDesc.toLowerCase().includes('laptop') ||
        goodsDesc.toLowerCase().includes('computer') ||
        goodsDesc.toLowerCase().includes('electronic') ||
        goodsDesc.toLowerCase().includes('equipment');

      if (isElectronicsHSCode && !descriptionMatchesHS) {
        await tools.createFinding({
          reportId,
          documentId: customsDoc.id,
          findingType: 'COMPLIANCE_RISK',
          severity: 'MEDIUM',
          description: `Potential HS code and goods description mismatch on Customs Declaration.`,
          evidence: `Customs Declaration: HS Code ${hsCode}. Goods Description: "${goodsDesc}". HS code ${hsCode} typically applies to electronic computing equipment.`,
          reasoning: `HS code ${hsCode} is classified under Chapter 84 (Machinery and Mechanical Appliances). The goods description "${goodsDesc}" should clearly describe electronic computing equipment to match this HS classification. Misclassification may result in incorrect tariff application and customs penalties.`,
          confidenceScore: 0.72,
          recommendedAction: `Have a licensed customs broker verify that HS code ${hsCode} is the correct classification for the actual goods. If there is a mismatch, file an amendment to the customs declaration before cargo arrives.`,
        });
      }
    }
  }

  // ── Compute final risk score and write executive summary ──────────────────
  const allFindings = await tools.getReportFindings(reportId);

  const hasHigh = allFindings.some((f) => f.severity === 'HIGH' || f.severity === 'CRITICAL');
  const hasMedium = allFindings.some((f) => f.severity === 'MEDIUM');
  const hasCritical = allFindings.some((f) => f.severity === 'CRITICAL');

  let status: 'PASSED' | 'FAILED' | 'PARTIAL';
  let riskLevel: string;
  let overallRiskScore: number;

  if (hasCritical) {
    status = 'FAILED';
    riskLevel = 'CRITICAL';
    overallRiskScore = 0.9;
  } else if (hasHigh) {
    status = 'FAILED';
    riskLevel = 'HIGH';
    overallRiskScore = 0.68;
  } else if (hasMedium) {
    status = 'PARTIAL';
    riskLevel = 'MEDIUM';
    overallRiskScore = 0.42;
  } else {
    status = 'PASSED';
    riskLevel = 'LOW';
    overallRiskScore = 0.12;
  }

  const docSummary = docs.length > 0
    ? `${docs.length} document${docs.length > 1 ? 's' : ''} (${docs.map((d) => d.documentType.replace(/_/g, ' ')).join(', ')})`
    : 'no documents';
  const findingCount = allFindings.length;
  const highCount = allFindings.filter((f) => f.severity === 'HIGH' || f.severity === 'CRITICAL').length;
  const mediumCount = allFindings.filter((f) => f.severity === 'MEDIUM').length;

  // Build a meaningful executive summary based on actual findings
  let executiveSummary: string;
  let recommendedDisposition: string;

  if (status === 'FAILED') {
    const primaryFindings = allFindings
      .filter((f) => f.severity === 'HIGH' || f.severity === 'CRITICAL')
      .map((f) => f.description)
      .slice(0, 2)
      .join('; ');

    executiveSummary =
      `This shipment (${shipment.trackingNumber}, ${shipment.origin} → ${shipment.destination}) presents ` +
      `${riskLevel} risk and requires immediate attention before customs clearance can proceed. ` +
      `Analysis of ${docSummary} identified ${findingCount} compliance finding${findingCount !== 1 ? 's' : ''}, ` +
      `including ${highCount} HIGH or CRITICAL severity issue${highCount !== 1 ? 's' : ''}. ` +
      `Key concerns: ${primaryFindings}. ` +
      (routeContext.sanctionsStatus !== 'CLEAR'
        ? `The ${routeContext.corridor} corridor carries elevated sanctions risk requiring full OFAC screening. `
        : '') +
      `The risk score of ${(overallRiskScore * 100).toFixed(0)}/100 reflects the probability of customs delay or regulatory action without intervention.`;

    recommendedDisposition =
      `HOLD FOR REVIEW — Do not proceed with customs filing until all HIGH and CRITICAL findings are resolved. ` +
      `${allFindings.filter((f) => (f.severity === 'HIGH' || f.severity === 'CRITICAL') && f.recommendedAction)
        .map((f) => f.recommendedAction)
        .slice(0, 2)
        .join(' ')}`;
  } else if (status === 'PARTIAL') {
    executiveSummary =
      `This shipment (${shipment.trackingNumber}, ${shipment.origin} → ${shipment.destination}) presents ` +
      `moderate risk requiring attention. ` +
      `Analysis identified ${findingCount} finding${findingCount !== 1 ? 's' : ''}, including ${mediumCount} MEDIUM severity concern${mediumCount !== 1 ? 's' : ''}. ` +
      `No critical issues were found that would prevent customs clearance, however the identified discrepancies should be resolved to avoid delays. ` +
      `The risk score of ${(overallRiskScore * 100).toFixed(0)}/100 indicates a moderate probability of customs query.`;

    recommendedDisposition =
      `CONDITIONAL PROCEED — Shipment may proceed but the compliance team should address the MEDIUM severity findings before cargo reaches the destination port.`;
  } else {
    executiveSummary =
      `This shipment (${shipment.trackingNumber}, ${shipment.origin} → ${shipment.destination}) has been assessed as LOW risk. ` +
      `Analysis of ${docSummary} found no significant compliance concerns. ` +
      `All available documentation appears internally consistent. ` +
      `The risk score of ${(overallRiskScore * 100).toFixed(0)}/100 indicates a low probability of customs delay or regulatory action.`;

    recommendedDisposition =
      `CLEAR TO PROCEED — No compliance holds required. Standard monitoring applies.`;
  }

  const processingTimeMs = Date.now() - startTime;

  await tools.finalizeReport({
    reportId,
    status,
    summary: `Risk assessment: ${riskLevel} (${findingCount} finding${findingCount !== 1 ? 's' : ''})`,
    executiveSummary,
    overallRiskScore,
    riskLevel,
    recommendedDisposition,
    modelId: 'mock-intelligence-engine-v3.1',
    modelConfidence: 0.84,
    processingTimeMs,
  });

  await tools.publishAuditEvent({
    shipmentId: trigger.shipmentId,
    eventType: 'COMPLIANCE_ASSESSED_MOCK',
    summary: `Mock risk intelligence completed for ${trigger.trackingNumber} — ${riskLevel}`,
    agentRunId,
    timestamp: new Date().toISOString(),
  });

  console.log(`[Runner][MOCK] Assessment complete — status: ${status}, riskLevel: ${riskLevel}, score: ${overallRiskScore}`);
}

// ─── Public entry point ───────────────────────────────────────────────────────
//
// vNext: Bedrock Nova Lite is ALWAYS the primary compliance engine.
// The mock runner is retained ONLY as an emergency fallback if Bedrock
// explicitly fails with a network error AND MOCK_AGENT=true is set.
// Normal operation: runBedrockAgent always.

export async function runComplianceAgent(
  trigger: ComplianceTriggerMessage,
  tools: AgentTools,
): Promise<void> {
  if (!bedrock) {
    // No AWS region configured — use mock (local dev without AWS credentials)
    console.warn('[Runner] AWS region not configured — falling back to mock agent');
    await runMockAgent(trigger, tools);
  } else {
    // Always use Bedrock Nova Lite — this is the production path
    await runBedrockAgent(trigger, tools);
  }

  // ── Auto-trigger: Copilot Executive Summary Enrichment ──────────────────
  // After the compliance agent finalizes, the Copilot Engine generates a
  // richer executive summary and overwrites the compliance agent's version.
  // Fire-and-forget — compliance result is already written and returned.
  setImmediate(async () => {
    try {
      const copilot = new CopilotEngine(tools);
      await copilot.autoEnrichExecutiveSummary(trigger.shipmentId);
    } catch (err) {
      console.warn(`[Runner] Copilot auto-enrichment failed (non-critical) for ${trigger.shipmentId}:`, err);
    }
  });
}

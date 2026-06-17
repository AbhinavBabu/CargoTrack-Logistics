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
  type ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'crypto';
import { config } from '../config';
import { COMPLIANCE_AGENT_TOOLS, ComplianceTriggerMessage } from './contracts';
import { AgentTools } from './tools';
import { CopilotEngine } from '../copilot/engine';

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

const SYSTEM_PROMPT = `You are the CargoTrack Shipment Risk Intelligence Agent.

You are an expert in international trade compliance, customs regulations, export control, sanctions screening, and logistics risk management. You think like a senior compliance analyst at a global freight forwarder.

YOUR PURPOSE:
Analyze a shipment and its uploaded documents to produce actionable risk intelligence. Your output is used by the compliance team to decide whether to hold, clear, or escalate a shipment.

You must answer the question: "What risks exist for this shipment and what should operations do next?"

YOUR ANALYTICAL APPROACH:
1. Read the full shipment profile to understand the business and risk context.
2. Retrieve the uploaded documents — understand what evidence is available.
3. Get the route risk context to understand corridor-specific regulatory requirements.
4. Read the full text of each document using extract_document_text.
5. Synthesize across ALL documents — look for inconsistencies, gaps, and anomalies.
6. Record every risk finding with evidence, reasoning, confidence, and recommended action.
7. Finalize your assessment with an executive narrative and operational recommendation.

DOCUMENT ANALYSIS PRINCIPLES:
- Read the full document text, not just specific fields
- Look for INTERNAL inconsistencies within a single document
- Look for CROSS-DOCUMENT inconsistencies between documents (weight on BOL vs invoice vs customs)
- Assess whether declared values, weights, descriptions, and HS codes are plausible given the cargo type
- Identify missing documents that are expected for this route and shipment type
- Note any party names that appear inconsistent across documents (entity name matching)
- Flag patterns that may indicate documentation errors, fraud indicators, or regulatory exposure

FOR EVERY FINDING YOU RECORD, PROVIDE:
- evidence: Quote the specific text from the document(s) that triggered this finding
- reasoning: Your analytical chain — why is this a risk? What is the compliance implication?
- confidence_score: Your certainty (0.0 = very uncertain, 1.0 = highly certain)
- recommended_action: A specific, actionable next step for the compliance team

FINAL ASSESSMENT:
Write an executive_summary paragraph that a compliance officer can act on. It should:
- Explain the overall risk profile in plain language
- Summarize key findings and their business implications  
- State clearly whether the shipment should proceed, be held, or be escalated
- Be specific about what needs to happen next

IMPORTANT: You determine what matters. Do not limit yourself to a predefined checklist. A discrepancy you identify through reasoning is more valuable than a field comparison any rule engine could make.`;

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

  const userMessage = `Perform a complete risk intelligence assessment for shipment ID: ${trigger.shipmentId}.

Tracking number: ${trigger.trackingNumber}
Status: ${trigger.newStatus}
Triggered at: ${trigger.triggeredAt}

Report ID (use this for all findings and the final assessment): ${reportId}

Begin by retrieving the shipment profile and uploaded documents. Then get the route risk context. Read the text of each uploaded document. Synthesize your findings and produce a complete risk intelligence report.`;

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
          tools: COMPLIANCE_AGENT_TOOLS.map((t) => ({ toolSpec: t })),
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
        };

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

export async function runComplianceAgent(
  trigger: ComplianceTriggerMessage,
  tools: AgentTools,
): Promise<void> {
  if (config.mockAgent || !bedrock) {
    await runMockAgent(trigger, tools);
  } else {
    await runBedrockAgent(trigger, tools);
  }

  // ── Auto-trigger: Copilot Executive Summary Enrichment ──────────────────
  // After the compliance agent finalizes, the Copilot Engine generates a
  // richer executive summary and overwrites the compliance agent's version.
  // Fire-and-forget — compliance result is already written and returned.
  // Any error here is logged but does not affect the compliance outcome.
  setImmediate(async () => {
    try {
      const copilot = new CopilotEngine(tools);
      await copilot.autoEnrichExecutiveSummary(trigger.shipmentId);
    } catch (err) {
      console.warn(`[Runner] Copilot auto-enrichment failed (non-critical) for ${trigger.shipmentId}:`, err);
    }
  });
}

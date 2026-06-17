//
// CargoTrack — Copilot System Prompts & Context Builders
//
// System prompts define the persona and output format for each capability.
// Context builders assemble shipment data into well-structured user messages.
//
// Key design principle: prompts request JSON output explicitly.
// The CopilotEngine parses the JSON and maps it to typed response objects.
//

import type { ShipmentRecord, DocumentRecord, RouteRiskContext } from '../agent/contracts';

// ─── System Prompts ───────────────────────────────────────────────────────────

export const SYSTEM_PROMPTS = {

  executiveSummary: `You are a logistics intelligence analyst at a global freight forwarder.
Your task is to produce a concise, accurate shipment brief from the provided shipment data and documents.
Write for a senior operations manager — be direct, specific, and actionable.

OUTPUT: Return ONLY valid JSON matching this structure exactly:
{
  "headline": "One sentence describing the shipment, carrier, and current status",
  "goods": "Specific description of the cargo (type, quantity, category)",
  "corridor": "Origin → Destination in full city/country format",
  "carrier": "Carrier name or 'Not specified'",
  "weight": "Weight with unit",
  "keyObservations": ["array of 3-4 factual observations about this shipment"],
  "potentialConcerns": ["array of 2-3 concerns or 'None identified' if clean"],
  "generatedAt": "ISO 8601 timestamp"
}
Do not include markdown, commentary, or any text outside the JSON object.`,

  explainRisk: `You are a senior compliance officer explaining trade compliance risks to an operations manager.
Translate technical compliance findings into clear, business-focused language.
Be specific — reference the actual findings, evidence, and regulatory context provided.

OUTPUT: Return ONLY valid JSON matching this structure exactly:
{
  "explanation": "Multi-paragraph plain English explanation of why this shipment carries its current risk level",
  "topFactors": ["array of 3-4 specific risk factors driving the assessment"],
  "riskDriverSummary": "One sentence identifying the single most important risk driver",
  "generatedAt": "ISO 8601 timestamp"
}
Do not include markdown, commentary, or any text outside the JSON object.`,

  recommendations: `You are a compliance operations specialist generating an action plan.
Produce specific, prioritized, actionable recommendations based on the compliance findings provided.
Each action must be concrete — avoid generic advice.

OUTPUT: Return ONLY valid JSON matching this structure exactly:
{
  "immediateActions": ["array of 2-4 actions to take RIGHT NOW, in priority order"],
  "beforeRelease": ["array of 3-5 items that must be verified before customs release"],
  "escalationRequired": true or false,
  "escalationReason": "string if escalationRequired is true, null if false",
  "timeline": "Plain language description of urgency and deadline",
  "generatedAt": "ISO 8601 timestamp"
}
Do not include markdown, commentary, or any text outside the JSON object.`,

  qna: `You are a shipment intelligence analyst who answers questions about specific shipments.
You have access to the full shipment profile, uploaded documents, and compliance assessment.
Answer questions with specificity — cite which document or data source supports your answer.

OUTPUT: Return ONLY valid JSON matching this structure exactly:
{
  "answer": "Direct, complete answer to the question (2-4 sentences)",
  "sourceReferences": ["array of 1-3 data sources that support this answer"],
  "confidence": 0.0 to 1.0 reflecting your certainty,
  "generatedAt": "ISO 8601 timestamp"
}
Do not include markdown, commentary, or any text outside the JSON object.`,

  similarAnalysis: `You are a trade compliance analyst identifying patterns across historical shipments.
Given a set of similar shipments with their risk outcomes, identify meaningful patterns and repeated risks.
Focus on actionable insights — what should the operator watch for based on history?

OUTPUT: Return ONLY valid JSON matching this structure exactly:
{
  "patterns": ["array of 3-4 observed patterns across the similar shipments"],
  "repeatedRisks": ["array of 2-3 risks that appear repeatedly and warrant a systematic fix"],
  "generatedAt": "ISO 8601 timestamp"
}
Do not include markdown, commentary, or any text outside the JSON object.`,

  timelineNarrative: `You are a logistics coordinator writing a shipment journey narrative for the operations team.
Transform the tracking event log into a readable, chronological story of the shipment's journey.
Be factual and specific — reference actual dates, locations, and status changes from the data.

OUTPUT: Return ONLY valid JSON matching this structure exactly:
{
  "narrative": "2-3 paragraph narrative of the shipment journey so far",
  "milestones": [{"phase": "status label", "description": "what happened at this milestone"}],
  "currentPhase": "CURRENT_STATUS string",
  "estimatedResolution": "Plain language estimate or 'Pending customs clearance' etc.",
  "generatedAt": "ISO 8601 timestamp"
}
Do not include markdown, commentary, or any text outside the JSON object.`,

};

// ─── Context Builders ─────────────────────────────────────────────────────────

/** Formats a ShipmentRecord for inclusion in a prompt */
function formatShipment(s: ShipmentRecord): string {
  return `SHIPMENT PROFILE:
  Tracking Number: ${s.trackingNumber}
  Title: ${(s as any).title ?? 'N/A'}
  Shipper: ${s.senderName}
  Consignee: ${s.receiverName}
  Origin: ${s.origin}
  Destination: ${s.destination}
  Cargo Type: ${s.shipmentType}
  Weight: ${s.weight} KG
  Carrier: ${s.carrierName ?? 'Not specified'}
  Current Status: ${s.status}
  Description: ${s.description ?? 'Not provided'}`;
}

/** Formats a compliance report for prompt context */
function formatReport(report: ReturnType<typeof noop> | null): string {
  if (!report) return 'COMPLIANCE REPORT: Not yet generated';

  const findingLines = report.findings
    .map((f: any) => `  [${f.severity}] ${f.findingType}: ${f.description}${f.evidence ? `\n    Evidence: ${f.evidence}` : ''}${f.reasoning ? `\n    Reasoning: ${f.reasoning}` : ''}`)
    .join('\n');

  return `COMPLIANCE REPORT:
  Status: ${report.status}
  Risk Level: ${report.riskLevel ?? 'N/A'}
  Risk Score: ${report.overallRiskScore != null ? (report.overallRiskScore * 100).toFixed(0) + '/100' : 'N/A'}
  Disposition: ${report.recommendedDisposition ?? 'N/A'}
  Findings (${report.findings.length}):
${findingLines || '  None'}`;
}

function noop(_: any) { return _; }

// ─── Prompt builders ──────────────────────────────────────────────────────────

export function buildSummaryPrompt(
  shipment: ShipmentRecord,
  docs: DocumentRecord[],
  docTexts: Record<string, string>,
  routeContext: RouteRiskContext,
  report: ReturnType<typeof noop> | null,
): string {
  const docSection = docs.length === 0
    ? 'DOCUMENTS: None uploaded'
    : `DOCUMENTS (${docs.length} files):\n${docs.map((d) => {
        const text = docTexts[d.documentType];
        return `  [${d.documentType}] ${d.originalName}\n${text ? `  Text excerpt: ${text.slice(0, 300)}...` : '  Text: unavailable'}`;
      }).join('\n')}`;

  const riskSummary = report
    ? `COMPLIANCE STATUS: ${report.status} | Risk: ${report.riskLevel ?? 'N/A'} | Findings: ${report.findings.length}`
    : 'COMPLIANCE STATUS: Not yet assessed';

  return `${formatShipment(shipment)}

${docSection}

ROUTE CONTEXT:
  Corridor: ${routeContext.corridor}
  Sanctions Status: ${routeContext.sanctionsStatus}
  Risk Multiplier: ${routeContext.riskMultiplier}x
  Regulatory Notes: ${routeContext.regulatoryNotes}

${riskSummary}

Generate a comprehensive executive summary for this shipment.`;
}

export function buildExplainRiskPrompt(
  shipment: ShipmentRecord,
  report: ReturnType<typeof noop> | null,
  routeContext: RouteRiskContext,
): string {
  return `${formatShipment(shipment)}

${formatReport(report)}

ROUTE CONTEXT:
  Corridor: ${routeContext.corridor}
  Sanctions Status: ${routeContext.sanctionsStatus}
  Regulatory Notes: ${routeContext.regulatoryNotes}
  Common Findings for this corridor: ${routeContext.commonFindings?.join(', ') ?? 'N/A'}

Explain in plain language why this shipment has its current risk assessment.
If no compliance report exists yet, explain the inherent risks for this corridor and shipment type.`;
}

export function buildRecommendationsPrompt(
  shipment: ShipmentRecord,
  report: ReturnType<typeof noop> | null,
  routeContext: RouteRiskContext,
): string {
  return `${formatShipment(shipment)}

${formatReport(report)}

ROUTE CONTEXT:
  Corridor: ${routeContext.corridor}
  Sanctions Status: ${routeContext.sanctionsStatus}
  Common Issues: ${routeContext.commonFindings?.join('; ') ?? 'N/A'}

Generate specific operational recommendations for the compliance team.
If no compliance report exists, provide standard pre-clearance checklist for this corridor.`;
}

export function buildQnAPrompt(
  shipment: ShipmentRecord,
  docs: DocumentRecord[],
  docTexts: Record<string, string>,
  report: ReturnType<typeof noop> | null,
  question: string,
): string {
  const docSection = docs.length === 0
    ? 'DOCUMENTS: None uploaded'
    : `DOCUMENTS (${docs.length} files):\n${docs.map((d) => {
        const text = docTexts[d.documentType];
        return `  [${d.documentType}] ${d.originalName}${text ? `\n  Excerpt: ${text.slice(0, 400)}` : ''}`;
      }).join('\n')}`;

  return `${formatShipment(shipment)}

${docSection}

${formatReport(report)}

QUESTION FROM OPERATOR: ${question}

Answer the operator's question using the shipment data, documents, and compliance findings provided above.`;
}

export function buildSimilarAnalysisPrompt(
  shipment: ShipmentRecord,
  similarShipments: Array<{
    trackingNumber: string;
    origin: string;
    destination: string;
    shipmentType: string;
    riskLevel: string | null;
    status: string;
    findingTypes: string[];
    createdAt: Date;
  }>,
): string {
  const similarSection = similarShipments.map((s, i) =>
    `  ${i + 1}. ${s.trackingNumber} | ${s.origin} → ${s.destination} | Risk: ${s.riskLevel ?? 'N/A'} | Status: ${s.status} | Findings: ${s.findingTypes.join(', ') || 'none'}`
  ).join('\n');

  return `CURRENT SHIPMENT:
  Tracking: ${shipment.trackingNumber}
  Route: ${shipment.origin} → ${shipment.destination}
  Type: ${shipment.shipmentType}
  Weight: ${shipment.weight} KG

SIMILAR HISTORICAL SHIPMENTS (${similarShipments.length} found):
${similarSection}

Analyze the patterns across these historical shipments and identify what the operator should watch for.`;
}

export function buildTimelineNarrativePrompt(
  shipment: ShipmentRecord,
  trackingEvents: Array<{
    status: string;
    location: string | null;
    description: string;
    timestamp: Date;
  }>,
): string {
  const eventsSection = trackingEvents.length === 0
    ? 'TRACKING EVENTS: No events recorded yet'
    : `TRACKING EVENTS (${trackingEvents.length} entries):\n${trackingEvents.map((e) =>
        `  ${e.timestamp.toISOString().slice(0, 16)} | ${e.status.replace(/_/g, ' ')} | ${e.location ?? 'Location not specified'} | ${e.description}`
      ).join('\n')}`;

  return `SHIPMENT:
  Tracking: ${shipment.trackingNumber}
  Shipper: ${shipment.senderName} → ${shipment.receiverName}
  Route: ${shipment.origin} → ${shipment.destination}
  Type: ${shipment.shipmentType}
  Weight: ${shipment.weight} KG
  Current Status: ${shipment.status}

${eventsSection}

Write a natural language narrative of this shipment's journey from origin to its current state.`;
}

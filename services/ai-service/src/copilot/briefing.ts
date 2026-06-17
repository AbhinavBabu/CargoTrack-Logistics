//
// CargoTrack — Route Intelligence Briefing Engine (Knowledge-Base Enhanced)
//
// Generates an instant AI route intelligence briefing for a shipment
// using a single Amazon Nova Lite call (no tool loop needed).
//
// v2: Now catalog-grounded. Before calling Nova, we:
//   1. Load route, sanctions, DG, HS, and Incoterms context from the knowledge base
//   2. Inject this as authoritative context into Nova's prompt
//   3. Ask Nova to REASON over the catalog data — not just rely on training
//
// This makes every briefing claim verifiable against our structured catalogs.
//

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config';
import type { AgentTools } from '../agent/tools';
import KnowledgeBase from '../knowledge/knowledge-base';

// ─── Response type ────────────────────────────────────────────────────────────

export interface RouteBriefingResponse {
  corridor: string;
  riskSummary: string;
  requiredDocuments: string[];
  customsComplexity: 'LOW' | 'MEDIUM' | 'HIGH';
  sanctionsStatus: 'CLEAR' | 'WATCH' | 'BLOCKED';
  estimatedClearanceHours: number;
  delayProbability: number;
  keyRisks: string[];
  regulatoryNotes: string;
  knowledgeSources: string[];
  knowledgeConfidence: string;
  modelId: string;
  generatedAt: string;
}

// ─── System prompt ────────────────────────────────────────────────────────────

const BRIEFING_SYSTEM_PROMPT = `You are a logistics route intelligence specialist at a global freight forwarder.
You provide concise, accurate route intelligence briefings that help operations teams understand
the compliance requirements, risks, and complexity of a shipping corridor before processing begins.

Your briefings are relied upon by:
- Compliance analysts who need to know what documents are required
- Operations managers who need to anticipate delays and complexity
- Risk officers who need to know if a corridor has sanctions or regulatory exposure

CRITICAL: You will be given CATALOG-GROUNDED CONTEXT from our logistics intelligence knowledge base.
This context contains authoritative information about the specific corridor, sanctions, HS codes, DG classification, and Incoterms.

Rules:
1. Your analysis MUST be consistent with the catalog data provided
2. When listing required documents, use the specific documents from the catalog, supplemented by your expertise
3. When assessing sanctions risk, use the catalog's sanctions level — do not downgrade it
4. When quoting clearance times or delay probabilities, start from the catalog baseline and adjust for specific shipment factors
5. Your keyRisks must be SPECIFIC to this shipment — reference actual catalog findings
6. Be specific, accurate, and actionable. Do not be vague.`;

// ─── Bedrock client ───────────────────────────────────────────────────────────

const bedrock = config.region
  ? new BedrockRuntimeClient({ region: config.region })
  : null;

// ─── Mock briefing (no AWS region configured) — now catalog-grounded ──────────

function generateMockBriefing(
  origin: string,
  destination: string,
  shipmentType: string,
  commodityType: string | null,
  isDangerousGoods: boolean,
  incoterms: string | null,
  hsCodeHint: string | null,
  knowledgeSources: string[],
  knowledgeConfidence: string,
): RouteBriefingResponse {
  // Even in mock mode, use catalog for basic facts
  const ctx = KnowledgeBase.buildGroundedContext({
    origin, destination, commodityType, hsCodeHint, incoterms, isDangerousGoods, shipmentType,
  });

  const route = ctx.route;
  const sanctions = ctx.sanctions;
  const dg = ctx.dg;

  // Determine sanctions status from catalog
  const sanctionsStatus: 'CLEAR' | 'WATCH' | 'BLOCKED' =
    sanctions.destinationRisk === 'CRITICAL' || sanctions.originRisk === 'CRITICAL' ? 'BLOCKED' :
    sanctions.destinationRisk === 'HIGH' || sanctions.originRisk === 'HIGH' ? 'WATCH' :
    sanctions.circumventionHubWarning ? 'WATCH' : 'CLEAR';

  // Build required documents from catalog
  const requiredDocs = [
    ...new Set([
      ...(route.requiredDocumentsExport || []),
      ...(route.requiredDocumentsImport || []),
      ...(dg.detected ? (dg.requiredDocuments || []) : []),
    ])
  ].slice(0, 8);

  const keyRisks: string[] = [];
  if (sanctionsStatus !== 'CLEAR') keyRisks.push(`Sanctions exposure: ${route.sanctionsNotes.slice(0, 100)}`);
  if (dg.detected) keyRisks.push(`DG Class ${dg.class} (${dg.label}): ${dg.airFreightStatus} by air`);
  if (route.customsComplexity === 'HIGH') keyRisks.push(`High customs complexity — ${route.estimatedClearanceHoursImport}h import clearance typical`);
  if (route.specialRequirements.length > 0) keyRisks.push(route.specialRequirements[0]);
  if (route.routeRestrictions.length > 0) keyRisks.push(`Route restriction: ${route.routeRestrictions[0]}`);
  if (keyRisks.length === 0) keyRisks.push('Standard compliance checks apply for this corridor');

  return {
    corridor: route.corridorLabel,
    riskSummary: `${route.corridorLabel}: ${route.customsComplexity} customs complexity, ${Math.round(route.delayProbabilityBaseline * 100)}% baseline delay probability. ${route.sanctionsNotes.slice(0, 150)}`,
    requiredDocuments: requiredDocs.length > 0 ? requiredDocs : ['Commercial Invoice', 'Packing List', 'Bill of Lading'],
    customsComplexity: route.customsComplexity as 'LOW' | 'MEDIUM' | 'HIGH',
    sanctionsStatus,
    estimatedClearanceHours: route.estimatedClearanceHoursImport || 24,
    delayProbability: route.delayProbabilityBaseline || 0.2,
    keyRisks,
    regulatoryNotes: `Regulatory bodies: ${route.regulatoryBodies.join(', ')}. ${route.tariffNotes || ''}`,
    knowledgeSources: ctx.knowledgeSources,
    knowledgeConfidence: ctx.knowledgeConfidence,
    modelId: 'catalog-grounded-mock',
    generatedAt: new Date().toISOString(),
  };
}

// ─── Nova Lite briefing generation — catalog-grounded ─────────────────────────

async function generateBedrockBriefing(
  shipment: {
    origin: string;
    destination: string;
    shipmentType: string;
    weight: number;
    commodityType: string | null;
    hsCodeHint: string | null;
    incoterms: string | null;
    isDangerousGoods: boolean;
    declaredValue: number | null;
    carrierName: string | null;
    description?: string | null;
  }
): Promise<RouteBriefingResponse & { knowledgeSources: string[]; knowledgeConfidence: string }> {
  if (!bedrock) {
    throw new Error('Bedrock client not initialized');
  }

  // Build and format catalog context for this shipment
  const ctx = KnowledgeBase.buildGroundedContext(shipment);
  const catalogContext = KnowledgeBase.formatContextForPrompt(ctx, shipment);

  const userMessage = `${catalogContext}

SHIPMENT DETAILS:
Origin: ${shipment.origin}
Destination: ${shipment.destination}
Shipment Type: ${shipment.shipmentType}
Weight: ${shipment.weight} kg
Commodity Type: ${shipment.commodityType || 'Not specified'}
HS Code Hint: ${shipment.hsCodeHint || 'Not provided'}
Incoterms: ${shipment.incoterms || 'Not specified'}
Declared Value: ${shipment.declaredValue ? `USD ${shipment.declaredValue.toLocaleString()}` : 'Not declared'}
Dangerous Goods Declared: ${shipment.isDangerousGoods ? 'YES' : 'Not declared'}
Carrier: ${shipment.carrierName || 'Not specified'}

Using the catalog-grounded intelligence above as your authoritative source, generate a route intelligence briefing.

Respond ONLY with a valid JSON object in this exact structure (no markdown, no explanation):
{
  "corridor": "use the corridor label from the catalog",
  "riskSummary": "2-3 sentence summary of the route risk profile, citing specific catalog findings",
  "requiredDocuments": ["list specific documents from catalog + any shipment-specific additions"],
  "customsComplexity": "LOW|MEDIUM|HIGH — match the catalog value unless specific shipment factors justify upgrading",
  "sanctionsStatus": "CLEAR|WATCH|BLOCKED — must be consistent with catalog sanctions risk",
  "estimatedClearanceHours": ${ctx.route.estimatedClearanceHoursImport},
  "delayProbability": ${ctx.route.delayProbabilityBaseline},
  "keyRisks": ["3-5 specific risks from the catalog context relevant to THIS shipment"],
  "regulatoryNotes": "2-3 sentences citing specific regulatory requirements from catalog, trade agreements, and regulatory bodies"
}

Rules:
- sanctionsStatus must be BLOCKED if catalog shows CRITICAL, WATCH if ELEVATED or HIGH, CLEAR if LOW
- requiredDocuments must include all documents from the catalog, plus any cargo-specific additions
- keyRisks must reference specific catalog findings (e.g., BIS Entity List, Section 301, GACC registration, DG class)
- Do not invent requirements not in the catalog or your expertise — if uncertain, reference the catalog entry`;

  const command = new ConverseCommand({
    modelId: config.bedrockModelId,
    system: [{ text: BRIEFING_SYSTEM_PROMPT }],
    messages: [{ role: 'user', content: [{ text: userMessage }] }],
    inferenceConfig: {
      maxTokens: 1500,
      temperature: 0.15, // Very low — catalog grounding requires consistent factual output
    },
  });

  const response = await bedrock.send(command);

  const rawText = response.output?.message?.content
    ?.filter((b) => 'text' in b)
    .map((b) => ('text' in b ? b.text : ''))
    .join('') ?? '';

  // Parse JSON from response
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Briefing: Nova response did not contain valid JSON. Raw: ${rawText.slice(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);

  return {
    corridor:               parsed.corridor || ctx.route.corridorLabel,
    riskSummary:            parsed.riskSummary || 'Route intelligence generated from catalog.',
    requiredDocuments:      Array.isArray(parsed.requiredDocuments) ? parsed.requiredDocuments : ctx.route.requiredDocumentsImport,
    customsComplexity:      (['LOW', 'MEDIUM', 'HIGH'].includes(parsed.customsComplexity) ? parsed.customsComplexity : ctx.route.customsComplexity) as 'LOW' | 'MEDIUM' | 'HIGH',
    sanctionsStatus:        (['CLEAR', 'WATCH', 'BLOCKED'].includes(parsed.sanctionsStatus) ? parsed.sanctionsStatus : 'CLEAR') as 'CLEAR' | 'WATCH' | 'BLOCKED',
    estimatedClearanceHours: typeof parsed.estimatedClearanceHours === 'number' ? parsed.estimatedClearanceHours : ctx.route.estimatedClearanceHoursImport,
    delayProbability:       typeof parsed.delayProbability === 'number' ? Math.min(1.0, Math.max(0.0, parsed.delayProbability)) : ctx.route.delayProbabilityBaseline,
    keyRisks:               Array.isArray(parsed.keyRisks) ? parsed.keyRisks : [],
    regulatoryNotes:        parsed.regulatoryNotes || '',
    knowledgeSources:       ctx.knowledgeSources,
    knowledgeConfidence:    ctx.knowledgeConfidence,
    modelId:                config.bedrockModelId,
    generatedAt:            new Date().toISOString(),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export class BriefingEngine {
  constructor(private tools: AgentTools) {}

  /**
   * Generate and persist a catalog-grounded route intelligence briefing for a shipment.
   * Called immediately on shipment creation.
   * Uses Nova Lite for a single-call, fast response (2-4 seconds).
   *
   * v2: Knowledge base context is injected into every call.
   * All claims are grounded in structured catalogs, not training knowledge alone.
   */
  async generateBriefing(shipmentId: string): Promise<RouteBriefingResponse> {
    const shipment = await this.tools.getShipment(shipmentId);
    if (!shipment) {
      throw new Error(`Shipment ${shipmentId} not found`);
    }

    console.log(`[Briefing] Generating catalog-grounded route intelligence for ${shipment.trackingNumber} (${shipment.origin} → ${shipment.destination})`);

    let briefing: RouteBriefingResponse;

    if (!bedrock) {
      console.log('[Briefing] No Bedrock client — using catalog-grounded mock briefing');
      const ctx = KnowledgeBase.buildGroundedContext(shipment);
      briefing = generateMockBriefing(
        shipment.origin,
        shipment.destination,
        shipment.shipmentType,
        shipment.commodityType,
        shipment.isDangerousGoods,
        shipment.incoterms,
        shipment.hsCodeHint,
        ctx.knowledgeSources,
        ctx.knowledgeConfidence,
      );
    } else {
      try {
        briefing = await generateBedrockBriefing(shipment);
      } catch (err) {
        console.error('[Briefing] Bedrock call failed, using catalog-grounded mock fallback:', err);
        const ctx = KnowledgeBase.buildGroundedContext(shipment);
        briefing = generateMockBriefing(
          shipment.origin,
          shipment.destination,
          shipment.shipmentType,
          shipment.commodityType,
          shipment.isDangerousGoods,
          shipment.incoterms,
          shipment.hsCodeHint,
          ctx.knowledgeSources,
          ctx.knowledgeConfidence,
        );
      }
    }

    // Persist to database
    await this.tools.saveBriefing(shipmentId, {
      corridor:                briefing.corridor,
      riskSummary:             briefing.riskSummary,
      requiredDocuments:       briefing.requiredDocuments,
      customsComplexity:       briefing.customsComplexity,
      sanctionsStatus:         briefing.sanctionsStatus,
      estimatedClearanceHours: briefing.estimatedClearanceHours,
      delayProbability:        briefing.delayProbability,
      keyRisks:                briefing.keyRisks,
      regulatoryNotes:         briefing.regulatoryNotes,
      modelId:                 briefing.modelId,
    });

    console.log(`[Briefing] Complete for ${shipment.trackingNumber}: ${briefing.sanctionsStatus} | ${briefing.customsComplexity} complexity | confidence: ${briefing.knowledgeConfidence} | sources: ${briefing.knowledgeSources.length}`);
    return briefing;
  }

  /**
   * Retrieve an existing briefing for a shipment.
   */
  async getBriefing(shipmentId: string): Promise<RouteBriefingResponse | null> {
    const b = await this.tools.getBriefing(shipmentId);
    if (!b) return null;
    return {
      corridor:               b.corridor,
      riskSummary:            b.riskSummary,
      requiredDocuments:      b.requiredDocuments,
      customsComplexity:      (b.customsComplexity as any) || 'MEDIUM',
      sanctionsStatus:        (b.sanctionsStatus as any) || 'CLEAR',
      estimatedClearanceHours: b.estimatedClearanceHours || 24,
      delayProbability:       b.delayProbability || 0.2,
      keyRisks:               b.keyRisks,
      regulatoryNotes:        b.regulatoryNotes || '',
      knowledgeSources:       [],  // Historical briefings: sources not persisted separately
      knowledgeConfidence:    'MEDIUM',
      modelId:                b.modelId || config.bedrockModelId,
      generatedAt:            b.generatedAt.toISOString(),
    };
  }
}

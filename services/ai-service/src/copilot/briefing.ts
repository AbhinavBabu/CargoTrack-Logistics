//
// CargoTrack — Route Intelligence Briefing Engine
//
// Generates an instant AI route intelligence briefing for a shipment
// using a single Amazon Nova Lite call (no tool loop needed).
//
// The briefing is generated as soon as a shipment is created,
// giving the compliance team immediate route context before
// any documents are uploaded.
//
// Output is stored in ShipmentAIBriefing table (written directly to Postgres).
//

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config';
import type { AgentTools } from '../agent/tools';

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

Be specific, accurate, and actionable. Do not be vague. If a route is clear, say so clearly.
If a route has risks, name them specifically with the regulatory context.`;

// ─── Bedrock client ───────────────────────────────────────────────────────────

const bedrock = config.region
  ? new BedrockRuntimeClient({ region: config.region })
  : null;

// ─── Mock briefing (no AWS region configured) ─────────────────────────────────

function generateMockBriefing(
  origin: string,
  destination: string,
  shipmentType: string,
  commodityType: string | null,
): RouteBriefingResponse {
  const isInternational = !origin.split(',').slice(-1)[0]?.trim().includes(
    destination.split(',').slice(-1)[0]?.trim() ?? ''
  );

  const reqDocs = isInternational
    ? ['Commercial Invoice', 'Bill of Lading', 'Packing List', 'Customs Declaration']
    : ['Commercial Invoice', 'Packing List', 'Proof of Delivery'];

  return {
    corridor: `${origin} → ${destination}`,
    riskSummary: `${isInternational ? 'International' : 'Domestic'} ${shipmentType} shipment via ${origin} → ${destination}. Standard compliance requirements apply${commodityType ? ` for ${commodityType} cargo` : ''}.`,
    requiredDocuments: reqDocs,
    customsComplexity: isInternational ? 'MEDIUM' : 'LOW',
    sanctionsStatus: 'CLEAR',
    estimatedClearanceHours: isInternational ? 24 : 4,
    delayProbability: isInternational ? 0.25 : 0.08,
    keyRisks: isInternational
      ? ['Missing customs documentation', 'HS code verification required', 'Consignee EORI number needed']
      : ['Standard domestic compliance checks'],
    regulatoryNotes: `${isInternational ? 'International shipment requires customs clearance at destination country. Ensure all documentation is complete before cargo departure.' : 'Domestic shipment subject to standard carrier and road transport regulations.'}`,
    modelId: 'mock-briefing-engine',
    generatedAt: new Date().toISOString(),
  };
}

// ─── Nova Lite briefing generation ───────────────────────────────────────────

async function generateBedrockBriefing(
  origin: string,
  destination: string,
  shipmentType: string,
  weight: number,
  commodityType: string | null,
  incoterms: string | null,
  isDangerousGoods: boolean,
): Promise<RouteBriefingResponse> {
  if (!bedrock) {
    throw new Error('Bedrock client not initialized');
  }

  const userMessage = `Generate a route intelligence briefing for this shipment:

Origin: ${origin}
Destination: ${destination}
Shipment Type: ${shipmentType}
Weight: ${weight} kg
Commodity Type: ${commodityType || 'Not specified'}
Incoterms: ${incoterms || 'Not specified'}
Dangerous Goods: ${isDangerousGoods ? 'YES' : 'Not declared'}

Respond ONLY with a valid JSON object in this exact structure (no markdown, no explanation):
{
  "corridor": "origin → destination corridor name",
  "riskSummary": "2-3 sentence summary of the route risk profile and main compliance considerations",
  "requiredDocuments": ["list", "of", "required", "document", "types"],
  "customsComplexity": "LOW|MEDIUM|HIGH",
  "sanctionsStatus": "CLEAR|WATCH|BLOCKED",
  "estimatedClearanceHours": 24,
  "delayProbability": 0.25,
  "keyRisks": ["specific risk 1", "specific risk 2", "specific risk 3"],
  "regulatoryNotes": "Detailed regulatory context for this corridor: specific customs requirements, known bottlenecks, special permits needed, relevant trade agreements."
}

Rules:
- requiredDocuments: list the actual document names required for this route and cargo type
- customsComplexity: LOW=straightforward domestic/simple bilateral, MEDIUM=standard international, HIGH=complex regulatory environment or sanctions-adjacent
- sanctionsStatus: CLEAR=no known issues, WATCH=adjacent to sanctioned territory or heightened screening required, BLOCKED=sanctions apply
- estimatedClearanceHours: realistic customs clearance time for this corridor (number only)
- delayProbability: probability of shipping delay due to regulatory/compliance issues (0.0-1.0)
- keyRisks: 3-5 specific actionable risks, not generic statements
- regulatoryNotes: 2-3 sentences with specific regulatory details`;

  const command = new ConverseCommand({
    modelId: config.bedrockModelId,
    system: [{ text: BRIEFING_SYSTEM_PROMPT }],
    messages: [{ role: 'user', content: [{ text: userMessage }] }],
    inferenceConfig: {
      maxTokens: 1200,
      temperature: 0.2,  // Low temperature for consistent, factual output
    },
  });

  const response = await bedrock.send(command);

  const rawText = response.output?.message?.content
    ?.filter((b) => 'text' in b)
    .map((b) => ('text' in b ? b.text : ''))
    .join('') ?? '';

  // Parse JSON from response — Nova often adds markdown fences even when asked not to
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Briefing: Nova response did not contain valid JSON. Raw: ${rawText.slice(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);

  return {
    corridor: parsed.corridor || `${origin} → ${destination}`,
    riskSummary: parsed.riskSummary || 'Route intelligence generated.',
    requiredDocuments: Array.isArray(parsed.requiredDocuments) ? parsed.requiredDocuments : [],
    customsComplexity: ['LOW', 'MEDIUM', 'HIGH'].includes(parsed.customsComplexity)
      ? parsed.customsComplexity : 'MEDIUM',
    sanctionsStatus: ['CLEAR', 'WATCH', 'BLOCKED'].includes(parsed.sanctionsStatus)
      ? parsed.sanctionsStatus : 'CLEAR',
    estimatedClearanceHours: typeof parsed.estimatedClearanceHours === 'number'
      ? parsed.estimatedClearanceHours : 24,
    delayProbability: typeof parsed.delayProbability === 'number'
      ? Math.min(1.0, Math.max(0.0, parsed.delayProbability)) : 0.2,
    keyRisks: Array.isArray(parsed.keyRisks) ? parsed.keyRisks : [],
    regulatoryNotes: parsed.regulatoryNotes || '',
    modelId: config.bedrockModelId,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export class BriefingEngine {
  constructor(private tools: AgentTools) {}

  /**
   * Generate and persist a route intelligence briefing for a shipment.
   * Called immediately on shipment creation.
   * Uses Nova Lite for a single-call, fast response (2-4 seconds).
   */
  async generateBriefing(shipmentId: string): Promise<RouteBriefingResponse> {
    const shipment = await this.tools.getShipment(shipmentId);
    if (!shipment) {
      throw new Error(`Shipment ${shipmentId} not found`);
    }

    console.log(`[Briefing] Generating route intelligence for ${shipment.trackingNumber} (${shipment.origin} → ${shipment.destination})`);

    let briefing: RouteBriefingResponse;

    if (!bedrock) {
      console.log('[Briefing] No Bedrock client — using mock briefing');
      briefing = generateMockBriefing(
        shipment.origin,
        shipment.destination,
        shipment.shipmentType,
        shipment.commodityType,
      );
    } else {
      try {
        briefing = await generateBedrockBriefing(
          shipment.origin,
          shipment.destination,
          shipment.shipmentType,
          shipment.weight,
          shipment.commodityType,
          shipment.incoterms,
          shipment.isDangerousGoods,
        );
      } catch (err) {
        console.error('[Briefing] Bedrock call failed, using mock fallback:', err);
        briefing = generateMockBriefing(
          shipment.origin,
          shipment.destination,
          shipment.shipmentType,
          shipment.commodityType,
        );
      }
    }

    // Persist to database
    await this.tools.saveBriefing(shipmentId, {
      corridor: briefing.corridor,
      riskSummary: briefing.riskSummary,
      requiredDocuments: briefing.requiredDocuments,
      customsComplexity: briefing.customsComplexity,
      sanctionsStatus: briefing.sanctionsStatus,
      estimatedClearanceHours: briefing.estimatedClearanceHours,
      delayProbability: briefing.delayProbability,
      keyRisks: briefing.keyRisks,
      regulatoryNotes: briefing.regulatoryNotes,
      modelId: briefing.modelId,
    });

    console.log(`[Briefing] Route intelligence complete for ${shipment.trackingNumber}: ${briefing.sanctionsStatus} | ${briefing.customsComplexity} complexity`);
    return briefing;
  }

  /**
   * Retrieve an existing briefing for a shipment.
   */
  async getBriefing(shipmentId: string): Promise<RouteBriefingResponse | null> {
    const b = await this.tools.getBriefing(shipmentId);
    if (!b) return null;
    return {
      corridor: b.corridor,
      riskSummary: b.riskSummary,
      requiredDocuments: b.requiredDocuments,
      customsComplexity: (b.customsComplexity as any) || 'MEDIUM',
      sanctionsStatus: (b.sanctionsStatus as any) || 'CLEAR',
      estimatedClearanceHours: b.estimatedClearanceHours || 24,
      delayProbability: b.delayProbability || 0.2,
      keyRisks: b.keyRisks,
      regulatoryNotes: b.regulatoryNotes || '',
      modelId: b.modelId || config.bedrockModelId,
      generatedAt: b.generatedAt.toISOString(),
    };
  }
}

//
// CargoTrack — Shipment Intelligence Copilot Engine
//
// Provides 7 distinct AI capabilities on top of the Risk Intelligence Engine.
// Each capability is a single async method that:
//   1. Fetches all necessary data via AgentTools (read-only)
//   2. Builds a rich context string (prompt building in prompts.ts)
//   3. Makes ONE Converse call via the LLMProvider (no tool loop)
//   4. Parses and returns a typed response
//
// Design principles:
//   - No tool loop — all data is pre-fetched before the LLM call
//   - Stateless — each call is independent (no conversation history stored)
//   - Provider-agnostic — uses LLMProvider abstraction (Bedrock / Gemini / Mock)
//   - Read-only except updateExecutiveSummary (auto-trigger only)
//   - Every capability has a mock path via MockLLMProvider
//

import { getLLMProvider } from '../llm/provider';
import type { AgentTools } from '../agent/tools';
import {
  buildSummaryPrompt,
  buildExplainRiskPrompt,
  buildRecommendationsPrompt,
  buildQnAPrompt,
  buildSimilarAnalysisPrompt,
  buildTimelineNarrativePrompt,
  SYSTEM_PROMPTS,
} from './prompts';

// ─── Response types ───────────────────────────────────────────────────────────

export interface ExecutiveSummaryResponse {
  headline: string;
  goods: string;
  corridor: string;
  carrier: string;
  weight: string;
  keyObservations: string[];
  potentialConcerns: string[];
  generatedAt: string;
  providerName?: string;
}

export interface ExplainRiskResponse {
  explanation: string;
  topFactors: string[];
  riskDriverSummary: string;
  generatedAt: string;
  providerName?: string;
}

export interface RecommendationsResponse {
  immediateActions: string[];
  beforeRelease: string[];
  escalationRequired: boolean;
  escalationReason: string | null;
  timeline: string;
  generatedAt: string;
  providerName?: string;
}

export interface QnAResponse {
  answer: string;
  sourceReferences: string[];
  confidence: number;
  generatedAt: string;
  providerName?: string;
}

export interface SimilarShipmentEntry {
  trackingNumber: string;
  origin: string;
  destination: string;
  shipmentType: string;
  riskLevel: string | null;
  status: string;
  findingTypes: string[];
}

export interface SimilarAnalysisResponse {
  similarShipments: SimilarShipmentEntry[];
  patterns: string[];
  repeatedRisks: string[];
  generatedAt: string;
  providerName?: string;
}

export interface TimelineNarrativeMilestone {
  phase: string;
  description: string;
}

export interface TimelineNarrativeResponse {
  narrative: string;
  milestones: TimelineNarrativeMilestone[];
  currentPhase: string;
  estimatedResolution: string;
  generatedAt: string;
  providerName?: string;
}

// ─── Engine class ─────────────────────────────────────────────────────────────

export class CopilotEngine {
  constructor(private tools: AgentTools) {}

  // ── Capability 1: Executive Summary ────────────────────────────────────────
  //
  // Produces a rich, natural-language shipment brief from profile + documents.
  // Auto-triggered after compliance report completion AND available on-demand.

  async generateExecutiveSummary(shipmentId: string): Promise<ExecutiveSummaryResponse> {
    const provider = await getLLMProvider();

    const [shipment, docs, report] = await Promise.all([
      this.tools.getShipment(shipmentId),
      this.tools.getDocuments(shipmentId),
      this.tools.getExistingReport(shipmentId),
    ]);

    if (!shipment) throw new Error(`Shipment ${shipmentId} not found`);

    // Extract document texts for context — run in parallel to avoid N×Textract-latency
    const docTexts: Record<string, string> = {};
    const extractions = await Promise.all(docs.map((doc) => this.tools.extractDocumentText(doc)));
    for (let i = 0; i < docs.length; i++) {
      docTexts[docs[i].documentType] = extractions[i].rawText.slice(0, 800);
    }

    const routeContext = this.tools.getRouteRiskContext(
      shipment.origin, shipment.destination, shipment.shipmentType
    );

    const userPrompt = buildSummaryPrompt(shipment, docs, docTexts, routeContext, report);

    const response = await provider.chat({
      system: SYSTEM_PROMPTS.executiveSummary,
      messages: [{ role: 'user', text: userPrompt }],
      temperature: 0.3,
      maxTokens: 1024,
    });

    const parsed = this.parseJSON<ExecutiveSummaryResponse>(response.text, {
      headline: 'Shipment intelligence summary generated',
      goods: shipment.description ?? shipment.shipmentType,
      corridor: `${shipment.origin} → ${shipment.destination}`,
      carrier: shipment.carrierName ?? 'Not specified',
      weight: `${shipment.weight} KG`,
      keyObservations: ['Compliance screening has been performed'],
      potentialConcerns: [],
      generatedAt: new Date().toISOString(),
    });

    return { ...parsed, providerName: provider.providerName };
  }

  // ── Capability 2: Explain Risk ──────────────────────────────────────────────
  //
  // Translates technical compliance findings into plain English.
  // Requires a compliance report to exist.

  async explainRisk(shipmentId: string): Promise<ExplainRiskResponse> {
    const provider = await getLLMProvider();

    const [shipment, report] = await Promise.all([
      this.tools.getShipment(shipmentId),
      this.tools.getExistingReport(shipmentId),
    ]);

    if (!shipment) throw new Error(`Shipment ${shipmentId} not found`);

    const routeContext = this.tools.getRouteRiskContext(
      shipment.origin, shipment.destination, shipment.shipmentType
    );

    const userPrompt = buildExplainRiskPrompt(shipment, report, routeContext);

    const response = await provider.chat({
      system: SYSTEM_PROMPTS.explainRisk,
      messages: [{ role: 'user', text: userPrompt }],
      temperature: 0.2,
      maxTokens: 1024,
    });

    const parsed = this.parseJSON<ExplainRiskResponse>(response.text, {
      explanation: report?.executiveSummary ?? 'No compliance report available for this shipment.',
      topFactors: [],
      riskDriverSummary: report?.riskLevel ? `Risk level: ${report.riskLevel}` : 'Risk assessment pending',
      generatedAt: new Date().toISOString(),
    });

    return { ...parsed, providerName: provider.providerName };
  }

  // ── Capability 3: Operational Recommendations ───────────────────────────────
  //
  // Produces a holistic action plan for the operations/compliance team.
  // Requires a compliance report to exist.

  async getRecommendations(shipmentId: string): Promise<RecommendationsResponse> {
    const provider = await getLLMProvider();

    const [shipment, report] = await Promise.all([
      this.tools.getShipment(shipmentId),
      this.tools.getExistingReport(shipmentId),
    ]);

    if (!shipment) throw new Error(`Shipment ${shipmentId} not found`);

    const routeContext = this.tools.getRouteRiskContext(
      shipment.origin, shipment.destination, shipment.shipmentType
    );

    const userPrompt = buildRecommendationsPrompt(shipment, report, routeContext);

    const response = await provider.chat({
      system: SYSTEM_PROMPTS.recommendations,
      messages: [{ role: 'user', text: userPrompt }],
      temperature: 0.2,
      maxTokens: 1024,
    });

    const parsed = this.parseJSON<RecommendationsResponse>(response.text, {
      immediateActions: ['Review compliance findings before proceeding'],
      beforeRelease: ['Verify all documentation is complete'],
      escalationRequired: false,
      escalationReason: null,
      timeline: 'Standard processing timeline',
      generatedAt: new Date().toISOString(),
    });

    return { ...parsed, providerName: provider.providerName };
  }

  // ── Capability 4: Shipment Q&A ──────────────────────────────────────────────
  //
  // Stateless free-form question answering about the shipment.
  // Each call is independent — no conversation history stored.

  async askQuestion(shipmentId: string, question: string): Promise<QnAResponse> {
    const provider = await getLLMProvider();

    const [shipment, docs, report] = await Promise.all([
      this.tools.getShipment(shipmentId),
      this.tools.getDocuments(shipmentId),
      this.tools.getExistingReport(shipmentId),
    ]);

    if (!shipment) throw new Error(`Shipment ${shipmentId} not found`);

    // Get doc texts for context — run in parallel to avoid N×Textract-latency
    const docTexts: Record<string, string> = {};
    const extractions = await Promise.all(docs.map((doc) => this.tools.extractDocumentText(doc)));
    for (let i = 0; i < docs.length; i++) {
      docTexts[docs[i].documentType] = extractions[i].rawText.slice(0, 600);
    }

    const userPrompt = buildQnAPrompt(shipment, docs, docTexts, report, question);

    const response = await provider.chat({
      system: SYSTEM_PROMPTS.qna,
      messages: [{ role: 'user', text: userPrompt }],
      temperature: 0.2,
      maxTokens: 800,
    });

    const parsed = this.parseJSON<QnAResponse>(response.text, {
      answer: 'I was unable to generate an answer for that question at this time. Please review the compliance findings directly.',
      sourceReferences: [],
      confidence: 0.5,
      generatedAt: new Date().toISOString(),
    });

    return { ...parsed, providerName: provider.providerName };
  }

  // ── Capability 5: Similar Shipment Analysis ─────────────────────────────────
  //
  // SQL-based similarity retrieval + LLM pattern analysis.
  // No vector DB, no embeddings.

  async analyzeSimilarShipments(shipmentId: string): Promise<SimilarAnalysisResponse> {
    const provider = await getLLMProvider();

    const [shipment, similarShipments] = await Promise.all([
      this.tools.getShipment(shipmentId),
      this.tools.getSimilarShipments(shipmentId),
    ]);

    if (!shipment) throw new Error(`Shipment ${shipmentId} not found`);

    if (similarShipments.length === 0) {
      return {
        similarShipments: [],
        patterns: ['No similar historical shipments found — this appears to be a novel route or shipment type for this system.'],
        repeatedRisks: [],
        generatedAt: new Date().toISOString(),
        providerName: provider.providerName,
      };
    }

    const userPrompt = buildSimilarAnalysisPrompt(shipment, similarShipments);

    const response = await provider.chat({
      system: SYSTEM_PROMPTS.similarAnalysis,
      messages: [{ role: 'user', text: userPrompt }],
      temperature: 0.3,
      maxTokens: 800,
    });

    const parsed = this.parseJSON<{ patterns: string[]; repeatedRisks: string[] }>(response.text, {
      patterns: ['Analysis based on available historical data'],
      repeatedRisks: [],
    });

    return {
      similarShipments: similarShipments.map((s) => ({
        trackingNumber: s.trackingNumber,
        origin: s.origin,
        destination: s.destination,
        shipmentType: s.shipmentType,
        riskLevel: s.riskLevel,
        status: s.status,
        findingTypes: s.findingTypes,
      })),
      patterns: parsed.patterns,
      repeatedRisks: parsed.repeatedRisks,
      generatedAt: new Date().toISOString(),
      providerName: provider.providerName,
    };
  }

  // ── Capability 6: Timeline Narrative ────────────────────────────────────────
  //
  // Converts raw TrackingEvent[] into a natural-language journey story.
  // Works even if no compliance report exists.

  async generateTimelineNarrative(shipmentId: string): Promise<TimelineNarrativeResponse> {
    const provider = await getLLMProvider();

    const [shipment, trackingEvents] = await Promise.all([
      this.tools.getShipment(shipmentId),
      this.tools.getTrackingEvents(shipmentId),
    ]);

    if (!shipment) throw new Error(`Shipment ${shipmentId} not found`);

    const userPrompt = buildTimelineNarrativePrompt(shipment, trackingEvents);

    const response = await provider.chat({
      system: SYSTEM_PROMPTS.timelineNarrative,
      messages: [{ role: 'user', text: userPrompt }],
      temperature: 0.4,
      maxTokens: 800,
    });

    const parsed = this.parseJSON<TimelineNarrativeResponse>(response.text, {
      narrative: `Shipment ${shipment.trackingNumber} is currently ${shipment.status.toLowerCase().replace(/_/g, ' ')}, moving from ${shipment.origin} to ${shipment.destination}.`,
      milestones: trackingEvents.map((e) => ({
        phase: e.status.replace(/_/g, ' '),
        description: e.description,
      })),
      currentPhase: shipment.status,
      estimatedResolution: 'Pending delivery confirmation',
      generatedAt: new Date().toISOString(),
    });

    return { ...parsed, providerName: provider.providerName };
  }

  // ── Auto-trigger: post-compliance executive summary ─────────────────────────
  //
  // Called by runner.ts after the compliance agent finalizes its report.
  // Generates a richer executive summary and stores it in the report.
  // Fire-and-forget — compliance run is not blocked by this.

  async autoEnrichExecutiveSummary(shipmentId: string): Promise<void> {
    try {
      console.log(`[Copilot] Auto-enriching executive summary for shipment: ${shipmentId}`);
      const summary = await this.generateExecutiveSummary(shipmentId);
      const narrative = `${summary.headline}\n\nGoods: ${summary.goods}\nCorridor: ${summary.corridor}\nCarrier: ${summary.carrier}\n\nKey Observations:\n${summary.keyObservations.map((o) => `• ${o}`).join('\n')}\n\nPotential Concerns:\n${summary.potentialConcerns.map((c) => `• ${c}`).join('\n')}`;
      await this.tools.updateExecutiveSummary(shipmentId, narrative);
      console.log(`[Copilot] Executive summary enriched for shipment: ${shipmentId}`);
    } catch (err) {
      // Best-effort — do not propagate failure
      console.warn(`[Copilot] Failed to auto-enrich executive summary for ${shipmentId}:`, err);
    }
  }

  // ─── JSON parse helper ────────────────────────────────────────────────────

  private parseJSON<T>(text: string | undefined, fallback: T): T {
    if (!text) return fallback;

    // Strip markdown code fences if present
    let cleaned = text
      .replace(/^```(?:json)?\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim();

    // Try direct parse first
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      // Nova Lite sometimes wraps JSON in prose text.
      // Find the first { or [ and extract the JSON block from there.
      const objStart = cleaned.indexOf('{');
      const arrStart = cleaned.indexOf('[');
      let start = -1;
      if (objStart !== -1 && arrStart !== -1) {
        start = Math.min(objStart, arrStart);
      } else {
        start = Math.max(objStart, arrStart);
      }

      if (start !== -1) {
        // Find matching closing bracket
        const openChar = cleaned[start];
        const closeChar = openChar === '{' ? '}' : ']';
        let depth = 0;
        let end = -1;
        for (let i = start; i < cleaned.length; i++) {
          if (cleaned[i] === openChar) depth++;
          else if (cleaned[i] === closeChar) {
            depth--;
            if (depth === 0) { end = i; break; }
          }
        }
        if (end !== -1) {
          const extracted = cleaned.slice(start, end + 1);
          try {
            return JSON.parse(extracted) as T;
          } catch {
            // fall through
          }
        }
      }

      console.warn('[CopilotEngine] Failed to parse LLM JSON response:', cleaned.slice(0, 200));
      return fallback;
    }
  }
}

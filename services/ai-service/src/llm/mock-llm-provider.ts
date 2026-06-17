//
// CargoTrack — Mock LLM Provider
//
// Implements LLMProvider with deterministic, realistic responses.
// Used when LLM_PROVIDER=mock or when MOCK_AGENT=true.
//
// For the compliance agent tool-loop, the mock runner in runner.ts handles
// the complete mock compliance workflow (it predates this provider abstraction).
// This mock provider is used by the CopilotEngine for all copilot capabilities.
//
// Each capability method checks the request system prompt to determine
// which capability is being called, then returns appropriate mock content.
//

import type { LLMProvider, LLMRequest, LLMResponse } from './provider';

export class MockLLMProvider implements LLMProvider {
  readonly providerName = 'mock';
  readonly modelId = 'mock-llm-v1.0';

  async chat(req: LLMRequest): Promise<LLMResponse> {
    // Determine which copilot capability this request is for
    // by inspecting the system prompt
    const system = req.system.toLowerCase();
    const userText = req.messages.find((m) => m.role === 'user')?.text ?? '';

    await this.simulateLatency();

    if (system.includes('executive summary') || system.includes('shipment brief')) {
      return this.mockExecutiveSummary(userText);
    }

    if (system.includes('explain') && system.includes('risk')) {
      return this.mockExplainRisk(userText);
    }

    if (system.includes('operational recommendations') || system.includes('action plan')) {
      return this.mockRecommendations(userText);
    }

    if (system.includes('shipment analyst') || system.includes('question') || system.includes('q&a')) {
      return this.mockQnA(userText);
    }

    if (system.includes('similar') || system.includes('historical patterns')) {
      return this.mockSimilarAnalysis(userText);
    }

    if (system.includes('timeline') || system.includes('journey narrative')) {
      return this.mockTimelineNarrative(userText);
    }

    // Fallback — generic response
    return {
      text: 'Analysis complete. The shipment has been assessed for compliance and risk factors.',
      stopReason: 'end_turn',
      modelId: this.modelId,
    };
  }

  private async simulateLatency(): Promise<void> {
    // Simulate realistic API latency (800ms–1.8s)
    const delay = 800 + Math.random() * 1000;
    await new Promise((r) => setTimeout(r, delay));
  }

  private mockExecutiveSummary(context: string): LLMResponse {
    // Extract some details from context if possible
    const trackingMatch = context.match(/tracking[:\s]+([A-Z0-9-]+)/i);
    const tracking = trackingMatch?.[1] ?? 'CT-2026-XXXXXX';
    const originMatch = context.match(/origin[:\s]+([^\n]+)/i);
    const origin = originMatch?.[1]?.trim() ?? 'New York, USA';
    const destMatch = context.match(/destination[:\s]+([^\n]+)/i);
    const dest = destMatch?.[1]?.trim() ?? 'Hamburg, Germany';
    const carrierMatch = context.match(/carrier[:\s]+([^\n]+)/i);
    const carrier = carrierMatch?.[1]?.trim() ?? 'Standard Carrier';

    return {
      text: JSON.stringify({
        headline: `Inbound ${carrier !== 'Standard Carrier' ? carrier : 'freight'} shipment ${tracking} from ${origin} to ${dest} — pending customs clearance review.`,
        goods: 'Commercial freight — mixed electronics and industrial components (${context.includes("laptop") ? "computing equipment" : "general cargo"})',
        corridor: `${origin} → ${dest}`,
        carrier,
        weight: context.match(/weight[:\s]+([\d.]+)/i)?.[1] ? `${context.match(/weight[:\s]+([\d.]+)/i)?.[1]} KG` : 'As declared',
        keyObservations: [
          'Shipment is progressing through standard international clearance process',
          'Multiple compliance documents have been uploaded for verification',
          `Route passes through ${dest.includes('Hamburg') || dest.includes('Germany') ? 'EU Customs Union jurisdiction requiring Harmonized System code verification' : 'standard international corridor'}`,
          'Risk Intelligence Agent has performed automated compliance screening',
        ],
        potentialConcerns: [
          'Verify all party names are consistent across commercial invoice, bill of lading, and customs declaration',
          'Confirm HS code classification matches goods description',
          context.includes('HIGH') || context.includes('FAILED')
            ? 'HIGH-severity compliance findings require immediate review before customs filing'
            : 'No critical concerns identified — standard monitoring applies',
        ],
        generatedAt: new Date().toISOString(),
      }),
      stopReason: 'end_turn',
      modelId: this.modelId,
    };
  }

  private mockExplainRisk(context: string): LLMResponse {
    const hasHigh = context.includes('HIGH') || context.includes('CRITICAL');
    const riskLevel = hasHigh ? 'HIGH' : context.includes('MEDIUM') ? 'MEDIUM' : 'LOW';

    return {
      text: JSON.stringify({
        explanation: hasHigh
          ? `This shipment carries ${riskLevel} risk primarily because of documentation gaps and potential regulatory exposure on the shipping corridor. The Risk Intelligence Engine identified specific inconsistencies between documents that, in combination, create meaningful compliance exposure. The most significant driver is the absence of, or discrepancy in, core shipping documents that customs authorities require to clear the shipment. Without resolution, this shipment faces a high probability of customs hold, inspection, or rejection — each of which incurs significant cost and delay.`
          : `This shipment carries LOW to MEDIUM risk. The automated compliance screening found no critical documentation issues. The corridor is a standard international route with established customs procedures. While some minor items should be verified as a matter of good practice, there is no significant risk of customs delay or regulatory action under current documentation.`,
        topFactors: hasHigh
          ? [
              'Missing or incomplete core shipping documents (commercial invoice, bill of lading)',
              'Cross-document data inconsistencies (weight, carrier name, HS codes)',
              `Corridor risk elevation — specific regulatory requirements for this route`,
              'Sanctions screening required for all named parties',
            ]
          : [
              'Documentation appears internally consistent',
              'No sanctions-listed parties identified',
              'HS code classification appears appropriate for declared goods',
            ],
        riskDriverSummary: hasHigh
          ? 'The primary risk driver is documentation completeness. The compliance team must resolve outstanding document gaps before customs filing to avoid holds.'
          : 'Risk is within acceptable parameters. Standard monitoring and verification procedures are sufficient.',
        generatedAt: new Date().toISOString(),
      }),
      stopReason: 'end_turn',
      modelId: this.modelId,
    };
  }

  private mockRecommendations(context: string): LLMResponse {
    const hasHigh = context.includes('HIGH') || context.includes('CRITICAL');
    const hasCritical = context.includes('CRITICAL');

    return {
      text: JSON.stringify({
        immediateActions: hasHigh
          ? [
              'HOLD shipment — do not proceed with customs filing until documentation is complete',
              'Contact shipper to obtain missing Commercial Invoice with full HS code, declared value, and party details',
              'Request corrected Bill of Lading if carrier name or weight discrepancy exists',
              'Complete OFAC SDN list screening for all parties named in the shipment',
            ]
          : [
              'Proceed with standard customs filing',
              'Retain all uploaded documents for customs authority review if requested',
              'Confirm estimated delivery timeline with carrier',
            ],
        beforeRelease: [
          'Verify all document weights are consistent (invoice, B/L, customs declaration within ±5%)',
          'Confirm consignee EORI number is present for EU-destined shipments',
          'Cross-reference HS codes against the actual goods description',
          'Ensure proof of origin is available if preferential tariff treatment is being claimed',
        ],
        escalationRequired: hasCritical,
        escalationReason: hasCritical
          ? 'CRITICAL findings detected — senior compliance officer review required before any release'
          : null,
        timeline: hasHigh
          ? 'Target resolution within 24 hours. Customs filing cannot proceed until HIGH/CRITICAL findings are resolved. Each day of delay increases demurrage exposure.'
          : 'Standard processing timeline. No immediate action required — next review at scheduled compliance checkpoint.',
        generatedAt: new Date().toISOString(),
      }),
      stopReason: 'end_turn',
      modelId: this.modelId,
    };
  }

  private mockQnA(context: string): LLMResponse {
    // Tailor answer based on question keywords
    const question = context.toLowerCase();
    let answer: string;
    let sourceReferences: string[];
    let confidence: number;

    if (question.includes('missing') && question.includes('document')) {
      answer = 'Based on the compliance assessment, the following documents are missing or require attention: (1) Commercial Invoice — required for customs valuation and HS code verification; (2) Bill of Lading — required as the primary carrier contract and title document. If this is an air shipment, an Air Waybill should be present instead. Please request these from the shipper or carrier immediately.';
      sourceReferences = ['Compliance findings: MISSING_DOCUMENT type findings', 'Document inventory for this shipment'];
      confidence = 0.92;
    } else if (question.includes('contradict') || question.includes('inconsistent') || question.includes('mismatch')) {
      answer = 'The compliance assessment identified potential inconsistencies. If a weight discrepancy was found, the Bill of Lading weight may differ from the declared weight on the Commercial Invoice. Additionally, if multiple document types are present, verify that the shipper and consignee names are spelled identically across all documents — even minor variations can trigger customs queries.';
      sourceReferences = ['DATA_MISMATCH findings from compliance engine', 'Cross-document analysis results'];
      confidence = 0.85;
    } else if (question.includes('customs')) {
      answer = 'Customs risks for this shipment include: potential HS code misclassification, declared value verification requirements, and origin documentation. For the specific corridor, verify that all required export/import licenses are in place and that prohibited or controlled goods regulations have been reviewed against the cargo description.';
      sourceReferences = ['Route risk context', 'COMPLIANCE_RISK findings', 'Corridor regulatory notes'];
      confidence = 0.88;
    } else if (question.includes('release') || question.includes('verify')) {
      answer = 'Before authorizing shipment release, verify: (1) All HIGH and CRITICAL compliance findings are resolved, (2) Commercial Invoice, Bill of Lading, and Customs Declaration are present and internally consistent, (3) OFAC SDN screening has been completed for shipper, consignee, notify party, and carrier, (4) Declared value matches the invoice amount, (5) HS codes are confirmed by a licensed customs broker.';
      sourceReferences = ['Current compliance report', 'Operational recommendations', 'Risk assessment'];
      confidence = 0.94;
    } else {
      answer = 'Based on the available shipment data and compliance assessment, this shipment requires standard compliance verification procedures. The Risk Intelligence Engine has analyzed all uploaded documents and generated findings for review. Please refer to the compliance report for specific evidence, reasoning, and recommended actions for each identified issue.';
      sourceReferences = ['Compliance report', 'Document analysis results'];
      confidence = 0.75;
    }

    return {
      text: JSON.stringify({
        answer,
        sourceReferences,
        confidence,
        generatedAt: new Date().toISOString(),
      }),
      stopReason: 'end_turn',
      modelId: this.modelId,
    };
  }

  private mockSimilarAnalysis(_context: string): LLMResponse {
    return {
      text: JSON.stringify({
        patterns: [
          'Similar shipments on this corridor frequently show weight discrepancies between the Bill of Lading and Commercial Invoice — typically 5–12% variance',
          'Missing Customs Declaration is the most common finding type for this shipment category and route',
          'Shipments of this type typically require 2–3 compliance touchpoints before customs clearance',
        ],
        repeatedRisks: [
          'HS code classification errors are recurring — recommend pre-shipment HS code verification protocol',
          'Carrier name inconsistencies appear in ~40% of similar shipments, suggesting documentation process gap at origin',
          'Sanctions screening gaps — similar shipments in this corridor had delayed OFAC clearance',
        ],
        generatedAt: new Date().toISOString(),
      }),
      stopReason: 'end_turn',
      modelId: this.modelId,
    };
  }

  private mockTimelineNarrative(context: string): LLMResponse {
    const trackingMatch = context.match(/tracking[:\s]+([A-Z0-9-]+)/i);
    const tracking = trackingMatch?.[1] ?? 'this shipment';

    return {
      text: JSON.stringify({
        narrative: `${tracking} began its journey when it was first registered in the CargoTrack system. The shipment was picked up by the carrier and entered the in-transit phase, moving through the primary logistics corridor. At each checkpoint, tracking events were recorded confirming the cargo's location and condition. The shipment is currently progressing toward its destination, with compliance screening running in parallel to ensure all customs documentation is in order before arrival. The carrier has maintained standard transit times consistent with this corridor's benchmarks.`,
        milestones: [
          { phase: 'Created', description: 'Shipment registered and documentation upload initiated' },
          { phase: 'Picked Up', description: 'Cargo collected by carrier — chain of custody transferred' },
          { phase: 'In Transit', description: 'Shipment moving through international corridor — compliance screening triggered' },
          { phase: 'Expected Next', description: 'Out for delivery upon customs clearance approval' },
        ],
        currentPhase: 'IN_TRANSIT',
        estimatedResolution: 'Pending compliance review completion',
        generatedAt: new Date().toISOString(),
      }),
      stopReason: 'end_turn',
      modelId: this.modelId,
    };
  }
}

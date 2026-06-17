/**
 * CargoTrack Logistics Intelligence Knowledge Base
 *
 * A deterministic, in-process lookup engine that loads structured catalogs
 * at startup and provides typed context builders for injection into Nova prompts.
 *
 * NO RAG. NO VECTOR DB. NO EXTERNAL CALLS.
 * Pure TypeScript lookup over JSON catalogs loaded from disk at startup.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Catalog path resolution ──────────────────────────────────────────────────

const CATALOG_DIR = path.join(__dirname, 'catalogs');

function loadCatalog<T>(filename: string): T {
  const filePath = path.join(CATALOG_DIR, filename);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(
      `[KnowledgeBase] Cannot read catalog "${filename}" at "${filePath}". ` +
      `Ensure the Docker image includes COPY src/knowledge/catalogs/ dist/knowledge/catalogs/. ` +
      `Original error: ${(err as Error).message}`
    );
  }
}

// ─── Catalog types (minimal — sufficient for prompt injection) ─────────────────

interface CatalogMeta {
  name: string;
  version: string;
  effectiveDate: string;
  sources: string[];
  disclaimer?: string;
}

interface RouteCatalog {
  _catalog: CatalogMeta;
  corridors: RouteCorridorEntry[];
}

interface RouteCorridorEntry {
  corridorId: string;
  label: string;
  from: string[];
  to: string[];
  bidirectional?: boolean;
  sanctionsRisk: 'CRITICAL' | 'ELEVATED' | 'MEDIUM' | 'LOW';
  sanctionsNotes: string;
  customsComplexity: 'HIGH' | 'MEDIUM' | 'LOW';
  estimatedClearanceHoursExport: number;
  estimatedClearanceHoursImport: number;
  delayProbabilityBaseline: number;
  requiredDocumentsExport: string[];
  requiredDocumentsImport: string[];
  specialRequirements: string[];
  tradeAgreements: string[];
  tariffNotes: string;
  regulatoryBodies: string[];
  routeRestrictions: string[];
}

interface DGCatalog {
  _catalog: CatalogMeta;
  classes: DGClassEntry[];
  hsCodeDGMapping: Record<string, string>;
}

interface DGClassEntry {
  class: string;
  label: string;
  iataLabel: string;
  commonExamples: string[];
  keywordTriggers: string[];
  requiredDocuments: string[];
  airFreightStatus: 'FORBIDDEN' | 'RESTRICTED' | 'PERMITTED';
  airFreightNotes: string;
  seaFreightNotes: string;
  packagingRequirements: string;
  screeningNotes: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
}

interface HSCatalog {
  _catalog: CatalogMeta;
  chapters: HSChapterEntry[];
}

interface HSChapterEntry {
  chapter: string;
  label: string;
  dgRisk: boolean;
  dgClass?: string;
  dgNotes?: string;
  exportControlRisk: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  sanctionsRisk: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  customsNotes: string;
  requiredDocumentsImport: string[];
  antiDumpingRisk: boolean;
  antiDumpingNotes?: string;
  keyComplianceConcerns: string[];
  criticalHeadings?: Record<string, string>;
}

interface IncotermsCatalog {
  _catalog: CatalogMeta;
  terms: IncotermEntry[];
}

interface IncotermEntry {
  term: string;
  fullName: string;
  validModes: string[];
  riskTransferPoint: string;
  sellerResponsibilities: string[];
  buyerResponsibilities: string[];
  requiredDocumentsForSeller: string[];
  commonMisuse: string;
  insuranceNotes: string;
  customsResponsibility: string;
  complianceFlags: string[];
  lcCompatible: boolean;
  lcNotes: string;
}

interface SanctionsCatalog {
  _catalog: CatalogMeta;
  mandatoryScreeningLists: ScreeningList[];
  jurisdictions: SanctionsJurisdiction[];
  fatfHighRiskJurisdictions: { description: string; currentList_2024: string[]; note: string };
  fatfIncreasedMonitoring: { description: string; currentList_2024: string[]; note: string };
}

interface ScreeningList {
  listName: string;
  authority: string;
  scope: string;
  screenEntities: string[];
}

interface SanctionsJurisdiction {
  jurisdiction: string;
  isoCode: string;
  sanctionsLevel: 'COMPREHENSIVE' | 'TARGETED' | 'ELEVATED' | 'CONFLICT_ZONE' | 'WATCH';
  sanctioningBodies: string[];
  triggerKeywords: string[];
  keyRestrictions: string[];
  allowedExceptions: string[];
  screeningRequired: string[];
  redFlags: string[];
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  specialNote?: string;
}

// ─── Grounded Context Output Types ───────────────────────────────────────────

export interface RouteContext {
  corridorLabel: string;
  corridorId: string;
  sanctionsRisk: string;
  sanctionsNotes: string;
  customsComplexity: string;
  estimatedClearanceHoursExport: number;
  estimatedClearanceHoursImport: number;
  delayProbabilityBaseline: number;
  requiredDocumentsExport: string[];
  requiredDocumentsImport: string[];
  specialRequirements: string[];
  tradeAgreements: string[];
  tariffNotes: string;
  routeRestrictions: string[];
  regulatoryBodies: string[];
  isGenericFallback: boolean;
}

export interface DGContext {
  detected: boolean;
  class?: string;
  label?: string;
  airFreightStatus?: string;
  airFreightNotes?: string;
  seaFreightNotes?: string;
  requiredDocuments?: string[];
  packagingRequirements?: string;
  screeningNotes?: string;
  severity?: string;
  fromHSMapping?: boolean;
}

export interface HSContext {
  chapter: string;
  label: string;
  dgRisk: boolean;
  dgClass?: string;
  exportControlRisk: string;
  sanctionsRisk: string;
  customsNotes: string;
  requiredDocumentsImport: string[];
  antiDumpingRisk: boolean;
  antiDumpingNotes?: string;
  keyComplianceConcerns: string[];
  criticalHeadings?: Record<string, string>;
}

export interface SanctionsContext {
  originRisk: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'CLEAR';
  destinationRisk: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'CLEAR';
  originJurisdiction?: SanctionsJurisdiction;
  destinationJurisdiction?: SanctionsJurisdiction;
  mandatoryScreeningLists: string[];
  combinedRedFlags: string[];
  circumventionHubWarning: boolean;
}

export interface IncotermContext {
  term: string;
  fullName: string;
  validModes: string[];
  riskTransferPoint: string;
  commonMisuse: string;
  insuranceNotes: string;
  customsResponsibility: string;
  complianceFlags: string[];
  requiredDocumentsForSeller: string[];
  lcCompatible: boolean;
  lcNotes: string;
}

export interface GroundedContext {
  route: RouteContext;
  dg: DGContext;
  hs: HSContext | null;
  sanctions: SanctionsContext;
  incoterm: IncotermContext | null;
  catalogVersion: string;
  knowledgeSources: string[];
  knowledgeConfidence: 'HIGH' | 'MEDIUM' | 'LOW';
  knowledgeConfidenceReason: string;
}

// ─── Singleton Catalog Store ──────────────────────────────────────────────────

class KnowledgeBaseStore {
  // Properties are assigned in load() before any getter is called.
  // The ! assertion satisfies strict-mode strictPropertyInitialization.
  private routes!: RouteCatalog;
  private dg!: DGCatalog;
  private hs!: HSCatalog;
  private incoterms!: IncotermsCatalog;
  private sanctions!: SanctionsCatalog;
  private loaded = false;

  load(): void {
    if (this.loaded) return;
    console.log(`[KnowledgeBase] Loading catalogs from: ${CATALOG_DIR}`);
    try {
      this.routes     = loadCatalog<RouteCatalog>('route-intelligence.json');
      this.dg         = loadCatalog<DGCatalog>('dangerous-goods.json');
      this.hs         = loadCatalog<HSCatalog>('hs-intelligence.json');
      this.incoterms  = loadCatalog<IncotermsCatalog>('incoterms-intelligence.json');
      this.sanctions  = loadCatalog<SanctionsCatalog>('sanctions-watch.json');
      this.loaded = true;
      console.log('[KnowledgeBase] ✓ All catalogs loaded:', {
        catalogDir:               CATALOG_DIR,
        routes:                   this.routes.corridors.length,
        dgClasses:                this.dg.classes.length,
        hsChapters:               this.hs.chapters.length,
        incoterms:                this.incoterms.terms.length,
        sanctionsJurisdictions:   this.sanctions.jurisdictions.length,
        catalogVersion: `routes:${this.routes._catalog.version} dg:${this.dg._catalog.version} hs:${this.hs._catalog.version}`,
      });
    } catch (err) {
      console.error('[KnowledgeBase] ✗ FAILED to load catalogs — AI will use INTERNATIONAL-GENERIC fallback for all shipments:');
      console.error((err as Error).message);
      // Do NOT throw — service still starts; routes degrade gracefully
    }
  }

  getRoutes()    { return this.routes; }
  getDG()        { return this.dg; }
  getHS()        { return this.hs; }
  getIncoterms() { return this.incoterms; }
  getSanctions() { return this.sanctions; }
  isReady()      { return this.loaded; }
}

const store = new KnowledgeBaseStore();

// ─── Helper: normalize location string for matching ──────────────────────────

function normalizeLocation(location: string): string {
  return location.toLowerCase().trim();
}

function locationMatchesList(location: string, list: string[]): boolean {
  const normalized = normalizeLocation(location);
  return list.some((entry) => normalized.includes(entry.toLowerCase()) || entry.toLowerCase().includes(normalized));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const KnowledgeBase = {
  /**
   * Initialize catalogs. Call once at service startup.
   */
  initialize(): void {
    store.load();
  },

  /**
   * Look up route intelligence for a given origin/destination pair.
   * Falls back to INTERNATIONAL-GENERIC if no specific corridor matches.
   */
  getRouteContext(origin: string, destination: string): RouteContext {
    if (!store.isReady()) return buildGenericRouteContext();

    const corridors = store.getRoutes().corridors;

    // Try to find a matching corridor
    let match: RouteCorridorEntry | undefined;

    for (const corridor of corridors) {
      if (corridor.corridorId === 'DOMESTIC' || corridor.corridorId === 'INTERNATIONAL-GENERIC') {
        continue; // these are fallbacks
      }
      const fromMatch = locationMatchesList(origin, corridor.from) || locationMatchesList(destination, corridor.from);
      const toMatch   = locationMatchesList(destination, corridor.to) || locationMatchesList(origin, corridor.to);

      // Bidirectional corridors: check both directions
      if (corridor.bidirectional) {
        const dir1 = locationMatchesList(origin, corridor.from) && locationMatchesList(destination, corridor.to);
        const dir2 = locationMatchesList(origin, corridor.to)   && locationMatchesList(destination, corridor.from);
        if (dir1 || dir2) {
          match = corridor;
          break;
        }
      } else {
        if (fromMatch && toMatch) {
          match = corridor;
          break;
        }
      }
    }

    // Domestic fallback: same country
    if (!match) {
      const isDomestic = normalizeLocation(origin).split(',').pop()?.trim() ===
                         normalizeLocation(destination).split(',').pop()?.trim();
      if (isDomestic) {
        match = corridors.find((c) => c.corridorId === 'DOMESTIC');
      }
    }

    // Generic international fallback
    if (!match) {
      match = corridors.find((c) => c.corridorId === 'INTERNATIONAL-GENERIC');
    }

    if (!match) return buildGenericRouteContext();

    return {
      corridorLabel:              match.label,
      corridorId:                 match.corridorId,
      sanctionsRisk:              match.sanctionsRisk,
      sanctionsNotes:             match.sanctionsNotes,
      customsComplexity:          match.customsComplexity,
      estimatedClearanceHoursExport: match.estimatedClearanceHoursExport,
      estimatedClearanceHoursImport: match.estimatedClearanceHoursImport,
      delayProbabilityBaseline:   match.delayProbabilityBaseline,
      requiredDocumentsExport:    match.requiredDocumentsExport,
      requiredDocumentsImport:    match.requiredDocumentsImport,
      specialRequirements:        match.specialRequirements,
      tradeAgreements:            match.tradeAgreements,
      tariffNotes:                match.tariffNotes,
      routeRestrictions:          match.routeRestrictions,
      regulatoryBodies:           match.regulatoryBodies,
      isGenericFallback:          match.corridorId === 'INTERNATIONAL-GENERIC',
    };
  },

  /**
   * Detect and return DG class context from commodity type, description, or HS code.
   */
  getDGContext(commodityType: string, description?: string | null, hsCode?: string | null): DGContext {
    if (!store.isReady()) return { detected: false };

    const dgCatalog = store.getDG();
    const searchText = `${commodityType} ${description || ''}`.toLowerCase();

    // 1. Try keyword matching against DG class triggers
    for (const dgClass of dgCatalog.classes) {
      if (dgClass.keywordTriggers.some((kw) => searchText.includes(kw.toLowerCase()))) {
        return {
          detected: true,
          class: dgClass.class,
          label: dgClass.label,
          airFreightStatus: dgClass.airFreightStatus,
          airFreightNotes: dgClass.airFreightNotes,
          seaFreightNotes: dgClass.seaFreightNotes,
          requiredDocuments: dgClass.requiredDocuments,
          packagingRequirements: dgClass.packagingRequirements,
          screeningNotes: dgClass.screeningNotes,
          severity: dgClass.severity,
          fromHSMapping: false,
        };
      }
    }

    // 2. If HS code provided, check HS→DG mapping
    if (hsCode && hsCode.length >= 2) {
      const chapter = hsCode.replace(/\D/g, '').substring(0, 2);
      const hsMapping = dgCatalog.hsCodeDGMapping[chapter];
      if (hsMapping) {
        // Find the first class mentioned in the mapping
        const classMatch = hsMapping.match(/Class (\d+[\.\d]*)/);
        if (classMatch) {
          const classId = classMatch[1].split('.')[0]; // just the main class
          const dgClass = dgCatalog.classes.find((c) => c.class === classId);
          if (dgClass) {
            return {
              detected: true,
              class: dgClass.class,
              label: dgClass.label,
              airFreightStatus: dgClass.airFreightStatus,
              airFreightNotes: dgClass.airFreightNotes,
              seaFreightNotes: dgClass.seaFreightNotes,
              requiredDocuments: dgClass.requiredDocuments,
              packagingRequirements: dgClass.packagingRequirements,
              screeningNotes: dgClass.screeningNotes,
              severity: dgClass.severity,
              fromHSMapping: true,
            };
          }
        }
      }
    }

    return { detected: false };
  },

  /**
   * Look up HS chapter intelligence from an HS code hint.
   */
  getHSContext(hsCode: string): HSContext | null {
    if (!store.isReady() || !hsCode) return null;

    const chapter = hsCode.replace(/\D/g, '').substring(0, 2);
    if (!chapter) return null;

    const hsCatalog = store.getHS();
    const entry = hsCatalog.chapters.find((c) => c.chapter === chapter);
    if (!entry) return null;

    return {
      chapter:                 entry.chapter,
      label:                   entry.label,
      dgRisk:                  entry.dgRisk,
      dgClass:                 entry.dgClass,
      exportControlRisk:       entry.exportControlRisk,
      sanctionsRisk:           entry.sanctionsRisk,
      customsNotes:            entry.customsNotes,
      requiredDocumentsImport: entry.requiredDocumentsImport,
      antiDumpingRisk:         entry.antiDumpingRisk,
      antiDumpingNotes:        entry.antiDumpingNotes,
      keyComplianceConcerns:   entry.keyComplianceConcerns,
      criticalHeadings:        entry.criticalHeadings,
    };
  },

  /**
   * Assess sanctions exposure for origin and destination countries.
   */
  getSanctionsContext(origin: string, destination: string): SanctionsContext {
    if (!store.isReady()) {
      return {
        originRisk: 'LOW', destinationRisk: 'LOW',
        mandatoryScreeningLists: [], combinedRedFlags: [], circumventionHubWarning: false,
      };
    }

    const catalog = store.getSanctions();
    const combined = `${origin} ${destination}`.toLowerCase();

    function findJurisdiction(location: string): SanctionsJurisdiction | undefined {
      return catalog.jurisdictions.find((j) =>
        j.triggerKeywords.some((kw) => kw && location.toLowerCase().includes(kw.toLowerCase())) ||
        location.toLowerCase().includes(j.jurisdiction.toLowerCase())
      );
    }

    const originJ      = findJurisdiction(origin);
    const destinationJ = findJurisdiction(destination);


    function toRisk(j?: SanctionsJurisdiction): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'CLEAR' {
      if (!j) return 'CLEAR';
      switch (j.severity) {
        case 'CRITICAL': return 'CRITICAL';
        case 'HIGH': return 'HIGH';
        case 'MEDIUM': return 'MEDIUM';
        default: return 'LOW';
      }
    }

    const circumventionHubs = ['UAE', 'Dubai', 'Abu Dhabi', 'Turkey', 'Türkiye', 'Istanbul'];
    const circumventionWarning = circumventionHubs.some((hub) =>
      combined.includes(hub.toLowerCase())
    ) && (
      combined.includes('russia') || combined.includes('russian') ||
      combined.includes('iran') || combined.includes('iranian')
    );

    const combinedRedFlags = [
      ...(originJ?.redFlags || []),
      ...(destinationJ?.redFlags || []),
    ].filter((v, i, a) => a.indexOf(v) === i); // deduplicate

    return {
      originRisk:         toRisk(originJ),
      destinationRisk:    toRisk(destinationJ),
      originJurisdiction: originJ,
      destinationJurisdiction: destinationJ,
      mandatoryScreeningLists: catalog.mandatoryScreeningLists.map((l) => l.listName),
      combinedRedFlags,
      circumventionHubWarning: circumventionWarning,
    };
  },

  /**
   * Get Incoterms intelligence for a given trade term.
   */
  getIncotermContext(incoterm: string): IncotermContext | null {
    if (!store.isReady() || !incoterm) return null;

    const normalized = incoterm.trim().toUpperCase().replace(/[^A-Z]/g, '');
    const catalog = store.getIncoterms();
    const entry = catalog.terms.find((t) => t.term === normalized);
    if (!entry) return null;

    return {
      term:                     entry.term,
      fullName:                 entry.fullName,
      validModes:               entry.validModes,
      riskTransferPoint:        entry.riskTransferPoint,
      commonMisuse:             entry.commonMisuse,
      insuranceNotes:           entry.insuranceNotes,
      customsResponsibility:    entry.customsResponsibility,
      complianceFlags:          entry.complianceFlags,
      requiredDocumentsForSeller: entry.requiredDocumentsForSeller,
      lcCompatible:             entry.lcCompatible,
      lcNotes:                  entry.lcNotes,
    };
  },

  /**
   * Build a complete GroundedContext for a shipment.
   * This is the primary entry point called by the Briefing Engine and Compliance Agent.
   */
  buildGroundedContext(shipment: {
    origin: string;
    destination: string;
    commodityType?: string | null;
    description?: string | null;
    hsCodeHint?: string | null;
    incoterms?: string | null;
    isDangerousGoods?: boolean;
    shipmentType?: string;
  }): GroundedContext {
    const route     = this.getRouteContext(shipment.origin, shipment.destination);
    const dg        = this.getDGContext(
                        shipment.commodityType || shipment.description || '',
                        shipment.description,
                        shipment.hsCodeHint
                      );
    const hs        = shipment.hsCodeHint ? this.getHSContext(shipment.hsCodeHint) : null;
    const sanctions = this.getSanctionsContext(shipment.origin, shipment.destination);
    const incoterm  = shipment.incoterms ? this.getIncotermContext(shipment.incoterms) : null;

    // Determine catalog version string
    const catalogVersion = store.isReady()
      ? `routes:${store.getRoutes()._catalog.version} dg:${store.getDG()._catalog.version} hs:${store.getHS()._catalog.version} incoterms:${store.getIncoterms()._catalog.version} sanctions:${store.getSanctions()._catalog.version}`
      : 'unavailable';

    // Build knowledge sources list
    const knowledgeSources: string[] = [];
    if (store.isReady()) {
      knowledgeSources.push(`Route Intelligence Catalog v${store.getRoutes()._catalog.version} (${store.getRoutes()._catalog.effectiveDate})`);
      knowledgeSources.push(`Sanctions Watch Catalog v${store.getSanctions()._catalog.version} (${store.getSanctions()._catalog.effectiveDate})`);
      if (dg.detected) {
        knowledgeSources.push(`Dangerous Goods Catalog v${store.getDG()._catalog.version} — IATA DGR / IMDG Code`);
      }
      if (hs) {
        knowledgeSources.push(`HS Intelligence Catalog v${store.getHS()._catalog.version} — WCO HS 2022 / BIS CCL`);
      }
      if (incoterm) {
        knowledgeSources.push(`Incoterms® Intelligence Catalog v${store.getIncoterms()._catalog.version} — ICC Incoterms® 2020`);
      }
    } else {
      knowledgeSources.push('Knowledge base unavailable — AI using training knowledge only');
    }

    // Confidence assessment
    let knowledgeConfidence: 'HIGH' | 'MEDIUM' | 'LOW';
    let knowledgeConfidenceReason: string;

    if (!store.isReady()) {
      knowledgeConfidence = 'LOW';
      knowledgeConfidenceReason = 'Catalogs not loaded — AI relying on training knowledge only';
    } else if (route.isGenericFallback) {
      knowledgeConfidence = 'MEDIUM';
      knowledgeConfidenceReason = `No specific corridor catalog entry for ${shipment.origin} → ${shipment.destination}. Using generic international baseline. Sanctions and HS intelligence remain catalog-grounded.`;
    } else if (hs && dg.detected && incoterm && !sanctions.originRisk.includes('CLEAR')) {
      knowledgeConfidence = 'HIGH';
      knowledgeConfidenceReason = 'Full catalog coverage: route, HS code, DG class, Incoterms, and sanctions all matched in knowledge base.';
    } else {
      knowledgeConfidence = 'MEDIUM';
      knowledgeConfidenceReason = `Partial catalog coverage: route matched (${route.corridorId})${hs ? ', HS code matched' : ', HS code not provided'}${dg.detected ? ', DG class detected' : ''}${incoterm ? ', Incoterms matched' : ''}.`;
    }

    return { route, dg, hs, sanctions, incoterm, catalogVersion, knowledgeSources, knowledgeConfidence, knowledgeConfidenceReason };
  },

  /**
   * Render the grounded context as a formatted string for injection into Nova's prompt.
   * This is what gets included verbatim in the system prompt.
   */
  formatContextForPrompt(ctx: GroundedContext, shipment: {
    origin: string;
    destination: string;
    commodityType?: string | null;
    hsCodeHint?: string | null;
    incoterms?: string | null;
    isDangerousGoods?: boolean;
    carrierName?: string | null;
    shipmentType?: string;
  }): string {
    const lines: string[] = [];

    lines.push('════════════════════════════════════════════════════════════════');
    lines.push('LOGISTICS INTELLIGENCE KNOWLEDGE BASE — CATALOG-GROUNDED CONTEXT');
    lines.push(`Catalog Version: ${ctx.catalogVersion}`);
    lines.push(`Knowledge Confidence: ${ctx.knowledgeConfidence}`);
    lines.push(`Confidence Rationale: ${ctx.knowledgeConfidenceReason}`);
    lines.push('════════════════════════════════════════════════════════════════');
    lines.push('');

    // Route Intelligence
    lines.push('── ROUTE INTELLIGENCE ──────────────────────────────────────────');
    lines.push(`Corridor: ${ctx.route.corridorLabel} (${ctx.route.corridorId})`);
    lines.push(`Sanctions Risk: ${ctx.route.sanctionsRisk}`);
    lines.push(`Sanctions Notes: ${ctx.route.sanctionsNotes}`);
    lines.push(`Customs Complexity: ${ctx.route.customsComplexity}`);
    lines.push(`Typical Clearance Time — Export: ${ctx.route.estimatedClearanceHoursExport}h, Import: ${ctx.route.estimatedClearanceHoursImport}h`);
    lines.push(`Delay Probability Baseline: ${Math.round(ctx.route.delayProbabilityBaseline * 100)}%`);

    if (ctx.route.tradeAgreements.length > 0) {
      lines.push(`Active Trade Agreements: ${ctx.route.tradeAgreements.join(', ')}`);
    }
    if (ctx.route.tariffNotes) {
      lines.push(`Tariff Notes: ${ctx.route.tariffNotes}`);
    }
    if (ctx.route.requiredDocumentsImport.length > 0) {
      lines.push(`Required Import Documents: ${ctx.route.requiredDocumentsImport.join(' | ')}`);
    }
    if (ctx.route.requiredDocumentsExport.length > 0) {
      lines.push(`Required Export Documents: ${ctx.route.requiredDocumentsExport.join(' | ')}`);
    }
    if (ctx.route.specialRequirements.length > 0) {
      lines.push('Special Requirements:');
      ctx.route.specialRequirements.forEach((r) => lines.push(`  • ${r}`));
    }
    if (ctx.route.routeRestrictions.length > 0) {
      lines.push('Route Restrictions / Alerts:');
      ctx.route.routeRestrictions.forEach((r) => lines.push(`  ⚠ ${r}`));
    }
    lines.push(`Regulatory Bodies: ${ctx.route.regulatoryBodies.join(', ')}`);
    lines.push('');

    // Sanctions Intelligence
    lines.push('── SANCTIONS INTELLIGENCE ──────────────────────────────────────');
    lines.push(`Origin Sanctions Risk: ${ctx.sanctions.originRisk}`);
    lines.push(`Destination Sanctions Risk: ${ctx.sanctions.destinationRisk}`);
    if (ctx.sanctions.originJurisdiction) {
      const j = ctx.sanctions.originJurisdiction;
      lines.push(`Origin Jurisdiction: ${j.jurisdiction} — ${j.sanctionsLevel} (${j.sanctioningBodies.join(', ')})`);
      lines.push(`Key Restrictions: ${j.keyRestrictions.slice(0, 3).join('; ')}`);
    }
    if (ctx.sanctions.destinationJurisdiction) {
      const j = ctx.sanctions.destinationJurisdiction;
      lines.push(`Destination Jurisdiction: ${j.jurisdiction} — ${j.sanctionsLevel} (${j.sanctioningBodies.join(', ')})`);
      lines.push(`Key Restrictions: ${j.keyRestrictions.slice(0, 3).join('; ')}`);
    }
    if (ctx.sanctions.circumventionHubWarning) {
      lines.push('⚠ CIRCUMVENTION HUB WARNING: Route involves a known sanctions evasion hub (UAE/Turkey). Enhanced due diligence mandatory. Verify ultimate destination and beneficial owners.');
    }
    if (ctx.sanctions.combinedRedFlags.length > 0) {
      lines.push('Sanctions Red Flags from Catalog:');
      ctx.sanctions.combinedRedFlags.slice(0, 5).forEach((f) => lines.push(`  ⚠ ${f}`));
    }
    lines.push(`Mandatory Screening Lists: ${ctx.sanctions.mandatoryScreeningLists.join(', ')}`);
    lines.push('');

    // HS Code Intelligence
    if (ctx.hs) {
      lines.push('── HS CODE INTELLIGENCE ─────────────────────────────────────────');
      lines.push(`HS Chapter: ${ctx.hs.chapter} — ${ctx.hs.label}`);
      lines.push(`Export Control Risk: ${ctx.hs.exportControlRisk}`);
      lines.push(`Sanctions Risk (HS): ${ctx.hs.sanctionsRisk}`);
      lines.push(`DG Risk: ${ctx.hs.dgRisk ? `YES — Class ${ctx.hs.dgClass}` : 'No specific DG risk for this chapter'}`);
      lines.push(`Customs Notes: ${ctx.hs.customsNotes}`);
      if (ctx.hs.antiDumpingRisk) {
        lines.push(`⚠ Anti-Dumping Risk: YES — ${ctx.hs.antiDumpingNotes || 'Check applicable AD orders'}`);
      }
      if (ctx.hs.keyComplianceConcerns.length > 0) {
        lines.push(`Key Compliance Concerns: ${ctx.hs.keyComplianceConcerns.join(' | ')}`);
      }
      if (ctx.hs.criticalHeadings) {
        lines.push('Critical Headings:');
        Object.entries(ctx.hs.criticalHeadings).forEach(([code, note]) => {
          lines.push(`  ${code}: ${note}`);
        });
      }
      lines.push('');
    }

    // DG Intelligence
    if (ctx.dg.detected) {
      lines.push('── DANGEROUS GOODS INTELLIGENCE ─────────────────────────────────');
      lines.push(`DG Class Detected: Class ${ctx.dg.class} — ${ctx.dg.label}`);
      lines.push(`Detection Method: ${ctx.dg.fromHSMapping ? 'HS Code chapter mapping' : 'Commodity keyword match'}`);
      lines.push(`Air Freight Status: ${ctx.dg.airFreightStatus}`);
      lines.push(`Air Freight Notes: ${ctx.dg.airFreightNotes}`);
      lines.push(`Sea Freight Notes: ${ctx.dg.seaFreightNotes}`);
      lines.push(`Severity: ${ctx.dg.severity}`);
      lines.push(`Packaging Requirements: ${ctx.dg.packagingRequirements}`);
      lines.push(`Required Documents (DG): ${(ctx.dg.requiredDocuments || []).join(' | ')}`);
      lines.push(`Screening Notes: ${ctx.dg.screeningNotes}`);
      if (shipment.isDangerousGoods === false && ctx.dg.detected) {
        lines.push('⚠ IMPORTANT: Shipment is NOT declared as dangerous goods, but commodity/HS code matches DG classification. Verify if DG declaration is required.');
      }
      lines.push('');
    } else if (shipment.isDangerousGoods) {
      lines.push('── DANGEROUS GOODS ──────────────────────────────────────────────');
      lines.push('⚠ Shipment declared as Dangerous Goods by shipper — DG class not automatically detected from commodity description. Verify DG class, UN number, packing group, and required declarations.');
      lines.push('');
    }

    // Incoterms Intelligence
    if (ctx.incoterm) {
      lines.push('── INCOTERMS® INTELLIGENCE ──────────────────────────────────────');
      lines.push(`Incoterm: ${ctx.incoterm.term} — ${ctx.incoterm.fullName}`);
      lines.push(`Valid Modes: ${ctx.incoterm.validModes.join(', ')}`);
      lines.push(`Risk Transfer Point: ${ctx.incoterm.riskTransferPoint}`);
      lines.push(`Customs Responsibility: ${ctx.incoterm.customsResponsibility}`);
      lines.push(`Insurance Notes: ${ctx.incoterm.insuranceNotes}`);
      if (ctx.incoterm.commonMisuse) {
        lines.push(`⚠ Common Misuse: ${ctx.incoterm.commonMisuse}`);
      }
      if (ctx.incoterm.complianceFlags.length > 0) {
        lines.push('Compliance Flags:');
        ctx.incoterm.complianceFlags.forEach((f) => lines.push(`  • ${f}`));
      }
      lines.push('');
    }

    // Knowledge Sources Footer
    lines.push('── KNOWLEDGE SOURCES USED ───────────────────────────────────────');
    ctx.knowledgeSources.forEach((src) => lines.push(`  • ${src}`));
    lines.push('════════════════════════════════════════════════════════════════');
    lines.push('');
    lines.push('INSTRUCTION: Base your analysis on the catalog-grounded data above.');
    lines.push('When citing risks or requirements, reference the specific catalog entries.');
    lines.push('Do not contradict the catalog data. You may expand on it with reasoning,');
    lines.push('but factual claims about routes, sanctions, DG class, and documents');
    lines.push('must be consistent with the knowledge base above.');
    lines.push('');

    return lines.join('\n');
  },
};

// ─── Utility: generic fallback route context ──────────────────────────────────

function buildGenericRouteContext(): RouteContext {
  return {
    corridorLabel: 'International (Generic)',
    corridorId: 'INTERNATIONAL-GENERIC',
    sanctionsRisk: 'MEDIUM',
    sanctionsNotes: 'Unknown corridor. Standard OFAC/EU/UN party screening required.',
    customsComplexity: 'MEDIUM',
    estimatedClearanceHoursExport: 8,
    estimatedClearanceHoursImport: 24,
    delayProbabilityBaseline: 0.25,
    requiredDocumentsExport: ['Commercial Invoice', 'Packing List', 'Bill of Lading', 'Export Customs Declaration'],
    requiredDocumentsImport: ['Commercial Invoice', 'Packing List', 'Import Customs Declaration', 'Bill of Lading'],
    specialRequirements: ['Verify applicable bilateral or regional trade agreements', 'Screen all parties against sanctions lists'],
    tradeAgreements: [],
    tariffNotes: 'Destination country MFN tariffs apply.',
    routeRestrictions: [],
    regulatoryBodies: ['Origin country customs', 'Destination country customs'],
    isGenericFallback: true,
  };
}

export default KnowledgeBase;

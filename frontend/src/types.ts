export interface User {
  id: string;
  email: string;
  name: string;
  role: 'USER' | 'ADMIN';
  profilePicture?: string | null;
  createdAt: string;
}

export type ShipmentStatus =
  | 'CREATED'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'DELAYED'
  | 'CANCELLED';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ComplianceStatus = 'PENDING' | 'PASSED' | 'FAILED' | 'PARTIAL';

export interface Shipment {
  id: string;
  trackingNumber: string;
  title: string;
  senderName: string;
  receiverName: string;
  origin: string;
  destination: string;
  shipmentType: string;
  weight: number;
  carrierName?: string | null;
  description?: string | null;
  estimatedDeliveryDate?: string | null;
  status: ShipmentStatus;
  // ── vNext: Extended intelligence fields ─────────────────────────────────────
  commodityType?: string | null;
  hsCodeHint?: string | null;
  isDangerousGoods?: boolean;
  dangerousGoodsClass?: string | null;
  incoterms?: string | null;
  declaredValue?: number | null;
  currencyCode?: string | null;
  aiRiskScore?: number | null;
  aiRiskLevel?: RiskLevel | null;
  // ────────────────────────────────────────────────────────────────────────────
  createdAt: string;
  updatedAt: string;
  userId: string;
  trackingEvents?: TrackingEvent[];
  documents?: ShipmentDocument[];
  user?: { id: string; name: string; email: string };
  complianceReport?: {
    status: ComplianceStatus;
    riskLevel?: RiskLevel | null;
    overallRiskScore?: number | null;
    executiveSummary?: string | null;
    recommendedDisposition?: string | null;
    modelId?: string | null;
    updatedAt?: string;
  } | null;
  aiBriefing?: {
    corridor?: string;
    riskSummary?: string;
    customsComplexity?: string | null;
    sanctionsStatus?: string | null;
    delayProbability?: number | null;
    generatedAt?: string;
  } | null;
  _count?: { documents: number };
}

export interface TrackingEvent {
  id: string;
  status: ShipmentStatus;
  location?: string;
  description: string;
  timestamp: string;
}

export interface ShipmentDocument {
  id: string;
  fileName: string;
  originalName: string;
  fileType: string;
  fileSize: number;
  documentType: string;
  uploadedAt: string;
}

export interface Notification {
  id: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface TrackingInfo {
  trackingNumber: string;
  title: string;
  origin: string;
  destination: string;
  status: ShipmentStatus;
  shipmentType: string;
  estimatedDeliveryDate?: string;
  createdAt: string;
  trackingEvents: TrackingEvent[];
}

// ─── AI Intelligence Types ────────────────────────────────────────────────────

export interface RouteBriefing {
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

export interface ComplianceFinding {
  id: string;
  findingType: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  evidence?: string | null;
  reasoning?: string | null;
  confidenceScore?: number | null;
  recommendedAction?: string | null;
  documentId?: string | null;
  resolvedAt?: string | null;
  createdAt: string;
}

export interface ComplianceReport {
  id: string;
  shipmentId: string;
  status: ComplianceStatus;
  summary?: string | null;
  overallRiskScore?: number | null;
  riskLevel?: RiskLevel | null;
  executiveSummary?: string | null;
  recommendedDisposition?: string | null;
  modelId?: string | null;
  modelConfidence?: number | null;
  processingTimeMs?: number | null;
  agentRunId?: string | null;
  findings: ComplianceFinding[];
  createdAt: string;
  updatedAt: string;
}

// ─── Admin Stats ─────────────────────────────────────────────────────────────

export interface AdminStats {
  total: number;
  totalDocuments: number;
  recentShipments: number;
  byStatus: Record<string, number>;
  riskDistribution: Record<string, number>;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  clearCount: number;
  unassessedCount: number;
}

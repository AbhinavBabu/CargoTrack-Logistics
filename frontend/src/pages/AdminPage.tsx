import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../api';
import { PaginatedResponse, Shipment, ShipmentStatus } from '../types';
import Layout from '../components/Layout';
import { StatusBadge } from '../components/TrackingTimeline';
import toast from 'react-hot-toast';
import {
  Search, Shield, MapPin, User, ChevronDown, X, FileText,
  Download, Package, TrendingUp, Clock, CheckCircle, AlertTriangle,
  Bot, Brain, AlertCircle, Info, Lightbulb, RefreshCw, Zap
} from 'lucide-react';

const STATUSES: ShipmentStatus[] = ['CREATED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELAYED', 'CANCELLED'];

// ─── Types ────────────────────────────────────────────────────────────────────

interface AdminStats {
  total: number;
  totalDocuments: number;
  recentShipments: number;
  byStatus: Record<ShipmentStatus, number>;
}

interface Document {
  id: string;
  originalName: string;
  documentType: string;
  fileSize: number;
  uploadedAt: string;
}

interface ComplianceFinding {
  id: string;
  findingType: string;
  severity: string;
  description: string;
  // v3.1: Risk Intelligence fields
  evidence: string | null;
  reasoning: string | null;
  confidenceScore: number | null;
  recommendedAction: string | null;
  documentId: string | null;
}

interface ComplianceReport {
  status: string;
  summary: string | null;
  // v3.1: Risk Intelligence fields
  overallRiskScore: number | null;
  riskLevel: string | null;
  executiveSummary: string | null;
  recommendedDisposition: string | null;
  modelId: string | null;
  modelConfidence: number | null;
  processingTimeMs: number | null;
  findings: ComplianceFinding[];
  createdAt: string;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, color }: {
  icon: React.ElementType;
  label: string;
  value: number | string;
  color: string;
}) {
  return (
    <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4 flex items-center gap-3">
      <div className={`w-9 h-9 ${color} rounded-lg flex items-center justify-center flex-shrink-0`}>
        <Icon className="w-4.5 h-4.5" />
      </div>
      <div>
        <p className="text-xs text-slate-500">{label}</p>
        <p className="text-lg font-bold text-slate-100">{value}</p>
      </div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    CRITICAL: 'bg-red-500/15 text-red-400 border-red-500/30',
    HIGH: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
    MEDIUM: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    LOW: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
  };
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border ${map[severity] ?? map.LOW}`}>
      {severity}
    </span>
  );
}

/** Visual 0.0–1.0 risk score gauge */
function RiskScoreGauge({ score, riskLevel }: { score: number; riskLevel: string | null }) {
  const percentage = Math.round(score * 100);

  const colorClass =
    riskLevel === 'CRITICAL' ? 'text-red-400' :
    riskLevel === 'HIGH'     ? 'text-orange-400' :
    riskLevel === 'MEDIUM'   ? 'text-yellow-400' :
                               'text-emerald-400';

  const bgClass =
    riskLevel === 'CRITICAL' ? 'bg-red-500/20 border-red-500/30' :
    riskLevel === 'HIGH'     ? 'bg-orange-500/20 border-orange-500/30' :
    riskLevel === 'MEDIUM'   ? 'bg-yellow-500/20 border-yellow-500/30' :
                               'bg-emerald-500/20 border-emerald-500/30';

  const barClass =
    riskLevel === 'CRITICAL' ? 'bg-red-500' :
    riskLevel === 'HIGH'     ? 'bg-orange-500' :
    riskLevel === 'MEDIUM'   ? 'bg-yellow-500' :
                               'bg-emerald-500';

  return (
    <div className={`rounded-xl border p-4 ${bgClass}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Zap className={`w-4 h-4 ${colorClass}`} />
          <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Risk Score</span>
        </div>
        <div className="text-right">
          <span className={`text-2xl font-bold ${colorClass}`}>{percentage}</span>
          <span className="text-xs text-slate-500">/100</span>
        </div>
      </div>
      {/* Progress bar */}
      <div className="h-2 bg-slate-700/60 rounded-full overflow-hidden mb-2">
        <div
          className={`h-full ${barClass} rounded-full transition-all duration-500`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      {riskLevel && (
        <div className="flex items-center justify-between">
          <span className={`text-xs font-semibold ${colorClass}`}>{riskLevel} RISK</span>
          <span className="text-xs text-slate-600">AI-assessed</span>
        </div>
      )}
    </div>
  );
}

/** Disposition recommendation banner */
function DispositionBanner({ disposition }: { disposition: string }) {
  const isHold = disposition.toUpperCase().includes('HOLD') || disposition.toUpperCase().includes('CRITICAL');
  const isConditional = disposition.toUpperCase().includes('CONDITIONAL') || disposition.toUpperCase().includes('MEDIUM');
  const isClear = disposition.toUpperCase().includes('CLEAR') || disposition.toUpperCase().includes('PROCEED');

  const style = isHold
    ? 'bg-red-500/10 border-red-500/30 text-red-300'
    : isConditional
    ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-300'
    : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300';

  const Icon = isHold ? AlertCircle : isConditional ? AlertTriangle : CheckCircle;

  return (
    <div className={`flex items-start gap-2.5 p-3 rounded-lg border ${style}`}>
      <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <p className="text-xs leading-relaxed font-medium">{disposition}</p>
    </div>
  );
}

/** Single finding card with expandable evidence/reasoning */
function FindingCard({ finding }: { finding: ComplianceFinding }) {
  const [expanded, setExpanded] = useState(false);
  const hasIntelligence = finding.evidence || finding.reasoning || finding.recommendedAction;

  return (
    <div className="bg-slate-800/60 border border-slate-700/50 rounded-lg overflow-hidden">
      {/* Finding header — always visible */}
      <div
        className={`p-3 ${hasIntelligence ? 'cursor-pointer hover:bg-slate-800' : ''} transition-colors`}
        onClick={() => hasIntelligence && setExpanded(!expanded)}
      >
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <p className="text-xs font-semibold text-slate-200 truncate">
              {finding.findingType.replace(/_/g, ' ')}
            </p>
            {finding.confidenceScore !== null && (
              <span className="text-xs text-slate-600 flex-shrink-0">
                {Math.round((finding.confidenceScore ?? 0) * 100)}% confidence
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <SeverityBadge severity={finding.severity} />
            {hasIntelligence && (
              <ChevronDown className={`w-3.5 h-3.5 text-slate-500 transition-transform ${expanded ? 'rotate-180' : ''}`} />
            )}
          </div>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">{finding.description}</p>
      </div>

      {/* Expanded intelligence panel */}
      {expanded && hasIntelligence && (
        <div className="border-t border-slate-700/50 divide-y divide-slate-700/30">
          {finding.evidence && (
            <div className="px-3 py-2.5">
              <div className="flex items-center gap-1.5 mb-1.5">
                <FileText className="w-3 h-3 text-blue-400" />
                <span className="text-xs font-semibold text-blue-400 uppercase tracking-wider">Evidence</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed font-mono bg-slate-900/60 rounded p-2">
                {finding.evidence}
              </p>
            </div>
          )}

          {finding.reasoning && (
            <div className="px-3 py-2.5">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Brain className="w-3 h-3 text-purple-400" />
                <span className="text-xs font-semibold text-purple-400 uppercase tracking-wider">AI Reasoning</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">{finding.reasoning}</p>
            </div>
          )}

          {finding.recommendedAction && (
            <div className="px-3 py-2.5">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Lightbulb className="w-3 h-3 text-amber-400" />
                <span className="text-xs font-semibold text-amber-400 uppercase tracking-wider">Recommended Action</span>
              </div>
              <p className="text-xs text-slate-200 leading-relaxed">{finding.recommendedAction}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Document Drawer ──────────────────────────────────────────────────────────

function DocumentDrawer({ shipment, onClose }: { shipment: Shipment; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [triggering, setTriggering] = useState(false);

  const { data: docs, isLoading } = useQuery<Document[]>({
    queryKey: ['admin-docs', shipment.id],
    queryFn: async () => {
      const { data } = await api.get(`/admin/documents/${shipment.id}`);
      return data;
    },
  });

  const { data: compliance, isLoading: complianceLoading } = useQuery<ComplianceReport>({
    queryKey: ['admin-compliance', shipment.id],
    queryFn: async () => {
      const { data } = await api.get(`/admin/compliance/${shipment.id}`);
      return data;
    },
    retry: false,
  });

  const handleRetrigger = async () => {
    setTriggering(true);
    try {
      await api.post(`/admin/compliance/trigger/${shipment.id}`);
      toast.success('Risk intelligence analysis started');
      // Poll until report updates
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['admin-compliance', shipment.id] });
      }, 4000);
    } catch {
      toast.error('Failed to trigger analysis');
    } finally {
      setTriggering(false);
    }
  };

  const handleDownload = async (docId: string, name: string) => {
    try {
      const response = await api.get(`/documents/${docId}/download`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', name);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error('Failed to download document');
    }
  };

  const complianceStatusColor: Record<string, string> = {
    PASSED: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    FAILED: 'text-red-400 bg-red-500/10 border-red-500/20',
    PARTIAL: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
    PENDING: 'text-slate-400 bg-slate-500/10 border-slate-500/20',
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Drawer panel */}
      <div className="relative w-full max-w-lg bg-slate-900 border-l border-slate-700/50 h-full overflow-y-auto shadow-2xl flex flex-col">
        {/* Header */}
        <div className="sticky top-0 bg-slate-900/95 backdrop-blur border-b border-slate-700/50 px-5 py-4 flex items-center justify-between z-10">
          <div>
            <p className="text-xs font-mono text-amber-400">{shipment.trackingNumber}</p>
            <h2 className="text-base font-semibold text-slate-100 mt-0.5">{shipment.title}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-slate-200 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 p-5 space-y-6">

          {/* ── AI Risk Intelligence Section ──────────────────────────── */}
          <div>
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2">
                <Brain className="w-4 h-4 text-purple-400" />
                <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  Shipment Risk Intelligence
                </h3>
              </div>
              <button
                onClick={handleRetrigger}
                disabled={triggering}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600 rounded-lg transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${triggering ? 'animate-spin' : ''}`} />
                Re-analyze
              </button>
            </div>

            {complianceLoading ? (
              <div className="flex justify-center py-8">
                <div className="w-5 h-5 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : compliance ? (
              <div className="space-y-3">
                {/* Status + model info */}
                <div className="flex items-center gap-2 flex-wrap">
                  <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium ${complianceStatusColor[compliance.status] ?? complianceStatusColor.PENDING}`}>
                    {compliance.status}
                  </div>
                  {compliance.modelId && (
                    <div className="flex items-center gap-1 px-2 py-1 bg-slate-800 border border-slate-700 rounded-lg">
                      <Bot className="w-3 h-3 text-slate-500" />
                      <span className="text-xs text-slate-500 font-mono truncate max-w-[160px]">{compliance.modelId}</span>
                    </div>
                  )}
                  {compliance.processingTimeMs && (
                    <span className="text-xs text-slate-600">{(compliance.processingTimeMs / 1000).toFixed(1)}s</span>
                  )}
                </div>

                {/* Risk score gauge */}
                {compliance.overallRiskScore !== null && compliance.overallRiskScore !== undefined && (
                  <RiskScoreGauge
                    score={compliance.overallRiskScore}
                    riskLevel={compliance.riskLevel}
                  />
                )}

                {/* Executive summary */}
                {compliance.executiveSummary && (
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Info className="w-3.5 h-3.5 text-blue-400" />
                      <span className="text-xs font-semibold text-blue-400 uppercase tracking-wider">Executive Summary</span>
                    </div>
                    <p className="text-sm text-slate-300 leading-relaxed">{compliance.executiveSummary}</p>
                  </div>
                )}

                {/* Disposition */}
                {compliance.recommendedDisposition && (
                  <DispositionBanner disposition={compliance.recommendedDisposition} />
                )}

                {/* Fallback: legacy summary */}
                {!compliance.executiveSummary && compliance.summary && (
                  <p className="text-sm text-slate-400 leading-relaxed">{compliance.summary}</p>
                )}

                {/* Findings */}
                {compliance.findings.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 pt-1">
                      <AlertTriangle className="w-3.5 h-3.5 text-slate-500" />
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                        {compliance.findings.length} Finding{compliance.findings.length !== 1 ? 's' : ''}
                      </span>
                      <span className="text-xs text-slate-700 ml-auto">Click to expand</span>
                    </div>
                    {compliance.findings.map((f) => (
                      <FindingCard key={f.id} finding={f} />
                    ))}
                  </div>
                )}

                {compliance.findings.length === 0 && compliance.status === 'PASSED' && (
                  <div className="flex items-center gap-2 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                    <CheckCircle className="w-4 h-4 text-emerald-400" />
                    <p className="text-xs text-emerald-300">No compliance risks identified</p>
                  </div>
                )}

                {/* Model confidence */}
                {compliance.modelConfidence !== null && compliance.modelConfidence !== undefined && (
                  <p className="text-xs text-slate-600 text-right">
                    Model confidence: {Math.round((compliance.modelConfidence ?? 0) * 100)}%
                  </p>
                )}
              </div>
            ) : (
              <div className="bg-slate-800/40 border border-slate-700/30 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Bot className="w-4 h-4 text-slate-600" />
                  <p className="text-xs text-slate-500 font-medium">No risk assessment yet</p>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  The Risk Intelligence Agent runs automatically when the shipment reaches IN_TRANSIT status.
                  Use the Re-analyze button to trigger a manual assessment.
                </p>
              </div>
            )}
          </div>

          {/* ── Documents Section ─────────────────────────────────────── */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <FileText className="w-4 h-4 text-slate-400" />
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Documents</h3>
              {docs && (
                <span className="ml-auto text-xs text-slate-600">{docs.length} file{docs.length !== 1 ? 's' : ''}</span>
              )}
            </div>

            {isLoading ? (
              <div className="flex justify-center py-6">
                <div className="w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : !docs || docs.length === 0 ? (
              <div className="bg-slate-800/40 border border-slate-700/30 rounded-lg p-6 text-center">
                <FileText className="w-6 h-6 text-slate-700 mx-auto mb-2" />
                <p className="text-xs text-slate-600">No documents uploaded</p>
              </div>
            ) : (
              <div className="space-y-2">
                {docs.map((doc) => (
                  <div
                    key={doc.id}
                    className="bg-slate-800/60 border border-slate-700/50 rounded-lg p-3 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-200 truncate">{doc.originalName}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs px-1.5 py-0.5 bg-slate-700 rounded text-slate-400 font-mono">
                          {doc.documentType.replace(/_/g, ' ')}
                        </span>
                        <span className="text-xs text-slate-600">
                          {(doc.fileSize / 1024).toFixed(1)} KB
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDownload(doc.id, doc.originalName)}
                      className="flex-shrink-0 p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-400 hover:text-slate-200 transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [selectedShipment, setSelectedShipment] = useState<Shipment | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<PaginatedResponse<Shipment>>({
    queryKey: ['admin-shipments', page, search, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('page', page.toString());
      params.set('limit', '10');
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      const { data } = await api.get(`/admin/shipments?${params}`);
      return data;
    },
  });

  const { data: stats } = useQuery<AdminStats>({
    queryKey: ['admin-stats'],
    queryFn: async () => {
      const { data } = await api.get('/admin/stats');
      return data;
    },
    staleTime: 30_000,
  });

  const handleUpdateStatus = async (shipmentId: string, newStatus: ShipmentStatus) => {
    setUpdatingId(shipmentId);
    try {
      await api.put(`/admin/shipments/${shipmentId}/status`, {
        status: newStatus,
        description: `Status updated to ${newStatus.replace(/_/g, ' ')}`,
      });
      toast.success(`Status → ${newStatus.replace(/_/g, ' ')}`);
      queryClient.invalidateQueries({ queryKey: ['admin-shipments'] });
      queryClient.invalidateQueries({ queryKey: ['admin-stats'] });
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to update status');
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <Layout>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-center justify-center">
            <Shield className="w-4.5 h-4.5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-100">Admin Panel</h1>
            <p className="text-xs text-slate-500">Manage shipments · AI Risk Intelligence · Compliance</p>
          </div>
        </div>

        {/* Stats Bar */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard icon={Package} label="Total Shipments" value={stats.total} color="bg-amber-500/10 text-amber-400 border border-amber-500/20" />
            <StatCard icon={TrendingUp} label="This Week" value={stats.recentShipments} color="bg-blue-500/10 text-blue-400 border border-blue-500/20" />
            <StatCard icon={Clock} label="In Transit" value={stats.byStatus?.IN_TRANSIT ?? 0} color="bg-indigo-500/10 text-indigo-400 border border-indigo-500/20" />
            <StatCard icon={CheckCircle} label="Delivered" value={stats.byStatus?.DELIVERED ?? 0} color="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" />
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1 flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-600" />
              <input
                type="text"
                placeholder="Search shipments..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (setSearch(searchInput), setPage(1))}
                className="w-full pl-9 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-500"
              />
            </div>
            <button
              onClick={() => { setSearch(searchInput); setPage(1); }}
              className="px-4 py-2 bg-slate-800 border border-slate-700 text-slate-400 text-sm font-medium rounded-lg hover:bg-slate-700 hover:text-slate-200 transition-colors"
            >
              Search
            </button>
          </div>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            className="px-3 py-2 bg-slate-800 border border-slate-700 text-slate-400 text-sm rounded-lg focus:outline-none focus:ring-1 focus:ring-amber-500"
          >
            <option value="">All Statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <>
            <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-700/50 bg-slate-800/80">
                      <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-5 py-3">Tracking #</th>
                      <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-5 py-3">Shipment</th>
                      <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-5 py-3">Customer</th>
                      <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-5 py-3">Route</th>
                      <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-5 py-3">Status</th>
                      <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-5 py-3">Docs</th>
                      <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-5 py-3">Update</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/30">
                    {(data?.data || []).map((shipment) => (
                      <tr
                        key={shipment.id}
                        className="hover:bg-slate-700/20 transition-colors cursor-pointer"
                      >
                        <td className="px-5 py-3.5" onClick={() => setSelectedShipment(shipment)}>
                          <span className="text-xs font-mono font-semibold text-amber-400">
                            {shipment.trackingNumber}
                          </span>
                        </td>
                        <td className="px-5 py-3.5" onClick={() => setSelectedShipment(shipment)}>
                          <p className="text-sm font-medium text-slate-200">{shipment.title}</p>
                        </td>
                        <td className="px-5 py-3.5" onClick={() => setSelectedShipment(shipment)}>
                          <div className="flex items-center gap-1.5">
                            <User className="w-3 h-3 text-slate-600" />
                            <span className="text-sm text-slate-400">{(shipment as any).user?.name || 'Unknown'}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3.5" onClick={() => setSelectedShipment(shipment)}>
                          <div className="flex items-center gap-1.5 text-xs text-slate-500">
                            <MapPin className="w-3 h-3 text-slate-600 flex-shrink-0" />
                            <span className="truncate max-w-[80px]">{shipment.origin}</span>
                            <span className="text-slate-700">→</span>
                            <span className="truncate max-w-[80px]">{shipment.destination}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3.5" onClick={() => setSelectedShipment(shipment)}>
                          <StatusBadge status={shipment.status} />
                        </td>
                        <td className="px-5 py-3.5" onClick={() => setSelectedShipment(shipment)}>
                          <div className="flex items-center gap-1 text-xs text-slate-500">
                            <FileText className="w-3 h-3" />
                            <span>{(shipment as any)._count?.documents ?? 0}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="relative">
                            <select
                              value=""
                              onChange={(e) => handleUpdateStatus(shipment.id, e.target.value as ShipmentStatus)}
                              disabled={updatingId === shipment.id}
                              onClick={(e) => e.stopPropagation()}
                              className="appearance-none pl-2 pr-7 py-1.5 text-xs bg-slate-700 border border-slate-600 rounded-lg text-slate-300 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50 cursor-pointer hover:bg-slate-600 transition-colors"
                            >
                              <option value="" disabled>Change status...</option>
                              {STATUSES.map((s) => (
                                <option key={s} value={s} disabled={s === shipment.status}>
                                  {s.replace(/_/g, ' ')}
                                </option>
                              ))}
                            </select>
                            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500 pointer-events-none" />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {(!data?.data || data.data.length === 0) && (
                <div className="p-16 text-center">
                  <AlertTriangle className="w-8 h-8 text-slate-700 mx-auto mb-2" />
                  <p className="text-sm text-slate-600">No shipments found</p>
                </div>
              )}
            </div>

            {/* Pagination */}
            {data && data.pagination.totalPages > 1 && (
              <div className="flex items-center justify-between pt-1">
                <p className="text-xs text-slate-600">
                  Page {data.pagination.page} of {data.pagination.totalPages} · {data.pagination.total} total
                </p>
                <div className="flex gap-2">
                  <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                    className="px-3 py-1.5 text-xs border border-slate-700 rounded-lg text-slate-400 disabled:opacity-40 hover:bg-slate-800 transition-colors">
                    Previous
                  </button>
                  <button onClick={() => setPage((p) => p + 1)} disabled={page >= data.pagination.totalPages}
                    className="px-3 py-1.5 text-xs border border-slate-700 rounded-lg text-slate-400 disabled:opacity-40 hover:bg-slate-800 transition-colors">
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Risk Intelligence Drawer */}
      {selectedShipment && (
        <DocumentDrawer
          shipment={selectedShipment}
          onClose={() => setSelectedShipment(null)}
        />
      )}
    </Layout>
  );
}

import { useState, useRef, useEffect } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import api from '../api';
import { PaginatedResponse, Shipment, ShipmentStatus, AdminStats } from '../types';
import Layout from '../components/Layout';
import { StatusBadge } from '../components/TrackingTimeline';
import toast from 'react-hot-toast';
import {
  Search, Shield, MapPin, User, ChevronDown, X, FileText,
  Download, Package, TrendingUp, Clock, CheckCircle, AlertTriangle,
  Bot, Brain, AlertCircle, Info, Lightbulb, RefreshCw, Zap,
  Send, MessageSquare, History, BarChart3, ListChecks, Sparkles,
  ChevronRight, Loader2, Route
} from 'lucide-react';

const STATUSES: ShipmentStatus[] = ['CREATED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELAYED', 'CANCELLED'];

// ─── Types ────────────────────────────────────────────────────────────────────

interface Document { id: string; originalName: string; documentType: string; fileSize: number; uploadedAt: string; }

interface ComplianceFinding { id: string; findingType: string; severity: string; description: string; evidence: string | null; reasoning: string | null; confidenceScore: number | null; recommendedAction: string | null; documentId: string | null; }
interface ComplianceReport { status: string; summary: string | null; overallRiskScore: number | null; riskLevel: string | null; executiveSummary: string | null; recommendedDisposition: string | null; modelId: string | null; modelConfidence: number | null; processingTimeMs: number | null; findings: ComplianceFinding[]; createdAt: string; }

interface CopilotSummary { headline: string; goods: string; corridor: string; carrier: string; weight: string; keyObservations: string[]; potentialConcerns: string[]; generatedAt: string; providerName?: string; }
interface CopilotExplainRisk { explanation: string; topFactors: string[]; riskDriverSummary: string; generatedAt: string; providerName?: string; }
interface CopilotRecommendations { immediateActions: string[]; beforeRelease: string[]; escalationRequired: boolean; escalationReason: string | null; timeline: string; generatedAt: string; providerName?: string; }
interface CopilotQnA { answer: string; sourceReferences: string[]; confidence: number; generatedAt: string; providerName?: string; }
interface SimilarShipment { trackingNumber: string; origin: string; destination: string; shipmentType: string; riskLevel: string | null; status: string; findingTypes: string[]; }
interface CopilotSimilar { similarShipments: SimilarShipment[]; patterns: string[]; repeatedRisks: string[]; generatedAt: string; providerName?: string; }
interface TimelineMilestone { phase: string; description: string; }
interface CopilotTimeline { narrative: string; milestones: TimelineMilestone[]; currentPhase: string; estimatedResolution: string; generatedAt: string; providerName?: string; }

// ─── Suggested questions per risk level ──────────────────────────────────────

const SUGGESTED_QUESTIONS: Record<string, string[]> = {
  HIGH: [
    'Why is this shipment high risk?',
    'What documents are missing?',
    'Which findings need immediate action?',
    'What should be verified before customs filing?',
    'Is there a sanctions risk on this route?',
  ],
  CRITICAL: [
    'Why is this shipment critical risk?',
    'What must be resolved before release?',
    'Are there sanctions-listed parties?',
    'What are the most serious compliance issues?',
    'Should this shipment be escalated?',
  ],
  MEDIUM: [
    'What are the moderate risk factors?',
    'Which documents need verification?',
    'Can this shipment proceed with conditions?',
    'What inconsistencies were found?',
  ],
  LOW: [
    'Is this shipment clear to proceed?',
    'Are all documents present?',
    'What standard checks apply to this route?',
  ],
  DEFAULT: [
    'What documents are missing?',
    'Summarize the compliance risks for this shipment.',
    'What should be verified before release?',
    'Are the weights consistent across documents?',
    'What are the customs requirements for this route?',
  ],
};

// ─── Utility: Risk colors ─────────────────────────────────────────────────────

function riskColor(riskLevel: string | null) {
  return riskLevel === 'CRITICAL' ? 'text-red-400'
    : riskLevel === 'HIGH'     ? 'text-orange-400'
    : riskLevel === 'MEDIUM'   ? 'text-yellow-400'
                                : 'text-emerald-400';
}
function riskBg(riskLevel: string | null) {
  return riskLevel === 'CRITICAL' ? 'bg-red-500/10 border-red-500/30'
    : riskLevel === 'HIGH'     ? 'bg-orange-500/10 border-orange-500/30'
    : riskLevel === 'MEDIUM'   ? 'bg-yellow-500/10 border-yellow-500/30'
                                : 'bg-emerald-500/10 border-emerald-500/30';
}
function riskBar(riskLevel: string | null) {
  return riskLevel === 'CRITICAL' ? 'bg-red-500'
    : riskLevel === 'HIGH'     ? 'bg-orange-500'
    : riskLevel === 'MEDIUM'   ? 'bg-yellow-500'
                                : 'bg-emerald-500';
}

// ─── Small UI components ──────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, color }: { icon: React.ElementType; label: string; value: number | string; color: string; }) {
  return (
    <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4 flex items-center gap-3">
      <div className={`w-9 h-9 ${color} rounded-lg flex items-center justify-center flex-shrink-0`}><Icon className="w-4.5 h-4.5" /></div>
      <div><p className="text-xs text-slate-500">{label}</p><p className="text-lg font-bold text-slate-100">{value}</p></div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = { CRITICAL: 'bg-red-500/15 text-red-400 border-red-500/30', HIGH: 'bg-orange-500/15 text-orange-400 border-orange-500/30', MEDIUM: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30', LOW: 'bg-slate-500/15 text-slate-400 border-slate-500/30' };
  return <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border ${map[severity] ?? map.LOW}`}>{severity}</span>;
}

function ProviderBadge({ providerName }: { providerName?: string }) {
  if (!providerName) return null;
  const label = providerName === 'bedrock' ? 'Nova Lite' : providerName === 'gemini' ? 'Gemini' : 'Mock AI';
  return <span className="text-xs px-1.5 py-0.5 bg-purple-500/10 border border-purple-500/20 rounded text-purple-400 font-mono">{label}</span>;
}

function SectionLoader() {
  return <div className="flex items-center gap-2 py-4 text-slate-600"><Loader2 className="w-4 h-4 animate-spin" /><span className="text-xs">AI is thinking...</span></div>;
}

function RiskScoreGauge({ score, riskLevel }: { score: number; riskLevel: string | null }) {
  const pct = Math.round(score * 100);
  return (
    <div className={`rounded-xl border p-4 ${riskBg(riskLevel)}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2"><Zap className={`w-4 h-4 ${riskColor(riskLevel)}`} /><span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Risk Score</span></div>
        <div className="text-right"><span className={`text-2xl font-bold ${riskColor(riskLevel)}`}>{pct}</span><span className="text-xs text-slate-500">/100</span></div>
      </div>
      <div className="h-2 bg-slate-700/60 rounded-full overflow-hidden mb-2"><div className={`h-full ${riskBar(riskLevel)} rounded-full transition-all duration-700`} style={{ width: `${pct}%` }} /></div>
      {riskLevel && <div className="flex items-center justify-between"><span className={`text-xs font-semibold ${riskColor(riskLevel)}`}>{riskLevel} RISK</span><span className="text-xs text-slate-600">AI-assessed</span></div>}
    </div>
  );
}

function DispositionBanner({ disposition }: { disposition: string }) {
  const isHold = /HOLD|CRITICAL/i.test(disposition);
  const isConditional = /CONDITIONAL|MEDIUM/i.test(disposition);
  const style = isHold ? 'bg-red-500/10 border-red-500/30 text-red-300' : isConditional ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-300' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300';
  const Icon = isHold ? AlertCircle : isConditional ? AlertTriangle : CheckCircle;
  return <div className={`flex items-start gap-2.5 p-3 rounded-lg border ${style}`}><Icon className="w-4 h-4 flex-shrink-0 mt-0.5" /><p className="text-xs leading-relaxed font-medium">{disposition}</p></div>;
}

function FindingCard({ finding }: { finding: ComplianceFinding }) {
  const [expanded, setExpanded] = useState(false);
  const hasIntel = finding.evidence || finding.reasoning || finding.recommendedAction;
  return (
    <div className="bg-slate-800/60 border border-slate-700/50 rounded-lg overflow-hidden">
      <div className={`p-3 ${hasIntel ? 'cursor-pointer hover:bg-slate-800' : ''} transition-colors`} onClick={() => hasIntel && setExpanded(!expanded)}>
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <p className="text-xs font-semibold text-slate-200 truncate">{finding.findingType.replace(/_/g, ' ')}</p>
            {finding.confidenceScore !== null && <span className="text-xs text-slate-600 flex-shrink-0">{Math.round((finding.confidenceScore ?? 0) * 100)}% conf</span>}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0"><SeverityBadge severity={finding.severity} />{hasIntel && <ChevronDown className={`w-3.5 h-3.5 text-slate-500 transition-transform ${expanded ? 'rotate-180' : ''}`} />}</div>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">{finding.description}</p>
      </div>
      {expanded && hasIntel && (
        <div className="border-t border-slate-700/50 divide-y divide-slate-700/30">
          {finding.evidence && <div className="px-3 py-2.5"><div className="flex items-center gap-1.5 mb-1.5"><FileText className="w-3 h-3 text-blue-400" /><span className="text-xs font-semibold text-blue-400 uppercase tracking-wider">Evidence</span></div><p className="text-xs text-slate-400 leading-relaxed font-mono bg-slate-900/60 rounded p-2">{finding.evidence}</p></div>}
          {finding.reasoning && <div className="px-3 py-2.5"><div className="flex items-center gap-1.5 mb-1.5"><Brain className="w-3 h-3 text-purple-400" /><span className="text-xs font-semibold text-purple-400 uppercase tracking-wider">AI Reasoning</span></div><p className="text-xs text-slate-300 leading-relaxed">{finding.reasoning}</p></div>}
          {finding.recommendedAction && <div className="px-3 py-2.5"><div className="flex items-center gap-1.5 mb-1.5"><Lightbulb className="w-3 h-3 text-amber-400" /><span className="text-xs font-semibold text-amber-400 uppercase tracking-wider">Recommended Action</span></div><p className="text-xs text-slate-200 leading-relaxed">{finding.recommendedAction}</p></div>}
        </div>
      )}
    </div>
  );
}

// ─── Copilot Section: Executive Summary Card ──────────────────────────────────

function ExecutiveSummaryCard({ data }: { data: CopilotSummary }) {
  return (
    <div className="space-y-3">
      <div className="bg-gradient-to-br from-slate-800/80 to-slate-900/80 border border-purple-500/20 rounded-xl p-4">
        <div className="flex items-start justify-between gap-2 mb-3">
          <p className="text-sm font-semibold text-slate-100 leading-snug">{data.headline}</p>
          <ProviderBadge providerName={data.providerName} />
        </div>
        <div className="grid grid-cols-2 gap-2 mb-3">
          {[['Goods', data.goods], ['Corridor', data.corridor], ['Carrier', data.carrier], ['Weight', data.weight]].map(([label, value]) => (
            <div key={label} className="bg-slate-900/60 rounded-lg px-2.5 py-2">
              <p className="text-xs text-slate-600 mb-0.5">{label}</p>
              <p className="text-xs font-medium text-slate-300 truncate">{value}</p>
            </div>
          ))}
        </div>
        {data.keyObservations.length > 0 && (
          <div className="mb-2">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Key Observations</p>
            <ul className="space-y-1">{data.keyObservations.map((o, i) => <li key={i} className="flex items-start gap-1.5"><ChevronRight className="w-3 h-3 text-blue-400 flex-shrink-0 mt-0.5" /><span className="text-xs text-slate-300">{o}</span></li>)}</ul>
          </div>
        )}
        {data.potentialConcerns.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Potential Concerns</p>
            <ul className="space-y-1">{data.potentialConcerns.map((c, i) => <li key={i} className="flex items-start gap-1.5"><AlertTriangle className="w-3 h-3 text-amber-400 flex-shrink-0 mt-0.5" /><span className="text-xs text-slate-400">{c}</span></li>)}</ul>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Copilot Section: Timeline Narrative ─────────────────────────────────────

function TimelineCard({ data }: { data: CopilotTimeline }) {
  return (
    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><Route className="w-3.5 h-3.5 text-indigo-400" /><span className="text-xs font-semibold text-indigo-400 uppercase tracking-wider">Journey Narrative</span></div>
        <ProviderBadge providerName={data.providerName} />
      </div>
      <p className="text-xs text-slate-300 leading-relaxed">{data.narrative}</p>
      {data.milestones.length > 0 && (
        <div className="space-y-1.5 pt-1">
          {data.milestones.map((m, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-indigo-500/60 flex-shrink-0" />
              <span className="text-xs text-slate-500 font-medium w-28 flex-shrink-0">{m.phase.replace(/_/g, ' ')}</span>
              <span className="text-xs text-slate-400">{m.description}</span>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-slate-600 italic">{data.estimatedResolution}</p>
    </div>
  );
}

// ─── Copilot Section: Explain Risk ───────────────────────────────────────────

function ExplainRiskCard({ data }: { data: CopilotExplainRisk }) {
  return (
    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><Brain className="w-3.5 h-3.5 text-purple-400" /><span className="text-xs font-semibold text-purple-400 uppercase tracking-wider">Risk Explanation</span></div>
        <ProviderBadge providerName={data.providerName} />
      </div>
      <p className="text-sm text-slate-300 leading-relaxed italic border-l-2 border-purple-500/30 pl-3">"{data.riskDriverSummary}"</p>
      <p className="text-xs text-slate-400 leading-relaxed">{data.explanation}</p>
      {data.topFactors.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Top Risk Factors</p>
          <ul className="space-y-1">{data.topFactors.map((f, i) => <li key={i} className="flex items-start gap-1.5"><AlertCircle className="w-3 h-3 text-orange-400 flex-shrink-0 mt-0.5" /><span className="text-xs text-slate-300">{f}</span></li>)}</ul>
        </div>
      )}
    </div>
  );
}

// ─── Copilot Section: Recommendations ────────────────────────────────────────

function RecommendationsCard({ data }: { data: CopilotRecommendations }) {
  return (
    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><ListChecks className="w-3.5 h-3.5 text-emerald-400" /><span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">Action Plan</span></div>
        <ProviderBadge providerName={data.providerName} />
      </div>
      {data.escalationRequired && (
        <div className="flex items-start gap-2 p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg">
          <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
          <div><p className="text-xs font-bold text-red-400">ESCALATION REQUIRED</p>{data.escalationReason && <p className="text-xs text-red-300 mt-0.5">{data.escalationReason}</p>}</div>
        </div>
      )}
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Immediate Actions</p>
        <ol className="space-y-1.5">{data.immediateActions.map((a, i) => <li key={i} className="flex items-start gap-2"><span className="text-xs font-bold text-slate-600 w-4 flex-shrink-0">{i + 1}.</span><span className="text-xs text-slate-300">{a}</span></li>)}</ol>
      </div>
      {data.beforeRelease.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Before Release</p>
          <ul className="space-y-1">{data.beforeRelease.map((b, i) => <li key={i} className="flex items-start gap-1.5"><CheckCircle className="w-3 h-3 text-emerald-400 flex-shrink-0 mt-0.5" /><span className="text-xs text-slate-400">{b}</span></li>)}</ul>
        </div>
      )}
      <p className="text-xs text-slate-500 border-t border-slate-700/30 pt-2">{data.timeline}</p>
    </div>
  );
}

// ─── Copilot Section: Similar Shipments ──────────────────────────────────────

function SimilarShipmentsCard({ data }: { data: CopilotSimilar }) {
  return (
    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><BarChart3 className="w-3.5 h-3.5 text-cyan-400" /><span className="text-xs font-semibold text-cyan-400 uppercase tracking-wider">Historical Patterns</span></div>
        <ProviderBadge providerName={data.providerName} />
      </div>
      {data.similarShipments.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-slate-600">{data.similarShipments.length} similar shipment{data.similarShipments.length !== 1 ? 's' : ''} analyzed</p>
          {data.similarShipments.slice(0, 4).map((s) => (
            <div key={s.trackingNumber} className="flex items-center gap-2 py-1.5 px-2 bg-slate-900/40 rounded-lg">
              <span className="text-xs font-mono text-slate-500 flex-shrink-0">{s.trackingNumber}</span>
              <span className={`text-xs font-medium flex-shrink-0 ${riskColor(s.riskLevel)}`}>{s.riskLevel ?? 'N/A'}</span>
              <span className="text-xs text-slate-600 truncate">{s.origin.split(',')[0]} → {s.destination.split(',')[0]}</span>
            </div>
          ))}
        </div>
      )}
      {data.patterns.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Observed Patterns</p>
          <ul className="space-y-1">{data.patterns.map((p, i) => <li key={i} className="flex items-start gap-1.5"><ChevronRight className="w-3 h-3 text-cyan-500 flex-shrink-0 mt-0.5" /><span className="text-xs text-slate-400">{p}</span></li>)}</ul>
        </div>
      )}
      {data.repeatedRisks.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Repeated Risks</p>
          <ul className="space-y-1">{data.repeatedRisks.map((r, i) => <li key={i} className="flex items-start gap-1.5"><AlertTriangle className="w-3 h-3 text-amber-400 flex-shrink-0 mt-0.5" /><span className="text-xs text-slate-400">{r}</span></li>)}</ul>
        </div>
      )}
    </div>
  );
}

// ─── Copilot Section: Ask AI (Q&A) ───────────────────────────────────────────

function AskCopilotPanel({ shipmentId, riskLevel }: { shipmentId: string; riskLevel: string | null }) {
  const [question, setQuestion] = useState('');
  const [lastQnA, setLastQnA] = useState<{ question: string; answer: CopilotQnA } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const suggested = SUGGESTED_QUESTIONS[riskLevel ?? 'DEFAULT'] ?? SUGGESTED_QUESTIONS.DEFAULT;

  const { mutate: ask, isPending } = useMutation({
    mutationFn: async (q: string) => {
      const { data } = await api.post(`/admin/copilot/${shipmentId}/ask`, { question: q });
      return data as CopilotQnA;
    },
    onSuccess: (data, q) => setLastQnA({ question: q, answer: data }),
    onError: () => toast.error('Failed to get AI answer'),
  });

  const handleAsk = () => {
    const q = question.trim();
    if (!q) return;
    ask(q);
    setQuestion('');
  };

  return (
    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <MessageSquare className="w-3.5 h-3.5 text-amber-400" />
        <span className="text-xs font-semibold text-amber-400 uppercase tracking-wider">Ask Copilot</span>
      </div>

      {/* Suggested questions */}
      <div>
        <p className="text-xs text-slate-600 mb-2">Suggested questions:</p>
        <div className="flex flex-wrap gap-1.5">
          {suggested.slice(0, 4).map((q) => (
            <button
              key={q}
              onClick={() => { setQuestion(q); setTimeout(() => inputRef.current?.focus(), 50); }}
              className="text-xs px-2.5 py-1 bg-slate-700/60 border border-slate-600/50 rounded-full text-slate-400 hover:text-slate-200 hover:border-amber-500/30 hover:bg-amber-500/5 transition-colors"
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      {/* Input */}
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAsk()}
          placeholder="Ask anything about this shipment..."
          className="flex-1 px-3 py-2 text-xs bg-slate-900/60 border border-slate-700 rounded-lg text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-500"
        />
        <button
          onClick={handleAsk}
          disabled={isPending || !question.trim()}
          className="flex-shrink-0 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-400 hover:bg-amber-500/20 disabled:opacity-40 transition-colors"
        >
          {isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* Answer */}
      {lastQnA && (
        <div className="bg-slate-900/60 border border-slate-700/30 rounded-lg p-3 space-y-2">
          <p className="text-xs font-medium text-amber-400">Q: {lastQnA.question}</p>
          <p className="text-xs text-slate-300 leading-relaxed">{lastQnA.answer.answer}</p>
          {lastQnA.answer.sourceReferences.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {lastQnA.answer.sourceReferences.map((ref, i) => (
                <span key={i} className="text-xs px-1.5 py-0.5 bg-slate-700/50 text-slate-500 rounded">{ref}</span>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between pt-0.5">
            <span className="text-xs text-slate-600">Confidence: {Math.round(lastQnA.answer.confidence * 100)}%</span>
            {lastQnA.answer.providerName && <ProviderBadge providerName={lastQnA.answer.providerName} />}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Document Drawer ──────────────────────────────────────────────────────────

function DocumentDrawer({ shipment, onClose }: { shipment: Shipment; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [triggering, setTriggering] = useState(false);

  const { data: docs, isLoading: docsLoading } = useQuery<Document[]>({
    queryKey: ['admin-docs', shipment.id],
    queryFn: async () => { const { data } = await api.get(`/admin/documents/${shipment.id}`); return data; },
  });

  const { data: compliance, isLoading: complianceLoading } = useQuery<ComplianceReport>({
    queryKey: ['admin-compliance', shipment.id],
    queryFn: async () => { const { data } = await api.get(`/admin/compliance/${shipment.id}`); return data; },
    retry: false,
  });

  // Route Intelligence Briefing — generated on shipment create
  const { data: briefing } = useQuery<any>({
    queryKey: ['admin-briefing', shipment.id],
    queryFn: async () => {
      const { data } = await api.get(`/admin/briefing/${shipment.id}`);
      return data;
    },
    retry: false,
    staleTime: 10 * 60 * 1000,
  });

  // Copilot queries — auto-load on drawer open
  const { data: copilotSummary, isLoading: summaryLoading } = useQuery<CopilotSummary>({
    queryKey: ['copilot-summary', shipment.id],
    queryFn: async () => { const { data } = await api.post(`/admin/copilot/${shipment.id}/summary`); return data; },
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const { data: copilotTimeline, isLoading: timelineLoading } = useQuery<CopilotTimeline>({
    queryKey: ['copilot-timeline', shipment.id],
    queryFn: async () => { const { data } = await api.get(`/admin/copilot/${shipment.id}/timeline`); return data; },
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  // On-demand copilot queries
  const { data: explainRisk, isLoading: explainLoading, refetch: fetchExplain } = useQuery<CopilotExplainRisk>({
    queryKey: ['copilot-explain', shipment.id],
    queryFn: async () => { const { data } = await api.post(`/admin/copilot/${shipment.id}/explain-risk`); return data; },
    enabled: false,
    retry: false,
  });

  const { data: recommendations, isLoading: recoLoading, refetch: fetchReco } = useQuery<CopilotRecommendations>({
    queryKey: ['copilot-reco', shipment.id],
    queryFn: async () => { const { data } = await api.post(`/admin/copilot/${shipment.id}/recommendations`); return data; },
    enabled: false,
    retry: false,
  });

  const { data: similar, isLoading: similarLoading, refetch: fetchSimilar } = useQuery<CopilotSimilar>({
    queryKey: ['copilot-similar', shipment.id],
    queryFn: async () => { const { data } = await api.get(`/admin/copilot/${shipment.id}/similar`); return data; },
    enabled: false,
    retry: false,
  });

  const handleRetrigger = async () => {
    setTriggering(true);
    try {
      await api.post(`/admin/compliance/trigger/${shipment.id}`);
      toast.success('Risk intelligence analysis started');
      setTimeout(() => { queryClient.invalidateQueries({ queryKey: ['admin-compliance', shipment.id] }); queryClient.invalidateQueries({ queryKey: ['copilot-summary', shipment.id] }); }, 5000);
    } catch { toast.error('Failed to trigger analysis'); } finally { setTriggering(false); }
  };

  const handleDownload = async (docId: string, name: string) => {
    try {
      const response = await api.get(`/documents/${docId}/download`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a'); link.href = url; link.setAttribute('download', name);
      document.body.appendChild(link); link.click(); link.remove(); window.URL.revokeObjectURL(url);
    } catch { toast.error('Failed to download document'); }
  };

  const statusColor: Record<string, string> = { PASSED: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20', FAILED: 'text-red-400 bg-red-500/10 border-red-500/20', PARTIAL: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20', PENDING: 'text-slate-400 bg-slate-500/10 border-slate-500/20' };
  const riskLevel = compliance?.riskLevel ?? null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-slate-900 border-l border-slate-700/50 h-full overflow-y-auto shadow-2xl flex flex-col">
        {/* Header */}
        <div className="sticky top-0 bg-slate-900/95 backdrop-blur border-b border-slate-700/50 px-5 py-4 flex items-center justify-between z-10">
          <div>
            <p className="text-xs font-mono text-amber-400">{shipment.trackingNumber}</p>
            <h2 className="text-base font-semibold text-slate-100 mt-0.5">{shipment.title}</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-slate-200 transition-colors"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 p-5 space-y-7">

          {/* ══ 0. Route Intelligence Briefing ═══════════════════════════ */}
          {briefing && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Route className="w-4 h-4 text-indigo-400" />
                <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Route Intelligence</h3>
              </div>
              <div style={{
                background: 'linear-gradient(135deg, rgba(15,23,42,0.95), rgba(30,41,59,0.95))',
                border: '1px solid rgba(99,102,241,0.3)',
                borderRadius: '12px',
                padding: '14px',
              }}>
                <div style={{ color: '#a5b4fc', fontSize: '12px', fontWeight: 700, marginBottom: '6px' }}>{briefing.corridor}</div>
                <p style={{ color: '#94a3b8', fontSize: '12px', lineHeight: 1.5, margin: '0 0 10px' }}>{briefing.riskSummary}</p>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
                  {briefing.customsComplexity && (
                    <span style={{
                      padding: '3px 8px', borderRadius: '12px', fontSize: '10px', fontWeight: 700,
                      background: briefing.customsComplexity === 'HIGH' ? 'rgba(239,68,68,0.1)' : briefing.customsComplexity === 'MEDIUM' ? 'rgba(245,158,11,0.1)' : 'rgba(34,197,94,0.1)',
                      color: briefing.customsComplexity === 'HIGH' ? '#fca5a5' : briefing.customsComplexity === 'MEDIUM' ? '#fcd34d' : '#86efac',
                      border: `1px solid ${briefing.customsComplexity === 'HIGH' ? 'rgba(239,68,68,0.25)' : briefing.customsComplexity === 'MEDIUM' ? 'rgba(245,158,11,0.25)' : 'rgba(34,197,94,0.25)'}`,
                    }}>⚙️ {briefing.customsComplexity} COMPLEXITY</span>
                  )}
                  {briefing.sanctionsStatus && (
                    <span style={{
                      padding: '3px 8px', borderRadius: '12px', fontSize: '10px', fontWeight: 700,
                      background: briefing.sanctionsStatus === 'BLOCKED' ? 'rgba(239,68,68,0.1)' : briefing.sanctionsStatus === 'WATCH' ? 'rgba(245,158,11,0.1)' : 'rgba(34,197,94,0.1)',
                      color: briefing.sanctionsStatus === 'BLOCKED' ? '#fca5a5' : briefing.sanctionsStatus === 'WATCH' ? '#fcd34d' : '#86efac',
                      border: `1px solid ${briefing.sanctionsStatus === 'BLOCKED' ? 'rgba(239,68,68,0.25)' : briefing.sanctionsStatus === 'WATCH' ? 'rgba(245,158,11,0.25)' : 'rgba(34,197,94,0.25)'}`,
                    }}>{briefing.sanctionsStatus === 'CLEAR' ? '✓' : '⚠'} {briefing.sanctionsStatus}</span>
                  )}
                  {briefing.estimatedClearanceHours && (
                    <span style={{ padding: '3px 8px', borderRadius: '12px', fontSize: '10px', fontWeight: 600, background: 'rgba(148,163,184,0.08)', color: '#94a3b8', border: '1px solid rgba(148,163,184,0.2)' }}>
                      ⏱ ~{briefing.estimatedClearanceHours}h clearance
                    </span>
                  )}
                  {typeof briefing.delayProbability === 'number' && (
                    <span style={{ padding: '3px 8px', borderRadius: '12px', fontSize: '10px', fontWeight: 600, background: 'rgba(148,163,184,0.08)', color: '#94a3b8', border: '1px solid rgba(148,163,184,0.2)' }}>
                      {Math.round(briefing.delayProbability * 100)}% delay risk
                    </span>
                  )}
                </div>
                {briefing.requiredDocuments?.length > 0 && (
                  <div>
                    <div style={{ color: '#64748b', fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '5px' }}>Required Documents</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                      {briefing.requiredDocuments.map((doc: string, i: number) => (
                        <span key={i} style={{ padding: '2px 8px', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '10px', color: '#a5b4fc', fontSize: '10px' }}>
                          {doc}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ══ 1. AI Executive Brief ════════════════════════════════════ */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-4 h-4 text-purple-400" />
              <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">AI Shipment Brief</h3>
            </div>
            {summaryLoading ? <SectionLoader /> : copilotSummary ? <ExecutiveSummaryCard data={copilotSummary} /> : <p className="text-xs text-slate-600">Unable to generate summary.</p>}
          </section>

          {/* ══ 2. Risk Intelligence Engine ══════════════════════════════ */}
          <section>
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2"><Brain className="w-4 h-4 text-purple-400" /><h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Risk Intelligence</h3></div>
              <button onClick={handleRetrigger} disabled={triggering} className="flex items-center gap-1 px-2 py-1 text-xs bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600 rounded-lg transition-colors disabled:opacity-50"><RefreshCw className={`w-3 h-3 ${triggering ? 'animate-spin' : ''}`} />Re-analyze</button>
            </div>
            {complianceLoading ? <SectionLoader /> : compliance ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium ${statusColor[compliance.status] ?? statusColor.PENDING}`}>{compliance.status}</span>
                  {compliance.modelId && <div className="flex items-center gap-1 px-2 py-1 bg-slate-800 border border-slate-700 rounded-lg"><Bot className="w-3 h-3 text-slate-500" /><span className="text-xs text-slate-500 font-mono truncate max-w-[160px]">{compliance.modelId}</span></div>}
                  {compliance.processingTimeMs && <span className="text-xs text-slate-600">{(compliance.processingTimeMs / 1000).toFixed(1)}s</span>}
                </div>
                {compliance.overallRiskScore !== null && <RiskScoreGauge score={compliance.overallRiskScore} riskLevel={compliance.riskLevel} />}
                {compliance.executiveSummary && <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4"><div className="flex items-center gap-2 mb-2"><Info className="w-3.5 h-3.5 text-blue-400" /><span className="text-xs font-semibold text-blue-400 uppercase tracking-wider">Executive Summary</span></div><p className="text-sm text-slate-300 leading-relaxed">{compliance.executiveSummary}</p></div>}
                {compliance.recommendedDisposition && <DispositionBanner disposition={compliance.recommendedDisposition} />}
                {compliance.findings.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 pt-1"><AlertTriangle className="w-3.5 h-3.5 text-slate-500" /><span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{compliance.findings.length} Finding{compliance.findings.length !== 1 ? 's' : ''}</span><span className="text-xs text-slate-700 ml-auto">Click to expand</span></div>
                    {compliance.findings.map((f) => <FindingCard key={f.id} finding={f} />)}
                  </div>
                )}
                {compliance.findings.length === 0 && compliance.status === 'PASSED' && <div className="flex items-center gap-2 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg"><CheckCircle className="w-4 h-4 text-emerald-400" /><p className="text-xs text-emerald-300">No compliance risks identified</p></div>}
              </div>
            ) : (
              <div className="bg-slate-800/40 border border-slate-700/30 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2"><Bot className="w-4 h-4 text-slate-600" /><p className="text-xs text-slate-500 font-medium">No risk assessment yet</p></div>
                <p className="text-xs text-slate-600 leading-relaxed">The Risk Intelligence Agent runs automatically at IN_TRANSIT. Use Re-analyze to trigger manually.</p>
              </div>
            )}
          </section>

          {/* ══ 3. On-demand Explain Risk ════════════════════════════════ */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2"><Brain className="w-3.5 h-3.5 text-purple-400" /><h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Explain Risk</h3></div>
              {!explainRisk && <button onClick={() => fetchExplain()} disabled={explainLoading} className="text-xs px-2.5 py-1 bg-purple-500/10 border border-purple-500/20 text-purple-400 rounded-lg hover:bg-purple-500/20 disabled:opacity-50 transition-colors flex items-center gap-1">{explainLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}Generate</button>}
            </div>
            {explainLoading ? <SectionLoader /> : explainRisk ? <ExplainRiskCard data={explainRisk} /> : <p className="text-xs text-slate-600">Click Generate to get a plain-English risk explanation.</p>}
          </section>

          {/* ══ 4. On-demand Recommendations ════════════════════════════ */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2"><ListChecks className="w-3.5 h-3.5 text-emerald-400" /><h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Action Plan</h3></div>
              {!recommendations && <button onClick={() => fetchReco()} disabled={recoLoading} className="text-xs px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-lg hover:bg-emerald-500/20 disabled:opacity-50 transition-colors flex items-center gap-1">{recoLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}Generate</button>}
            </div>
            {recoLoading ? <SectionLoader /> : recommendations ? <RecommendationsCard data={recommendations} /> : <p className="text-xs text-slate-600">Click Generate to get an AI-powered action plan.</p>}
          </section>

          {/* ══ 5. Ask Copilot (Q&A) ════════════════════════════════════ */}
          <section>
            <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-3">Ask Copilot</h3>
            <AskCopilotPanel shipmentId={shipment.id} riskLevel={riskLevel} />
          </section>

          {/* ══ 6. Timeline Narrative ════════════════════════════════════ */}
          <section>
            <div className="flex items-center gap-2 mb-3"><History className="w-3.5 h-3.5 text-indigo-400" /><h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Journey Narrative</h3></div>
            {timelineLoading ? <SectionLoader /> : copilotTimeline ? <TimelineCard data={copilotTimeline} /> : <p className="text-xs text-slate-600">Timeline narrative unavailable.</p>}
          </section>

          {/* ══ 7. Similar Shipment Analysis ════════════════════════════ */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2"><BarChart3 className="w-3.5 h-3.5 text-cyan-400" /><h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Historical Patterns</h3></div>
              {!similar && <button onClick={() => fetchSimilar()} disabled={similarLoading} className="text-xs px-2.5 py-1 bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 rounded-lg hover:bg-cyan-500/20 disabled:opacity-50 transition-colors flex items-center gap-1">{similarLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}Analyze</button>}
            </div>
            {similarLoading ? <SectionLoader /> : similar ? <SimilarShipmentsCard data={similar} /> : <p className="text-xs text-slate-600">Click Analyze to find similar historical shipments.</p>}
          </section>

          {/* ══ 8. Documents ════════════════════════════════════════════ */}
          <section>
            <div className="flex items-center gap-2 mb-3"><FileText className="w-4 h-4 text-slate-400" /><h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Documents</h3>{docs && <span className="ml-auto text-xs text-slate-600">{docs.length} file{docs.length !== 1 ? 's' : ''}</span>}</div>
            {docsLoading ? <SectionLoader /> : !docs || docs.length === 0 ? (
              <div className="bg-slate-800/40 border border-slate-700/30 rounded-lg p-6 text-center"><FileText className="w-6 h-6 text-slate-700 mx-auto mb-2" /><p className="text-xs text-slate-600">No documents uploaded</p></div>
            ) : (
              <div className="space-y-2">
                {docs.map((doc) => (
                  <div key={doc.id} className="bg-slate-800/60 border border-slate-700/50 rounded-lg p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0"><p className="text-sm font-medium text-slate-200 truncate">{doc.originalName}</p><div className="flex items-center gap-2 mt-0.5"><span className="text-xs px-1.5 py-0.5 bg-slate-700 rounded text-slate-400 font-mono">{doc.documentType.replace(/_/g, ' ')}</span><span className="text-xs text-slate-600">{(doc.fileSize / 1024).toFixed(1)} KB</span></div></div>
                    <button onClick={() => handleDownload(doc.id, doc.originalName)} className="flex-shrink-0 p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-400 hover:text-slate-200 transition-colors"><Download className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

// ─── Main Admin Page ──────────────────────────────────────────────────────────

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
      params.set('page', page.toString()); params.set('limit', '10');
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      const { data } = await api.get(`/admin/shipments?${params}`);
      return data;
    },
  });

  const { data: stats } = useQuery<AdminStats>({
    queryKey: ['admin-stats'],
    queryFn: async () => { const { data } = await api.get('/admin/stats'); return data; },
    staleTime: 30_000,
  });

  const handleUpdateStatus = async (shipmentId: string, newStatus: ShipmentStatus) => {
    setUpdatingId(shipmentId);
    try {
      await api.put(`/admin/shipments/${shipmentId}/status`, { status: newStatus, description: `Status updated to ${newStatus.replace(/_/g, ' ')}` });
      toast.success(`Status → ${newStatus.replace(/_/g, ' ')}`);
      queryClient.invalidateQueries({ queryKey: ['admin-shipments'] });
      queryClient.invalidateQueries({ queryKey: ['admin-stats'] });
    } catch (error: any) { toast.error(error.response?.data?.error || 'Failed to update status'); }
    finally { setUpdatingId(null); }
  };

  return (
    <Layout>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-center justify-center"><Shield className="w-4.5 h-4.5 text-amber-400" /></div>
          <div>
            <h1 className="text-xl font-bold text-slate-100">Admin Panel</h1>
            <p className="text-xs text-slate-500">Shipment Intelligence Copilot · Risk Engine · Compliance</p>
          </div>
        </div>

        {/* ── Intelligence Operations Dashboard ───────────────────────── */}
        {stats && (
          <div style={{
            background: 'linear-gradient(135deg, rgba(15,23,42,0.9) 0%, rgba(30,41,59,0.9) 100%)',
            border: '1px solid rgba(99,102,241,0.25)',
            borderRadius: '16px',
            padding: '20px 24px',
            marginBottom: '4px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ width: '28px', height: '28px', borderRadius: '8px', background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px' }}>✦</div>
                <div>
                  <div style={{ color: '#e2e8f0', fontSize: '14px', fontWeight: 700 }}>Fleet Risk Intelligence</div>
                  <div style={{ color: '#64748b', fontSize: '11px' }}>Real-time AI-assessed risk distribution · Nova Lite</div>
                </div>
              </div>
              <div style={{ color: '#64748b', fontSize: '11px' }}>{stats.total} shipments · {stats.unassessedCount ?? 0} pending analysis</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
              {[
                { label: 'CRITICAL', count: stats.criticalCount ?? 0, color: '#ef4444', bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.3)', icon: '🔴' },
                { label: 'HIGH',     count: stats.highCount     ?? 0, color: '#f97316', bg: 'rgba(249,115,22,0.1)', border: 'rgba(249,115,22,0.3)', icon: '🟠' },
                { label: 'MEDIUM',   count: stats.mediumCount   ?? 0, color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.3)', icon: '🟡' },
                { label: 'CLEAR',    count: stats.clearCount    ?? 0, color: '#22c55e', bg: 'rgba(34,197,94,0.1)',  border: 'rgba(34,197,94,0.3)',  icon: '🟢' },
              ].map(({ label, count, color, bg, border, icon }) => (
                <div key={label} style={{
                  background: bg, border: `1px solid ${border}`,
                  borderRadius: '12px', padding: '14px 16px', textAlign: 'center',
                }}>
                  <div style={{ fontSize: '20px', marginBottom: '4px' }}>{icon}</div>
                  <div style={{ color, fontSize: '26px', fontWeight: 800, lineHeight: 1 }}>{count}</div>
                  <div style={{ color, fontSize: '10px', fontWeight: 700, letterSpacing: '0.1em', marginTop: '4px' }}>{label}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Standard stats row */}
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
              <input type="text" placeholder="Search shipments..." value={searchInput} onChange={(e) => setSearchInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (setSearch(searchInput), setPage(1))} className="w-full pl-9 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-500" />
            </div>
            <button onClick={() => { setSearch(searchInput); setPage(1); }} className="px-4 py-2 bg-slate-800 border border-slate-700 text-slate-400 text-sm font-medium rounded-lg hover:bg-slate-700 hover:text-slate-200 transition-colors">Search</button>
          </div>
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} className="px-3 py-2 bg-slate-800 border border-slate-700 text-slate-400 text-sm rounded-lg focus:outline-none focus:ring-1 focus:ring-amber-500">
            <option value="">All Statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" /></div>
        ) : (
          <>
            <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-700/50 bg-slate-800/80">
                      {['Tracking #', 'Shipment', 'Customer', 'Route', 'AI Risk', 'Status', 'Docs', 'Update'].map((h) => (
                        <th key={h} className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-5 py-3">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/30">
                    {(data?.data || []).map((shipment) => (
                      <tr key={shipment.id} className="hover:bg-slate-700/20 transition-colors cursor-pointer">
                        <td className="px-5 py-3.5" onClick={() => setSelectedShipment(shipment)}><span className="text-xs font-mono font-semibold text-amber-400">{shipment.trackingNumber}</span></td>
                        <td className="px-5 py-3.5" onClick={() => setSelectedShipment(shipment)}><p className="text-sm font-medium text-slate-200">{shipment.title}</p><p className="text-xs text-slate-600 mt-0.5">{shipment.shipmentType}</p></td>
                        <td className="px-5 py-3.5" onClick={() => setSelectedShipment(shipment)}><div className="flex items-center gap-1.5"><User className="w-3 h-3 text-slate-600" /><span className="text-sm text-slate-400">{(shipment as any).user?.name || 'Unknown'}</span></div></td>
                        <td className="px-5 py-3.5" onClick={() => setSelectedShipment(shipment)}><div className="flex items-center gap-1.5 text-xs text-slate-500"><MapPin className="w-3 h-3 text-slate-600 flex-shrink-0" /><span className="truncate max-w-[80px]">{shipment.origin}</span><span className="text-slate-700">→</span><span className="truncate max-w-[80px]">{shipment.destination}</span></div></td>
                        <td className="px-5 py-3.5" onClick={() => setSelectedShipment(shipment)}>
                          {shipment.aiRiskLevel ? (
                            <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-bold border ${
                              shipment.aiRiskLevel === 'CRITICAL' ? 'bg-red-500/10 border-red-500/30 text-red-400' :
                              shipment.aiRiskLevel === 'HIGH'     ? 'bg-orange-500/10 border-orange-500/30 text-orange-400' :
                              shipment.aiRiskLevel === 'MEDIUM'   ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400' :
                                                                    'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                            }`}>
                              {shipment.aiRiskLevel === 'CRITICAL' ? '🔴' : shipment.aiRiskLevel === 'HIGH' ? '🟠' : shipment.aiRiskLevel === 'MEDIUM' ? '🟡' : '🟢'}
                              {' '}{shipment.aiRiskLevel}
                            </span>
                          ) : (
                            <span className="text-xs text-slate-600 italic">Pending...</span>
                          )}
                        </td>
                        <td className="px-5 py-3.5" onClick={() => setSelectedShipment(shipment)}><div className="flex items-center gap-1 text-xs text-slate-500"><FileText className="w-3 h-3" /><span>{(shipment as any)._count?.documents ?? 0}</span></div></td>
                        <td className="px-5 py-3.5">
                          <div className="relative">
                            <select value="" onChange={(e) => handleUpdateStatus(shipment.id, e.target.value as ShipmentStatus)} disabled={updatingId === shipment.id} onClick={(e) => e.stopPropagation()} className="appearance-none pl-2 pr-7 py-1.5 text-xs bg-slate-700 border border-slate-600 rounded-lg text-slate-300 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50 cursor-pointer hover:bg-slate-600 transition-colors">
                              <option value="" disabled>Change...</option>
                              {STATUSES.map((s) => <option key={s} value={s} disabled={s === shipment.status}>{s.replace(/_/g, ' ')}</option>)}
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
                <div className="p-16 text-center"><AlertTriangle className="w-8 h-8 text-slate-700 mx-auto mb-2" /><p className="text-sm text-slate-600">No shipments found</p></div>
              )}
            </div>

            {/* Pagination */}
            {data && data.pagination.totalPages > 1 && (
              <div className="flex items-center justify-between pt-1">
                <p className="text-xs text-slate-600">Page {data.pagination.page} of {data.pagination.totalPages} · {data.pagination.total} total</p>
                <div className="flex gap-2">
                  <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1.5 text-xs border border-slate-700 rounded-lg text-slate-400 disabled:opacity-40 hover:bg-slate-800 transition-colors">Previous</button>
                  <button onClick={() => setPage((p) => p + 1)} disabled={page >= data.pagination.totalPages} className="px-3 py-1.5 text-xs border border-slate-700 rounded-lg text-slate-400 disabled:opacity-40 hover:bg-slate-800 transition-colors">Next</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Intelligence Drawer */}
      {selectedShipment && <DocumentDrawer shipment={selectedShipment} onClose={() => setSelectedShipment(null)} />}
    </Layout>
  );
}

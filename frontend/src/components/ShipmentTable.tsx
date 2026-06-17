import { Link } from 'react-router-dom';
import type { Shipment } from '../types';
import { StatusBadge } from './TrackingTimeline';
import { Eye, MapPin, Package } from 'lucide-react';

interface Props {
  shipments: Shipment[];
}

// ─── Risk badge helper ────────────────────────────────────────────────────────

function RiskBadge({ level }: { level?: string | null }) {
  if (!level) {
    return <span style={{ color: '#475569', fontSize: '10px', fontStyle: 'italic' }}>AI pending</span>;
  }
  const config: Record<string, { color: string; bg: string; border: string; dot: string }> = {
    CRITICAL: { color: '#fca5a5', bg: 'rgba(239,68,68,0.1)',  border: 'rgba(239,68,68,0.3)',  dot: '🔴' },
    HIGH:     { color: '#fdba74', bg: 'rgba(249,115,22,0.1)', border: 'rgba(249,115,22,0.3)', dot: '🟠' },
    MEDIUM:   { color: '#fcd34d', bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.3)', dot: '🟡' },
    LOW:      { color: '#86efac', bg: 'rgba(34,197,94,0.1)',  border: 'rgba(34,197,94,0.3)',  dot: '🟢' },
  };
  const c = config[level] || config.LOW;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      padding: '2px 8px', borderRadius: '10px',
      background: c.bg, border: `1px solid ${c.border}`,
      color: c.color, fontSize: '10px', fontWeight: 700,
    }}>
      {c.dot} {level}
    </span>
  );
}

export default function ShipmentTable({ shipments }: Props) {
  if (shipments.length === 0) {
    return (
      <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-16 text-center">
        <Package className="w-10 h-10 text-slate-700 mx-auto mb-3" />
        <p className="text-sm font-medium text-slate-500">No shipments found</p>
        <p className="text-xs text-slate-600 mt-1">Create your first shipment to get started</p>
      </div>
    );
  }

  return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 overflow-hidden">
      {/* Desktop Table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-700/50 bg-slate-800/80">
              <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-5 py-3">Tracking #</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-5 py-3">Shipment</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-5 py-3">Route</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-5 py-3">AI Risk</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-5 py-3">Status</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-5 py-3">Date</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-5 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {shipments.map((shipment) => (
              <tr key={shipment.id} className="hover:bg-slate-700/20 transition-colors group">
                <td className="px-5 py-3.5">
                  <span className="text-xs font-mono font-semibold text-amber-400 tracking-wide">
                    {shipment.trackingNumber}
                  </span>
                </td>
                <td className="px-5 py-3.5">
                  <p className="text-sm font-medium text-slate-200">{shipment.title}</p>
                  <p className="text-xs text-slate-600 mt-0.5">
                    {shipment.shipmentType} · {shipment.weight} kg
                    {shipment.commodityType && ` · ${shipment.commodityType}`}
                  </p>
                </td>
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-1.5 text-xs text-slate-400">
                    <MapPin className="w-3 h-3 text-slate-600 flex-shrink-0" />
                    <span className="truncate max-w-[90px]">{shipment.origin}</span>
                    <span className="text-slate-700">→</span>
                    <span className="truncate max-w-[90px]">{shipment.destination}</span>
                  </div>
                  {/* Show corridor from aiBriefing if available */}
                  {shipment.aiBriefing?.customsComplexity && (
                    <span style={{
                      display: 'inline-block', marginTop: '4px',
                      padding: '1px 6px', borderRadius: '8px', fontSize: '9px', fontWeight: 700,
                      background: shipment.aiBriefing.customsComplexity === 'HIGH' ? 'rgba(239,68,68,0.08)' : shipment.aiBriefing.customsComplexity === 'MEDIUM' ? 'rgba(245,158,11,0.08)' : 'rgba(34,197,94,0.08)',
                      color: shipment.aiBriefing.customsComplexity === 'HIGH' ? '#fca5a5' : shipment.aiBriefing.customsComplexity === 'MEDIUM' ? '#fcd34d' : '#86efac',
                      border: `1px solid ${shipment.aiBriefing.customsComplexity === 'HIGH' ? 'rgba(239,68,68,0.2)' : shipment.aiBriefing.customsComplexity === 'MEDIUM' ? 'rgba(245,158,11,0.2)' : 'rgba(34,197,94,0.2)'}`,
                    }}>
                      {shipment.aiBriefing.customsComplexity} CUSTOMS
                    </span>
                  )}
                </td>
                <td className="px-5 py-3.5">
                  <RiskBadge level={shipment.aiRiskLevel || shipment.complianceReport?.riskLevel} />
                </td>
                <td className="px-5 py-3.5">
                  <StatusBadge status={shipment.status} />
                </td>
                <td className="px-5 py-3.5">
                  <span className="text-xs text-slate-600">{new Date(shipment.createdAt).toLocaleDateString()}</span>
                </td>
                <td className="px-5 py-3.5">
                  <Link
                    to={`/shipments/${shipment.id}`}
                    className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-amber-400 font-medium transition-colors opacity-0 group-hover:opacity-100"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    View
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile Cards */}
      <div className="md:hidden divide-y divide-slate-700/30">
        {shipments.map((shipment) => (
          <Link key={shipment.id} to={`/shipments/${shipment.id}`} className="block p-4 hover:bg-slate-700/20 transition-colors">
            <div className="flex items-start justify-between mb-2">
              <span className="text-xs font-mono font-semibold text-amber-400">{shipment.trackingNumber}</span>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <RiskBadge level={shipment.aiRiskLevel || shipment.complianceReport?.riskLevel} />
                <StatusBadge status={shipment.status} />
              </div>
            </div>
            <p className="text-sm font-medium text-slate-200">{shipment.title}</p>
            <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-1.5">
              <MapPin className="w-3 h-3 text-slate-600" />
              {shipment.origin} → {shipment.destination}
            </div>
            <p className="text-xs text-slate-600 mt-1">{new Date(shipment.createdAt).toLocaleDateString()}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

import React from 'react';
import type { RouteBriefing } from '../types';

// ─── Risk color helpers ───────────────────────────────────────────────────────

const COMPLEXITY_CONFIG = {
  LOW:    { label: 'Low Complexity',    color: '#22c55e', bg: 'rgba(34,197,94,0.12)',   dot: '#22c55e' },
  MEDIUM: { label: 'Medium Complexity', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  dot: '#f59e0b' },
  HIGH:   { label: 'High Complexity',   color: '#ef4444', bg: 'rgba(239,68,68,0.12)',   dot: '#ef4444' },
};

const SANCTIONS_CONFIG = {
  CLEAR:   { label: 'Sanctions Clear',    color: '#22c55e', bg: 'rgba(34,197,94,0.12)',   icon: '✓' },
  WATCH:   { label: 'Screening Required', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', icon: '⚠' },
  BLOCKED: { label: 'Sanctions Risk',     color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  icon: '✗' },
};

// ─── Component ────────────────────────────────────────────────────────────────

interface RouteBriefingCardProps {
  briefing: RouteBriefing;
  compact?: boolean;
}

export default function RouteBriefingCard({ briefing, compact = false }: RouteBriefingCardProps) {
  const complexity = COMPLEXITY_CONFIG[briefing.customsComplexity] || COMPLEXITY_CONFIG.MEDIUM;
  const sanctions  = SANCTIONS_CONFIG[briefing.sanctionsStatus]  || SANCTIONS_CONFIG.CLEAR;
  const delayPct   = Math.round((briefing.delayProbability ?? 0) * 100);
  const isMock     = briefing.modelId?.startsWith('mock');

  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(15,23,42,0.95) 0%, rgba(30,41,59,0.95) 100%)',
      border: '1px solid rgba(99,102,241,0.3)',
      borderRadius: '16px',
      padding: compact ? '16px' : '24px',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Subtle background glow */}
      <div style={{
        position: 'absolute', top: 0, right: 0,
        width: '200px', height: '200px',
        background: 'radial-gradient(circle, rgba(99,102,241,0.08) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '32px', height: '32px', borderRadius: '8px',
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '16px',
          }}>🛤️</div>
          <div>
            <div style={{ color: '#a5b4fc', fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              Route Intelligence
            </div>
            <div style={{ color: '#e2e8f0', fontSize: '14px', fontWeight: 700 }}>
              {briefing.corridor}
            </div>
          </div>
        </div>
        <div style={{
          padding: '4px 10px', borderRadius: '20px',
          background: isMock ? 'rgba(100,116,139,0.2)' : 'rgba(99,102,241,0.15)',
          border: `1px solid ${isMock ? 'rgba(100,116,139,0.3)' : 'rgba(99,102,241,0.3)'}`,
          color: isMock ? '#94a3b8' : '#a5b4fc',
          fontSize: '10px', fontWeight: 600, letterSpacing: '0.05em',
        }}>
          {isMock ? 'MOCK MODE' : '✦ Nova Lite'}
        </div>
      </div>

      {/* Risk summary */}
      <p style={{ color: '#cbd5e1', fontSize: '13px', lineHeight: 1.6, marginBottom: '16px', margin: '0 0 16px 0' }}>
        {briefing.riskSummary}
      </p>

      {/* Status pills row */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
        {/* Customs complexity */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          padding: '6px 12px', borderRadius: '20px',
          background: complexity.bg, border: `1px solid ${complexity.color}30`,
        }}>
          <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: complexity.dot }} />
          <span style={{ color: complexity.color, fontSize: '12px', fontWeight: 600 }}>
            {complexity.label}
          </span>
        </div>

        {/* Sanctions */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          padding: '6px 12px', borderRadius: '20px',
          background: sanctions.bg, border: `1px solid ${sanctions.color}30`,
        }}>
          <span style={{ color: sanctions.color, fontSize: '12px' }}>{sanctions.icon}</span>
          <span style={{ color: sanctions.color, fontSize: '12px', fontWeight: 600 }}>
            {sanctions.label}
          </span>
        </div>

        {/* Clearance time */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          padding: '6px 12px', borderRadius: '20px',
          background: 'rgba(148,163,184,0.08)', border: '1px solid rgba(148,163,184,0.2)',
        }}>
          <span style={{ color: '#94a3b8', fontSize: '12px' }}>⏱</span>
          <span style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 600 }}>
            ~{briefing.estimatedClearanceHours}h clearance
          </span>
        </div>

        {/* Delay risk */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          padding: '6px 12px', borderRadius: '20px',
          background: delayPct > 40 ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)',
          border: `1px solid ${delayPct > 40 ? 'rgba(239,68,68,0.25)' : 'rgba(34,197,94,0.25)'}`,
        }}>
          <span style={{ fontSize: '12px' }}>{delayPct > 40 ? '⚠️' : '📦'}</span>
          <span style={{ color: delayPct > 40 ? '#fca5a5' : '#86efac', fontSize: '12px', fontWeight: 600 }}>
            {delayPct}% delay risk
          </span>
        </div>
      </div>

      {/* Two-column grid: Required docs + Key risks */}
      {!compact && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
          {/* Required documents */}
          <div style={{
            background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '12px', padding: '14px',
          }}>
            <div style={{ color: '#64748b', fontSize: '10px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '10px' }}>
              📄 Required Documents
            </div>
            {briefing.requiredDocuments.length === 0 ? (
              <p style={{ color: '#64748b', fontSize: '12px', margin: 0 }}>No documents listed</p>
            ) : (
              <ul style={{ margin: 0, padding: '0 0 0 16px' }}>
                {briefing.requiredDocuments.map((doc, i) => (
                  <li key={i} style={{ color: '#cbd5e1', fontSize: '12px', marginBottom: '4px', lineHeight: 1.4 }}>
                    {doc}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Key risks */}
          <div style={{
            background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '12px', padding: '14px',
          }}>
            <div style={{ color: '#64748b', fontSize: '10px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '10px' }}>
              ⚠ Key Risks
            </div>
            {briefing.keyRisks.length === 0 ? (
              <p style={{ color: '#64748b', fontSize: '12px', margin: 0 }}>No specific risks identified</p>
            ) : (
              <ul style={{ margin: 0, padding: '0 0 0 16px' }}>
                {briefing.keyRisks.map((risk, i) => (
                  <li key={i} style={{ color: '#fca5a5', fontSize: '12px', marginBottom: '4px', lineHeight: 1.4 }}>
                    {risk}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Regulatory notes */}
      {!compact && briefing.regulatoryNotes && (
        <div style={{
          background: 'rgba(99,102,241,0.06)',
          border: '1px solid rgba(99,102,241,0.2)',
          borderRadius: '10px',
          padding: '12px 14px',
        }}>
          <div style={{ color: '#818cf8', fontSize: '10px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '6px' }}>
            📋 Regulatory Context
          </div>
          <p style={{ color: '#94a3b8', fontSize: '12px', lineHeight: 1.6, margin: 0 }}>
            {briefing.regulatoryNotes}
          </p>
        </div>
      )}
    </div>
  );
}

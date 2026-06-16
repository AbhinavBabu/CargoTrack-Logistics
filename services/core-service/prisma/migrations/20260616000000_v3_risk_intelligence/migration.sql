-- ============================================================
-- Migration: v3_risk_intelligence
-- Description:
--   Extends ComplianceReport and ComplianceFinding with
--   risk intelligence fields produced by the Shipment Risk
--   Intelligence Engine (Bedrock Nova agent).
--
--   All new columns are nullable — existing rows are unaffected.
--   This migration is safe to apply on a live database.
-- ============================================================

-- ─── ComplianceReport: Risk Intelligence fields ───────────────────────────────

-- Continuous risk score: 0.0 (no risk) to 1.0 (critical)
ALTER TABLE "ComplianceReport" ADD COLUMN "overallRiskScore" DOUBLE PRECISION;

-- Categorical risk level: LOW | MEDIUM | HIGH | CRITICAL
ALTER TABLE "ComplianceReport" ADD COLUMN "riskLevel" TEXT;

-- Multi-paragraph executive narrative written by the LLM
ALTER TABLE "ComplianceReport" ADD COLUMN "executiveSummary" TEXT;

-- Operational recommendation for the compliance team
ALTER TABLE "ComplianceReport" ADD COLUMN "recommendedDisposition" TEXT;

-- Which Bedrock model (modelId) produced this assessment
ALTER TABLE "ComplianceReport" ADD COLUMN "modelId" TEXT;

-- Model's stated confidence in the overall assessment (0.0–1.0)
ALTER TABLE "ComplianceReport" ADD COLUMN "modelConfidence" DOUBLE PRECISION;

-- End-to-end agent processing time in milliseconds
ALTER TABLE "ComplianceReport" ADD COLUMN "processingTimeMs" INTEGER;

-- ─── ComplianceFinding: Risk Intelligence fields ──────────────────────────────

-- Specific text from document(s) that triggered this finding
ALTER TABLE "ComplianceFinding" ADD COLUMN "evidence" TEXT;

-- LLM analytical reasoning chain explaining why this is a risk
ALTER TABLE "ComplianceFinding" ADD COLUMN "reasoning" TEXT;

-- LLM confidence score for this specific finding (0.0–1.0)
ALTER TABLE "ComplianceFinding" ADD COLUMN "confidenceScore" DOUBLE PRECISION;

-- Actionable next step for the operations or compliance team
ALTER TABLE "ComplianceFinding" ADD COLUMN "recommendedAction" TEXT;

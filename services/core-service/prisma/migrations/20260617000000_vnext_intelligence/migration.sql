-- CargoTrack vNext Migration: 20260617000000_vnext_intelligence
-- Adds shipment intelligence fields, AI briefing model, and expanded FindingType enum

-- ─── Expand FindingType enum ──────────────────────────────────────────────────
ALTER TYPE "FindingType" ADD VALUE IF NOT EXISTS 'DANGEROUS_GOODS_RISK';
ALTER TYPE "FindingType" ADD VALUE IF NOT EXISTS 'PARTY_SCREENING_FLAG';
ALTER TYPE "FindingType" ADD VALUE IF NOT EXISTS 'HS_CODE_MISMATCH';
ALTER TYPE "FindingType" ADD VALUE IF NOT EXISTS 'VALUE_DISCREPANCY';
ALTER TYPE "FindingType" ADD VALUE IF NOT EXISTS 'ROUTE_RESTRICTION';

-- ─── Add vNext intelligence fields to Shipment ────────────────────────────────
ALTER TABLE "Shipment"
  ADD COLUMN IF NOT EXISTS "commodityType"       TEXT,
  ADD COLUMN IF NOT EXISTS "hsCodeHint"          TEXT,
  ADD COLUMN IF NOT EXISTS "isDangerousGoods"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "dangerousGoodsClass" TEXT,
  ADD COLUMN IF NOT EXISTS "incoterms"           TEXT,
  ADD COLUMN IF NOT EXISTS "declaredValue"       DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "currencyCode"        TEXT DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS "aiRiskScore"         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "aiRiskLevel"         TEXT;

-- ─── Create ShipmentAIBriefing table ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ShipmentAIBriefing" (
  "id"                      TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "shipmentId"              TEXT NOT NULL,
  "corridor"                TEXT NOT NULL,
  "riskSummary"             TEXT NOT NULL,
  "requiredDocuments"       JSONB NOT NULL DEFAULT '[]',
  "customsComplexity"       TEXT,
  "sanctionsStatus"         TEXT,
  "estimatedClearanceHours" INTEGER,
  "delayProbability"        DOUBLE PRECISION,
  "keyRisks"                JSONB NOT NULL DEFAULT '[]',
  "regulatoryNotes"         TEXT,
  "modelId"                 TEXT,
  "generatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ShipmentAIBriefing_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one briefing per shipment
CREATE UNIQUE INDEX IF NOT EXISTS "ShipmentAIBriefing_shipmentId_key"
  ON "ShipmentAIBriefing"("shipmentId");

-- Foreign key
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'ShipmentAIBriefing_shipmentId_fkey'
  ) THEN
    ALTER TABLE "ShipmentAIBriefing"
      ADD CONSTRAINT "ShipmentAIBriefing_shipmentId_fkey"
      FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- ─── Add @db.Text columns to ComplianceReport ─────────────────────────────────
-- PostgreSQL TEXT type is already used; these are no-ops on Postgres but
-- ensure Prisma generates the correct type for the ORM layer.
-- (No SQL needed — TEXT is the same as @db.Text in Postgres)

-- ─── Prisma migration bookkeeping ─────────────────────────────────────────────
INSERT INTO "_prisma_migrations" (
  "id", "checksum", "finished_at", "migration_name",
  "logs", "rolled_back_at", "started_at", "applied_steps_count"
) VALUES (
  gen_random_uuid()::TEXT,
  'vnext_intelligence_manual',
  NOW(), '20260617000000_vnext_intelligence',
  NULL, NULL, NOW(), 1
) ON CONFLICT DO NOTHING;

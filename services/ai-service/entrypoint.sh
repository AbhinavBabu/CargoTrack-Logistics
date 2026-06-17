#!/bin/sh
set -e

if [ -z "$DATABASE_URL" ]; then
  DB_HOST="${DATABASE_HOST:-localhost}"
  DB_PORT="${DATABASE_PORT:-5432}"
  DB_NAME="${DATABASE_NAME:-cargotrack}"
  DB_USER="${DATABASE_USER:-cargotrack}"
  DB_PASS="${DATABASE_PASSWORD:-cargotrack123}"
  DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public"
  export DATABASE_URL
  echo "[ai-service] DATABASE_URL constructed (host: ${DB_HOST}:${DB_PORT})"
fi

# ── Knowledge base catalog pre-flight check ─────────────────────────────────
# Fail loudly if catalogs are missing — a silent fallback to INTERNATIONAL-GENERIC
# means every shipment gets MEDIUM risk regardless of actual corridor/sanctions.
CATALOG_DIR="dist/knowledge/catalogs"
REQUIRED_CATALOGS="route-intelligence.json dangerous-goods.json hs-intelligence.json incoterms-intelligence.json sanctions-watch.json"

echo "[ai-service] Verifying knowledge base catalogs..."
CATALOG_OK=1
for catalog in $REQUIRED_CATALOGS; do
  if [ ! -f "${CATALOG_DIR}/${catalog}" ]; then
    echo "[ai-service] FATAL: Missing catalog: ${CATALOG_DIR}/${catalog}"
    CATALOG_OK=0
  fi
done

if [ "$CATALOG_OK" = "0" ]; then
  echo "[ai-service] FATAL: One or more knowledge base catalogs are missing."
  echo "[ai-service] The Docker image must include: ${CATALOG_DIR}/"
  echo "[ai-service] Check Dockerfile — COPY src/knowledge/catalogs/ dist/knowledge/catalogs/ is required."
  exit 1
fi

echo "[ai-service] Knowledge base catalogs: OK (5/5)"

# AI service does NOT run migrations. Schema is owned by core-service.
echo "[ai-service] Starting compliance agent..."
node dist/index.js

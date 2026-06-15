#!/usr/bin/env bash
# =============================================================================
# CargoTrack v3 — Local Validation Script
# Tests all services end-to-end in Docker Compose
# Usage: bash scripts/validate-local.sh
# =============================================================================
set -euo pipefail

COMPOSE_FILE="docker-compose.v3.yml"
ENV_FILE=".env.v3"
BASE_CORE="http://localhost:4000/api"
BASE_DOCS="http://localhost:4001/api"
BASE_AI="http://localhost:4002/api"
BASE_FE="http://localhost"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

PASS=0; FAIL=0

pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASS++)); }
fail() { echo -e "${RED}[FAIL]${NC} $1 — $2"; ((FAIL++)); }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }
section() { echo -e "\n${YELLOW}▶ $1${NC}"; }

wait_healthy() {
  local name=$1 url=$2 max=60 i=0
  info "Waiting for $name at $url..."
  until curl -sf "$url" > /dev/null 2>&1; do
    sleep 3; ((i+=3))
    if [ $i -ge $max ]; then echo -e "${RED}TIMEOUT waiting for $name${NC}"; return 1; fi
  done
  echo "  $name is up!"
}

# ── 0: Start stack ─────────────────────────────────────────────────────────────
section "0. Starting Docker Compose stack"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build
info "Waiting 45s for services to become healthy..."
sleep 45

# ── 1: Health checks ───────────────────────────────────────────────────────────
section "1. Health Checks"
for svc_url in "$BASE_CORE/health:core-service" "$BASE_DOCS/health:document-service" "$BASE_AI/health:ai-service"; do
  url="${svc_url%%:*}"; name="${svc_url##*:}"
  if curl -sf "$url" | grep -q '"status":"healthy"'; then pass "$name health"; else fail "$name health" "$(curl -sf "$url")"; fi
done

# Check extractor backends in ai-service health
AI_HEALTH=$(curl -sf "$BASE_AI/health" 2>/dev/null || echo '{}')
if echo "$AI_HEALTH" | grep -q '"extractors"'; then pass "AI service reports extractor backends"; else fail "AI extractor status" "missing from health response"; fi

# ── 2: Auth ───────────────────────────────────────────────────────────────────
section "2. Authentication"
REG_RESP=$(curl -sf -X POST "$BASE_CORE/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","email":"testuser@example.com","password":"TestPass123!"}' 2>/dev/null || echo '{}')
if echo "$REG_RESP" | grep -q '"token"'; then pass "User registration"; else fail "User registration" "$REG_RESP"; fi
USER_TOKEN=$(echo "$REG_RESP" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

LOGIN_RESP=$(curl -sf -X POST "$BASE_CORE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@cargotrack.com","password":"admin123"}' 2>/dev/null || echo '{}')
if echo "$LOGIN_RESP" | grep -q '"token"'; then pass "Admin login"; else fail "Admin login" "$LOGIN_RESP"; fi
ADMIN_TOKEN=$(echo "$LOGIN_RESP" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

# ── 3: Shipment lifecycle ──────────────────────────────────────────────────────
section "3. Shipment Lifecycle"
SHIP_RESP=$(curl -sf -X POST "$BASE_CORE/shipments" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -d '{
    "trackingNumber":"CT-VAL-001",
    "senderName":"Global Exports Ltd",
    "receiverName":"European Imports GmbH",
    "origin":"New York, USA",
    "destination":"Hamburg, Germany",
    "shipmentType":"STANDARD",
    "carrierName":"Maersk Line",
    "weight":15.5,
    "description":"Electronics — Validation shipment"
  }' 2>/dev/null || echo '{}')
if echo "$SHIP_RESP" | grep -q '"id"'; then pass "Shipment creation"; else fail "Shipment creation" "$SHIP_RESP"; fi
SHIPMENT_ID=$(echo "$SHIP_RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
info "Created shipment: $SHIPMENT_ID"

GET_RESP=$(curl -sf -H "Authorization: Bearer $USER_TOKEN" "$BASE_CORE/shipments/$SHIPMENT_ID" 2>/dev/null || echo '{}')
if echo "$GET_RESP" | grep -q '"trackingNumber"'; then pass "Shipment retrieval"; else fail "Shipment retrieval" "$GET_RESP"; fi

# ── 4: Document upload ────────────────────────────────────────────────────────
section "4. Document Upload"
# Create a test invoice PDF text file
echo -e "INVOICE\nInvoice No: INV-TEST-001\nDate: $(date +%Y-%m-%d)\nFrom: Global Exports Ltd\nTo: European Imports GmbH\nTotal Amount: 4750.00 USD\nPayment Terms: Net 30\nGoods: Electronic Equipment" > /tmp/test-invoice.txt

UPLOAD_RESP=$(curl -sf -X POST "$BASE_DOCS/documents/$SHIPMENT_ID/upload" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -F "document=@/tmp/test-invoice.txt;type=text/plain" \
  -F "documentType=INVOICE" 2>/dev/null || echo '{}')
if echo "$UPLOAD_RESP" | grep -q '"id"'; then pass "Document upload"; else fail "Document upload" "$UPLOAD_RESP"; fi
DOC_ID=$(echo "$UPLOAD_RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
info "Uploaded document: $DOC_ID"

DOCS_LIST=$(curl -sf -H "Authorization: Bearer $USER_TOKEN" "$BASE_DOCS/documents/$SHIPMENT_ID" 2>/dev/null || echo '[]')
if echo "$DOCS_LIST" | grep -q '"id"'; then pass "Document list"; else fail "Document list" "$DOCS_LIST"; fi

# ── 5: Compliance trigger ─────────────────────────────────────────────────────
section "5. AI Compliance Agent"
TRIGGER_RESP=$(curl -sf -X POST "$BASE_AI/compliance/trigger" \
  -H "Content-Type: application/json" \
  -d "{\"shipmentId\":\"$SHIPMENT_ID\",\"trackingNumber\":\"CT-VAL-001\",\"newStatus\":\"CUSTOMS_REVIEW\"}" 2>/dev/null || echo '{}')
if echo "$TRIGGER_RESP" | grep -q '"status"'; then pass "Compliance trigger"; else fail "Compliance trigger" "$TRIGGER_RESP"; fi

info "Waiting 5s for compliance report to be written..."
sleep 5

REPORT_RESP=$(curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE_CORE/admin/compliance/$SHIPMENT_ID" 2>/dev/null || echo '{}')
if echo "$REPORT_RESP" | grep -q '"status"'; then pass "Compliance report created"; else fail "Compliance report" "$REPORT_RESP"; fi
info "Report: $(echo $REPORT_RESP | grep -o '"status":"[^"]*"' | head -1)"

# ── 6: Admin endpoints ────────────────────────────────────────────────────────
section "6. Admin Dashboard"
ADMIN_STATS=$(curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE_CORE/admin/stats" 2>/dev/null || echo '{}')
if echo "$ADMIN_STATS" | grep -q '"totalShipments"'; then pass "Admin stats"; else fail "Admin stats" "$ADMIN_STATS"; fi

ADMIN_SHIPS=$(curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE_CORE/admin/shipments" 2>/dev/null || echo '[]')
if echo "$ADMIN_SHIPS" | grep -q '"id"'; then pass "Admin shipments list"; else fail "Admin shipments list" "$ADMIN_SHIPS"; fi

ADMIN_DOCS=$(curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE_CORE/admin/documents" 2>/dev/null || echo '[]')
if echo "$ADMIN_DOCS" | grep -q '"id"'; then pass "Admin documents list"; else fail "Admin documents list" "$ADMIN_DOCS"; fi

# ── 7: Frontend ───────────────────────────────────────────────────────────────
section "7. Frontend"
if curl -sf "$BASE_FE" | grep -qi "cargotrack\|html"; then pass "Frontend serves HTML"; else fail "Frontend" "no response"; fi
if curl -sf "$BASE_FE/api/health" | grep -q '"status":"healthy"'; then pass "Frontend → core-service proxy"; else fail "Frontend proxy" "could not reach core via nginx"; fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo -e "\n${CYAN}============================================${NC}"
echo -e "${CYAN}  VALIDATION SUMMARY${NC}"
echo -e "${CYAN}============================================${NC}"
echo -e "  ${GREEN}PASSED: $PASS${NC}"
echo -e "  ${RED}FAILED: $FAIL${NC}"
if [ "$FAIL" -eq 0 ]; then
  echo -e "\n  ${GREEN}✓ All validation checks passed!${NC}"
  echo -e "  ${GREEN}  CargoTrack v3 is fully operational locally.${NC}"
else
  echo -e "\n  ${RED}✗ $FAIL check(s) failed. Review output above.${NC}"
fi

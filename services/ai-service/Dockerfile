FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app

COPY package*.json ./
RUN npm install

# Generate Prisma client — no migrations (core-service owns schema changes)
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ── Copy knowledge base catalogs into dist ──────────────────────────────────
# tsc only emits compiled .js files — JSON catalog files must be copied
# explicitly. Without this step, KnowledgeBase.initialize() fails with ENOENT
# and every shipment silently falls back to INTERNATIONAL-GENERIC risk scoring.
RUN mkdir -p dist/knowledge/catalogs
COPY src/knowledge/catalogs/ dist/knowledge/catalogs/

EXPOSE 4002

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]

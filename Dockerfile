# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-slim AS deps

WORKDIR /app

# better-sqlite3 may compile native bindings when no matching prebuild exists.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

RUN groupadd --gid 1001 relay \
  && useradd --uid 1001 --gid relay --shell /bin/sh --create-home relay

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY package.json ./

RUN mkdir -p /data \
  && chown relay:relay /data

USER relay

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/relay.db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/index.js"]

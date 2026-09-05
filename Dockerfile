# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:24-slim AS deps

WORKDIR /app

# better-sqlite3 v12 ships prebuilt binaries for Node 24 (linux-x64/arm64),
# so no native build tools are needed — prebuild-install downloads the right
# binary automatically and skips compilation entirely.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime

# Create a non-root user for the process
RUN groupadd --gid 1001 relay && \
    useradd --uid 1001 --gid relay --shell /bin/sh --create-home relay

WORKDIR /app

# Copy installed dependencies from build stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY src/ ./src/
COPY package.json ./

# Data directory for SQLite — will be bind-mounted in production
RUN mkdir -p /data && chown relay:relay /data

# Switch to non-root user
USER relay

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/relay.db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/index.js"]

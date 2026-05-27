# ── Build stage ──────────────────────────────────────────────────────────────
# Use a slim Node image. better-sqlite3 needs a native build; the official
# node:*-slim image has the required build tools available via apt.
FROM node:20-slim AS deps

WORKDIR /app

# Install build tools for native modules (better-sqlite3 compiles from source)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

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
RUN mkdir -p /app/data && chown relay:relay /app/data

# Switch to non-root user
USER relay

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/index.js"]

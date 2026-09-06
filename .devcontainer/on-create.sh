#!/usr/bin/env bash
# on-create.sh — runs once when the Codespace is created
# Sets up a .env with safe dev-only defaults so `npm start` just works.

set -euo pipefail

echo "📦 Installing dependencies..."
npm install

generate_secret() {
  node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
}

ensure_encryption_secret() {
  local encryption_secret
  encryption_secret="$(generate_secret)"
  ENCRYPTION_SECRET="$encryption_secret" node <<'NODE'
const fs = require('fs');
const dotenv = require('dotenv');

const envPath = '.env';
const secret = process.env.ENCRYPTION_SECRET;
let env = fs.readFileSync(envPath, 'utf8');
const lines = env.split(/\r?\n/);
const assignmentIndexes = [];

for (const [index, line] of lines.entries()) {
  if (/^\s*(?:export\s+)?ENCRYPTION_SECRET\s*=/.test(line)) {
    assignmentIndexes.push(index);
  }
}

if (assignmentIndexes.length > 1) {
  console.error('❌ .env has duplicate ENCRYPTION_SECRET assignments. Refusing to pick one or rotate secrets automatically. Remove duplicates and keep one 32+ character value.');
  process.exit(1);
}

if (assignmentIndexes.length === 1) {
  const parsed = dotenv.parse(`${lines[assignmentIndexes[0]]}\n`);
  const existing = parsed.ENCRYPTION_SECRET ?? '';

  if (existing.length >= 32) {
    process.exit(0);
  }

  const reason = existing.length === 0
    ? 'empty or whitespace-only'
    : `only ${existing.length} character${existing.length === 1 ? '' : 's'} long`;
  console.error(`❌ Existing ENCRYPTION_SECRET is ${reason}. Refusing to replace it automatically because stored keys may become undecryptable. Set a 32+ character value manually, or reset/migrate the dev data first.`);
  process.exit(1);
}

env += `${env.endsWith('\n') ? '' : '\n'}ENCRYPTION_SECRET=${secret}\n`;
fs.writeFileSync(envPath, env, { mode: 0o600 });
console.log('✅ Added fresh ENCRYPTION_SECRET');
NODE
}

umask 077

if [ ! -f .env ]; then
  echo "🔧 Creating .env with dev-only defaults..."
  ENCRYPTION_SECRET="$(generate_secret)"
  cat > .env <<EOF
# ── Dev-only defaults — NOT for production ──────────────────────────────
# Generate real secrets with: openssl rand -hex 32

# Required: 32+ char secret used to AES-256-GCM encrypt stored API keys
ENCRYPTION_SECRET=${ENCRYPTION_SECRET}

# Optional: if set, POST /users requires Authorization: Bearer <APP_SECRET>
# APP_SECRET=

# Optional: comma-separated CORS origins (default: all)
# ALLOWED_ORIGINS=http://localhost:5173,https://your-app.vercel.app

# Optional: comma-separated allowed models (default: all)
# ALLOWED_MODELS=gpt-4o,claude-*,gemini-*

# Server port (default: 3000)
PORT=3000
EOF
  echo "✅ .env created"
else
  echo "ℹ️  .env already exists — checking required settings"
  ensure_encryption_secret
fi
chmod 600 .env

echo ""
echo "✅ byok-relay dev environment ready!"
echo ""
echo "Start the server:"
echo "  npm start"
echo ""
echo "Run tests:"
echo "  npm test"
echo ""
echo "Verify it's working:"
echo "  curl http://localhost:3000/health"

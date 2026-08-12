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
  if grep -Eq '^ENCRYPTION_SECRET=.{32,}$' .env; then
    return
  fi

  local encryption_secret
  encryption_secret="$(generate_secret)"
  ENCRYPTION_SECRET="$encryption_secret" node <<'NODE'
const fs = require('fs');

const envPath = '.env';
const secret = process.env.ENCRYPTION_SECRET;
let env = fs.readFileSync(envPath, 'utf8');

if (/^ENCRYPTION_SECRET=.*$/m.test(env)) {
  env = env.replace(/^ENCRYPTION_SECRET=.*$/m, `ENCRYPTION_SECRET=${secret}`);
} else {
  env += `${env.endsWith('\n') ? '' : '\n'}ENCRYPTION_SECRET=${secret}\n`;
}

fs.writeFileSync(envPath, env);
NODE
  echo "✅ Added fresh ENCRYPTION_SECRET"
}

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

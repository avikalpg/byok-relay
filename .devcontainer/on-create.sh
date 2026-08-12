#!/usr/bin/env bash
# on-create.sh — runs once when the Codespace is created
# Sets up a .env with safe dev-only defaults so `npm start` just works.

set -euo pipefail

echo "📦 Installing dependencies..."
npm install

if [ ! -f .env ]; then
  echo "🔧 Creating .env with dev-only defaults..."
  cat > .env <<'EOF'
# ── Dev-only defaults — NOT for production ──────────────────────────────
# Generate real secrets with: openssl rand -hex 32

# Required: 32+ char secret used to AES-256-GCM encrypt stored API keys
ENCRYPTION_SECRET=dev-only-change-this-before-any-real-use-32chars

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
  echo "ℹ️  .env already exists — skipping"
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

# Railway Template Submission Guide

> Status: `railway.toml` production-ready config merged into repo (PR #52). Manual submission steps below.

---

## What was added to the repo (PR #52)

- `railway.toml` — Nixpacks builder, Node 20 pin, `/health` healthcheck, `DB_PATH=/data/relay.db` env var default
- README deploy button updated — now includes `DB_PATH` env var prompt with `/data/relay.db` default
- README Railway section updated — explicit step to add a volume in the Railway dashboard after first deploy

---

## Quick test (deploy button — live now, no account needed)

The button in the README already works:

```
https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay&envs=ENCRYPTION_SECRET%2CALLOWED_ORIGINS%2CAPP_SECRET%2CDB_PATH&...
```

Anyone clicking it lands on Railway with the repo pre-configured. No submission needed for this flow.

---

## Official Railway Template Marketplace

Railway's template marketplace surfaces pre-configured one-click deployments at:
→ **https://railway.app/templates**

Submitting creates a permanent template page at `https://railway.app/template/<slug>` with:
- One-click deploy
- Pre-filled env vars with descriptions
- Volume configuration guidance
- Your repo as the source

### Submission steps

1. **Log into Railway** → https://railway.app/login (use Avi's account)

2. **Go to template creation** → https://railway.app/new/template

   Or from Dashboard → "Templates" → "New Template"

3. **Fill in the template form:**

   | Field | Value |
   |-------|-------|
   | **GitHub Repository** | `https://github.com/avikalpg/byok-relay` |
   | **Name** | `byok-relay — BYOK AI gateway` |
   | **Description** | Relay AI API calls from the browser. Users store their own OpenAI/Anthropic/Gemini/ElevenLabs keys; you build the product. No backend required. CORS handled, keys encrypted at rest. |
   | **Category** | Developer Tools |
   | **Tags** | `ai`, `openai`, `anthropic`, `byok`, `self-hosted`, `api-gateway`, `cors`, `node`, `express` |

4. **Configure environment variables** in the template form:

   | Name | Description | Default | Required |
   |------|-------------|---------|----------|
   | `ENCRYPTION_SECRET` | AES-256-GCM key for API keys at rest — generate: `openssl rand -hex 32` | *(generate)* | ✅ |
   | `APP_SECRET` | Gate for `POST /users` — generate: `openssl rand -hex 32` | *(generate)* | ✅ |
   | `ALLOWED_ORIGINS` | CORS origin whitelist — your frontend domain | `https://yourapp.example.com` | ✅ |
   | `DB_PATH` | SQLite database path — must match volume mount | `/data/relay.db` | ✅ |
   | `TOKEN_HMAC_SECRET` | Separate HMAC key for token hashing — `openssl rand -hex 32` | *(generate)* | Recommended |
   | `ENCRYPTION_SALT` | KDF salt for key encryption — `openssl rand -hex 32` | *(generate)* | Recommended |

5. **Add a volume** in the template form:
   - Mount Path: `/data`
   - Size: 1 GB (default)
   - This stores `relay.db` persistently across deploys

6. **Set the health check:** `/health` (already in `railway.toml`)

7. **Publish** the template — Railway generates a shareable URL

---

## After submission

Once published, add the template marketplace URL to:

1. `README.md` — "Deploy in one click" table: add a "Railway Template" link column
2. `GROWTH_PLAN.md` — update Day 13 notes with the template URL
3. Discord `#byok-relay` — post the template link

Suggested template marketplace URL format:
```
https://railway.app/template/byok-relay
```
(exact slug assigned by Railway after publish)

---

## Volume setup (critical for data persistence)

SQLite writes to `DB_PATH` env var (default: `/data/relay.db`). Without a Railway volume mounted at `/data`, the database resets on every deploy — all registered users and encrypted keys are lost.

**Post-deploy checklist:**
1. Deploy completes → check `/health` returns `{"status":"ok"}`
2. Dashboard → your service → **Volumes** → **Add Volume** → Mount Path: `/data`
3. Redeploy (triggers once automatically after volume add, or click "Redeploy")
4. Confirm persistence: register a test user, redeploy, verify the token still works

---

## Testing the template

```bash
# After deploy, get your Railway service URL from the dashboard
RELAY=https://your-service.up.railway.app

# 1. Health check
curl $RELAY/health

# 2. Register a test user
curl -X POST $RELAY/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $APP_SECRET" \
  -d '{"app_id": "test-app"}'

# 3. List providers
curl $RELAY/providers

# 4. Check stats endpoint
curl -H "Authorization: Bearer <token-from-step-2>" $RELAY/stats
```

Expected: all four return valid JSON responses.

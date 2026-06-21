# byok-relay

**Website:** [byokrelay.com](https://byokrelay.com) | **Hosted relay:** [relay.byokrelay.com](https://relay.byokrelay.com)

[![skills.sh](https://skills.sh/b/avikalpg/byok-relay)](https://skills.sh/avikalpg/byok-relay)
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay&envs=ENCRYPTION_SECRET%2CALLOWED_ORIGINS%2CAPP_SECRET&ENCRYPTION_SECRETDesc=Generate%20with%3A%20openssl%20rand%20-hex%2032&ALLOWED_ORIGINSDesc=Your%20frontend%20domain%20e.g.%20https%3A%2F%2Fmy-app.vercel.app&APP_SECRETDesc=Secret%20key%20for%20user%20registration%20generate%20with%3A%20openssl%20rand%20-hex%2032)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay&env=ENCRYPTION_SECRET,ALLOWED_ORIGINS,APP_SECRET&envDescription=ENCRYPTION_SECRET%3A%20generate%20with%20%60openssl%20rand%20-hex%2032%60.%20ALLOWED_ORIGINS%3A%20your%20frontend%20domain%20(e.g.%20https%3A%2F%2Fmy-app.vercel.app)&envLink=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay%23setup&project-name=byok-relay&repository-name=byok-relay)

> **Your users bring their own AI keys. byok-relay lets them use those keys straight from the browser — CORS handled, keys never in your code, costs on their bill.**

Browser apps can't call `api.openai.com` or `api.anthropic.com` directly — CORS blocks them. The usual fix (a backend proxy) puts your users' keys — and your users' AI costs — on your tab. byok-relay flips this: each user gets a secure token; they store their own key; they pay for their own inference. You build the product.

## Get started

**Option A — Use our relay (zero setup):**

```
https://relay.byokrelay.com
```

Free. Open CORS (any origin). [Health check →](https://relay.byokrelay.com/health)

**Option B — Self-host in 3 commands:**

```bash
git clone https://github.com/avikalpg/byok-relay.git && cd byok-relay
echo "ENCRYPTION_SECRET=$(openssl rand -hex 32)" > .env
docker compose up -d   # relay running at http://localhost:3000
```

Or without Docker: `npm install && npm start` (requires Node 18+). [Full quickstart →](#quickstart-60-seconds)

## For AI coding agents

If you're using a coding agent (Cursor, Claude Code, Copilot, Codex, etc.), install the skill and let it handle the integration:

```bash
npx skills add avikalpg/byok-relay
```

Or point your agent directly at the skill file:

```
https://byokrelay.com/skill
```

> Prompt: *"Read the byok-relay skill at https://byokrelay.com/skill and integrate byok-relay into this project using the hosted relay at https://relay.byokrelay.com"*

## How it works

```
Browser                  byok-relay              AI Provider
  │                           │                       │
  ├─ POST /users ────────────►│                       │
  │◄─ { token } ─────────────┤                       │
  │                           │                       │
  ├─ POST /keys/anthropic ───►│                       │
  │  { key: "sk-ant-..." }    │ (stored encrypted)    │
  │◄─ { ok: true } ──────────┤                       │
  │                           │                       │
  ├─ POST /relay/anthropic ──►│                       │
  │  x-relay-token: <token>   ├─ (real key injected) ►│
  │  { model, messages... }   │                       │
  │◄─ streamed response ──────┤◄─ streamed response ──┤
```

The **token** (not the key) lives in the browser. The API key stays server-side, encrypted at rest with AES-256-GCM. Users register once; every request uses their key, billed to their account.

## How it compares

| | byok-relay | OpenRouter | LiteLLM |
|---|---|---|---|
| Who holds the API keys | Your users | OpenRouter | Your org |
| Who pays for AI usage | Your users | You (the dev) | You (the org) |
| BYOK for end users | ✅ | ❌ | ❌ |
| Browser-safe (CORS handled) | ✅ | ✅ | ❌ (needs backend) |
| Self-hosted | ✅ | ❌ | ✅ |
| Open source | ✅ Apache 2.0 | ❌ | ✅ |
| Model routing / fallbacks | ❌ | ✅ | ✅ |

Use OpenRouter or LiteLLM when you're paying for your users' AI and want routing + analytics. Use byok-relay when you want **users to bring their own keys**.

## Quickstart (60 seconds)

```bash
# 1. Clone and install
git clone https://github.com/avikalpg/byok-relay.git && cd byok-relay && npm install

# 2. Configure
echo "ENCRYPTION_SECRET=$(openssl rand -hex 32)" > .env
echo "ALLOWED_ORIGINS=http://localhost:3000" >> .env

# 3. Start (add APP_SECRET for production to restrict who can register users)
# echo "APP_SECRET=$(openssl rand -hex 32)" >> .env
npm start &

# 4. Register a user and get a token
TOKEN=$(curl -s -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"app_id":"test"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# 5. Store your Anthropic key
curl -X POST http://localhost:3000/keys/anthropic \
  -H "Content-Type: application/json" \
  -H "x-relay-token: $TOKEN" \
  -d '{"key":"sk-ant-YOUR-KEY-HERE"}'

# 6. Relay a request (streaming)
curl -X POST http://localhost:3000/relay/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-relay-token: $TOKEN" \
  -d '{"model":"claude-3-5-haiku-20241022","max_tokens":256,"stream":true,"messages":[{"role":"user","content":"Hello!"}]}'
```

## Supported providers

| Provider | Name | Notes |
|---|---|---|
| Anthropic | `anthropic` | Claude models, SSE streaming |
| OpenAI | `openai` | GPT models, SSE streaming |
| Google | `google` | Gemini API (key in query param) |
| Groq | `groq` | Fast inference, OpenAI-compatible |
| OpenRouter | `openrouter` | 200+ models via one API |
| Mistral | `mistral` | Mistral models |
| Any OpenAI-compatible | `openai-compatible` | Pass `x-relay-base-url` header — covers LiteLLM, Ollama, Perplexity, Together AI, and any other OpenAI-compatible endpoint |

Adding a new built-in provider is ~5 lines in `src/providers.js`.

## API

### Register a user
```http
POST /users
Content-Type: application/json

{ "app_id": "my-app" }
```
→ `{ "token": "<relay-token>" }` — store in browser localStorage

> **If `APP_SECRET` is set**, the request must include `Authorization: Bearer <secret>`:
> ```http
> POST /users
> Content-Type: application/json
> Authorization: Bearer <APP_SECRET>
> 
> { "app_id": "my-app" }
> ```
> Without a valid `Authorization` header, the server returns `401 Unauthorized`.

### Store an API key
```http
POST /keys/anthropic
x-relay-token: <token>
Content-Type: application/json

{ "key": "sk-ant-..." }
```

### List stored providers (key values never returned)
```http
GET /keys
x-relay-token: <token>
```

### Delete a key
```http
DELETE /keys/anthropic
x-relay-token: <token>
```

### Relay a request
```http
POST /relay/anthropic/v1/messages
x-relay-token: <token>
Content-Type: application/json
anthropic-version: 2023-06-01

{ "model": "claude-3-5-haiku-20241022", "max_tokens": 1024, "messages": [...], "stream": true }
```
Full streaming (SSE) is supported — the response is piped directly from the provider to the browser.

### Generic OpenAI-compatible relay
```http
POST /relay/openai-compatible/v1/chat/completions
x-relay-token: <token>
x-relay-base-url: https://openrouter.ai
Content-Type: application/json

{ "model": "...", "messages": [...] }
```

## Deploy in one click

Pick a platform based on your use case:

| Platform | Best for | Persistent storage | Cost |
|----------|----------|--------------------|------|
| **Railway** | Production, hobby projects | ✅ Yes — volumes included | Free trial, then ~$5/mo |
| **Render** | Production, free tier | ✅ Yes — 1 GB disk | Free tier available |
| **Vercel** | Demos, prototyping | ⚠️ Ephemeral (resets on cold start) | Free tier |

### Deploy to Railway (recommended — persistent SQLite)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay&envs=ENCRYPTION_SECRET%2CALLOWED_ORIGINS%2CAPP_SECRET&ENCRYPTION_SECRETDesc=Generate%20with%3A%20openssl%20rand%20-hex%2032&ALLOWED_ORIGINSDesc=Your%20frontend%20domain%20e.g.%20https%3A%2F%2Fmy-app.vercel.app&APP_SECRETDesc=Secret%20key%20for%20user%20registration%20generate%20with%3A%20openssl%20rand%20-hex%2032)

1. Click the button above — Railway prompts for env vars
2. Set `ENCRYPTION_SECRET` (`openssl rand -hex 32`), `ALLOWED_ORIGINS` (your frontend domain), `APP_SECRET` (`openssl rand -hex 32`)
3. Railway provisions a persistent volume automatically — your relay and all user keys survive deploys and restarts

### Deploy to Render (free tier with persistent disk)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/avikalpg/byok-relay)

1. Click the button — Render reads `render.yaml` from the repo and configures the service + 1 GB disk automatically
2. Override `ALLOWED_ORIGINS` with your frontend domain in the Render dashboard after deploy
3. `ENCRYPTION_SECRET` and `APP_SECRET` are auto-generated by Render

### Deploy to Vercel (demos and prototyping)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay&env=ENCRYPTION_SECRET,ALLOWED_ORIGINS,APP_SECRET&envDescription=ENCRYPTION_SECRET%3A%20generate%20with%20%60openssl%20rand%20-hex%2032%60.%20ALLOWED_ORIGINS%3A%20your%20frontend%20domain%20(e.g.%20https%3A%2F%2Fmy-app.vercel.app).%20APP_SECRET%3A%20registration%20gate%20key%2C%20generate%20with%20%60openssl%20rand%20-hex%2032%60&envLink=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay%23setup&project-name=byok-relay&repository-name=byok-relay)

1. Click the button — Vercel clones the repo and prompts for env vars
2. Set `ENCRYPTION_SECRET`, `ALLOWED_ORIGINS`, and `APP_SECRET`
3. Deploy — your relay is live at `https://byok-relay-<hash>.vercel.app`

> ⚠️ **Vercel limitation:** Vercel serverless functions run on an ephemeral filesystem. SQLite state (registered users, stored keys) resets between cold starts. Use Vercel for demos and local testing only. For real users, deploy to Railway or Render instead.

## Setup

### 1. Install
```bash
git clone https://github.com/avikalpg/byok-relay.git
cd byok-relay
npm install
```

### 2. Configure
```bash
cp .env.example .env
# Set ENCRYPTION_SECRET (generate: openssl rand -hex 32)
# Set ALLOWED_ORIGINS to your app's domain(s)
```

### 3. Run
```bash
npm start
```

### Production (Ubuntu + systemd)
```bash
# Copy service file
sudo cp deploy/byok-relay.service /etc/systemd/system/
sudo systemctl enable --now byok-relay

# HTTPS with nginx + Let's Encrypt
sudo apt install nginx
sudo snap install --classic certbot
sudo certbot --nginx -d relay.yourdomain.com
```

## Security

- **AES-256-GCM encryption** — keys are encrypted at rest; the `ENCRYPTION_SECRET` lives only in your server environment
- **Keys never returned** — after the initial POST, the key value is never sent over the wire again
- **Registration gate** — set `APP_SECRET` to require `Authorization: Bearer <secret>` on `POST /users`; without it anyone who reaches your relay can register. Generate with `openssl rand -hex 32`.
- **Rate limiting** — 100 req/min global, 20 AI req/min per token, 10 registrations/hour per IP
- **Startup validation** — server refuses to start without a valid `ENCRYPTION_SECRET`
- **CORS** — restrict `ALLOWED_ORIGINS` to your app's domain in production
- **HTTPS required** in production (mixed-content browsers block HTTP endpoints called from HTTPS pages)

## BYOK — your users pay for what they use

Two patterns, one integration:

**Prosumer / individual** — each user registers their own API key once. They use their own credits; you spend $0 on inference. Great for developer tools, research UIs, or any product where users already have API accounts.

**Team / B2B** — a company admin registers the org's shared API key once. The relay token lives in your app's backend; all team members access AI through your app, which routes requests automatically. Billing, usage, and key rotation are managed inside the customer's organisation — not by you.

byok-relay handles both patterns today.

## Trade-offs

- **You hold the encrypted keys** — users trust your server. Mitigate with a cloud KMS-backed store for higher assurance.
- **No built-in user accounts** — the relay token is the only credential. Scope tokens to IP or add your own auth layer for production.
- **Self-hosted** — you're responsible for uptime, security updates, and backups. Or use [relay.byokrelay.com](https://relay.byokrelay.com) and skip all of that.

## Find us on

- [There's An AI For That](https://theresanaiforthat.com) — *submission in review*
- [skills.sh](https://skills.sh/avikalpg/byok-relay) — AI coding agent skill registry
- [Awesome LLMOps](https://github.com/tensorchord/Awesome-LLMOps) — *PR in review*
- [Awesome ChatGPT API](https://github.com/reorx/awesome-chatgpt-api) — *PR in review*

## License

Apache 2.0

---

**Ready to integrate?** → Use `npx skills add avikalpg/byok-relay` or point your coding agent at [byokrelay.com/skill](https://byokrelay.com/skill)

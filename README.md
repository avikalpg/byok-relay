# byok-relay

**Website:** [byokrelay.com](https://byokrelay.com) | **Hosted relay:** [relay.byokrelay.com](https://relay.byokrelay.com)

[![skills.sh](https://skills.sh/b/avikalpg/byok-relay)](https://skills.sh/avikalpg/byok-relay)
[![OpenAPI 3.0](https://img.shields.io/badge/OpenAPI-3.0-85EA2D?logo=openapiinitiative&logoColor=white)](https://relay.byokrelay.com/openapi.json)
[![MCP Server](https://img.shields.io/badge/MCP-Claude%20Desktop-orange?logo=anthropic)](https://www.npmjs.com/package/@byok-relay/mcp)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/avikalpg/byok-relay?quickstart=1)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay&env=ENCRYPTION_SECRET,ALLOWED_ORIGINS,APP_SECRET&envDescription=ENCRYPTION_SECRET%3A%20generate%20with%20%60openssl%20rand%20-hex%2032%60.%20ALLOWED_ORIGINS%3A%20your%20frontend%20domain%20(e.g.%20https%3A%2F%2Fmy-app.vercel.app)&envLink=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay%23setup&project-name=byok-relay&repository-name=byok-relay)

**Your users already have AI keys. byok-relay lets them use those keys — straight from your frontend, with no CORS issues and no keys in your code.**

Built for developers building prosumer tools and B2B AI products. Whether you're running a frontend-only app or have a full backend, byok-relay handles the BYOK plumbing — encrypted key storage, secure relay, multi-provider support — in minutes, not days. Your users bring their own OpenAI, Anthropic, or Gemini keys; you build the product; they pay for their own AI usage.

## Managed relay

**Skip the setup — use ours:**

```
https://relay.byokrelay.com
```

Free to use. Open CORS (any origin). [Health check →](https://relay.byokrelay.com/health)

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

## The problem

Browser apps can't call AI APIs directly:
- `api.anthropic.com`, `api.openai.com`, and most AI providers **block browser requests via CORS**
- Putting API keys in frontend code exposes them to every user

The common workaround — a backend proxy — means the *app developer* holds the keys. That's a trust problem, and it puts inference costs on your bill permanently.

**byok-relay solves this differently:** the relay sits between your frontend and the AI provider. Users register their own keys once; every request after that uses their key, billed to their account.

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

Use OpenRouter or LiteLLM when you're paying for your users' AI and want routing + analytics. Use byok-relay when you want users to bring their own keys.

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

The `token` (not the API key) lives in the browser. The API key stays server-side, encrypted at rest with AES-256-GCM.

## Try it instantly

No install needed — open byok-relay in a fully configured dev environment in your browser:

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/avikalpg/byok-relay?quickstart=1)

Dependencies are installed and a dev `.env` is pre-configured. Just run `npm start` and the API is live on port 3000.

---

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

> **Full OpenAPI 3.0 spec** (import into Postman, Insomnia, or any OpenAPI tool):
> - JSON: [`/openapi.json`](https://relay.byokrelay.com/openapi.json)
> - YAML: [`/openapi.yaml`](https://relay.byokrelay.com/openapi.yaml)

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

## Use from Claude Desktop / Claude Code (MCP)

byok-relay ships an [MCP server](packages/mcp/README.md) so Claude Desktop, Claude Code, Cursor, and any MCP-compatible client can relay AI requests through users' own API keys directly from the chat interface.

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "byok-relay": {
      "command": "npx",
      "args": ["-y", "@byok-relay/mcp"],
      "env": {
        "RELAY_URL": "https://relay.byokrelay.com",
        "RELAY_TOKEN": "<your-relay-token>"
      }
    }
  }
}
```

Restart Claude Desktop — the `byok_relay_*` tools will appear. Ask Claude to run `byok_relay_register` to get your token, then `byok_relay_store_key` to save a provider key, then `byok_relay_chat` to make relay calls.

See [`packages/mcp/README.md`](packages/mcp/README.md) for Claude Code, Cursor, and Windsurf setup.

---

## Deploy in one click

The fastest way to get byok-relay running is via Vercel:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay&env=ENCRYPTION_SECRET,ALLOWED_ORIGINS,APP_SECRET&envDescription=ENCRYPTION_SECRET%3A%20generate%20with%20%60openssl%20rand%20-hex%2032%60.%20ALLOWED_ORIGINS%3A%20your%20frontend%20domain%20(e.g.%20https%3A%2F%2Fmy-app.vercel.app)&envLink=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay%23setup&project-name=byok-relay&repository-name=byok-relay)

1. Click the button above
2. Set `ENCRYPTION_SECRET` (generate: `openssl rand -hex 32`) and `ALLOWED_ORIGINS` (your frontend domain)
3. Deploy — your relay is live at `https://byok-relay-<hash>.vercel.app`

> **Note:** Vercel's serverless environment has an ephemeral filesystem, so SQLite state resets between cold starts. This is fine for demos and prototyping. For production with persistent key storage, deploy to a long-running server (see [Production setup](#production-ubuntu--systemd) below, or use Railway/Render).

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
- [`@byok-relay/mcp`](https://www.npmjs.com/package/@byok-relay/mcp) — MCP server for Claude Desktop / Claude Code

## License

Apache 2.0

---

**Ready to integrate?** → Use `npx skills add avikalpg/byok-relay` or point your coding agent at [byokrelay.com/skill](https://byokrelay.com/skill)

# byok-relay

**Website:** [byokrelay.com](https://byokrelay.com) | **Hosted relay:** [relay.byokrelay.com](https://relay.byokrelay.com)

[![skills.sh](https://skills.sh/b/avikalpg/byok-relay)](https://skills.sh/avikalpg/byok-relay)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay&env=ENCRYPTION_SECRET,ALLOWED_ORIGINS&envDescription=ENCRYPTION_SECRET%3A%20generate%20with%20%60openssl%20rand%20-hex%2032%60.%20ALLOWED_ORIGINS%3A%20your%20frontend%20domain%20(e.g.%20https%3A%2F%2Fmy-app.vercel.app)&envLink=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay%23setup&project-name=byok-relay&repository-name=byok-relay)

A self-hosted (or managed) relay that removes inference costs from the developer's bill. Your users — whether individuals with personal keys or company admins managing a shared key — supply the API credentials. You build the product; they pay their own provider.

## Managed relay

**Don't want to self-host?** Use ours — no setup needed:

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

The common workaround — a backend proxy — means the *app developer* holds the keys. That's a trust problem. Users have to trust you not to misuse or leak their keys.

**byok-relay solves this differently:**

**Individuals / prosumers** — each user registers their own API key. They pay for their own usage; you pay nothing for inference. Works great for developer tools, research UIs, or any product where users already have API accounts.

**Teams / B2B** — a company admin registers the company's shared API key once. Every team member gets a relay token that routes through that same key. The developer (you) doesn't touch the key; it belongs to the customer's organization.

In both cases, the relay stores keys encrypted on *your* server and proxies requests without ever returning the key. The API key travels over the wire exactly once — when it's first registered.

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

The `token` (not the API key) is stored in the browser. The API key stays server-side, encrypted at rest with AES-256-GCM.

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

The fastest way to get byok-relay running is via Vercel:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay&env=ENCRYPTION_SECRET,ALLOWED_ORIGINS&envDescription=ENCRYPTION_SECRET%3A%20generate%20with%20%60openssl%20rand%20-hex%2032%60.%20ALLOWED_ORIGINS%3A%20your%20frontend%20domain%20(e.g.%20https%3A%2F%2Fmy-app.vercel.app)&envLink=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay%23setup&project-name=byok-relay&repository-name=byok-relay)

1. Click the button above
2. Set `ENCRYPTION_SECRET` (generate: `openssl rand -hex 32`) and `ALLOWED_ORIGINS` (your frontend domain)
3. Deploy — your relay is live at `https://byok-relay-<hash>.vercel.app`

> **Note:** Vercel's serverless environment has an ephemeral filesystem, so SQLite state resets between cold starts. This is fine for demos and prototyping. For production with persistent key storage, deploy to a long-running server (see [Production setup](#production-ubuntu--systemd) below, or use Railway/Render).

## Quickstart (60 seconds)

```bash
# 1. Clone and install
git clone https://github.com/avikalpg/byok-relay.git && cd byok-relay && npm install

# 2. Configure
echo "ENCRYPTION_SECRET=$(openssl rand -hex 32)" > .env
echo "ALLOWED_ORIGINS=http://localhost:3000" >> .env

# 3. Start
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
- **Keys never returned** — the API after initial POST
- **Rate limiting** — 100 req/min global, 20 AI req/min per token, 10 registrations/hour per IP
- **Startup validation** — server refuses to start without a valid `ENCRYPTION_SECRET`
- **CORS** — restrict `ALLOWED_ORIGINS` to your app's domain in production
- **HTTPS required** in production (mixed-content browsers block HTTP endpoints called from HTTPS pages)

## "BYOK" — what it actually means

"Bring your own key" sounds like every employee brings a personal API key. That's one use case, but **the more common B2B pattern is a company-managed key**:

1. Your customer's IT admin creates one API key with their provider (OpenAI, Anthropic, etc.)
2. They register that key with your relay once via `POST /keys/:provider` (e.g. `POST /keys/openai`)
3. Every team member gets their own relay token; the admin registers the shared company key under their account
4. Usage, billing, and key rotation are all managed by the customer's organization

> **Note:** In the current implementation, keys are stored per relay-token (user). For a true "one shared company key" model, the admin should register the company API key and then share their relay token with the team, or you can build a thin wrapper that maps multiple relay tokens to a single stored key. Org-level key sharing is on the roadmap.

byok-relay supports both the individual and company-managed patterns today.

## Trade-offs

- **You hold the encrypted keys** — users trust your server. If your server is compromised and the `ENCRYPTION_SECRET` leaks, all keys could be decrypted. For higher assurance, replace SQLite with a cloud KMS-backed store.
- **No user accounts** — the relay token is the only credential. Anyone who steals a user's localStorage token can use their stored key. Mitigate by scoping tokens to IP or adding optional auth.
- **Self-hosted** — you're responsible for uptime, security updates, and backups.

## Find us on

- [There's An AI For That](https://theresanaiforthat.com) — *submission in review*
- [skills.sh](https://skills.sh/avikalpg/byok-relay) — AI coding agent skill registry
- [Awesome LLMOps](https://github.com/tensorchord/Awesome-LLMOps) — *PR in review*
- [Awesome ChatGPT API](https://github.com/reorx/awesome-chatgpt-api) — *PR in review*

## License

Apache 2.0

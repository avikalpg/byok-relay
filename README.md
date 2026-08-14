# byok-relay

**Website:** [byokrelay.com](https://byokrelay.com) | **Hosted relay:** [relay.byokrelay.com](https://relay.byokrelay.com)

[![npm version](https://img.shields.io/npm/v/byok-relay.svg)](https://www.npmjs.com/package/byok-relay)
[![npm downloads](https://img.shields.io/npm/dm/byok-relay.svg)](https://www.npmjs.com/package/byok-relay)
[![skills.sh](https://skills.sh/b/avikalpg/byok-relay)](https://skills.sh/avikalpg/byok-relay)
[![OpenAPI 3.0](https://img.shields.io/badge/OpenAPI-3.0-85EA2D?logo=openapiinitiative&logoColor=white)](https://relay.byokrelay.com/openapi.json)
[![MCP Server](https://img.shields.io/badge/MCP-Claude%20Desktop-orange?logo=anthropic)](https://www.npmjs.com/package/@byok-relay/mcp)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/avikalpg/byok-relay?quickstart=1)
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay&envs=ENCRYPTION_SECRET%2CALLOWED_ORIGINS%2CAPP_SECRET%2CDB_PATH&ENCRYPTION_SECRETDesc=Generate%20with%3A%20openssl%20rand%20-hex%2032&ALLOWED_ORIGINSDesc=Your%20frontend%20domain%20e.g.%20https%3A%2F%2Fmy-app.vercel.app&APP_SECRETDesc=Secret%20key%20for%20user%20registration%20%E2%80%94%20generate%20with%3A%20openssl%20rand%20-hex%2032&DB_PATHDesc=SQLite%20path%20%E2%80%94%20match%20your%20Railway%20volume%20mount%20(default%3A%20%2Fdata%2Frelay.db)&DB_PATHDefault=%2Fdata%2Frelay.db)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay&env=ENCRYPTION_SECRET,ALLOWED_ORIGINS,APP_SECRET&envDescription=ENCRYPTION_SECRET%3A%20generate%20with%20%60openssl%20rand%20-hex%2032%60.%20ALLOWED_ORIGINS%3A%20your%20frontend%20domain%20(e.g.%20https%3A%2F%2Fmy-app.vercel.app)&envLink=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay%23setup&project-name=byok-relay&repository-name=byok-relay)
[![Run on Replit](https://replit.com/badge/github/avikalpg/byok-relay)](https://replit.com/github/avikalpg/byok-relay)

> **Your users bring their own AI keys. byok-relay lets them use those keys straight from the browser — CORS handled, keys never in your code, costs on their bill.**

Browser apps can't call `api.openai.com` or `api.anthropic.com` directly — CORS blocks them. The usual fix (a backend proxy) puts your users' keys — and your users' AI costs — on your tab. byok-relay flips this: each user gets a secure token; they store their own key; they pay for their own inference. You build the product.

## Get started

**Option A — Use our relay (zero setup):**

```text
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

> **Trust model:** The managed relay holds the `ENCRYPTION_SECRET`. All request bodies (prompts, conversation history) transit through it in plaintext on the way to AI providers. It is suitable for **prototypes, demos, and development** — not production apps with paying users or sensitive data. For production: [self-host](#setup). See [SECURITY.md](SECURITY.md#data-residency-managed-relay) for full data residency details.

## React hooks

For React apps (Lovable, Bolt.new, Vite, Next.js, Remix), install the hooks package:

```bash
npm install @byok-relay/react
```

```jsx
import { useChat, useStreamingChat, useByokRelay } from '@byok-relay/react';

// Add BYOK chat to any React component
const { messages, sendMessage, isLoading } = useChat({
  appId: 'my-app',
  provider: 'openai',  // or 'anthropic', 'groq', 'mistral', 'openrouter'
  model: 'gpt-4o',
});

// Real-time streaming
const { streamingContent, isStreaming } = useStreamingChat({
  appId: 'my-app', provider: 'anthropic', model: 'claude-3-5-sonnet-20241022'
});

// Key storage UI
const { storeKey } = useByokRelay({ appId: 'my-app' });
await storeKey('openai', userEnteredKey);
```

See [`packages/react`](./packages/react/README.md) for full API docs.

## Vue composables

For Vue 3 apps (Nuxt, Vite+Vue, Quasar), install the composables package:

```bash
npm install @byok-relay/vue
```

```vue
<script setup>
import { useByokRelay, useStreamingChat } from '@byok-relay/vue'

const relay = useByokRelay({ appId: 'my-app' })
const chat  = useStreamingChat({
  token: relay.token,
  provider: 'openai',  // or 'anthropic', 'groq', 'mistral', 'openrouter'
  model: 'gpt-4o-mini',
})
</script>

<template>
  <div v-for="m in chat.messages.value" :key="m.role">{{ m.role }}: {{ m.content }}</div>
  <p v-if="chat.isStreaming.value" style="opacity:.6">{{ chat.streamingContent.value }}</p>
  <input @keydown.enter="e => chat.sendMessage(e.target.value)" />
  <button v-if="chat.isStreaming.value" @click="chat.stopStreaming()">Stop</button>
</template>
```

Four composables: `useByokRelay` (token + key storage), `useChat` (stateful chat), `useStreamingChat` (SSE streaming with `stopStreaming()`), `useRelayHealth` (polls `/health`).

See [`packages/vue`](./packages/vue/README.md) for full API docs.

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

The **token** (not the key) lives in the browser. The API key stays server-side, encrypted at rest with AES-256-GCM. In the individual flow, users register once; every request uses their key and is billed to their provider account. In the B2B flow, requests use the organization's registered key and provider billing account.

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

## JavaScript client

The easiest way to integrate byok-relay into a Vite/ESM browser app:

```bash
npm install @byok-relay/client
```

```js
import { createClient } from '@byok-relay/client'

const relay = createClient({
  relayUrl: import.meta.env.VITE_RELAY_URL ?? 'https://relay.byokrelay.com', // or your self-hosted relay URL
})

// Your user enters their API key once
await relay.storeKey('openai', userApiKey)

// Then stream — no backend required
const text = await relay.streamChat({
  provider: 'openai',
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello!' }],
  onChunk: (delta) => console.log(delta),
})
```

Works in browsers (localStorage default), Node.js (in-memory default), and any custom storage adapter. See [`packages/client/README.md`](packages/client/README.md) for full API reference.

---

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
        "RELAY_URL": "https://relay.byokrelay.com"
      }
    }
  }
}
```

Restart Claude Desktop — the `byok_relay_*` tools will appear. Ask Claude to run `byok_relay_register` first. Copy the returned token into the config as `RELAY_TOKEN`, restart Claude Desktop again so the MCP server picks it up, then use `byok_relay_store_key` or `byok_relay_chat`.

See [`packages/mcp/README.md`](packages/mcp/README.md) for Claude Code, Cursor, and Windsurf setup.

---

## Try it instantly

No install needed — open byok-relay in a fully configured dev environment in your browser:

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/avikalpg/byok-relay?quickstart=1)

Dependencies are installed and a dev `.env` is pre-configured. Just run `npm start` and the API is live on port 3000.

---

## Quickstart (60 seconds)

**Option A — zero install with npx:**

```bash
ENCRYPTION_SECRET=$(openssl rand -hex 32) npx byok-relay
```

**Option B — clone and run:**

```bash
# 1. Clone and install
git clone https://github.com/avikalpg/byok-relay.git && cd byok-relay && npm install

# 2. Configure
echo "ENCRYPTION_SECRET=$(openssl rand -hex 32)" > .env
echo "ALLOWED_ORIGINS=http://localhost:5173" >> .env  # replace with your browser app's origin
# Production only: restrict who can register users, and keep this shell variable for step 4.
# APP_SECRET=$(openssl rand -hex 32)
# echo "APP_SECRET=$APP_SECRET" >> .env

# 3. Start
npm start &
i=0; until curl -fsS http://localhost:3000/health >/dev/null; do i=$((i + 1)); [ "$i" -ge 30 ] && { echo "Relay did not become ready"; exit 1; }; sleep 1; done

# 4. Register a user and get a token
# Development, when APP_SECRET is not set:
TOKEN=$(curl -s -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"app_id":"test"}' | node -e "let s=''; process.stdin.on('data', d => s += d).on('end', () => console.log(JSON.parse(s).token))")

# Production, when APP_SECRET is set:
# TOKEN=$(curl -s -X POST http://localhost:3000/users \
#   -H "Content-Type: application/json" \
#   -H "Authorization: Bearer $APP_SECRET" \
#   -d '{"app_id":"test"}' | node -e "let s=''; process.stdin.on('data', d => s += d).on('end', () => console.log(JSON.parse(s).token))")

# 5. Store your Anthropic key
curl -X POST http://localhost:3000/keys/anthropic \
  -H "Content-Type: application/json" \
  -H "x-relay-token: $TOKEN" \
  -d '{"key":"sk-ant-YOUR-KEY-HERE"}'

# 6. Relay a request — unified endpoint
curl -X POST http://localhost:3000/relay \
  -H "Content-Type: application/json" \
  -H "x-relay-token: $TOKEN" \
  -d '{"model":"anthropic/claude-3-5-haiku","max_tokens":256,"messages":[{"role":"user","content":"Hello!"}]}'

# Or with streaming
curl -X POST http://localhost:3000/relay \
  -H "Content-Type: application/json" \
  -H "x-relay-token: $TOKEN" \
  -d '{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"Hello!"}]}'
```

## Supported providers

### LLM providers

| Provider | Name | Notes |
|---|---|---|
| Anthropic | `anthropic` | Claude models, SSE streaming |
| OpenAI | `openai` | GPT models, SSE streaming |
| Google | `google` | Gemini API (key in query param) |
| Groq | `groq` | Fast inference, OpenAI-compatible |
| OpenRouter | `openrouter` | 200+ models via one API |
| Mistral | `mistral` | Mistral models |
| Any OpenAI-compatible | `openai-compatible` | Pass `x-relay-base-url` header — covers LiteLLM, Ollama, Perplexity, Together AI, and any other OpenAI-compatible endpoint |

### Non-LLM inference providers (audio, image, multimodal)

byok-relay supports non-LLM APIs that return binary responses (audio, images) or accept raw audio uploads. The same BYOK model applies: your users bring their own key; byok-relay handles auth headers and binary pass-through.

| Provider | Name | Key scheme | Use cases |
|---|---|---|---|
| ElevenLabs | `elevenlabs` | `xi-api-key` header | Text-to-speech (TTS), speech-to-speech, voice generation |
| HuggingFace | `huggingface` | Bearer token | NLP, image generation, audio models (Inference API) |
| Deepgram | `deepgram` | `Token` scheme | Speech-to-text (STT), text-to-speech |

**Binary response handling:** Audio and image responses are piped through byte-for-byte — no JSON parsing. The relay preserves `Content-Type`, `Content-Length`, and `Content-Disposition` headers so the client receives the raw audio/image buffer directly.

**Raw audio uploads (Deepgram STT):** When sending audio to `/v1/listen`, set `Content-Type` to the audio MIME type (e.g. `audio/wav`, `audio/mpeg`). The relay detects non-JSON content types and passes the raw binary body through to the provider without re-encoding.

#### ElevenLabs example — text-to-speech

```http
POST /relay/elevenlabs/v1/text-to-speech/{voice_id}
x-relay-token: <your-token>
Content-Type: application/json

{ "text": "Hello from byok-relay!", "model_id": "eleven_monolingual_v1" }
```

Response: `audio/mpeg` binary stream.

#### Deepgram example — speech-to-text

```http
POST /relay/deepgram/v1/listen?model=nova-2
x-relay-token: <your-token>
Content-Type: audio/wav

<raw audio bytes>
```

Response: JSON transcript from Deepgram.

Adding a new built-in provider is ~5 lines in `src/providers.js`.

## API

> **OpenAPI 3.0 spec for health, users, keys, and per-provider relay endpoints** (import into Postman, Insomnia, or any OpenAPI tool):
> - JSON: [openapi.json](https://relay.byokrelay.com/openapi.json)
> - YAML: [openapi.yaml](https://relay.byokrelay.com/openapi.yaml)

| Endpoint | Description |
|---|---|
| `POST /users` | Register app user, get relay token |
| `POST /keys/:provider` | Store encrypted API key |
| `GET /keys` | List stored providers |
| `DELETE /keys/:provider` | Remove a stored key |
| `POST /relay` | **Unified routing** — `model` field selects provider |
| `GET /models` | Routing table (patterns + provider prefixes) |
| `POST /relay/:provider/*` | Per-provider relay (backward-compat) |
| `GET /health` | Health check + version |

### Health check
```http
GET /health
```
Returns `HTTP 200` when the relay is healthy, `HTTP 503` when a critical check fails.

```json
{
  "ok": true,
  "version": "1.5.1",
  "uptime": 3600,
  "timestamp": "2026-06-11T03:00:00.000Z",
  "providers": ["openai", "anthropic", "google", "groq", "openrouter", "mistral", "elevenlabs", "deepgram", "openai-compatible"],
  "checks": {
    "db": { "ok": true },
    "config": { "ok": true, "encryption_key_set": true, "registration_gated": true }
  }
}
```

**Deep / readiness probe** — also pings a provider's models endpoint to verify network reachability:
```http
GET /health?deep=1&provider=openai
```
Adds `checks.upstream: { ok, provider, statusCode }` to the response and is rate-limited more tightly than the base liveness check. Use this for post-deploy smoke tests, not per-request liveness probes because it makes an outbound network call.

Use `/health` as your **liveness probe** and `/health?deep=1` as your **readiness probe** in K8s / docker-compose healthchecks.

### Register a user
```http
POST /users
Content-Type: application/json

{ "app_id": "my-app" }
```
→ `{ "token": "<relay-token>" }` — store securely in client-managed storage and treat it like a password

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

### Rotate a key (atomic: verify new → replace old)
```http
POST /keys/anthropic/rotate
x-relay-token: <token>
Content-Type: application/json

{ "key": "sk-ant-api03-..." }
```
The relay validates the new key's format, pings the provider with a lightweight read-only request to confirm the key is accepted, then atomically replaces the stored key in a single DB write.

The old key is **never touched** if the new key fails validation or is rejected by the provider — safe to call on a live deployment.

Returns `{ ok: true, provider, rotated: true }` if an existing key was replaced, or `{ ok: true, provider, rotated: false }` if no prior key existed.

### Delete a key
```http
DELETE /keys/anthropic
x-relay-token: <token>
```

### Revoke a relay token
```http
POST /tokens/revoke
x-relay-token: <token>
```
Immediately invalidates the token. Stored keys remain in the database but are no longer accessible. To regain access, register a new token (`POST /users`) and re-enter your keys.

### Delete account (GDPR erasure)
```http
DELETE /users
x-relay-token: <token>
```
Permanently deletes the user account **and all associated API keys**. This action is irreversible.

### Relay a request — unified endpoint (recommended)

Send a single request to `POST /relay` with a `model` field; the relay resolves
the provider automatically.

Use `"provider/model-name"` for an explicit route, or just the model name if it
matches a known pattern:

```http
POST /relay
x-relay-token: <token>
Content-Type: application/json

{ "model": "anthropic/claude-3-5-haiku", "max_tokens": 256, "messages": [{"role":"user","content":"Hello"}] }
```

```http
POST /relay
x-relay-token: <token>
Content-Type: application/json

{ "model": "gpt-4o", "messages": [{"role":"user","content":"Hello"}] }
```

Full streaming (SSE) is supported — pass `"stream": true` in the body.

**Discovery:** `GET /models` returns the full routing table plus the active model allowlist status. When unrestricted, the allowlist status is `{ "restricted": false, "message": "All models are permitted on this relay." }`.

**Body format note:** the request body must match the target provider's native
API format (`messages` for OpenAI/Anthropic/Groq/Mistral, `contents` for Google).
The provider prefix is stripped from the `model` field before forwarding.

### Relay a request — per-provider path (backward-compatible)
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

### Restrict allowed models

Set `ALLOWED_MODELS` to a comma-separated list of model names or wildcard patterns to prevent users from requesting expensive or unsupported models. Configure the raw `model` value clients send, including provider prefixes for `POST /relay` requests that use them:

```bash
ALLOWED_MODELS=gpt-4o-mini,anthropic/claude-3-5-haiku*,google/gemini-2.0-flash*
```

Matching is case-insensitive. `*` matches zero or more characters.

`GET /models` includes the routing table and the current allowlist status. If no allowlist is configured, the response includes:

```json
{ "restricted": false, "message": "All models are permitted on this relay." }
```

If an allowlist is configured, the response includes `"restricted": true` and `"allowed_models"`.

If a relay request includes a `model` field not on the list, the relay returns:

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json

{ "error": "Model \"gpt-4o\" is not permitted on this relay.", "allowed_models": ["gpt-4o-mini", "anthropic/claude-3-5-haiku*", "google/gemini-2.0-flash*"] }
```

## Deploy in one click

### Docker (recommended for self-hosters)

```bash
# 1. Copy and fill in the env template
cp .env.example .env
# Set ENCRYPTION_SECRET (required): openssl rand -hex 32
# Set ALLOWED_ORIGINS to your frontend domain(s)
# Set APP_SECRET (strongly recommended): openssl rand -hex 32

# 2. Start the relay
docker compose up -d

# 3. Check it's healthy
docker compose ps
curl http://localhost:3000/health
```

SQLite data persists in the Compose named volume `relay_data` (mounted at `/app/data` inside the container).
Back up the volume contents (the SQLite file holds all encrypted API keys). Example:

```bash
docker run --rm -v relay_data:/data -v $(pwd):/out alpine sh -c \
  'apk add --no-cache sqlite && sqlite3 /data/relay.db ".backup /out/relay-backup-$(date +%s).db"'
```

> **Note:** When you update the image, run `docker compose up --build -d` — the `relay_data` volume is preserved.

Pick a hosted platform based on your use case:

| Platform | Best for | Persistent storage | Cost |
|----------|----------|--------------------|------|
| **Railway** | Production, hobby projects | ✅ Yes — volumes included | Free trial, then ~$5/mo |
| **Render** | Production, free tier | ✅ Yes — 1 GB disk | Free tier available |
| **Vercel** | Demos, prototyping | ⚠️ Ephemeral (resets on cold start) | Free tier |

### Deploy to Railway (recommended — persistent SQLite)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay&envs=ENCRYPTION_SECRET%2CALLOWED_ORIGINS%2CAPP_SECRET%2CDB_PATH&ENCRYPTION_SECRETDesc=Generate%20with%3A%20openssl%20rand%20-hex%2032&ALLOWED_ORIGINSDesc=Your%20frontend%20domain%20e.g.%20https%3A%2F%2Fmy-app.vercel.app&APP_SECRETDesc=Secret%20key%20for%20user%20registration%20%E2%80%94%20generate%20with%3A%20openssl%20rand%20-hex%2032&DB_PATHDesc=SQLite%20path%20%E2%80%94%20match%20your%20Railway%20volume%20mount%20(default%3A%20%2Fdata%2Frelay.db)&DB_PATHDefault=%2Fdata%2Frelay.db)

1. Click the button above — Railway prompts for env vars
2. Set `ENCRYPTION_SECRET` (`openssl rand -hex 32`), `ALLOWED_ORIGINS` (your frontend domain), `APP_SECRET` (`openssl rand -hex 32`), and leave `DB_PATH` as `/data/relay.db`
3. As soon as the initial deploy completes, **before registering users or storing keys**, open **Dashboard → your service → Volumes → Add Volume** and set the mount path to `/data`
4. Redeploy, wait for `/health` to succeed, and only then use the relay — tokens and keys now survive restarts

> **Already used the relay without a volume?** Before attaching the volume, stop writes and use Railway SSH to create a SQLite online backup of the existing `relay.db` and download it. After mounting `/data`, restore that backup to `/data/relay.db` before reopening the service. Keep the existing `ENCRYPTION_SECRET` and `TOKEN_HMAC_SECRET`; changing either can make restored keys or tokens unusable.

### Deploy to Render (free tier with persistent disk)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/avikalpg/byok-relay)

1. Click the button — Render reads `render.yaml` from the repo and configures the service + 1 GB disk automatically
2. Override `ALLOWED_ORIGINS` with your frontend domain in the Render dashboard after deploy
3. `ENCRYPTION_SECRET` and `APP_SECRET` are auto-generated by Render

### Run on Replit (browser-based, zero install)

[![Run on Replit](https://replit.com/badge/github/avikalpg/byok-relay)](https://replit.com/github/avikalpg/byok-relay)

1. Click the button — Replit imports the repo and installs dependencies automatically
2. Add secrets in the Replit **Secrets** tab (🔒 icon in the sidebar):
   - `ENCRYPTION_SECRET` — `openssl rand -hex 32`
   - `ALLOWED_ORIGINS` — your frontend domain (e.g. `https://my-app.vercel.app`)
   - `APP_SECRET` — `openssl rand -hex 32`
3. Hit **Run** — your relay starts at the URL shown in the Replit webview

> **Note:** Free Repls sleep after ~5 minutes of inactivity. SQLite data persists in the Repl workspace across sleeps. For always-on production relays use Railway or Render instead.

### Deploy to Vercel (demos and prototyping)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay&env=ENCRYPTION_SECRET,ALLOWED_ORIGINS,APP_SECRET&envDescription=ENCRYPTION_SECRET%3A%20generate%20with%20%60openssl%20rand%20-hex%2032%60.%20ALLOWED_ORIGINS%3A%20your%20frontend%20domain%20(e.g.%20https%3A%2F%2Fmy-app.vercel.app).%20APP_SECRET%3A%20registration%20gate%20key%2C%20generate%20with%20%60openssl%20rand%20-hex%2032%60&envLink=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay%23setup&project-name=byok-relay&repository-name=byok-relay)

1. Click the button — Vercel clones the repo and prompts for env vars
2. Set `ENCRYPTION_SECRET`, `ALLOWED_ORIGINS`, and `APP_SECRET`
3. Deploy — your relay is live at `https://byok-relay-<hash>.vercel.app`

> ⚠️ **Vercel limitation:** Vercel serverless functions run on an ephemeral filesystem. SQLite state (registered users, stored keys) resets between cold starts. Use Vercel for demos and local testing only. For real users, deploy to Railway or Render instead.

## Quickstart (npm / CLI)

> **Fastest path (dev only):** `export ENCRYPTION_SECRET=$(openssl rand -hex 32) ALLOWED_ORIGINS=http://localhost:5173 && npx byok-relay`
> ⚠️ Keep the same `ENCRYPTION_SECRET` across restarts. If it changes, the relay cannot decrypt previously stored keys. For anything beyond a throwaway dev run, save it in a durable `.env`, shell profile, or secret manager.
> For install options, see [Setup](#setup).

**Clone-and-run walkthrough:**

```bash
# 1. Clone and install
git clone https://github.com/avikalpg/byok-relay.git && cd byok-relay && npm install

# 2. Configure
echo "ENCRYPTION_SECRET=$(openssl rand -hex 32)" > .env
echo "ALLOWED_ORIGINS=http://localhost:5173" >> .env  # replace with your browser app's origin

# 3. Start
npm start &
i=0; until curl -fsS http://localhost:3000/health >/dev/null; do i=$((i + 1)); [ "$i" -ge 30 ] && { echo "Relay did not become ready"; exit 1; }; sleep 1; done

# 4. Register a user and get a token
TOKEN=$(curl -s -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"app_id":"test"}' | node -e "let s=''; process.stdin.on('data', d => s += d).on('end', () => console.log(JSON.parse(s).token))")

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

**Option A — npx (quickest, no install)**

`npx byok-relay` launches a **standalone relay server process** — you run it alongside your existing app. It is not an embedded library; it listens on a port that your frontend calls. Set env vars in your shell before running.

```bash
export ENCRYPTION_SECRET=$(openssl rand -hex 32)
export ALLOWED_ORIGINS=https://your-app.example.com  # or * for dev
npx byok-relay
```

> ⚠️ **Persistence:** `ENCRYPTION_SECRET` set via `export` is ephemeral (session only). If you restart the server without the same secret, it cannot decrypt previously stored keys and all users will need to re-register their keys. Save it to a file (e.g. `.env`) or your shell profile for persistence. If you also customize `ENCRYPTION_SALT` (default: `byok-relay-salt`), save and keep that unchanged too — both values must match to decrypt existing keys.

**Option B — global install**

Same standalone server as Option A, available as a persistent command.

```bash
npm install -g byok-relay
export ENCRYPTION_SECRET=$(openssl rand -hex 32)
export ALLOWED_ORIGINS=https://your-app.example.com
byok-relay
```

> ⚠️ **Persistence:** Same caveat as Option A — store `ENCRYPTION_SECRET` somewhere durable (e.g. a `.env` file or your shell's `.bashrc`/`.zshrc`) so restarts don't invalidate existing stored keys. This applies to `ENCRYPTION_SALT` too if you've customized it.

**Option C — clone & run**
```bash
git clone https://github.com/avikalpg/byok-relay.git
cd byok-relay
npm install
```

### 2. Configure *(Option C only — A and B use env vars directly, as shown above)*
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

# Add a deny block to your nginx site config to block direct DB file access:
# Inside your server {} block, add:
#   location ~* \.db(-wal|-shm)?$ { deny all; return 404; }
# Then: sudo nginx -t && sudo systemctl reload nginx
```

## Security

### What byok-relay protects

| Threat | Protection |
|--------|------------|
| API key leaked from DB backup or LFI | AES-256-GCM encryption at rest; key is never returned to clients or persisted in plaintext |
| Relay token leaked from database | HMAC-SHA256 stored token hash; raw token sent to user exactly once at registration; legacy hashes are upgraded lazily. Browser-stolen raw tokens remain usable until expiry or revocation |
| Unauthenticated registration abuse | `APP_SECRET` gate on `POST /users` when configured; rate-limited to 10 registrations/hour per IP while the limiter store is available |
| SSRF via `openai-compatible` base URL | URL blocklist (RFC-1918, link-local, cloud IMDS, IPv6 loopback, IPv4-mapped IPv6); HTTPS-only; DNS rebinding protection via resolved-IP validation |
| Request floods | Three-layer rate limiting: 100 req/min global, 20 AI req/min per token, 10 registrations/hour per IP. Redis-backed for serverless/multi-process deployments; limits fail open if Redis/store is unavailable |
| Unexpected expensive model usage | Optional `ALLOWED_MODELS` allowlist with exact names and `*` wildcards; rejects configured JSON relay requests whose `model` is outside the list |
| Path traversal beyond inference | Allowlist of permitted path prefixes per provider (`/chat/completions`, `/completions`, `/embeddings`, `/messages`, etc.) |
| Header injection into upstream requests | CRLF sanitisation on all forwarded header values |
| Hung upstream connections | 30 s `AbortController` hard timeout on every `fetch()` to AI providers |
| Token theft → permanent access | Tokens expire after 90 days (`TOKEN_EXPIRY_DAYS`); `POST /tokens/revoke` for immediate invalidation |
| WAL file exposure via nginx misconfiguration | Nginx deny rules for `.db`, `.db-wal`, and `.db-shm` files; `DB_PATH` to move DB out of web root; systemd service tightens DB file permissions |

### Encryption implementation

**API key storage:**
```text
scrypt(ENCRYPTION_SECRET + ENCRYPTION_SALT) → 32-byte derived key  (computed once at startup)
aes-256-gcm(derived key, random 16-byte IV) → { iv, authTag, ciphertext }  stored as JSON in SQLite
```
- Derived key cached at module scope — `scrypt` runs exactly once per process startup, not per request
- Each key encrypted with a fresh random IV
- AES-GCM's `authTag` catches any tampering with the ciphertext
- `ENCRYPTION_SECRET` is required at startup
- `ENCRYPTION_SALT` is configurable (default fallback exists for backward compat; generate your own with `openssl rand -hex 32`)

**Relay token storage:**
```text
HMAC-SHA256(TOKEN_HMAC_SECRET, rawToken) → tokenHash  stored in SQLite
```
- The raw token is sent to the user exactly once (registration response) and never stored or logged
- All subsequent lookups compare `HMAC(incoming_token)` against stored token hashes in SQLite
- Set `TOKEN_HMAC_SECRET` to use a dedicated HMAC key. Existing hashes made with the historical `ENCRYPTION_SECRET` fallback continue to authenticate and are upgraded lazily, provided the existing `ENCRYPTION_SECRET` remains unchanged until every legacy-token user has authenticated and been upgraded.
- Run `npm run token-migration-status` on the relay host to see conservative `current`, `legacy`, and percentage counts. Existing rows begin as legacy/unconfirmed and become current after successful authentication; no user identifiers or tokens are printed.
- Tokens expire after 90 days and can be revoked immediately via `POST /tokens/revoke`

### Threat model: what byok-relay does NOT protect against

- **Prompt content confidentiality** — request bodies (prompts, conversation history) pass through the relay in plaintext on the way to AI providers. For production use with sensitive data, self-host on infrastructure you control.
- **XSS in your app** — any browser-accessible relay token can be stolen by XSS in *your* app. Store tokens with the least exposure your app can support, add CSP headers, scope tokens to IP when possible, and consider a short expiry.
- **Compromised `ENCRYPTION_SECRET`** — if your server environment is fully compromised, the encryption key is accessible. Mitigate with a cloud KMS (AWS KMS, GCP Cloud KMS) for higher assurance.
- **Multi-instance SQLite concurrency** — SQLite handles concurrent reads well but bottlenecks on concurrent writes. For high-traffic multi-replica deployments, use a Postgres backend.

### Managed relay vs self-hosted — an honest comparison

| | `relay.byokrelay.com` (managed) | Self-hosted |
|---|---|---|
| Setup time | Zero | ~5 min |
| Control over `ENCRYPTION_SECRET` | **No** — operator holds the key | **Yes** — you hold it |
| Request data flows through | Third-party infra | Your infra |
| Uptime SLA | None | Your ops |
| Good for | Prototypes, demos, development | Production, sensitive data |

For production deployments or any app with paying users: **self-host**. The managed relay is an easy way to evaluate byok-relay, not a production dependency.

### Hardening checklist for production

```bash
# Required
ENCRYPTION_SECRET=$(openssl rand -hex 32)   # ≥32 chars, never reuse
APP_SECRET=$(openssl rand -hex 32)           # gate POST /users
TOKEN_HMAC_SECRET=$(openssl rand -hex 32)    # HMAC token storage
ALLOWED_ORIGINS=https://yourdomain.com       # lock down CORS

# Recommended
ENCRYPTION_SALT=$(openssl rand -hex 32)      # unique per deployment; preserve with backups
REDIS_URL=redis://...                        # persistent rate limiting
TOKEN_EXPIRY_DAYS=30                         # shorter than default 90
ALLOWED_MODELS=gpt-4o-mini,claude-haiku*     # cap model access for shared/team relays
DB_PATH=/var/lib/byok-relay/relay.db         # outside web root
```

- Serve behind HTTPS (Let's Encrypt / Cloudflare)
- Restrict `ALLOWED_ORIGINS` to your app's domain in production
- Add nginx `deny` rules for `.db`, `.db-wal`, and `.db-shm` files if DB is in the project directory
- The systemd service applies `chmod 600` to `data/relay.db`, `relay.db-wal`, and `relay.db-shm` on every start via `ExecStartPost`. If deploying without systemd, run `chmod 600 data/relay.db*` manually after first start.
- Back up SQLite safely while WAL is enabled: use SQLite's online backup mechanism, or stop the service and checkpoint the WAL before copying `relay.db` (and any `relay.db-wal` / `relay.db-shm` files). The DB contains encrypted API keys; recovery requires preserving both `ENCRYPTION_SECRET` and `ENCRYPTION_SALT`.
- Rotate `ENCRYPTION_SECRET` only after `npm run token-migration-status` reports zero legacy or unconfirmed relay-token rows, then re-encrypt all stored API keys. API-key re-encryption alone does not migrate legacy token HMAC rows. Automated rotation tooling is not available yet; deleting users is not a safe rotation substitute because it destroys stored keys.

### Reporting vulnerabilities

Report vulnerabilities through GitHub Security Advisories when available, or email the maintainer privately. Do not open public GitHub issues or post exploit details before a fix is available.

---

### Verifying the managed relay

Users of `relay.byokrelay.com` can verify that the managed relay runs the exact public repo code:

1. **Check the running commit:**
   ```bash
   curl https://relay.byokrelay.com/version
   # { "version": "1.0.1", "commit": "<sha>", "buildTime": "...", "repoUrl": "...", "attestationUrl": "..." }
   ```

2. **Download the attestation manifest** for that release:
   ```bash
   curl -L https://github.com/avikalpg/byok-relay/releases/download/v<version>/attestation.json -o attestation.json
   ```

3. **Clone and verify:**
   ```bash
   git clone https://github.com/avikalpg/byok-relay byok-relay-verify
   cd byok-relay-verify
   git checkout <commit-from-step-1>
   node scripts/verify-attestation.js ../attestation.json
   # Expected: all PASS lines, exit code 0
   ```

The attestation manifest is a JSON file containing SHA-256 hashes of every file that affects relay behaviour (`src/index.js`, `src/db.js`, `src/providers.js`, `package.json`, `package-lock.json`). It is generated by GitHub Actions on every tagged release and attached to the release page — no trust in the relay operator required to verify it.

For higher assurance, self-host the relay on your own infrastructure using the same public code.

## BYOK — your users pay for what they use

Two patterns, one integration:

**Prosumer / individual** — each user registers their own API key once. Requests use their own credits and are billed to their provider account; you spend $0 on inference. Great for developer tools, research UIs, or any product where users already have API accounts.

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

## Legal

- [SECURITY.md](SECURITY.md) — vulnerability reporting, incident response runbook, hardening checklist
- [PRIVACY.md](PRIVACY.md) — privacy policy + template for operators running their own relay

---

**Ready to integrate?** → Use `npx skills add avikalpg/byok-relay` or point your coding agent at [byokrelay.com/skill](https://byokrelay.com/skill)

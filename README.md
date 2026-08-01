# byok-relay

**Website:** [byokrelay.com](https://byokrelay.com) | **Hosted relay:** [relay.byokrelay.com](https://relay.byokrelay.com)

[![skills.sh](https://skills.sh/b/avikalpg/byok-relay)](https://skills.sh/avikalpg/byok-relay)
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

## JavaScript client

The easiest way to integrate byok-relay into a JavaScript app:

```bash
npm install @byok-relay/client
```

```js
import { createClient } from '@byok-relay/client'

const relay = createClient({
  relayUrl: import.meta.env.VITE_RELAY_URL ?? 'https://relay.byokrelay.com',
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

**Discovery:** `GET /models` returns the full routing table.

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

### Vercel (prototyping only)

The fastest way to get byok-relay running is via Vercel:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay&env=ENCRYPTION_SECRET,ALLOWED_ORIGINS,APP_SECRET&envDescription=ENCRYPTION_SECRET%3A%20generate%20with%20%60openssl%20rand%20-hex%2032%60.%20ALLOWED_ORIGINS%3A%20your%20frontend%20domain%20(e.g.%20https%3A%2F%2Fmy-app.vercel.app)&envLink=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay%23setup&project-name=byok-relay&repository-name=byok-relay)

1. Click the button above
2. Set `ENCRYPTION_SECRET` (generate: `openssl rand -hex 32`) and `ALLOWED_ORIGINS` (your frontend domain)
3. Deploy — your relay is live at `https://byok-relay-<hash>.vercel.app`

> **Note:** Vercel's serverless environment has an ephemeral filesystem, so SQLite state resets between cold starts. This is fine for demos and prototyping. For production with persistent key storage, deploy to a long-running server (see [Production setup](#production-ubuntu--systemd) below, or use Railway/Render).

## Quickstart (npm / CLI)

> **Fastest path:** `export ENCRYPTION_SECRET=$(openssl rand -hex 32) && npx byok-relay`
> For the full walkthrough continue below, or see [Setup options](#setup) for `npm install -g` and clone paths.

```bash
# 1. Clone and install (or skip this with: npx byok-relay)
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

- **AES-256-GCM encryption** — keys are encrypted at rest; the `ENCRYPTION_SECRET` lives only in your server environment
- **Separated token hashing** — set `TOKEN_HMAC_SECRET` to use a dedicated HMAC key. Existing hashes made with the historical `ENCRYPTION_SECRET` fallback continue to authenticate and are upgraded lazily, provided the existing `ENCRYPTION_SECRET` remains unchanged until every legacy-token user has authenticated and been upgraded.
- **Migration progress** — run `npm run token-migration-status` on the relay host to see conservative `current`, `legacy`, and percentage counts. Existing rows begin as legacy/unconfirmed and become current after successful authentication; no user identifiers or tokens are printed.
- **Keys never returned** — after the initial POST, the key value is never sent over the wire again
- **Registration gate** — set `APP_SECRET` to require `Authorization: Bearer <secret>` on `POST /users`; without it anyone who reaches your relay can register. Generate with `openssl rand -hex 32`.
- **Rate limiting** — 100 req/min global, 20 AI req/min per token, 10 registrations/hour per IP. Set `REDIS_URL` for persistent limits across Vercel cold-starts and multi-process deployments (in-memory works fine for single-process self-hosted)
- **SSRF and DNS rebinding protection** — the `openai-compatible` provider validates `x-relay-base-url` against private/reserved CIDR ranges (RFC-1918, link-local, IMDS, IPv6 loopback, IPv4-mapped IPv6). It also validates resolved DNS answers and pins the upstream request to an approved IP, blocking DNS rebinding techniques such as `127.0.0.1.nip.io` that pass hostname validation but resolve to a blocked address.
- **Startup validation** — server refuses to start without a valid `ENCRYPTION_SECRET`
- **CORS** — restrict `ALLOWED_ORIGINS` to your app's domain in production
- **HTTPS required** in production (mixed-content browsers block HTTP endpoints called from HTTPS pages)
- **SQLite file permissions** — the systemd service file applies `chmod 600` to `data/relay.db`, `relay.db-wal`, and `relay.db-shm` on every start via `ExecStartPost`. If deploying without systemd, run `chmod 600 data/relay.db*` manually after first start.
- **WAL file exposure** — SQLite WAL mode creates `.db-wal` and `.db-shm` sibling files. If nginx serves the project root, add `location ~* \.db(-wal|-shm)?$ { deny all; return 404; }` to your server block to prevent direct download. Alternatively, move the `data/` directory outside the web root and update `DB_PATH` in `.env`.

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

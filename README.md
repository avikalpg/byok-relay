# byok-relay

A lightweight self-hosted relay server for **Bring Your Own Key (BYOK)** AI applications.

Users store their own API keys (Anthropic, OpenAI, etc.) once via a registration flow. The relay stores keys **encrypted at rest** and proxies requests on the user's behalf — the API key never travels over the wire after initial registration.

## Why

Direct browser-to-AI-provider calls are blocked by CORS. The relay solves this while keeping keys off the frontend and out of app source code.

## API

### Register a new user
```http
POST /users
Content-Type: application/json

{ "app_id": "my-app" }
```
Returns `{ "token": "<relay-token>" }`. Store this token in the user's browser (e.g. localStorage). It identifies the user to the relay.

### Store an API key
```http
POST /keys/anthropic
x-relay-token: <token>
Content-Type: application/json

{ "key": "sk-ant-..." }
```
Returns `{ "ok": true, "provider": "anthropic" }`. The key is encrypted and stored server-side. It is never returned.

### Check stored keys
```http
GET /keys
x-relay-token: <token>
```
Returns `{ "providers": ["anthropic"] }`. Key values are never returned.

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

{ "model": "claude-haiku-3-5", "max_tokens": 1024, "messages": [...], "stream": true }
```
The relay looks up the stored key, forwards the request to Anthropic, and streams the response back. Works with streaming (`stream: true`) and non-streaming requests.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env — set ENCRYPTION_SECRET and ALLOWED_ORIGINS
openssl rand -hex 32  # use this as ENCRYPTION_SECRET
```

### 3. Run
```bash
npm start
```

### Production (systemd)
See `deploy/byok-relay.service` for the systemd unit file.

## Security

- API keys are encrypted with AES-256-GCM before storage
- The encryption key (`ENCRYPTION_SECRET`) lives only in the server environment, never in source code
- Keys are never returned via the API after storage
- Rate limiting: 20 AI requests/minute per user token
- CORS restricted to configured origins in production
- HTTPS required in production (configure with nginx + Let's Encrypt)

## Supported providers

- `anthropic` — Claude models via `api.anthropic.com`
- `openai` — GPT models via `api.openai.com`

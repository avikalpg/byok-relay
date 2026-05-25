# byok-relay × Vanilla JS Example

A **single HTML file** that lets users bring their own Anthropic or OpenAI API key, stored securely on the relay — zero build step, zero dependencies.

## What this shows

- How to register a user and get a relay token
- How to store the user's API key on the relay (encrypted at rest)
- How to stream AI responses through byok-relay from plain JavaScript
- How to persist the relay token across page loads with `localStorage`

## Quick start

**Option A — Hosted relay (zero setup):**

Just open `index.html` in your browser. The file defaults to `https://relay.byokrelay.com` so no local server is needed.

```bash
# macOS
open examples/vanilla-js/index.html

# Linux
xdg-open examples/vanilla-js/index.html

# Windows
start examples/vanilla-js/index.html

# or just double-click index.html in your file manager
```

**Option B — Local relay:**

```bash
# 1. Start byok-relay locally
git clone https://github.com/avikalpg/byok-relay.git
cd byok-relay && npm install
ENCRYPTION_SECRET=$(openssl rand -hex 32) \
  ALLOWED_ORIGINS=null \
  npm start &

# 2. Open the demo, change Relay URL to http://localhost:3000
open examples/vanilla-js/index.html
```

> **Tip:** Set `ALLOWED_ORIGINS=null` or `*` when testing a file:// page locally; production should restrict to your domain.

## How it works

```text
Browser (this file)         byok-relay              Anthropic/OpenAI
      │                          │                         │
      ├── POST /users ──────────►│                         │
      │◄── { token } ───────────┤                         │
      │                          │                         │
      ├── POST /keys/anthropic ─►│                         │
      │   { key: "sk-ant-..." }  │ (stored encrypted)      │
      │◄── { ok: true } ────────┤                         │
      │                          │                         │
      ├── POST /relay/anthropic ►│                         │
      │   x-relay-token: token   ├── (key injected) ──────►│
      │◄── SSE stream ───────────┤◄── SSE stream ──────────┤
```

The user's API key is sent to the relay **once** and stored encrypted. It is **never** written to `localStorage` or exposed in the browser after that. The relay token (not the key) lives in `localStorage`.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Complete self-contained demo — HTML + CSS + JS in one file |

## Supported providers

| Provider | Model default | Key prefix |
|----------|--------------|------------|
| Anthropic | `claude-3-5-haiku-20241022` | `sk-ant-…` |
| OpenAI | `gpt-4o-mini` | `sk-…` |

Switch provider in the UI dropdown before saving your key.

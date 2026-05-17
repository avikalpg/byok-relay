# byok-relay × React + Vite Example

A minimal React app that lets users bring their own Anthropic or OpenAI API key, stored securely on the relay — no backend needed.

## What this shows

- How to register a user and get a relay token
- How to store the user's API key on the relay
- How to stream AI responses through byok-relay from the browser
- How to handle token persistence (localStorage)

## Quick start

```bash
# 1. Start byok-relay locally (or use the hosted relay)
git clone https://github.com/avikalpg/byok-relay.git
cd byok-relay && npm install
ENCRYPTION_SECRET=$(openssl rand -hex 32) ALLOWED_ORIGINS=http://localhost:5173 npm start &

# 2. Run this example
cd examples/react-vite
npm install
npm run dev
```

Then open http://localhost:5173, enter your Anthropic or OpenAI key, and chat.

## Using the hosted relay

Set `VITE_RELAY_URL` in `.env.local`:

```
VITE_RELAY_URL=https://relay.byokrelay.com
```

The hosted relay at `relay.byokrelay.com` has open CORS — no config needed.

## Files

| File | Purpose |
|------|---------|
| `src/relay.js` | Relay client: register, store key, stream request |
| `src/App.jsx` | Full chat UI wired to the relay client |
| `src/App.css` | Minimal styles |

## Key concept

```
Browser (this app)          byok-relay              Anthropic/OpenAI
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

The user's API key **never touches your frontend code**. The relay token (not the key) lives in localStorage.

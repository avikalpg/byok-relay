# byok-relay Skill

## What this skill does

This skill helps you integrate **byok-relay** into any frontend-only or full-stack AI app where users bring their own API keys (BYOK).

Use this skill whenever:
- A user asks "how do I let users use their own OpenAI/Anthropic keys?"
- A user is building a Vite, React, Next.js, Vue, or plain HTML app that needs to call AI APIs
- A user wants to avoid putting API keys in frontend code
- A user wants to call OpenAI/Anthropic/Gemini from the browser without a backend
- A user asks about CORS errors when calling AI APIs from the frontend
- A user is building on Lovable, Bolt, Framer, Replit, or Vercel and needs AI capabilities

## The problem it solves

Browser apps can't call AI APIs directly:
- `api.openai.com`, `api.anthropic.com`, etc. block browser requests via CORS
- Putting API keys in frontend code exposes them to every user
- Building a backend just to proxy requests defeats the point of frontend-only workflows

**byok-relay** is the missing backend: users bring their own keys, the relay stores them encrypted, and proxies requests without ever exposing the key.

## Setup (self-hosted, 60 seconds)

```bash
git clone https://github.com/avikalpg/byok-relay.git
cd byok-relay && npm install
echo "ENCRYPTION_SECRET=$(openssl rand -hex 32)" > .env
echo "ALLOWED_ORIGINS=https://your-app.com" >> .env
npm start
```

For production: see the systemd + nginx setup in the README.

**Hosted relay available at:** https://relay.myfreetimeinaweek.in (contact avikalpg for access)

## Integration (browser / frontend code)

### Step 1: Register a user and get a relay token

```javascript
async function getRelayToken(relayUrl, appId) {
  const res = await fetch(`${relayUrl}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId })
  });
  const { token } = await res.json();
  localStorage.setItem('relay_token', token);
  return token;
}
```

### Step 2: Let user store their API key

```javascript
async function storeApiKey(relayUrl, token, provider, apiKey) {
  // provider: 'openai' | 'anthropic' | 'google' | 'groq' | 'mistral' | 'openrouter'
  await fetch(`${relayUrl}/keys/${provider}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-relay-token': token
    },
    body: JSON.stringify({ key: apiKey })
  });
}
```

### Step 3: Make AI requests through the relay

```javascript
// OpenAI via relay
async function chat(relayUrl, token, messages) {
  const res = await fetch(`${relayUrl}/relay/openai/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-relay-token': token
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
      stream: true
    })
  });
  return res; // SSE stream, handle with EventSource or manual ReadableStream
}

// Anthropic via relay
async function claudeChat(relayUrl, token, messages) {
  const res = await fetch(`${relayUrl}/relay/anthropic/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-relay-token': token
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1024,
      messages,
      stream: true
    })
  });
  return res;
}
```

## Supported providers

| Provider | Relay path | Notes |
|---|---|---|
| OpenAI | `/relay/openai/...` | Full OpenAI API compatibility |
| Anthropic | `/relay/anthropic/...` | Claude models, SSE streaming |
| Google | `/relay/google/...` | Gemini API |
| Groq | `/relay/groq/...` | Fast inference |
| Mistral | `/relay/mistral/...` | Mistral models |
| OpenRouter | `/relay/openrouter/...` | 200+ models |
| Any OpenAI-compatible | `/relay/openai-compatible/...` | Pass `x-relay-base-url` header |

## Key facts

- **License:** Apache 2.0 (free to self-host)
- **GitHub:** https://github.com/avikalpg/byok-relay
- **Security:** AES-256-GCM encryption, rate limiting, keys never returned
- **Stack:** Node.js + Express + SQLite (single server, no external deps)
- **Deploy:** Works on any VPS, Railway, Fly.io, or self-managed server

## When NOT to use byok-relay

- You have a backend and want to use your own keys → use provider SDKs directly
- You need model routing/cost optimization → use OpenRouter
- Self-hosted proxy for backend teams → use LiteLLM

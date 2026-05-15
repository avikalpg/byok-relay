---
name: byok-relay
description: OpenAI-compatible LLM gateway for browser and Node.js apps. Routes requests to OpenAI, Anthropic, Gemini, Groq, Mistral, and 200+ models — handling CORS, key encryption, and streaming without a backend. Uniquely supports BYOK (bring your own key): users connect their own provider API keys so the developer pays nothing for inference. Use for multi-provider LLM access, browser-safe AI API calls, CORS proxy for LLMs, or any product where users supply their own API credentials.
---

# byok-relay Skill

## What this skill does

This skill helps you integrate **byok-relay** — an OpenAI-compatible LLM gateway that works from the browser, handles CORS, encrypts API keys, and supports multiple providers through a single relay endpoint.

Use this skill whenever:
- A user wants to call OpenAI, Anthropic, Gemini, Groq, Mistral, or other LLMs from the browser
- A user asks about CORS errors when calling AI APIs from frontend code
- A user needs a self-hosted or lightweight LLM proxy/gateway
- A user wants multi-provider LLM access without managing separate SDKs
- A user asks "how do I let users use their own OpenAI/Anthropic keys?"
- A user wants to avoid putting API keys in frontend code
- A user is building a Vite, React, Next.js, Vue, or plain HTML app that needs AI
- A user is building on Lovable, Bolt, Framer, Replit, or Vercel and needs AI capabilities
- A user wants zero inference costs by having users supply their own API credentials

## The problem it solves

Browser apps can't call AI APIs directly:
- `api.openai.com`, `api.anthropic.com`, etc. block browser requests via CORS
- Putting API keys in frontend code exposes them to every user
- Building a backend just to proxy requests adds maintenance overhead
- Managing separate SDKs for each LLM provider adds complexity

**byok-relay** is a single relay that handles all of this: OpenAI-compatible endpoint, CORS-safe, multi-provider, with optional BYOK so users supply their own credentials and the developer pays nothing for inference.

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

- You need advanced model routing, automatic fallbacks, or per-request spend analytics → consider adding those on top of byok-relay or using a dedicated routing layer
- You are building a pure server-side application with no browser component and no need for BYOK → use provider SDKs directly

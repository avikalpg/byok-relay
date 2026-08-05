---
title: "The missing backend for Lovable and Bolt apps"
published: false
description: "You built an app without a backend. Now you need AI. Here's the three-line fix that doesn't require spinning up a server."
tags: webdev, javascript, ai, lovable
cover_image: https://byokrelay.com/og-image.png
canonical_url: https://byokrelay.com/blog/missing-backend-for-lovable-bolt
---

You used Lovable (or Bolt, or Replit, or Cursor) to ship a real app in two days. No backend. It's live. Users love it.

Then someone asks: "Can you add AI?"

You open a new tab, get an OpenAI API key, and write three lines of `fetch`. It works locally. You deploy it.

Then you open DevTools on the live site and see your API key sitting right there in the network tab. Readable by anyone. Billable by anyone.

---

## The actual problem

Browser apps can't call AI APIs the normal way. Two things stop you:

**1. CORS.** `api.openai.com`, `api.anthropic.com`, and friends block cross-origin requests from browsers. Every AI provider does this. It's intentional.

**2. Key exposure.** Even if you find a workaround, any API key in your frontend code is visible to every user — in the source, in the bundle, in the network tab. One angry user or one curious competitor and your key is burned.

The standard advice is "add a backend to proxy your requests." That's 200 lines of Express, a Dockerfile, a deployed server, a domain, TLS, CORS headers, environment secrets management, and a monthly bill — for what should have been three lines of code.

There's a better option.

---

## byok-relay: zero backend required

[byok-relay](https://github.com/avikalpg/byok-relay) is an open-source relay that handles the CORS and key-security problem for you. You point your `fetch` calls at it instead of directly at OpenAI/Anthropic/Gemini. It forwards the request, handles CORS, and never puts your key (or your users' keys) anywhere a browser can read it.

The twist: it's built for **BYOK** — Bring Your Own Key. Your users connect their own API keys. You pay nothing for inference. They get AI in your app without trusting you with their key.

**For Lovable/Bolt apps specifically:** use the managed relay at `relay.byokrelay.com`. No setup, no server, open CORS.

---

## The integration (it's actually three steps)

### Step 1: Register your user

When a user opens your app for the first time, register them with the relay:

```javascript
const RELAY_URL = 'https://relay.byokrelay.com';

async function getRelayToken(appId) {
  // Check if we already have a token from a previous session
  const stored = localStorage.getItem('relay_token');
  if (stored) return stored;

  const res = await fetch(`${RELAY_URL}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId })
  });
  const { token } = await res.json();
  localStorage.setItem('relay_token', token);
  return token;
}
```

That token is how they authenticate with the relay going forward.

### Step 2: Let them save their API key

Add an input in your settings/onboarding UI:

```javascript
async function saveApiKey(relayToken, provider, apiKey) {
  const res = await fetch(`${RELAY_URL}/keys/${provider}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${relayToken}`
    },
    body: JSON.stringify({ key: apiKey })
  });
  return res.ok;
}

// Example: user enters their OpenAI key in a settings form
await saveApiKey(token, 'openai', 'sk-...');
```

The key is encrypted with AES-256-GCM before it's stored. It never travels back to the browser in plaintext. You never see it. Your users decide to trust the relay, not you.

### Step 3: Relay AI calls through it

```javascript
async function chat(relayToken, messages) {
  const res = await fetch(`${RELAY_URL}/relay/openai/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${relayToken}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages
    })
  });
  return res.json();
}

// Use it like normal
const reply = await chat(token, [
  { role: 'user', content: 'Summarize this for me: ...' }
]);
```

The relay decrypts the user's stored key, injects it into the outbound request to OpenAI, streams back the response. Your browser code never touches the key. CORS is handled. Done.

---

## Streaming works too

```javascript
async function streamChat(relayToken, messages, onChunk) {
  const res = await fetch(`${RELAY_URL}/relay/openai/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${relayToken}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages,
      stream: true
    })
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder.decode(value).split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const data = JSON.parse(line.slice(6));
      const chunk = data.choices?.[0]?.delta?.content;
      if (chunk) onChunk(chunk);
    }
  }
}
```

SSE streaming pipes through unchanged. The relay doesn't buffer or transform the stream — it just gets out of the way.

---

## Provider support

byok-relay supports OpenAI, Anthropic, Google Gemini, Groq, Mistral, Cohere, Together, Perplexity, and any OpenAI-compatible endpoint. It also supports ElevenLabs (TTS/STT), HuggingFace, and Deepgram for non-LLM inference.

Switch providers by changing the path:

```javascript
// Anthropic
POST /relay/anthropic/v1/messages

// Gemini (via OpenAI-compatible endpoint)
POST /relay/google/v1/chat/completions

// Groq
POST /relay/groq/openai/v1/chat/completions

// ElevenLabs TTS
POST /relay/elevenlabs/v1/text-to-speech/:voice_id
```

Or use unified routing with a single endpoint:

```javascript
// Single /relay endpoint, model param selects provider automatically
POST /relay
Body: { "model": "anthropic/claude-3-5-sonnet-latest", "messages": [...] }
```

---

## The "why not just use OpenRouter?" question

OpenRouter is great. You pay for credits, it proxies to whatever model. But the economics are different:

- **OpenRouter model:** You (the developer) buy credits → your users consume them → you eat the cost or charge for it
- **byok-relay model:** Your users bring their own keys → they pay directly → your marginal cost per user is zero

For a prosumer tool — something used by developers, researchers, or power users who already have API keys — BYOK is the better deal. They don't pay you a markup. You don't run an AI bill. They get the model they already pay for.

---

## Self-hosting when you're ready for production

The managed relay is for prototypes and development. For production with real users, run your own:

```bash
git clone https://github.com/avikalpg/byok-relay.git
cd byok-relay
cp .env.example .env
# Set ENCRYPTION_SECRET, TOKEN_HMAC_SECRET, APP_SECRET, ALLOWED_ORIGINS
npm start
```

Or with Docker:

```yaml
# docker-compose.yml
services:
  relay:
    image: node:20-alpine
    working_dir: /app
    volumes:
      - .:/app
      - ./data:/app/data
    ports:
      - "3000:3000"
    env_file: .env
    command: npm start
```

One-click Vercel deploy is also available in the README (note: use Turso or another persistent DB for production; Vercel's filesystem is ephemeral).

---

## What's already built in

This isn't a weekend project anymore. Current feature list:

- ✅ AES-256-GCM key encryption at rest
- ✅ HMAC-SHA256 token hashing (tokens never stored plaintext)
- ✅ Token expiry (90 days default, configurable) + revocation
- ✅ Rate limiting (Redis-backed for multi-instance, in-memory fallback)
- ✅ DNS rebinding protection (SSRF-safe fetch hooks)
- ✅ Per-provider API key format validation (catches typos before they 502)
- ✅ Atomic key rotation with live provider ping verification
- ✅ Request logging + `GET /stats` endpoint (per-user analytics)
- ✅ Streaming pipe error handler (no silent crashes on mid-stream disconnect)
- ✅ `GET /health` liveness + `GET /health?deep=1` readiness probe
- ✅ Model allowlist via `ALLOWED_MODELS` env var
- ✅ Binary response pass-through (audio, images, video)
- ✅ `@byok-relay/client` npm package for easier integration
- ✅ `SECURITY.md`, `PRIVACY.md` (GDPR/CCPA template) for trust documentation
- ✅ E2E test suite (Node 20 + 22, CI on every push)

MIT licensed. 51 GitHub stars. Actively maintained.

---

## Getting started right now

If you're in a Lovable/Bolt app:

```javascript
// Paste this into your project
const RELAY = 'https://relay.byokrelay.com';

const token = await fetch(`${RELAY}/users`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: 'my-lovable-app' })
}).then(r => r.json()).then(d => d.token);

localStorage.setItem('relay_token', token);

// Then let users save their OpenAI key:
await fetch(`${RELAY}/keys/openai`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({ key: 'sk-...' })
});

// Then call AI normally:
const reply = await fetch(`${RELAY}/relay/openai/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello!' }]
  })
}).then(r => r.json());
```

That's the whole thing. No new server. No Dockerfile. No $50/month infrastructure bill for a hobby project.

---

**GitHub:** [github.com/avikalpg/byok-relay](https://github.com/avikalpg/byok-relay)
**Managed relay:** [relay.byokrelay.com](https://relay.byokrelay.com)
**SKILL.md (for AI coding agents):** `npx skills add avikalpg/byok-relay`

If this saved you an afternoon, a ⭐ on GitHub goes a long way.

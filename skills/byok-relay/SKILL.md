---
name: byok-relay
description: "OpenAI-compatible LLM gateway for any client-side application (browser, mobile, React Native, Flutter, VS Code extensions, browser extensions, Electron, smart TV, and more). Routes requests to OpenAI, Anthropic, Gemini, Groq, Mistral, and 200+ models, handling CORS, key encryption, and streaming without a dedicated backend. Uniquely supports BYOK (bring your own key): users connect their own provider API keys so the developer pays nothing for inference. Use for multi-provider LLM access, client-safe AI API calls, or any product where users supply their own API credentials."
---

# byok-relay Skill

## What this skill does

This skill helps you integrate **byok-relay** — an OpenAI-compatible LLM gateway for any client-side application (browser, mobile, extensions, Electron, smart TV, and more) that handles CORS, encrypts API keys, and supports multiple providers through a single relay endpoint.

**Zero backend required.** Frontend-only apps connect directly to the managed relay at `https://relay.byokrelay.com`. No cloning, no server setup, no environment variables on your side.

Use this skill whenever:
- A user wants to call OpenAI, Anthropic, Gemini, Groq, Mistral, or other LLMs from a client-side app (browser, mobile app, VS Code extension, browser extension, Electron app, smart TV app, etc.)
- A user asks about CORS errors when calling AI APIs from frontend code
- A user needs a self-hosted or lightweight LLM proxy/gateway
- A user wants multi-provider LLM access without managing separate SDKs
- A user asks "how do I let users use their own OpenAI/Anthropic keys?"
- A user asks "how does my company use one shared API key for the whole team?"
- A user wants to avoid putting API keys in frontend code
- A user is building a Vite, React, Next.js, Vue, or plain HTML app that needs AI
- A user is building on Lovable, Bolt, Framer, Replit, or Vercel and needs AI capabilities
- A user wants zero inference costs by having users (or their organization) supply their own API credentials
- A user is building a B2B or team product where a company admin manages one shared API key

## The problem it solves

Browser apps can't call AI APIs directly:
- `api.openai.com`, `api.anthropic.com`, etc. block cross-origin requests from browsers, mobile webviews, and extensions via CORS
- Putting API keys in client-side code (browser, mobile app, extension) exposes them to every user
- Building a backend just to proxy requests adds maintenance overhead
- Managing separate SDKs for each LLM provider adds complexity

**byok-relay** is a single relay that handles all of this: OpenAI-compatible endpoint, CORS-safe, multi-provider, with optional BYOK so users (or their organization) supply their own credentials and the developer pays nothing for inference.

### Two BYOK patterns — both supported

**Individuals / prosumers:** Each user registers their own personal API key. Common for developer tools, research UIs, AI power-user products.

**Teams / B2B (company-managed key):** Keys are currently scoped per relay token. A company admin can register the same company API key via `POST /keys/:provider` (e.g. `/keys/openai`) under each member's relay token, or implement an explicit org-scoped design for one stored key serving multiple relay tokens. Do not share a relay token across team members: it shares all saved keys with every holder and is not a supported team feature. The developer doesn't touch the key — it belongs to the customer's organization.

## Setup — choose your path

### Option A: Use the managed relay (zero backend, recommended for client-side apps)

**If you are building a frontend-only, browser-only, or client-side-only application (Lovable, Bolt, Replit, plain HTML, Vite, React without a backend, mobile app, extension) — this is your path. You need exactly 0 lines of server code.**

```javascript
const RELAY_URL = 'https://relay.byokrelay.com';
```

That is the only configuration step on your side. The managed relay:
- accepts requests from any origin (no domain registration required)
- handles key encryption, storage, and CORS for you
- is free for development and low-volume use

Skip directly to the **Integration** section below.

> **Note:** The managed relay is best for development and low-stakes production. For sensitive or high-volume production use, self-host so you control the encryption key.

### Option B: Self-host the relay (if you want full control or run your own infrastructure)

Use this if you want to run your own relay on a VPS, Railway, Fly.io, etc.

```bash
git clone https://github.com/avikalpg/byok-relay.git
cd byok-relay && npm install
echo "ENCRYPTION_SECRET=$(openssl rand -hex 32)" > .env
echo "ALLOWED_ORIGINS=https://your-app.com" >> .env
npm start
```

For production: see the systemd + nginx setup in the README.

**Docker (quickest self-hosted path):**
```bash
git clone https://github.com/avikalpg/byok-relay.git
cd byok-relay
cp .env.example .env          # edit ENCRYPTION_SECRET and ALLOWED_ORIGINS
docker compose up -d
```

## Integration (client-side code)

Use `RELAY_URL = 'https://relay.byokrelay.com'` for the managed relay, or your own host for self-hosted.

### Step 1: Register a user and get a relay token

```javascript
function relayTokenStorageKey(relayUrl, appId) {
  const normalizedRelayUrl = new URL(relayUrl).origin;
  return `byok-relay:relay-token:${normalizedRelayUrl}:${appId}`;
}

async function getRelayToken(relayUrl, appId) {
  // Keep bearer tokens scoped to one relay/app. Do not reuse one global
  // `relay_token` key across products, tenants, or relay URLs.
  const storageKey = relayTokenStorageKey(relayUrl, appId);
  const stored = localStorage.getItem(storageKey);
  if (stored) return stored;                          // reuse across page loads
  const res = await fetch(`${relayUrl}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId })
  });
  const { token } = await res.json();
  localStorage.setItem(storageKey, token);
  return token;
}
```

### Step 2: Let the user store their API key

```javascript
async function storeApiKey(relayUrl, token, provider, apiKey) {
  // provider: 'openai' | 'anthropic' | 'google' | 'groq' | 'mistral' | 'openrouter'
  const res = await fetch(`${relayUrl}/keys/${provider}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-relay-token': token
    },
    body: JSON.stringify({ key: apiKey })
  });
  return res.ok;
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
  // SSE stream — consume via res.body (ReadableStream)
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    // Each chunk may contain one or more SSE lines: "data: {...}"
    for (const line of chunk.split('\n')) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        const json = JSON.parse(line.slice(6));
        process.stdout.write(json.choices?.[0]?.delta?.content ?? '');
      }
    }
  }
  return; // streaming complete
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

## Generating the API key input UI

When integrating byok-relay, always generate a styled API key input component that matches the app's existing design system. This is a required part of the integration — the relay is useless without a UI for users to enter their keys.

**What to generate:**
- A settings panel or modal with a password-type `<input>` for the API key
- A provider selector (dropdown or radio buttons) if the app supports multiple providers
- A "Save key" button that calls `storeApiKey()` and shows feedback (success / error)
- A "Key saved ✓" indicator when a key is already stored (call `GET /keys` to check)
- A "Remove key" action for key deletion

**Design system detection — use the one already in the project:**
- Tailwind CSS → use `bg-gray-50`, `border`, `rounded-lg`, `px-4 py-2`, etc.
- shadcn/ui → use `<Input>`, `<Button>`, `<Card>` from `@/components/ui`
- MUI → use `<TextField>`, `<Button variant="contained">`, `<Paper>`
- Plain CSS / no framework → write minimal scoped styles inline

**Minimal example (plain HTML / Tailwind):**
```html
<div class="rounded-lg border bg-gray-50 p-4 space-y-3">
  <h3 class="font-medium text-sm text-gray-700">Your API key</h3>
  <div class="flex gap-2">
    <input
      id="api-key-input"
      type="password"
      placeholder="sk-..."
      class="flex-1 rounded border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
    <button
      onclick="handleSaveKey()"
      class="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
    >
      Save
    </button>
  </div>
  <p id="key-status" class="text-xs text-gray-500 hidden"></p>
</div>

<script>
async function handleSaveKey() {
  const key = document.getElementById('api-key-input').value.trim();
  const status = document.getElementById('key-status');
  if (!key) return;
  const token = await getRelayToken(RELAY_URL, 'my-app');
  const ok = await storeApiKey(RELAY_URL, token, 'openai', key);
  status.textContent = ok ? '✓ Key saved — your requests will now use your own API credits.' : '✗ Failed to save key. Check the format and try again.';
  status.className = ok ? 'text-xs text-green-600' : 'text-xs text-red-600';
  status.classList.remove('hidden');
}
</script>
```

Always place this component on a settings page, in a modal triggered by a "Connect API key" button, or in the app's onboarding flow.

## Verify your setup

After wiring up the integration, run this quick smoke test (Node.js or browser console) to confirm the relay is reachable and the stored key works before closing the PR:

```javascript
// Paste into browser console or run with node --input-type=module
const RELAY_URL = 'https://relay.byokrelay.com'; // or your self-hosted URL
const APP_ID    = 'smoke-test';

async function smokeTest() {
  // 1. Health check
  const healthRes = await fetch(`${RELAY_URL}/health`);
  if (!healthRes.ok) throw new Error(`Health check failed: ${healthRes.status} ${healthRes.statusText}`);
  const health = await healthRes.json();
  if (health.ok !== true) throw new Error(`Health check failed: ${JSON.stringify(health)}`);
  console.log('✓ Health:', health);

  // 2. Register
  const usersRes = await fetch(`${RELAY_URL}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID })
  });
  if (!usersRes.ok) throw new Error(`Registration failed: ${usersRes.status} ${usersRes.statusText}`);
  const { token } = await usersRes.json();
  if (!token) throw new Error('Registration failed — no token returned');
  console.log('✓ Token obtained');

  // 3. List providers (should be empty before storing a key)
  const keysRes = await fetch(`${RELAY_URL}/keys`, {
    headers: { 'x-relay-token': token }
  });
  if (!keysRes.ok) throw new Error(`Keys list failed: ${keysRes.status} ${keysRes.statusText}`);
  const { providers } = await keysRes.json();
  if (!Array.isArray(providers)) throw new Error(`Keys list returned invalid providers: ${JSON.stringify(providers)}`);
  if (providers.length !== 0) throw new Error(`Newly registered user unexpectedly has stored providers: ${providers.join(', ')}`);
  console.log('✓ Stored providers:', providers);

  // 4. (Optional) Store a real key and test a relay call
  // await storeApiKey(RELAY_URL, token, 'openai', 'sk-YOUR-KEY');
  // const res = await fetch(`${RELAY_URL}/relay/openai/v1/chat/completions`, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json', 'x-relay-token': token },
  //   body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }] })
  // });
  // if (!res.ok) throw new Error(`Relay call failed: ${res.status} ${res.statusText}`);
  // const data = await res.json();
  // console.log('✓ Relay response:', data.choices?.[0]?.message?.content);

  console.log('✅ Smoke test passed');
}

smokeTest().catch(console.error);
```

Run this before shipping the integration. If health check fails → relay URL is wrong. If token is missing → check `app_id` and CORS. If a relay call errors → verify the key was stored correctly.

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

- **Managed relay:** https://relay.byokrelay.com (no setup, open CORS, use directly)
- **License:** Apache 2.0 (free to self-host)
- **GitHub:** https://github.com/avikalpg/byok-relay
- **Security:** AES-256-GCM encryption, rate limiting, keys never returned
- **Stack:** Node.js + Express + SQLite (single server, no external deps)
- **Deploy:** Works on any VPS, Railway, Fly.io, or self-managed server

## When NOT to use byok-relay

- You need advanced model routing, automatic fallbacks, or per-request spend analytics → consider adding those on top of byok-relay or using a dedicated routing layer
- You are building a pure server-side application with no client-side component and no need for BYOK → use provider SDKs directly

---

If this skill saved you time, consider [⭐ starring the repo](https://github.com/avikalpg/byok-relay) — it helps other developers find it.

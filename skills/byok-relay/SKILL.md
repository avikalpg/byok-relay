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
  return res; // SSE stream — handle with EventSource or ReadableStream
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

## Provider-specific API key guidance

Use the correct link and wording for each provider. **Important:** API accounts and API credits are separate from consumer subscriptions (ChatGPT Plus, Claude Pro, Gemini Advanced, Grok Premium). A user who pays for a consumer subscription still needs to create a separate API account and add billing credits to get an API key.

| Provider | Get API key | Key format | Note |
|---|---|---|---|
| OpenAI | https://platform.openai.com/api-keys | `sk-...` (≥40 chars) | Separate from ChatGPT Plus. Requires billing credits. |
| Anthropic | https://console.anthropic.com/settings/keys | `sk-ant-api03-...` | Separate from Claude Pro. Requires billing credits. |
| Google Gemini | https://aistudio.google.com/app/apikey | `AIza...` (39 chars) | Free tier available. Separate from Gemini Advanced. |
| Groq | https://console.groq.com/keys | `gsk_...` | Free tier available. Fast inference. |
| Mistral | https://console.mistral.ai/api-keys | `...` (32 hex chars) | Separate billing from Mistral subscription. |
| OpenRouter | https://openrouter.ai/settings/keys | `sk-or-v1-...` | Routes to 200+ models. One key for many providers. |

**User-facing copy to include near the input:** "Your API key is encrypted and stored on the relay. We never log, expose, or transmit your key to third parties. Inference costs go directly to your provider account, not to us."

**Subscription disambiguation copy (show when appropriate):** "Note: Your [ChatGPT Plus / Claude Pro / Gemini Advanced / Grok Premium] subscription does not include API access. Create a separate account at [link] and add billing credits to get an API key."

## Generating the API key input UI

When integrating byok-relay, always generate a styled API key input component that matches the app's existing design system. This is a required part of the integration — the relay is useless without a UI for users to enter their keys.

**Never prefill the input with a stored key value.** The relay never returns stored key material. If a key is already stored, show a masked placeholder (e.g. `sk-...••••••••`) or a "Key already saved" badge — never the actual key.

**What to generate:**
- A settings panel or modal with a password-type `<input>` for the API key
- A provider selector (dropdown or radio buttons) if the app supports multiple providers
- A "Connect" / "Save key" button that calls `storeApiKey()` and shows feedback
- A "Key saved ✓" indicator when a key is already stored (call `GET /keys` to check)
- A "Rotate key" action for in-place key replacement without downtime
- A "Remove key" / "Disconnect" action for key deletion
- Accessible labels and `aria-describedby` for status messages
- Paste-friendly: allow paste, do not strip characters, do not show key in clear text after save

**Design system detection — use the one already in the project:**
- Tailwind CSS → use `bg-gray-50`, `border`, `rounded-lg`, `px-4 py-2`, etc.
- shadcn/ui → use `<Input>`, `<Button>`, `<Card>` from `@/components/ui`
- MUI → use `<TextField>`, `<Button variant="contained">`, `<Paper>`
- Plain CSS / no framework → write minimal scoped styles inline

**Headless Connect AI component:** When `@byok-relay/connect` (issue #103) is available in the project's dependencies, prefer it over a hand-rolled component. It provides accessible, tested flows for all providers out of the box. Fall back to the pattern below only if it is not installed.

**Minimal example (plain HTML / Tailwind):**
```html
<div class="rounded-lg border bg-gray-50 p-4 space-y-3" role="region" aria-label="API key settings">
  <h3 class="font-medium text-sm text-gray-700">Connect your API key</h3>
  <p class="text-xs text-gray-500">
    Your key is encrypted at rest and never returned or logged.
    Inference costs go directly to your provider account.
    <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener" class="underline">Get an OpenAI key ↗</a>
  </p>
  <div class="flex gap-2">
    <input
      id="api-key-input"
      type="password"
      placeholder="sk-..."
      autocomplete="off"
      aria-label="API key"
      aria-describedby="key-status"
      class="flex-1 rounded border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
    <button
      id="save-btn"
      onclick="handleSaveKey()"
      class="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
    >
      Connect
    </button>
  </div>
  <p id="key-status" class="text-xs text-gray-500 hidden" aria-live="polite"></p>
  <div id="key-actions" class="hidden flex gap-2 pt-1">
    <button onclick="handleRotateKey()" class="text-xs text-blue-600 hover:underline">Rotate key</button>
    <button onclick="handleRemoveKey()" class="text-xs text-red-500 hover:underline">Disconnect</button>
    <button onclick="handleTestKey()" class="text-xs text-gray-500 hover:underline">Test connection</button>
  </div>
</div>

<script>
async function handleSaveKey() {
  const input = document.getElementById('api-key-input');
  const key = input.value.trim();
  if (!key) return;
  setStatus('validating', 'Validating key…');
  const token = await getRelayToken(RELAY_URL, APP_ID);
  const ok = await storeApiKey(RELAY_URL, token, 'openai', key);
  input.value = ''; // clear after save — never store in DOM
  if (ok) {
    setStatus('connected', '✓ Connected — your requests use your own API credits.');
    document.getElementById('key-actions').classList.remove('hidden');
  } else {
    setStatus('invalid', '✗ Failed. Check the key format and try again.');
  }
}
async function handleRotateKey() {
  const key = prompt('Enter the new API key to replace the current one:');
  if (!key) return;
  setStatus('rotating', 'Rotating key…');
  const token = await getRelayToken(RELAY_URL, APP_ID);
  const res = await fetch(`${RELAY_URL}/keys/openai/rotate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-relay-token': token },
    body: JSON.stringify({ key })
  });
  const data = await res.json();
  setStatus(data.ok ? 'connected' : 'invalid',
    data.ok ? '✓ Key rotated — live with zero downtime.' : '✗ Rotation failed. Old key is unchanged.');
}
async function handleRemoveKey() {
  if (!confirm('Remove your API key? You will need to reconnect to use AI features.')) return;
  setStatus('disconnecting', 'Removing key…');
  const token = await getRelayToken(RELAY_URL, APP_ID);
  await fetch(`${RELAY_URL}/keys/openai`, { method: 'DELETE', headers: { 'x-relay-token': token } });
  setStatus('disconnected', 'Key removed. Connect a new key to resume.');
  document.getElementById('key-actions').classList.add('hidden');
}
async function handleTestKey() {
  setStatus('validating', 'Sending test request…');
  try {
    const token = await getRelayToken(RELAY_URL, APP_ID);
    const res = await fetch(`${RELAY_URL}/relay/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relay-token': token },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 })
    });
    setStatus(res.ok ? 'connected' : 'invalid',
      res.ok ? '✓ Test request succeeded.' : `✗ Test failed (${res.status}). Check your key and billing.`);
  } catch { setStatus('invalid', '✗ Test failed. Check network and relay URL.'); }
}
function setStatus(state, msg) {
  const el = document.getElementById('key-status');
  const colors = { connected:'text-green-600', invalid:'text-red-600',
    validating:'text-blue-500', rotating:'text-blue-500',
    disconnected:'text-gray-500', disconnecting:'text-gray-400' };
  el.textContent = msg;
  el.className = `text-xs ${colors[state] || 'text-gray-500'}`;
  el.classList.remove('hidden');
}
</script>
```

Always place this component on a settings page, in a modal triggered by a "Connect API key" button, or in the app's onboarding flow.

## UX connection states

Track and display the correct state at all times. Never leave the user guessing.

| State | Display | User action |
|---|---|---|
| `unconnected` | Empty input, "Connect" CTA prominent | Paste key and click Connect |
| `validating` | Spinner / "Validating…" | None — wait |
| `connected` | Badge "✓ Connected", key actions visible | Rotate, test, or disconnect |
| `invalid` | Error "Key format invalid" or "Key rejected by provider" | Re-enter correct key |
| `expired` | Warning "Your key has expired or been revoked" | Rotate or enter new key |
| `rate_limited` | Warning "Too many requests — slow down" | Retry later or upgrade plan |
| `rotating` | Spinner / "Rotating…" | None — wait |
| `disconnected` | "No key connected" + Connect CTA | Connect a new key |

**Do not surface raw HTTP status codes to users.** Map relay responses to human-readable states. A 401/403 from the relay → `invalid`; a 429 → `rate_limited`; a network error → show "Could not reach relay — check your connection."

## Individual and organization-admin flows

**Individual / personal key flow:** Each user connects their own provider API key. The relay token is scoped to that user. Keys are personal and must not be shared.

**Organization / company-managed key flow:** A company admin connects one shared provider key under a dedicated relay token. The app backend distributes the relay token (never the provider key) to team members. The admin uses the "Rotate key" action when cycling credentials. **Do not share relay tokens across team members directly in the client** — a relay token grants full access to all stored keys for that token. Implement a server-side token-per-member model if per-user granularity is needed.

For the admin UI, add:
- A clear "Admin key" label and a note that this key covers the whole team
- A "Last rotated" timestamp pulled from `GET /keys` metadata
- Confirmation step before deletion (team loses AI access immediately)

## Key lifecycle: rotation, deletion, and recovery

**Rotation (`POST /keys/:provider/rotate`):**
- Validates the new key format and pings the provider before swapping — zero downtime
- Old key is untouched on any failure
- Show "Rotating…" state; confirm success or failure clearly
- Recommended cadence: every 90 days or on any suspected compromise

**Deletion (`DELETE /keys/:provider`):**
- Immediate effect — all in-flight requests using that key will fail
- Prompt the user to confirm before deleting
- After deletion, set UI state to `disconnected` and hide key actions

**Account erasure (`DELETE /users`):**
- Deletes all stored keys and the relay token (GDPR Art. 17)
- Include in account-deletion or data-export flows
- Irreversible — warn the user explicitly

**Recovery if key is compromised:**
1. Rotate the relay key immediately via `POST /keys/:provider/rotate`
2. Revoke the old provider key at the provider's console (not just delete from relay)
3. If the relay token itself is compromised: call `POST /tokens/revoke`, then re-register

## Integration verification checklist

Before declaring the integration complete, confirm every item:

- [ ] Provider key is never logged, returned, or stored in `localStorage`/`sessionStorage` in plain text
- [ ] Input field uses `type="password"` and clears after save
- [ ] Stored key presence shown as masked badge — not the actual key value
- [ ] All UX states render correctly (connected, invalid, rate_limited, expired, rotating, disconnected)
- [ ] "Get an API key" link present and points to the correct provider console
- [ ] Subscription disambiguation copy shown when the provider has a separate consumer product
- [ ] Security copy present: encryption, billing ownership, what is stored
- [ ] Rotate and Disconnect actions available when a key is connected
- [ ] Test-connection button calls the relay and surfaces result
- [ ] Organization flow: relay tokens are not shared client-side across team members
- [ ] Smoke test passed (see Verify your setup below)
- [ ] No provider key persists in client-side state after page reload (open DevTools → Application → Storage and verify)

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

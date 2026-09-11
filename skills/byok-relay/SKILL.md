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
    body: JSON.stringify({ app_id: appId }),
    redirect: 'error'
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
    body: JSON.stringify({ key: apiKey }),
    redirect: 'error'
  });
  return res.ok;
}
```

### Step 3: Make AI requests through the relay

```javascript
// OpenAI via relay
// onDelta is a browser-safe callback — e.g. (text) => { div.textContent += text; }
async function chat(relayUrl, token, messages, onDelta = () => {}) {
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
    }),
    redirect: 'error'
  });
  // SSE stream — buffered across chunk boundaries (ReadableStream, browser-safe)
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // { stream: true } handles multi-byte UTF-8 characters split across chunks
    buffer += decoder.decode(value, { stream: true });
    // Process complete lines only; keep any trailing partial line in the buffer
    const lines = buffer.split('\n');
    buffer = lines.pop(); // last element may be an incomplete line
    for (const line of lines) {
      if (line.startsWith('data: ') && line.trimEnd() !== 'data: [DONE]') {
        try {
          const json = JSON.parse(line.slice(6));
          const delta = json.choices?.[0]?.delta?.content ?? '';
          if (delta) onDelta(delta);
        } catch { /* ignore malformed SSE lines */ }
      }
    }
  }
  // Flush the TextDecoder and process any remaining buffered content
  buffer += decoder.decode();
  if (buffer.startsWith('data: ') && buffer.trimEnd() !== 'data: [DONE]') {
    try {
      const json = JSON.parse(buffer.slice(6));
      const delta = json.choices?.[0]?.delta?.content ?? '';
      if (delta) onDelta(delta);
    } catch { /* partial or empty final line — ignore */ }
  }
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
    }),
    redirect: 'error'
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
  <!-- Primary input: used for both initial connect and key rotation -->
  <div id="connect-panel" class="flex gap-2">
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
  <!-- Rotation panel: shown in place of connect panel when rotating -->
  <div id="rotate-panel" class="hidden flex gap-2">
    <input
      id="rotate-key-input"
      type="password"
      placeholder="New API key…"
      autocomplete="off"
      aria-label="New API key for rotation"
      aria-describedby="key-status"
      class="flex-1 rounded border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
    <button
      onclick="confirmRotateKey()"
      class="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
    >
      Confirm
    </button>
    <button
      onclick="cancelRotate()"
      class="rounded border px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100"
    >
      Cancel
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
// On load: check whether a key is already stored and restore connected state
async function initKeyState() {
  try {
    const token = await getRelayToken(RELAY_URL, APP_ID);
    const res = await fetch(`${RELAY_URL}/keys`, {
      headers: { 'x-relay-token': token },
      redirect: 'error'
    });
    if (!res.ok) {
      const state = await responseState(res);
      setStatus(state, statusMessages[state]);
      return;
    }
    const data = await res.json();
    if (data.providers && data.providers.includes('openai')) {
      setStatus('connected', '✓ Connected — key already saved (sk-…••••••••).');
      document.getElementById('key-actions').classList.remove('hidden');
    }
  } catch {
    setStatus('network', statusMessages.network);
  }
}
document.addEventListener('DOMContentLoaded', initKeyState);

// Map relay/provider responses to distinct UX states. Only the relay-owned
// X-Byok-Relay-Error header identifies relay authentication failures. Provider
// responses are forwarded and may use similar words in their response bodies.
async function responseState(res) {
  const relayError = res.headers.get('x-byok-relay-error');
  if (relayError === 'missing-relay-token' || relayError === 'invalid-relay-token') {
    return 'relay_auth';
  }
  let detail = '';
  try { detail = JSON.stringify(await res.clone().json()).toLowerCase(); } catch { /* plain-text error */ }
  if (res.status === 429) return 'rate_limited';
  if (res.status >= 500 && res.status < 600) return 'server_error';
  if (/\b(expired|revoked)\b/.test(detail)) return 'expired';
  if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 422) return 'invalid'; // provider rejection or key validation
  return 'server_error'; // unknown failures are retryable, not bad keys
}
const statusMessages = {
  connected:    '✓ Connected — your requests use your own API credits.',
  invalid:      '✗ Key rejected. Check the key format and ensure billing credits are available.',
  relay_auth:   '✗ Your relay session is invalid or expired. Sign in again and retry.',
  rate_limited: '⚠ Too many requests — slow down or try again shortly.',
  expired:      '⚠ Your key has expired or been revoked. Rotate or enter a new key.',
  network:      '✗ Could not reach the relay. Check your connection and relay URL.',
  server_error: '⚠ Relay or provider is temporarily unavailable. Retry shortly.',
  rotating:     '↻ Rotating key…',
  disconnected: 'No key connected. Add a key to use AI features.',
  disconnecting:'Removing key…',
  validating:   'Validating key…',
};

async function handleSaveKey() {
  const input = document.getElementById('api-key-input');
  const key = input.value.trim();
  if (!key) return;
  setStatus('validating', statusMessages.validating);
  try {
    const token = await getRelayToken(RELAY_URL, APP_ID);
    const res = await fetch(`${RELAY_URL}/keys/openai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relay-token': token },
      body: JSON.stringify({ key }),
      redirect: 'error'
    });
    input.value = ''; // clear after attempt — never leave key in DOM
    if (res.ok) {
      setStatus('connected', statusMessages.connected);
      document.getElementById('key-actions').classList.remove('hidden');
    } else {
      const state = await responseState(res);
      setStatus(state, statusMessages[state]);
    }
  } catch {
    input.value = '';
    setStatus('network', statusMessages.network);
  }
}

// handleRotateKey: show the rotation panel with a password input instead of window.prompt()
function handleRotateKey() {
  document.getElementById('connect-panel').classList.add('hidden');
  document.getElementById('key-actions').classList.add('hidden');
  const rotatePanel = document.getElementById('rotate-panel');
  rotatePanel.classList.remove('hidden');
  document.getElementById('rotate-key-input').focus();
  setStatus('rotating', 'Enter the new key and click Confirm.');
}
function cancelRotate() {
  document.getElementById('rotate-key-input').value = '';
  document.getElementById('rotate-panel').classList.add('hidden');
  document.getElementById('connect-panel').classList.add('hidden'); // stays hidden — key still connected
  document.getElementById('key-actions').classList.remove('hidden');
  setStatus('connected', statusMessages.connected);
}
async function confirmRotateKey() {
  const input = document.getElementById('rotate-key-input');
  const key = input.value.trim();
  if (!key) return;
  setStatus('rotating', statusMessages.rotating);
  try {
    const token = await getRelayToken(RELAY_URL, APP_ID);
    const res = await fetch(`${RELAY_URL}/keys/openai/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relay-token': token },
      body: JSON.stringify({ key }),
      redirect: 'error'
    });
    input.value = ''; // clear regardless of outcome
    document.getElementById('rotate-panel').classList.add('hidden');
    document.getElementById('key-actions').classList.remove('hidden');
    if (res.ok) {
      setStatus('connected', '✓ Key rotated — live with zero downtime.');
    } else {
      const state = await responseState(res);
      setStatus(state, state === 'invalid'
        ? `✗ Rotation failed. Old key is unchanged.`
        : statusMessages[state]);
    }
  } catch {
    document.getElementById('rotate-key-input').value = '';
    setStatus('network', statusMessages.network);
  }
}

async function handleRemoveKey() {
  if (!confirm('Remove your API key? You will need to reconnect to use AI features.')) return;
  setStatus('disconnecting', statusMessages.disconnecting);
  try {
    const token = await getRelayToken(RELAY_URL, APP_ID);
    const res = await fetch(`${RELAY_URL}/keys/openai`, {
      method: 'DELETE',
      headers: { 'x-relay-token': token },
      redirect: 'error'
    });
    if (res.ok) {
      setStatus('disconnected', statusMessages.disconnected);
      document.getElementById('key-actions').classList.add('hidden');
      document.getElementById('connect-panel').classList.remove('hidden');
    } else {
      // Deletion failed — keep UI in connected state and report a safe summary.
      const state = await responseState(res);
      setStatus(state, '✗ Could not remove key. Key may still be stored.');
      document.getElementById('key-actions').classList.remove('hidden');
    }
  } catch {
    setStatus('network', statusMessages.network);
    document.getElementById('key-actions').classList.remove('hidden');
  }
}

async function handleTestKey() {
  setStatus('validating', 'Sending test request…');
  try {
    const token = await getRelayToken(RELAY_URL, APP_ID);
    const res = await fetch(`${RELAY_URL}/relay/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relay-token': token },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
      redirect: 'error'
    });
    if (res.ok) {
      setStatus('connected', '✓ Test request succeeded.');
    } else {
      const state = await responseState(res);
      setStatus(state, statusMessages[state]);
    }
  } catch {
    setStatus('network', statusMessages.network);
  }
}

function setStatus(state, msg) {
  const el = document.getElementById('key-status');
  const colors = {
    connected:'text-green-600', invalid:'text-red-600',
    validating:'text-blue-500', rotating:'text-blue-500',
    rate_limited:'text-amber-600', expired:'text-amber-600',
    disconnected:'text-gray-500', disconnecting:'text-gray-400',
    network:'text-red-600', server_error:'text-amber-600',
  };
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
| `relay_auth` | Error "Your relay session is invalid or expired" | Sign in again, then retry |
| `expired` | Warning "Your key has expired or been revoked" | Rotate or enter new key |
| `rate_limited` | Warning "Too many requests — slow down" | Retry later or upgrade plan |
| `network` | Error "Could not reach relay — check your connection." | Check connection and relay URL, then retry |
| `server_error` | Warning "Relay or provider is temporarily unavailable" | Retry shortly; do not ask for a new key |
| `rotating` | Spinner / "Rotating…" | None — wait |
| `disconnected` | "No key connected" + Connect CTA | Connect a new key |

**Do not surface raw HTTP status codes to users.** Map relay responses to human-readable states. The relay identifies a missing or invalid token with its `X-Byok-Relay-Error` response header, which maps to `relay_auth`. A provider-key rejection maps to `invalid`; a 429 to `rate_limited`; an expired/revoked provider-key response to `expired`; a network error to `network` with "Could not reach relay — check your connection."; and 5xx or unknown failures to retryable `server_error`.

**Response-classification fixtures:** Cover these cases in the integration's client tests. The header is intentionally the only signal for relay authentication, so provider error text cannot misclassify a provider rejection.

| Fixture | Expected state |
|---|---|
| `401` with `X-Byok-Relay-Error: invalid-relay-token` | `relay_auth` |
| Provider `401` / `403` without that header | `invalid` |
| Provider error body says expired or revoked | `expired` |
| `429` | `rate_limited` |
| `5xx` | `server_error` |
| Plain-text or otherwise unrecognized error | `server_error` |

## Individual and organization-admin flows

**Individual / personal key flow:** Each user connects their own provider API key. The relay token is scoped to that user. Keys are personal and must not be shared.

**Organization / company-managed key flow:** An org admin registers one relay token per team member via the app's backend (`POST /users` server-side), then stores the company's provider API key under each member's token. The shared token must not be distributed to client browsers — a relay token grants full access to all stored keys for that token. **Never pass a shared relay token to end-user clients.** Instead, have the app server proxy relay requests on behalf of the member (server-side `x-relay-token` header) and issue a session credential to the browser that has no relay privilege by itself.

For the admin UI, add:
- A clear "Team key" label and a note that this key covers the whole team
- Confirmation step before deletion (team loses AI access immediately)
- A last-updated display sourced from your app's own audit log (the relay's `GET /keys` returns only which providers are stored, not rotation timestamps)

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
1. Rotate the provider API key immediately via `POST /keys/:provider/rotate`
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
    body: JSON.stringify({ app_id: APP_ID }),
    redirect: 'error'
  });
  if (!usersRes.ok) throw new Error(`Registration failed: ${usersRes.status} ${usersRes.statusText}`);
  const { token } = await usersRes.json();
  if (!token) throw new Error('Registration failed — no token returned');
  console.log('✓ Token obtained');

  // 3. List providers (should be empty before storing a key)
  const keysRes = await fetch(`${RELAY_URL}/keys`, {
    headers: { 'x-relay-token': token },
    redirect: 'error'
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
  //   body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }] }),
  //   redirect: 'error'
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

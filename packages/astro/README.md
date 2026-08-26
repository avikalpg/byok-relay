# @byok-relay/astro

> Astro integration for [byok-relay](https://byokrelay.com) — keep your relay URL private with server-side middleware, create API route proxies in one line, and use a plain-JS client in Astro `<script>` blocks or View Transitions.

[![npm](https://img.shields.io/npm/v/@byok-relay/astro)](https://www.npmjs.com/package/@byok-relay/astro)
[![byok-relay](https://img.shields.io/badge/byok--relay-1.0.0-blue)](https://github.com/avikalpg/byok-relay)

---

## Why a dedicated Astro package?

The [preact package](https://www.npmjs.com/package/@byok-relay/preact) works great inside Astro component islands, but **Astro SSR unlocks something better**: keep the relay URL a server-only secret. `@byok-relay/astro` adds:

| Feature | What it solves |
|---|---|
| **Middleware** (`createByokRelayMiddleware`) | Proxy `/api/relay/*` server-side; `RELAY_URL` never ships to the browser |
| **API route factory** (`createRelayApiRoute`) | One-liner catch-all route for `src/pages/api/relay/[...path].ts` |
| **`ByokRelayClient`** | Plain-JS client for `<script>` blocks, View Transitions, and SSR pages |

---

## Install

```bash
npm install @byok-relay/astro
```

---

## Quick start — SSR mode (recommended)

### 1. Store the relay URL as a server-only env var

```ini
# .env  (never commits to git)
RELAY_URL=https://relay.byokrelay.com
```

### 2. Add a catch-all API route

```ts
// src/pages/api/relay/[...path].ts
import { createRelayApiRoute } from '@byok-relay/astro';

export const prerender = false;

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = createRelayApiRoute({
  relayUrl: import.meta.env.RELAY_URL,   // server-only — never in the browser bundle
});
```

That's it. Every `fetch('/api/relay/...')` call from the browser is transparently proxied to the upstream relay.

### 3. Use `ByokRelayClient` in client `<script>` blocks

```astro
---
// src/pages/index.astro  (SSR page)
---
<div>
  <input id="api-key" type="password" placeholder="Your OpenAI key" />
  <button id="save">Save key</button>
  <button id="chat">Chat</button>
  <p id="output"></p>
</div>

<script>
  import { ByokRelayClient } from '@byok-relay/astro';

  // Point at the local proxy route — RELAY_URL never exposed to the browser
  const relay = new ByokRelayClient({ relayUrl: '/api/relay', appId: 'my-app' });

  document.getElementById('save').addEventListener('click', async () => {
    const key = document.getElementById('api-key').value.trim();
    await relay.storeKey('openai', key);
    console.log('Key saved!');
  });

  document.getElementById('chat').addEventListener('click', async () => {
    const reply = await relay.chat({
      provider: 'openai',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Say hello!' }],
    });
    document.getElementById('output').textContent = reply;
  });
</script>
```

---

## Middleware approach (alternative to API routes)

For more control or when you want a global proxy without an API route file:

```ts
// src/middleware.ts
import { sequence } from 'astro:middleware';
import { createByokRelayMiddleware } from '@byok-relay/astro';

export const onRequest = sequence(
  createByokRelayMiddleware({
    relayUrl: import.meta.env.RELAY_URL,
    pathPrefix: '/api/relay',       // default; all sub-paths proxied
    allowedApps: ['my-app'],        // optional verified app allowlist
    verifyApp: async ({ request, appId }) => {
      const session = await getSession(request); // your server-side session lookup
      return session?.appId === appId;
    },
  }),
);
```

The middleware intercepts any request whose pathname starts with `pathPrefix` and proxies it to the relay, streaming the response back. Requests to other paths call `next()` normally.

When `allowedApps`, `verifyApp`, or `appSecrets` is set, the app ID must be verified by trusted server-side state. Provide either `verifyApp` for session/cookie based apps or `appSecrets` for signed server-to-server requests with `x-app-id`, `x-app-timestamp`, `x-app-nonce`, and `x-app-signature`. The proxy never authorizes a request based on a client-supplied `x-app-id` or `app_id` alone.

---

## Static / client-only mode

No SSR? Point `ByokRelayClient` directly at the public relay:

```astro
<script>
  import { ByokRelayClient } from '@byok-relay/astro';

  // Public relay URL — fine for prototypes; for production, use SSR proxy above
  const relay = new ByokRelayClient({
    relayUrl: 'https://relay.byokrelay.com',
    appId: 'my-app',
  });
</script>
```

---

## `ByokRelayClient` API reference

```ts
const relay = new ByokRelayClient({
  relayUrl: string,       // Relay or proxy URL. Default: 'https://relay.byokrelay.com'
  appId: string,          // Your app identifier. Default: 'astro-app'
  storageKey?: string,    // localStorage key for the relay token. Default: 'byok_relay_token'
});
```

### Token management

| Method | Description |
|---|---|
| `relay.register()` | Register a new user and store the relay token in localStorage. Returns `Promise<string>`. |
| `relay.ensureToken()` | Return existing token or register first. Safe to call before every action. |
| `relay.logout()` | Clear the token from memory and localStorage. |
| `relay.token` | Current token or `null`. |

### Key management

| Method | Description |
|---|---|
| `relay.storeKey(provider, apiKey)` | Store an API key for the given provider (`'openai'`, `'anthropic'`, etc.). |
| `relay.listKeys()` | List stored provider names (values never returned). |
| `relay.deleteKey(provider)` | Delete a stored key. |
| `relay.rotateKey(provider, newApiKey)` | Atomic key rotation: validate new key with provider before swapping. |

### Chat

| Method | Description |
|---|---|
| `relay.chat({ provider, model, messages, systemPrompt?, extraParams? })` | Non-streaming chat. Returns `Promise<string>`. |
| `relay.streamChat({ provider, model, messages, onChunk, onDone?, systemPrompt?, extraParams? })` | SSE streaming. Calls `onChunk(delta)` per token, `onDone(full)` when finished. Returns `Promise<string>`. |

### Utility

| Method | Description |
|---|---|
| `relay.health(deep?)` | GET /health. `deep=true` probes upstream providers. |
| `relay.stats(appId?)` | GET /stats (per-user) or /stats/:appId (operator aggregate). |
| `relay.getModels()` | GET /models — list available models and providers. |
| `relay.deleteAccount()` | Delete account + all keys (GDPR Art. 17). Calls `logout()` on success. |

---

## `createRelayApiRoute` options

```ts
createRelayApiRoute({
  relayUrl?: string,                        // Upstream relay URL. Uses managed relay by default.
  allowedApps?: Iterable<string> | string,  // Optional verified app allowlist.
  verifyApp?: ({ request, appId }) => boolean | string | Promise<boolean | string>,
  appSecrets?: Record<string, string> | Map<string, string>, // Server-only HMAC secrets keyed by app ID.
  appSignatureToleranceMs?: number,         // Positive milliseconds. Default: 5 minutes.
})
```

Returns an object with `{ GET, POST, PUT, PATCH, DELETE, OPTIONS }` Astro `APIRoute` handlers.

When `allowedApps`, `verifyApp`, or `appSecrets` is set, the route requires a server-side proof. Use `verifyApp` to bind the app ID to a trusted session/cookie, or send signed server-to-server requests with `x-app-id`, `x-app-timestamp`, `x-app-nonce`, and `x-app-signature`. The signature is `sha256=<hex_hmac_sha256(secret, METHOD + '\\n' + PATHNAME + '\\n' + SEARCH + '\\n' + TIMESTAMP + '\\n' + APP_ID + '\\n' + BODY_SHA256 + '\\n' + NONCE)>`.

HMAC wire contract:
- `TIMESTAMP` is Unix time in milliseconds and must be within `appSignatureToleranceMs`.
- `METHOD` is uppercased, `PATHNAME` is `url.pathname`, and `SEARCH` is raw `url.search` including the leading `?` when present or an empty string otherwise.
- `BODY_SHA256` is lowercase hexadecimal SHA-256 of the request body for methods that carry a body, and an empty string for `GET` and `HEAD`.
- `NONCE` is the exact `x-app-nonce` header value and is rejected on replay until the tolerance window expires.
- Fields are separated by literal newline characters. The digest is lowercase hexadecimal HMAC-SHA256, and the `sha256=` prefix is optional.

Never ship `appSecrets` to browser code. HMAC signatures attest the server-side app integration; relay tokens remain the authorization boundary for user/provider access.

The `params.path` catch-all value is used to construct the upstream sub-path:
- `/api/relay/health` → params.path = `'health'` → proxies to `RELAY_URL/health`
- `/api/relay/keys/openai` → params.path = `'keys/openai'` → proxies to `RELAY_URL/keys/openai`

---

## `createByokRelayMiddleware` options

```ts
createByokRelayMiddleware({
  relayUrl?: string,                        // Upstream relay URL. Uses managed relay by default.
  pathPrefix?: string,                      // URL prefix to intercept. Default: '/api/relay'.
  allowedApps?: Iterable<string> | string,  // Optional verified app allowlist.
  verifyApp?: ({ request, appId }) => boolean | string | Promise<boolean | string>,
  appSecrets?: Record<string, string> | Map<string, string>, // Server-only HMAC secrets keyed by app ID.
  appSignatureToleranceMs?: number,         // Positive milliseconds. Default: 5 minutes.
})
```

---

## Supported providers

| Provider | `provider` value |
|---|---|
| OpenAI | `'openai'` |
| Anthropic | `'anthropic'` |
| Groq | `'groq'` |
| Mistral | `'mistral'` |
| OpenRouter | `'openrouter'` |
| ElevenLabs | `'elevenlabs'` |
| HuggingFace | `'huggingface'` |
| Deepgram | `'deepgram'` |
| Any OpenAI-compatible | `'openai-compatible'` |

---

## Streaming example (View Transitions safe)

```astro
<script>
  import { ByokRelayClient } from '@byok-relay/astro';

  const relay = new ByokRelayClient({ relayUrl: '/api/relay', appId: 'my-app' });
  const output = document.getElementById('output');

  document.getElementById('send').addEventListener('click', async () => {
    output.textContent = '';
    await relay.streamChat({
      provider: 'anthropic',
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: document.getElementById('input').value }],
      onChunk: (delta) => { output.textContent += delta; },
    });
  });
</script>
```

---

## Self-hosting

If you self-host byok-relay, pass your instance URL:

```ts
createRelayApiRoute({ relayUrl: import.meta.env.RELAY_URL })
// RELAY_URL=http://your-server:3000 in .env
```

See [byok-relay](https://github.com/avikalpg/byok-relay) for self-hosting docs (Docker, Railway, Render).

---

## Related packages

| Package | For |
|---|---|
| [`@byok-relay/client`](https://www.npmjs.com/package/@byok-relay/client) | Vanilla JS — works anywhere |
| [`@byok-relay/react`](https://www.npmjs.com/package/@byok-relay/react) | React hooks |
| [`@byok-relay/vue`](https://www.npmjs.com/package/@byok-relay/vue) | Vue 3 composables |
| [`@byok-relay/svelte`](https://www.npmjs.com/package/@byok-relay/svelte) | Svelte stores |
| [`@byok-relay/solid`](https://www.npmjs.com/package/@byok-relay/solid) | SolidJS signals |
| [`@byok-relay/preact`](https://www.npmjs.com/package/@byok-relay/preact) | Preact hooks (Astro islands) |
| [`@byok-relay/angular`](https://www.npmjs.com/package/@byok-relay/angular) | Angular services |
| [`@byok-relay/vercel-ai`](https://www.npmjs.com/package/@byok-relay/vercel-ai) | Vercel AI SDK adapter |
| [`@byok-relay/mcp`](https://www.npmjs.com/package/@byok-relay/mcp) | MCP server for Claude Desktop |

---

If this saved you time, consider ⭐ [starring the repo](https://github.com/avikalpg/byok-relay).

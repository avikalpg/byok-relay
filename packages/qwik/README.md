# @byok-relay/qwik

> Qwik City server loaders, actions, and reactive stores for [byok-relay](https://github.com/avikalpg/byok-relay) — BYOK AI in any Qwik City app.

[![npm](https://img.shields.io/npm/v/@byok-relay/qwik)](https://www.npmjs.com/package/@byok-relay/qwik)

`RELAY_URL` stays in `process.env` (server-only via Vite private env). The browser never sees your upstream relay URL.

---

## Install

```bash
npm install @byok-relay/qwik
```

Peer deps (optional — all APIs work without them via built-in shims):

```bash
npm install @builder.io/qwik @builder.io/qwik-city
```

---

## Quick Start — Qwik City route proxy

Create a catch-all route at `src/routes/relay/[...path]/index.tsx`:

```tsx
// src/routes/relay/[...path]/index.tsx  (server-only)
import { routeAction$, routeLoader$, zod$, z } from '@builder.io/qwik-city';
import { createRelayLoader, createRelayAction } from '@byok-relay/qwik';

// GET/HEAD requests → relay (health checks, model list, etc.)
export const useRelayData = routeLoader$(createRelayLoader());

// POST/PUT/PATCH/DELETE → relay (chat, key management, etc.)
export const useRelayAction = routeAction$(
  createRelayAction(),
  zod$({ path: z.string(), token: z.string(), body: z.any().optional() })
);
```

`RELAY_URL` is read from `process.env.RELAY_URL` on the server — never shipped to the browser.

---

## Quick Start — Client component with streaming

```tsx
// src/components/chat.tsx
import { component$, useStore, useVisibleTask$ } from '@builder.io/qwik';
import {
  createByokRelayStore,
  createStreamingChatStore,
} from '@byok-relay/qwik';

export default component$(() => {
  // Qwik reactive stores
  const relayState  = useStore({ token: null, keys: [], loading: false, error: null });
  const streamState = useStore({
    messages: [], streamingContent: '', isStreaming: false, error: null
  });

  const relay = createByokRelayStore({
    store    : relayState,
    relayUrl : '/relay',   // proxied through your Qwik City route
    appId    : 'my-app',
  });

  const chat = createStreamingChatStore({
    store    : streamState,
    model    : 'openai/gpt-4o-mini',
    relayUrl : '/relay',
  });

  useVisibleTask$(async () => {
    await relay.init();         // restore token from localStorage
  });

  return (
    <div>
      {relayState.token ? (
        <div>
          {streamState.messages.map((m, i) => (
            <p key={i}><b>{m.role}:</b> {m.content}</p>
          ))}
          {streamState.streamingContent && (
            <p><b>assistant (streaming):</b> {streamState.streamingContent}</p>
          )}
          <button
            onClick$={() => chat.sendMessage('Hello from Qwik!')}
            disabled={streamState.isStreaming}
          >
            Send
          </button>
          {streamState.isStreaming && (
            <button onClick$={() => chat.stopStreaming()}>Stop</button>
          )}
        </div>
      ) : (
        <button onClick$={() => relay.register()}>
          {relayState.loading ? 'Connecting…' : 'Connect AI'}
        </button>
      )}
    </div>
  );
});
```

---

## API Reference

### Server helpers

#### `createRelayLoader(opts?)`

Returns a Qwik City `routeLoader$`-compatible async function for GET/HEAD proxying.

```ts
createRelayLoader({
  relayUrl    ?: string,    // default: process.env.RELAY_URL
  allowedApps ?: string[],  // optional app_id allowlist (403 if not in list)
})
```

Pass the result directly into `routeLoader$`:

```tsx
export const useRelayData = routeLoader$(createRelayLoader());
```

The loader reads `params['path']` to map `[...path]` to the upstream relay sub-path. Strips hop-by-hop headers. 30 s timeout.

#### `createRelayAction(opts?)`

Returns a Qwik City `routeAction$`-compatible async function for POST/PUT/PATCH/DELETE proxying.

```ts
createRelayAction({
  relayUrl    ?: string,
  allowedApps ?: string[],
})
```

The action receives `{ path, token, body, appId? }` from the Zod-validated form data:

```tsx
export const useRelayAction = routeAction$(
  createRelayAction(),
  zod$({ path: z.string(), token: z.string(), body: z.any().optional() })
);
```

Returns `{ success: true, data }` on success, `{ success: false, status, error }` on failure.

---

### Client stores

All stores work in any Qwik component. Pass a `useStore()` result as `opts.store` for full Qwik fine-grained reactivity; omit it for a plain-JS object (works in tests and non-Qwik contexts).

#### `createByokRelayStore(opts)`

Token registration, key management, and logout.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `store` | `object` | internal | Pre-created `useStore()` result for Qwik reactivity |
| `relayUrl` | `string` | `'https://relay.byokrelay.com'` | Relay base URL |
| `appId` | `string` | `'qwik-app'` | App identifier |
| `storage` | `{ get, set, remove }` | localStorage / in-memory | Custom storage adapter |

**State:** `{ token, keys, loading, error }`

**Methods:** `init()`, `register()`, `storeKey(provider, apiKey)`, `refreshKeys()`, `deleteKey(provider)`, `rotateKey(provider, newKey)`, `logout()`

```tsx
const relayState = useStore({ token: null, keys: [], loading: false, error: null });
const relay      = createByokRelayStore({ store: relayState, relayUrl: '/relay' });
useVisibleTask$(async () => { await relay.init(); });
```

#### `createChatStore(opts)`

Stateful non-streaming chat.

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `model` | `string` | ✅ | `'provider/model'` or bare model name |
| `store` | `object` | — | Pre-created `useStore()` result |
| `relayUrl` | `string` | — | Relay base URL |
| `appId` | `string` | — | App identifier |
| `systemPrompt` | `string` | — | Prepended to every call |
| `extraParams` | `object` | — | Extra body params (`temperature`, `max_tokens`, …) |

**State:** `{ messages, loading, error }`

**Methods:** `sendMessage(userContent)`, `clearMessages()`

#### `createStreamingChatStore(opts)`

SSE streaming chat with AbortController.

Same options as `createChatStore`.

**State:** `{ messages, streamingContent, isStreaming, error }`

**Methods:** `sendMessage(userContent)`, `stopStreaming()`, `clearMessages()`

- `streamingContent` updates in real-time as chunks arrive
- On `stopStreaming()`, partial content is committed to `messages` with `[stopped]` suffix
- Triggers Qwik fine-grained re-renders when store is from `useStore()`

#### `createRelayHealthStore(opts)`

Polls `GET /health` and exposes relay status.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `store` | `object` | internal | Pre-created `useStore()` result |
| `relayUrl` | `string` | managed relay | Relay base URL |
| `intervalMs` | `number` | `30000` | Poll interval |

**State:** `{ status, lastCheck, details, error }` — `status` is `'ok' | 'degraded' | 'unknown'`

**Methods:** `check(deep?)`, `startPolling(intervalMs?)`, `stopPolling()`, `destroy()`

Call `destroy()` in a `useVisibleTask$` cleanup function to stop polling when the component unmounts:

```tsx
useVisibleTask$(({ cleanup }) => {
  health.startPolling();
  cleanup(() => health.destroy());
});
```

---

### `ByokRelayClient`

Plain-JS class for use inside `routeLoader$`, `routeAction$`, middleware, or browser scripts.

```ts
const client = new ByokRelayClient({
  relayUrl ?: string,   // default: managed relay
  appId    ?: string,   // default: 'qwik-app'
  storage  ?: { get(k): string|null, set(k, v): void, remove(k): void },
});
```

**Browser:** defaults to `localStorage`.  
**SSR / Node:** defaults to in-memory map.  
**Custom:** pass `storage` for cookie-session or server-side persistence.

| Method | Description |
|--------|-------------|
| `register()` | Register a new relay token (returns `{ token }`) |
| `ensureToken()` | Return stored token, registering first if needed |
| `logout()` | Clear stored token |
| `storeKey(provider, apiKey)` | Store AES-256-GCM encrypted API key |
| `listKeys()` | List stored provider keys |
| `deleteKey(provider)` | Delete a provider key |
| `rotateKey(provider, newKey)` | Atomic key rotation (validate → live-ping → replace) |
| `relayRequest(provider, path, body, extra?)` | Low-level relay forward |
| `chat(model, messages, extra?)` | Non-streaming unified chat |
| `streamChat(model, messages, extra?, signal?)` | Async generator — yields text chunks |
| `health(deep?)` | `GET /health[?deep=1]` |
| `deepHealth(provider?)` | `GET /health?deep=1[&provider=…]` |
| `stats(appId?)` | `GET /stats[/:appId]` |
| `getModels()` | `GET /models` |
| `deleteAccount()` | Full GDPR erasure (`DELETE /users`) |

#### Server Action example

```tsx
// src/routes/api/chat/index.tsx
import { routeAction$, zod$, z } from '@builder.io/qwik-city';
import { ByokRelayClient } from '@byok-relay/qwik';

export const useChatAction = routeAction$(
  async (data) => {
    const client = new ByokRelayClient({ relayUrl: process.env.RELAY_URL });
    // Use server-side token (from session cookie adapter)
    const result = await client.chat(data.model, data.messages);
    return { ok: true, content: result.choices[0].message.content };
  },
  zod$({
    model    : z.string(),
    messages : z.array(z.object({ role: z.string(), content: z.string() })),
  })
);
```

---

## Supported providers

| Provider | Model prefix | Example |
|----------|-------------|---------|
| OpenAI | `openai/` | `openai/gpt-4o-mini` |
| Anthropic | `anthropic/` | `anthropic/claude-haiku-4-5` |
| Google Gemini | `google/` | `google/gemini-1.5-flash` |
| Groq | `groq/` | `groq/llama3-70b-8192` |
| Mistral | `mistral/` | `mistral/mistral-small-latest` |
| OpenRouter | `openrouter/` | `openrouter/meta-llama/llama-3.1-8b-instruct` |

---

## Self-hosting

To use your own relay instead of the managed relay:

1. [Deploy byok-relay](https://github.com/avikalpg/byok-relay#quickstart-60-seconds) to Railway, Render, or your own server.
2. Set `RELAY_URL` in your Qwik City `.env`:
   ```
   RELAY_URL=https://your-relay.example.com
   ```
3. Use `/relay` (your Qwik City catch-all route) as `relayUrl` in client stores — the server reads `process.env.RELAY_URL`, so the upstream URL stays server-only.

---

## Related packages

| Package | Framework |
|---------|-----------|
| [`@byok-relay/react`](https://npmjs.com/package/@byok-relay/react) | React hooks |
| [`@byok-relay/vue`](https://npmjs.com/package/@byok-relay/vue) | Vue 3 composables |
| [`@byok-relay/svelte`](https://npmjs.com/package/@byok-relay/svelte) | Svelte stores |
| [`@byok-relay/solid`](https://npmjs.com/package/@byok-relay/solid) | SolidJS stores |
| [`@byok-relay/angular`](https://npmjs.com/package/@byok-relay/angular) | Angular services |
| [`@byok-relay/preact`](https://npmjs.com/package/@byok-relay/preact) | Preact hooks |
| [`@byok-relay/astro`](https://npmjs.com/package/@byok-relay/astro) | Astro SSR |
| [`@byok-relay/remix`](https://npmjs.com/package/@byok-relay/remix) | Remix / React Router v7 |
| [`@byok-relay/next`](https://npmjs.com/package/@byok-relay/next) | Next.js App Router |
| [`@byok-relay/hono`](https://npmjs.com/package/@byok-relay/hono) | Hono / CF Workers |
| [`@byok-relay/vercel-ai`](https://npmjs.com/package/@byok-relay/vercel-ai) | Vercel AI SDK |
| [`@byok-relay/mcp`](https://npmjs.com/package/@byok-relay/mcp) | MCP server (Claude Desktop) |
| [`@byok-relay/client`](https://npmjs.com/package/@byok-relay/client) | Vanilla JS |

---

## License

MIT

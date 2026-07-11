# @byok-relay/tanstack

TanStack Start API route factory, server function adapter, and React hooks for [byok-relay](https://byokrelay.com) BYOK AI.

`RELAY_URL` stays in `process.env` on the server — the browser only ever calls your own `/api/relay` TanStack Start API route.

```bash
npm install @byok-relay/tanstack
```

---

## Quick start — TanStack Start API route (recommended)

```ts
// app/routes/api/relay.$.ts
import { createAPIFileRoute }      from '@tanstack/start/api';
import { createByokRelayAPIRoute } from '@byok-relay/tanstack';

// RELAY_URL is read from process.env on the server — never in the browser bundle
export const APIRoute = createAPIFileRoute('/api/relay/$')({
  ...createByokRelayAPIRoute(),
});
```

```tsx
// Client component — streaming chat
import { useByokRelay, useStreamingChat } from '@byok-relay/tanstack';

export function ChatBox () {
  const { token, storeKey }                               = useByokRelay({ relayUrl: '/api/relay' });
  const { messages, streamingContent, sendMessage, stopStreaming } = useStreamingChat({
    relayUrl : '/api/relay',
    model    : 'openai/gpt-4o-mini',
    token,
  });

  return (
    <div>
      {messages.map((m, i) => <p key={i}><b>{m.role}:</b> {m.content}</p>)}
      {streamingContent && <p><b>assistant:</b> {streamingContent}</p>}
      <button onClick={() => sendMessage('Hello!')}>Send</button>
      <button onClick={stopStreaming}>Stop</button>
    </div>
  );
}
```

---

## Quick start — Server function adapter

```ts
// app/server/relay.ts
import { createServerFn }              from '@tanstack/react-start/server';
import { z }                           from 'zod';
import { createRelayServerFnHandler }  from '@byok-relay/tanstack';

export const relayFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      path       : z.string(),
      token      : z.string(),
      method     : z.string().optional(),
      body       : z.any().optional(),
      contentType: z.string().optional(),
    })
  )
  .handler(
    // RELAY_URL read from process.env.RELAY_URL — never reaches the client bundle
    createRelayServerFnHandler()
  );
```

```tsx
// Client component — use the typed server function
import { relayFn } from '~/server/relay';

async function sendChat (token: string, message: string) {
  return relayFn({
    data: {
      path  : 'relay',
      token,
      method: 'POST',
      body  : {
        model   : 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: message }],
      },
    },
  });
}
```

---

## API reference

### `createByokRelayAPIRoute(opts?)`

Returns a handler map for TanStack Start's `createAPIFileRoute`.

| Option | Type | Default | Description |
|---|---|---|---|
| `relayUrl` | `string` | `process.env.RELAY_URL` | Upstream relay URL. Prefers env var. |
| `allowedAppIds` | `string[]` | — | Optional app_id allowlist. Non-matching requests get 403. |
| `timeoutMs` | `number` | `30000` | Upstream fetch abort timeout. |

### `createRelayServerFnHandler(opts?)`

Returns an async handler for `createServerFn().handler()`.

| Option | Type | Default | Description |
|---|---|---|---|
| `relayUrl` | `string` | `process.env.RELAY_URL` | Upstream relay URL. |
| `timeoutMs` | `number` | `30000` | Abort timeout ms. |

**Input shape** (pass to `.validator(z.object(...))`):

| Field | Type | Description |
|---|---|---|
| `path` | `string` | Relay sub-path, e.g. `'relay'`, `'health'`. |
| `token` | `string` | User's relay token. |
| `method` | `string` | HTTP method (default `'POST'`). |
| `body` | `any` | Request body (auto-stringified if object). |
| `contentType` | `string` | `Content-Type` header (default `'application/json'`). |

---

### React hooks

#### `useByokRelay(opts)`

Token registration, key CRUD, and logout.

| Option | Type | Default |
|---|---|---|
| `relayUrl` | `string` | `'/api/relay'` |
| `appId` | `string` | `'tanstack-app'` |
| `storage` | `object` | `localStorage` |

Returns `{ token, keys, loading, error, register, ensureToken, storeKey, listKeys, deleteKey, rotateKey, logout }`.

#### `useChat(opts)`

Stateful non-streaming chat.

| Option | Type | Default |
|---|---|---|
| `relayUrl` | `string` | `'/api/relay'` |
| `model` | `string` | `'openai/gpt-4o-mini'` |
| `token` | `string` | — |
| `systemPrompt` | `string` | — |
| `extraParams` | `object` | — |

Returns `{ messages, loading, error, sendMessage(content, token?), clearMessages }`.

#### `useStreamingChat(opts)`

SSE streaming with `AbortController` cancellation.

| Option | Type | Default |
|---|---|---|
| `relayUrl` | `string` | `'/api/relay'` |
| `model` | `string` | `'openai/gpt-4o-mini'` |
| `token` | `string` | — |
| `systemPrompt` | `string` | — |
| `extraParams` | `object` | — |

Returns `{ messages, streamingContent, isStreaming, error, sendMessage, stopStreaming, clearMessages }`.

#### `useRelayHealth(opts)`

Polls `/health` and provides readiness checks.

| Option | Type | Default |
|---|---|---|
| `relayUrl` | `string` | `'/api/relay'` |
| `intervalMs` | `number` | — |

Returns `{ status, details, check(deep?), startPolling(ms?), stopPolling }`.

---

### `ByokRelayClient`

Framework-agnostic class. Safe in TanStack Start server functions, loaders, and browser scripts.

```ts
import { ByokRelayClient } from '@byok-relay/tanstack';

// Server function — picks up RELAY_URL from process.env automatically
const client = new ByokRelayClient();

// Browser — point at your own /api/relay proxy route
const client = new ByokRelayClient({ relayUrl: '/api/relay' });
```

| Method | Description |
|---|---|
| `register()` | Create a new user, store token. |
| `ensureToken()` | Return existing token or register. |
| `logout()` | Clear token from storage. |
| `storeKey(provider, apiKey)` | Encrypt and store an API key. |
| `listKeys()` | List stored provider keys. |
| `deleteKey(provider)` | Delete a provider key. |
| `rotateKey(provider, newApiKey)` | Atomic key rotation with live validation. |
| `relayRequest(path, opts)` | Low-level relay fetch. |
| `chat(opts)` | Non-streaming unified model chat. |
| `streamChat(opts)` | Async generator — yields text deltas. |
| `health(deep?)` | Liveness / readiness probe. |
| `stats(appId?)` | Per-user/app usage stats. |
| `getModels()` | List allowed models. |
| `deleteAccount()` | GDPR account erasure. |

#### Cookie-session storage (server functions)

```ts
// In a TanStack Start server function that has access to cookies
import { ByokRelayClient } from '@byok-relay/tanstack';
import { getCookie, setCookie, deleteCookie } from '@tanstack/react-start/server';

const client = new ByokRelayClient({
  storage: {
    getItem   : (k)    => getCookie(k) ?? null,
    setItem   : (k, v) => setCookie(k, v, { httpOnly: true, secure: true }),
    removeItem: (k)    => deleteCookie(k),
  },
});
```

---

## Supported providers

| Provider | Model prefix | Auth header |
|---|---|---|
| OpenAI | `openai/` | `Authorization: Bearer` |
| Anthropic | `anthropic/` | `x-api-key` |
| Google Gemini | `google/` | `x-goog-api-key` |
| Groq | `groq/` | `Authorization: Bearer` |
| Mistral | `mistral/` | `Authorization: Bearer` |
| OpenRouter | `openrouter/` | `Authorization: Bearer` |
| ElevenLabs | `elevenlabs/` | `xi-api-key` |
| Deepgram | `deepgram/` | `Token` |
| HuggingFace | `huggingface/` | `Authorization: Bearer` |

---

## Self-hosting

Point at your own relay instead of the managed one:

```ts
// app/routes/api/relay.$.ts
export const APIRoute = createAPIFileRoute('/api/relay/$')({
  ...createByokRelayAPIRoute({ relayUrl: process.env.RELAY_URL }),
});
```

Set `RELAY_URL=http://your-relay:3000` in your environment. The relay URL never reaches the browser.

See [byok-relay](https://github.com/avikalpg/byok-relay) for self-hosting docs.

---

## Related packages

| Package | Framework |
|---|---|
| [`@byok-relay/react`](https://www.npmjs.com/package/@byok-relay/react) | React (any bundler) |
| [`@byok-relay/next`](https://www.npmjs.com/package/@byok-relay/next) | Next.js App Router |
| [`@byok-relay/remix`](https://www.npmjs.com/package/@byok-relay/remix) | Remix / React Router v7 |
| [`@byok-relay/vue`](https://www.npmjs.com/package/@byok-relay/vue) | Vue 3 |
| [`@byok-relay/svelte`](https://www.npmjs.com/package/@byok-relay/svelte) | Svelte / SvelteKit |
| [`@byok-relay/solid`](https://www.npmjs.com/package/@byok-relay/solid) | SolidJS / SolidStart |
| [`@byok-relay/nuxt`](https://www.npmjs.com/package/@byok-relay/nuxt) | Nuxt 3 |
| [`@byok-relay/qwik`](https://www.npmjs.com/package/@byok-relay/qwik) | Qwik City |
| [`@byok-relay/astro`](https://www.npmjs.com/package/@byok-relay/astro) | Astro SSR |
| [`@byok-relay/hono`](https://www.npmjs.com/package/@byok-relay/hono) | Hono / Cloudflare Workers |
| [`@byok-relay/vercel-ai`](https://www.npmjs.com/package/@byok-relay/vercel-ai) | Vercel AI SDK |
| [`@byok-relay/mcp`](https://www.npmjs.com/package/@byok-relay/mcp) | Claude Desktop / Claude Code |
| [`@byok-relay/client`](https://www.npmjs.com/package/@byok-relay/client) | Vanilla JS / any framework |

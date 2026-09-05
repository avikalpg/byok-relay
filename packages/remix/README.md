# @byok-relay/remix

Remix v2 / React Router v7 integration for [byok-relay](https://byokrelay.com) — BYOK AI gateway.

```
npm install @byok-relay/remix
```

---

## Why?

Remix's loader/action pattern is the natural place to proxy relay calls server-side. This package gives you:

- **`createRelayLoader`** — Catch-all loader that proxies GET relay calls. `RELAY_URL` stays in `process.env`, never reaches the browser bundle.
- **`createRelayAction`** — Catch-all action that proxies POST/PUT/PATCH/DELETE relay calls.
- **React hooks** (`useByokRelay`, `useChat`, `useStreamingChat`, `useRelayHealth`) — Client-side hooks for Remix's hydration model. Identical API to `@byok-relay/react`.
- **`ByokRelayClient`** — Plain-JS class, works in both loaders (server) and browser `<script>` blocks.

---

## Quick start — Remix v2

### 1. Create a catch-all relay route

Create `app/routes/api.relay.$.tsx` (the `$` makes it a catch-all):

```tsx
// app/routes/api.relay.$.tsx
import { createRelayLoader, createRelayAction } from '@byok-relay/remix';

// RELAY_URL is a server-only env var — never shipped to the browser
export const loader = createRelayLoader({ relayUrl: process.env.RELAY_URL });
export const action = createRelayAction({ relayUrl: process.env.RELAY_URL });
```

That's it for the server side. Every `GET /api/relay/*` is proxied to your relay. Every `POST|PUT|PATCH|DELETE /api/relay/*` is proxied too.

### 2. Add the public relay URL to `window.ENV`

Expose the *public-facing* relay path to the browser via your root loader:

```tsx
// app/root.tsx
import { json } from '@remix-run/node';
import { useLoaderData } from '@remix-run/react';

export async function loader() {
  return json({
    ENV: { RELAY_URL: '/api/relay' },   // browser points to the catch-all route
  });
}

export default function App() {
  const { ENV } = useLoaderData<typeof loader>();
  return (
    <html>
      <head>...</head>
      <body>
        ...
        {/* Make ENV available to client scripts */}
        <script
          dangerouslySetInnerHTML={{
            __html: `window.ENV = ${JSON.stringify(ENV)}`,
          }}
        />
        ...
      </body>
    </html>
  );
}
```

### 3. Use the React hooks in your components

```tsx
// app/components/AiChat.tsx
import { useByokRelay, useStreamingChat } from '@byok-relay/remix';

export function AiChat() {
  const { token, loading: registering } = useByokRelay({
    relayUrl: '/api/relay',
    appId: 'my-app',
  });

  const { messages, streamingContent, send, stopStreaming, loading } =
    useStreamingChat({
      relayUrl: '/api/relay',
      token,
      provider: 'openai',
      model: 'gpt-4o-mini',
    });

  return (
    <div>
      {messages.map((m, i) => (
        <p key={i}><strong>{m.role}:</strong> {m.content}</p>
      ))}
      {streamingContent && <p><em>Assistant: {streamingContent}</em></p>}
      <button onClick={() => send('Hello!')} disabled={loading || registering}>
        Send
      </button>
      {loading && <button onClick={stopStreaming}>Stop</button>}
    </div>
  );
}
```

---

## Quick start — React Router v7 (framework mode)

React Router v7 uses the same loader/action pattern:

```tsx
// app/routes/api.relay.$.tsx
import type { Route } from './+types/api.relay.$';
import { createRelayLoader, createRelayAction } from '@byok-relay/remix';

export const loader = createRelayLoader({ relayUrl: process.env.RELAY_URL });
export const action = createRelayAction({ relayUrl: process.env.RELAY_URL });
```

---

## API reference

### `createRelayLoader(opts)` → `LoaderFunction`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `relayUrl` | `string` | managed relay | Upstream relay base URL (server-only). |
| `allowedApps` | `string[]` | — | Optional app_id allowlist; returns 403 if not matched. |

The catch-all param `$` maps to the relay sub-path:

```
GET /api/relay/health          →  relay GET /health
GET /api/relay/models          →  relay GET /models
GET /api/relay/stats           →  relay GET /stats
```

---

### `createRelayAction(opts)` → `ActionFunction`

Same options as `createRelayLoader`. Forwards POST, PUT, PATCH, DELETE with the original body and headers.

```
POST   /api/relay/users                →  relay POST /users
POST   /api/relay/keys/openai          →  relay POST /keys/openai
DELETE /api/relay/keys/openai          →  relay DELETE /keys/openai
POST   /api/relay/relay/openai/chat/completions  →  relay POST /relay/openai/chat/completions
```

---

### `useByokRelay(opts)`

Registers a user and manages key CRUD. Token is stored in `localStorage`.

| Option | Type | Default |
|--------|------|---------|
| `relayUrl` | `string` | managed relay |
| `appId` | `string` | `''` |

Returns:

| Property | Type | Description |
|----------|------|-------------|
| `token` | `string \| null` | Current relay token. |
| `loading` | `boolean` | Registration in progress. |
| `error` | `string \| null` | Last error message. |
| `storeKey(provider, apiKey)` | `async fn` | Store an API key. |
| `listKeys()` | `async fn` | List stored provider keys. |
| `deleteKey(provider)` | `async fn` | Remove a provider key. |
| `rotateKey(provider, newKey)` | `async fn` | Atomic key rotation. |
| `logout()` | `fn` | Remove token from localStorage. |

---

### `useChat(opts)`

Non-streaming chat with stateful message list.

| Option | Type | Default |
|--------|------|---------|
| `relayUrl` | `string` | managed relay |
| `token` | `string` | — |
| `provider` | `string` | `'openai'` |
| `model` | `string` | `'gpt-4o-mini'` |
| `systemPrompt` | `string` | — |
| `extraParams` | `object` | `{}` |

Returns `{ messages, send(text), clear(), loading, error }`.

---

### `useStreamingChat(opts)`

SSE streaming chat. Same options as `useChat`, plus:

Returns `{ messages, streamingContent, send(text), stopStreaming(), clear(), loading, error }`.

- `streamingContent` — live string of the current streaming response.
- `stopStreaming()` — abort the current stream; partial response is committed to `messages`.

---

### `useRelayHealth(opts)`

| Option | Type | Default |
|--------|------|---------|
| `relayUrl` | `string` | managed relay |
| `intervalMs` | `number` | `30000` (0 = no poll) |

Returns `{ status, checks, warnings, uptime, loading, error, refetch(), check(deep?) }`.

---

### `ByokRelayClient`

Plain-JS class, works in any environment.

```js
import { ByokRelayClient } from '@byok-relay/remix';

// In a Remix loader (server) — use private RELAY_URL
const serverClient = new ByokRelayClient({ relayUrl: process.env.RELAY_URL });

// In browser - use the same-origin relay route
const browserClient = new ByokRelayClient({ relayUrl: '/api/relay' });
```

| Method | Description |
|--------|-------------|
| `register(appId?)` | Register → persist token. |
| `ensureToken()` | Register only if no stored token. |
| `logout()` | Clear stored token. |
| `storeKey(provider, apiKey)` | Store an API key. |
| `listKeys()` | List stored keys. |
| `deleteKey(provider)` | Delete a stored key. |
| `rotateKey(provider, newKey)` | Atomic key rotation. |
| `chat(opts)` | Non-streaming chat request. |
| `streamChat(opts)` | Streaming chat with `onChunk`/`onDone` callbacks. |
| `health(deep?)` | GET /health[?deep=1]. |
| `stats(appId?)` | GET /stats[/:appId]. |
| `getModels()` | GET /models. |
| `deleteAccount()` | DELETE /users (GDPR erasure). |

---

## Supported providers

| Provider | `provider` value |
|----------|-----------------|
| OpenAI | `openai` |
| Anthropic | `anthropic` |
| Google Gemini | `google` |
| Groq | `groq` |
| Mistral | `mistral` |
| OpenRouter | `openrouter` |
| Any OpenAI-compat | `openai-compatible` |

---

## Self-hosting

Point `RELAY_URL` at your own relay instance:

```bash
# .env (server-only, never shipped to browser)
RELAY_URL=https://relay.yourcompany.com
```

See the [byok-relay self-hosting guide](https://github.com/avikalpg/byok-relay#self-hosting) for Railway, Render, and Docker deployment options.

---

## Related packages

| Package | Framework |
|---------|-----------|
| [`@byok-relay/react`](../react) | React (CRA, Vite, Next.js) |
| [`@byok-relay/vue`](../vue) | Vue 3 / Nuxt |
| [`@byok-relay/svelte`](../svelte) | Svelte / SvelteKit |
| [`@byok-relay/solid`](../solid) | SolidJS / SolidStart |
| [`@byok-relay/angular`](../angular) | Angular |
| [`@byok-relay/preact`](../preact) | Preact / Astro islands |
| [`@byok-relay/astro`](../astro) | Astro SSR |
| [`@byok-relay/vercel-ai`](../vercel-ai) | Vercel AI SDK |
| [`@byok-relay/mcp`](../mcp) | MCP (Claude Desktop / Claude Code) |
| [`@byok-relay/client`](../client) | Plain JS (framework-agnostic) |

---

If this package saved you time, consider ⭐ [starring the repo](https://github.com/avikalpg/byok-relay).

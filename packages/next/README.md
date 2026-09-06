# @byok-relay/next

Next.js App Router integration for [byok-relay](https://byokrelay.com) — BYOK AI for any frontend app.

Provides a **Route Handler factory**, **middleware factory**, **React hooks** for `'use client'` components, and a **plain-JS `ByokRelayClient`** for Server Components and Server Actions.

**Key security pattern:** `RELAY_URL` lives in `process.env` (server-only). The browser calls your own Next.js API route (`/api/relay/*`), which proxies server-to-server to the relay. The upstream relay URL never ships to the browser bundle.

```bash
npm install @byok-relay/next
```

---

## Quick Start (App Router)

### 1. Create the catch-all Route Handler

```js
// app/api/relay/[...path]/route.js
import { createRelayRouteHandler } from '@byok-relay/next';

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } =
  createRelayRouteHandler({
    relayUrl: process.env.RELAY_URL, // server-only — never in browser bundle
  });
```

Add to `.env.local`:
```
RELAY_URL=https://relay.byokrelay.com   # or your self-hosted relay
```

### 2. Use hooks in a Client Component

```jsx
// app/components/ChatBox.jsx
'use client';
import { useByokRelay, useStreamingChat } from '@byok-relay/next';

export function ChatBox () {
  const { token, registerUser } = useByokRelay({
    relayUrl: '/api/relay',  // your own Next.js API route
    appId: 'my-app',
  });
  const { messages, streamingContent, sendMessage, stopStreaming } =
    useStreamingChat({ relayUrl: '/api/relay', token, model: 'openai/gpt-4o' });

  return (
    <div>
      {!token && <button onClick={registerUser}>Connect</button>}
      {messages.map((m, i) => (
        <p key={i}><strong>{m.role}:</strong> {m.content}</p>
      ))}
      {streamingContent && <p><strong>assistant:</strong> {streamingContent}▍</p>}
      <button onClick={() => sendMessage('Hello!')}>Send</button>
      <button onClick={stopStreaming}>Stop</button>
    </div>
  );
}
```

---

## Route Handler Factory

```js
import { createRelayRouteHandler } from '@byok-relay/next';

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } =
  createRelayRouteHandler({
    relayUrl: process.env.RELAY_URL,   // required — upstream relay URL
    allowedApps: ['app-a', 'app-b'],  // optional app_id allowlist (403 otherwise)
    timeoutMs: 30_000,                 // optional upstream fetch timeout
  });
```

Place this file at `app/api/relay/[...path]/route.js` (or `.ts`).

The `[...path]` catch-all segment maps to the relay sub-path:
- `POST /api/relay/users` → relay `POST /users`
- `GET /api/relay/health` → relay `GET /health`
- `POST /api/relay/relay/openai/chat/completions` → relay `POST /relay/openai/chat/completions`

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `relayUrl` | string | `process.env.RELAY_URL` or managed relay | Upstream relay base URL |
| `allowedApps` | string[] | — | Optional app_id allowlist |
| `timeoutMs` | number | 30 000 | Upstream fetch timeout |

---

## Middleware Factory

For cases where you want to proxy relay calls through `middleware.js` instead of an API route (edge runtime, all routes).

```js
// middleware.js (project root)
import { createRelayMiddleware } from '@byok-relay/next';

export const middleware = createRelayMiddleware({
  relayUrl: process.env.RELAY_URL,
  pathPrefix: '/relay',   // intercept requests starting with /relay
});

export const config = { matcher: ['/relay/:path*'] };
```

> **Edge Runtime note:** `process.env.RELAY_URL` is available on Edge Runtime in Next.js ≥ 13.4 for env vars referenced in code. Set it in `.env.local` and add it to your Vercel project settings.

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `relayUrl` | string | `process.env.RELAY_URL` | Upstream relay base URL |
| `pathPrefix` | string | `/relay` | URL path prefix to intercept |
| `allowedApps` | string[] | — | Optional app_id allowlist |
| `timeoutMs` | number | 30 000 | Upstream fetch timeout |

---

## React Hooks

All hooks accept `relayUrl` pointing at your **own Next.js API route** (`/api/relay`), not the upstream relay. `RELAY_URL` stays server-only.

Mark components using hooks with `'use client'`.

### `useByokRelay(opts)`

Register a user and manage API keys.

```jsx
'use client';
import { useByokRelay } from '@byok-relay/next';

function ApiKeySettings () {
  const {
    token,
    loading,
    error,
    registerUser,
    storeKey,
    listKeys,
    deleteKey,
    rotateKey,
    logout,
  } = useByokRelay({ relayUrl: '/api/relay', appId: 'my-app' });

  const handleSave = async (provider, key) => {
    if (!token) await registerUser();
    await storeKey(provider, key);
  };

  return (/* ... */);
}
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `relayUrl` | string | `/api/relay` | Your Next.js API route prefix |
| `appId` | string | `next-app` | Application identifier |

Returns: `{ token, loading, error, registerUser, storeKey, listKeys, deleteKey, rotateKey, logout }`

### `useChat(opts)`

Stateful non-streaming chat.

```jsx
'use client';
import { useChat } from '@byok-relay/next';

function Chat ({ token }) {
  const { messages, sendMessage, clearMessages, loading, error } = useChat({
    relayUrl: '/api/relay',
    token,
    model: 'anthropic/claude-3-5-sonnet-20241022',
    systemPrompt: 'You are a helpful assistant.',
  });

  return (/* ... */);
}
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `relayUrl` | string | `/api/relay` | Next.js API route prefix |
| `token` | string | — | Relay token from `useByokRelay` |
| `model` | string | `openai/gpt-4o` | Provider/model string |
| `systemPrompt` | string | — | System prompt |
| `extraParams` | object | `{}` | Additional body params |

Returns: `{ messages, sendMessage, clearMessages, loading, error }`

### `useStreamingChat(opts)`

SSE streaming chat with `AbortController` cancel support.

```jsx
'use client';
import { useStreamingChat } from '@byok-relay/next';

function StreamingChat ({ token }) {
  const {
    messages,
    streamingContent,
    sendMessage,
    stopStreaming,
    clearMessages,
    loading,
    error,
  } = useStreamingChat({
    relayUrl: '/api/relay',
    token,
    model: 'openai/gpt-4o',
  });

  return (
    <div>
      {messages.map((m, i) => <p key={i}><b>{m.role}:</b> {m.content}</p>)}
      {streamingContent && <p><b>assistant:</b> {streamingContent}▍</p>}
      <button onClick={stopStreaming} disabled={!loading}>Stop</button>
    </div>
  );
}
```

Returns: `{ messages, streamingContent, sendMessage, stopStreaming, clearMessages, loading, error }`

### `useRelayHealth(opts)`

Poll the relay health endpoint.

```jsx
'use client';
import { useRelayHealth } from '@byok-relay/next';

function HealthBadge () {
  const { status, latencyMs, warnings, refetch } =
    useRelayHealth({ relayUrl: '/api/relay', intervalMs: 60_000 });

  return <span>{status === 'ok' ? '🟢' : '🔴'} {latencyMs}ms</span>;
}
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `relayUrl` | string | `/api/relay` | Next.js API route prefix |
| `intervalMs` | number | 60 000 | Auto-poll interval (0 = no auto-poll) |

Returns: `{ status, latencyMs, warnings, loading, error, refetch, check }`

---

## ByokRelayClient (Server Components / Server Actions)

Framework-agnostic class safe in Server Components, Server Actions, API Routes, and browser scripts. Accepts a custom `storage` adapter for server-side session stores.

### Usage in a Server Action

```js
// app/actions/relay.js
'use server';

import { ByokRelayClient } from '@byok-relay/next';
import { cookies } from 'next/headers';

function makeCookieStorage (cookieStore) {
  return {
    getItem: (k) => cookieStore.get(k)?.value ?? null,
    setItem: (k, v) => cookieStore.set(k, v, { httpOnly: true, secure: true }),
    removeItem: (k) => cookieStore.delete(k),
  };
}

export async function relayChat (messages) {
  const cookieStore = await cookies();
  const client = new ByokRelayClient({
    relayUrl: process.env.RELAY_URL,   // direct relay, server-only
    storage: makeCookieStorage(cookieStore),
  });
  const token = await client.ensureToken('my-app');
  return client.chat({ model: 'openai/gpt-4o', messages });
}
```

### Usage in a Server Component

```jsx
// app/page.jsx
import { ByokRelayClient } from '@byok-relay/next';

export default async function Page () {
  const client = new ByokRelayClient({ relayUrl: process.env.RELAY_URL });
  const health = await client.health();

  return <div>Relay status: {health.status}</div>;
}
```

### Usage in a Browser Script (e.g. Pages Router `_app.js`)

```js
import { ByokRelayClient } from '@byok-relay/next';

// Point at your own API route, not the upstream relay
const client = new ByokRelayClient({ relayUrl: '/api/relay' });
const token = await client.ensureToken('my-app');
await client.storeKey('openai', userProvidedKey);
```

### API Reference

| Method | Description |
|--------|-------------|
| `new ByokRelayClient({ relayUrl, storage })` | Create client |
| `register(appId?)` | Register new user, return token |
| `ensureToken(appId?)` | Return stored token or register |
| `logout(appId?)` | Clear token from storage |
| `storeKey(provider, apiKey)` | Store API key for provider |
| `listKeys()` | List stored provider names |
| `deleteKey(provider)` | Delete a provider key |
| `rotateKey(provider, newKey)` | Atomic key rotation with live validation |
| `chat({ model, messages, systemPrompt, ...rest })` | Non-streaming chat |
| `streamChat({ model, messages, systemPrompt, signal, ...rest })` | Async generator yielding text deltas |
| `health(deep?)` | GET /health — liveness/readiness probe |
| `stats(appId?)` | GET /stats — usage stats |
| `getModels()` | GET /models — allowed model list |
| `deleteAccount()` | DELETE /users — GDPR erasure |

---

## Supported Providers

| Provider | Model format | Example |
|----------|-------------|---------|
| OpenAI | `openai/<model>` | `openai/gpt-4o` |
| Anthropic | `anthropic/<model>` | `anthropic/claude-3-5-sonnet-20241022` |
| Google Gemini | `google/<model>` | `google/gemini-1.5-pro` |
| Groq | `groq/<model>` | `groq/llama-3.1-70b-versatile` |
| Mistral | `mistral/<model>` | `mistral/mistral-large-latest` |
| OpenRouter | `openrouter/<model>` | `openrouter/meta-llama/llama-3-70b` |
| HuggingFace | `huggingface/<model>` | `huggingface/mistralai/Mistral-7B` |
| ElevenLabs | `elevenlabs/<path>` | `elevenlabs/v1/text-to-speech/voice-id` |
| Deepgram | `deepgram/<path>` | `deepgram/v1/listen` |
| Any OpenAI-compatible | `openai-compatible/<url>` | custom endpoints |

---

## Self-Hosting

Point `RELAY_URL` at your self-hosted relay:

```env
RELAY_URL=https://relay.your-domain.com
```

See the [byok-relay README](https://github.com/avikalpg/byok-relay) for self-hosting options (Docker, Railway, Render, npm).

---

## Related Packages

| Package | Description |
|---------|-------------|
| [`@byok-relay/client`](https://npmjs.com/package/@byok-relay/client) | Vanilla JS client (any framework) |
| [`@byok-relay/react`](https://npmjs.com/package/@byok-relay/react) | React hooks (Vite, CRA, without Next.js) |
| [`@byok-relay/remix`](https://npmjs.com/package/@byok-relay/remix) | Remix v2 / React Router v7 |
| [`@byok-relay/astro`](https://npmjs.com/package/@byok-relay/astro) | Astro SSR middleware + API routes |
| [`@byok-relay/vue`](https://npmjs.com/package/@byok-relay/vue) | Vue 3 composables |
| [`@byok-relay/svelte`](https://npmjs.com/package/@byok-relay/svelte) | Svelte stores |
| [`@byok-relay/solid`](https://npmjs.com/package/@byok-relay/solid) | SolidJS stores |
| [`@byok-relay/angular`](https://npmjs.com/package/@byok-relay/angular) | Angular injectable services |
| [`@byok-relay/vercel-ai`](https://npmjs.com/package/@byok-relay/vercel-ai) | Vercel AI SDK custom provider |
| [`@byok-relay/hono`](https://npmjs.com/package/@byok-relay/hono) | Hono middleware (Cloudflare Workers, Deno, Bun) |
| [`@byok-relay/mcp`](https://npmjs.com/package/@byok-relay/mcp) | MCP server (Claude Desktop, Claude Code) |

---

If this package saved you time, consider ⭐ [starring byok-relay](https://github.com/avikalpg/byok-relay) on GitHub.

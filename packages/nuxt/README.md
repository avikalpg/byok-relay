# @byok-relay/nuxt

Nuxt 3 module, H3 server route factory, and Vue composables for [byok-relay](https://byokrelay.com) BYOK AI.

Keep `RELAY_URL` in process.env (Nitro server-only). The browser calls your own Nuxt server route; your route proxies to the upstream relay.

---

## Install

```bash
npm install @byok-relay/nuxt
```

---

## Quick start — Nuxt 3 server route

**1. Create a catch-all server route** `server/routes/relay/[...].js`:

```js
import { createRelayServerRoute } from '@byok-relay/nuxt'

export default createRelayServerRoute({
  // RELAY_URL is read from process.env automatically if omitted
  allowedAppIds: ['my-nuxt-app'],  // optional
})
```

**2. Set your env vars** (`.env`):

```bash
RELAY_URL=https://relay.byokrelay.com   # or self-hosted URL
```

**3. Use in a `<script setup>` component**:

```vue
<script setup>
import { useByokRelay, useStreamingChat } from '@byok-relay/nuxt'

// Points at your own Nuxt server route — RELAY_URL never reaches the browser
const { token, storeKey, providers } = useByokRelay({ relayUrl: '/relay' })
const { messages, streamingContent, sendMessage, stopStreaming } = useStreamingChat({
  relayUrl : '/relay',
  model    : 'openai/gpt-4o',
})

async function saveKey() {
  await storeKey('openai', apiKey.value)
}
</script>

<template>
  <div v-for="msg in messages" :key="msg.role + msg.content">
    <strong>{{ msg.role }}:</strong> {{ msg.content }}
  </div>
  <p v-if="streamingContent">{{ streamingContent }}</p>
  <button @click="sendMessage(input)">Send</button>
  <button @click="stopStreaming">Stop</button>
</template>
```

---

## Nuxt module (auto-registers /relay route)

Add to `nuxt.config.ts`:

```ts
import { defineByokRelayModule } from '@byok-relay/nuxt'

export default defineNuxtConfig({
  modules: [
    defineByokRelayModule({
      relayUrl      : process.env.RELAY_URL,  // server-only, never in browser bundle
      publicRelayUrl: '/relay',               // exposed to browser as $config.public.relayUrl
    }),
  ],
  runtimeConfig: {
    relayUrl: process.env.RELAY_URL,          // server-only
    public: {
      relayUrl: '/relay',                     // browser-safe proxy URL
    },
  },
})
```

Then in components, read via `useRuntimeConfig()`:

```vue
<script setup>
const config = useRuntimeConfig()
const { token, storeKey } = useByokRelay({ relayUrl: config.public.relayUrl })
</script>
```

---

## ByokRelayClient (plain-JS class)

Use in server routes, plugins, `useAsyncData`, or browser scripts.

```ts
import { ByokRelayClient } from '@byok-relay/nuxt'

// In a Nuxt server route (server/api/init.ts):
const client = new ByokRelayClient({
  relayUrl: process.env.RELAY_URL,
  appId   : 'my-app',
  // Custom storage for cookie-based sessions:
  storage: {
    getItem    : (k)    => event.node.req.cookies?.[k] ?? null,
    setItem    : (k, v) => setCookie(event, k, v, { httpOnly: true }),
    removeItem : (k)    => deleteCookie(event, k),
  },
})

const token = await client.ensureToken()
await client.storeKey('openai', 'sk-your-key')
const res   = await client.chat(messages, { model: 'openai/gpt-4o' })
```

### ByokRelayClient API

| Method | Description |
|--------|-------------|
| `register(appId?)` | Register new token. Returns token string. |
| `ensureToken(appId?)` | Return cached token or register. |
| `logout()` | Clear token from storage. |
| `deleteAccount()` | Delete account + all keys server-side. Clears token. |
| `storeKey(provider, apiKey)` | Store encrypted API key. |
| `listKeys()` | List stored provider keys. |
| `deleteKey(provider)` | Delete a provider key. |
| `rotateKey(provider, newApiKey)` | Atomic key rotation with live provider ping. |
| `relayRequest(provider, path, body, method?)` | Low-level relay call. |
| `chat(messages, opts)` | Unified chat (non-streaming). |
| `streamChat(messages, opts, onChunk?, onDone?)` | Async generator — yields text deltas. |
| `health(deep?)` | Liveness / readiness probe. |
| `stats(appId?)` | Usage stats per user or app. |
| `getModels()` | List allowed models. |

---

## Composable API

### `useByokRelay(opts?)`

Token registration + key CRUD + logout.

| Option | Type | Description |
|--------|------|-------------|
| `relayUrl` | `string` | Defaults to `/relay` or `process.env.RELAY_URL`. |
| `appId` | `string` | Your app identifier. |
| `storage` | `object` | Custom `{ getItem, setItem, removeItem }`. |

**Returns:** `{ token, loading, error, providers, register, ensureToken, storeKey, listKeys, deleteKey, rotateKey, logout }`

---

### `useChat(opts?)`

Stateful non-streaming chat.

| Option | Type | Description |
|--------|------|-------------|
| `relayUrl` | `string` | |
| `model` | `string` | e.g. `'openai/gpt-4o'` or `'claude-3-5-sonnet'` |
| `systemPrompt` | `string` | Prepended system message. |
| `extraParams` | `object` | Extra fields merged into request body. |

**Returns:** `{ messages, loading, error, sendMessage(content, opts?), clearMessages() }`

---

### `useStreamingChat(opts?)`

SSE streaming chat with AbortController. Cleans up on `onUnmounted`.

| Option | Type | Description |
|--------|------|-------------|
| `relayUrl` | `string` | |
| `model` | `string` | |
| `systemPrompt` | `string` | |
| `extraParams` | `object` | |

**Returns:** `{ messages, streamingContent, loading, error, sendMessage(content, opts?), stopStreaming(), clearMessages() }`

- `streamingContent` — live accumulation of the current stream
- `stopStreaming()` — aborts the current request; partial content committed with `[stopped]` suffix

---

### `useRelayHealth(opts?)`

Health polling composable.

| Option | Type | Description |
|--------|------|-------------|
| `relayUrl` | `string` | |
| `intervalMs` | `number` | Start auto-polling at interval. Default: no auto-poll. |

**Returns:** `{ status, data, loading, error, check(deep?), startPolling(ms), stopPolling(), destroy() }`

- `status` — `'ok' | 'degraded' | 'unknown'`
- `check(true)` — deep readiness probe (pings upstream provider)
- Call `destroy()` in `onUnmounted()` if you use `startPolling`

---

### `createRelayServerRoute(opts?)`

H3 event handler for `server/routes/relay/[...].js`.

| Option | Type | Description |
|--------|------|-------------|
| `relayUrl` | `string` | Default: `process.env.RELAY_URL` |
| `allowedAppIds` | `string[]` | Optional app_id whitelist |
| `timeoutMs` | `number` | Upstream timeout ms (default 30000) |

**Placement:** `server/routes/relay/[...].js` — Nuxt maps this to `/relay/*`.

---

### `defineByokRelayModule(opts?)`

Nuxt module factory. Registers the server route and injects `runtimeConfig.public.relayUrl`.

| Option | Type | Description |
|--------|------|-------------|
| `relayUrl` | `string` | Server-only upstream relay URL |
| `publicRelayUrl` | `string` | Browser-safe URL (default `/relay`) |
| `allowedAppIds` | `string[]` | Forwarded to server route |

---

## Supported providers

| Provider | Model format |
|----------|-------------|
| OpenAI | `openai/gpt-4o`, `gpt-4o` |
| Anthropic | `anthropic/claude-3-5-sonnet` |
| Groq | `groq/llama-3.1-70b` |
| Mistral | `mistral/mistral-large` |
| OpenRouter | `openrouter/anthropic/claude-3.5-sonnet` |
| + any `openai-compatible` | `openai-compatible/...` |

---

## Key differentiator vs `@byok-relay/vue`

`@byok-relay/vue` ships composables for client-only Vue apps. `@byok-relay/nuxt` adds:

- `createRelayServerRoute` — H3 handler keeps `RELAY_URL` in `process.env` (never in browser bundle)
- `defineByokRelayModule` — zero-config Nuxt module auto-registration
- `ByokRelayClient` safe in Nitro server routes, plugins, and `useAsyncData()`
- `useRuntimeConfig()` integration for `publicRelayUrl`

---

## Self-hosting

```bash
npx byok-relay   # or: docker compose up
```

Set `RELAY_URL=http://localhost:3000` in your `.env`. See [byokrelay.com](https://byokrelay.com) for full setup.

---

## Related packages

| Package | Target |
|---------|--------|
| [`@byok-relay/react`](https://www.npmjs.com/package/@byok-relay/react) | React hooks |
| [`@byok-relay/vue`](https://www.npmjs.com/package/@byok-relay/vue) | Vue 3 composables (client-only) |
| [`@byok-relay/svelte`](https://www.npmjs.com/package/@byok-relay/svelte) | Svelte stores |
| [`@byok-relay/solid`](https://www.npmjs.com/package/@byok-relay/solid) | SolidJS stores |
| [`@byok-relay/next`](https://www.npmjs.com/package/@byok-relay/next) | Next.js App Router |
| [`@byok-relay/hono`](https://www.npmjs.com/package/@byok-relay/hono) | Hono / Cloudflare Workers |
| [`@byok-relay/astro`](https://www.npmjs.com/package/@byok-relay/astro) | Astro SSR |
| [`@byok-relay/remix`](https://www.npmjs.com/package/@byok-relay/remix) | Remix / React Router v7 |
| [`@byok-relay/qwik`](https://www.npmjs.com/package/@byok-relay/qwik) | Qwik City |
| [`@byok-relay/mcp`](https://www.npmjs.com/package/@byok-relay/mcp) | Claude Desktop / MCP |
| [`@byok-relay/client`](https://www.npmjs.com/package/@byok-relay/client) | Framework-agnostic |

---

If this saved you time, consider ⭐ [starring the repo](https://github.com/avikalpg/byok-relay).

# @byok-relay/hono

> Hono middleware and route factory for [byok-relay](https://byokrelay.com) — Cloudflare Workers, Deno Deploy, Bun, Node.js.

Add BYOK AI relay support to any [Hono](https://hono.dev) application with two lines. Works on every edge runtime Hono supports.

```bash
npm install @byok-relay/hono
```

---

## Why Hono + byok-relay?

Hono runs on Cloudflare Workers, Deno Deploy, Bun, and Node.js — all environments where you want to keep your relay URL and credentials **server-side only**. `@byok-relay/hono` proxies requests from the browser to the upstream relay through your Hono app, so `RELAY_URL` never ships to the client bundle.

---

## Quick start — Cloudflare Workers

```typescript
// src/worker.ts
import { Hono } from 'hono';
import { createByokRelayMiddleware } from '@byok-relay/hono';

const app = new Hono<{ Bindings: { RELAY_URL: string } }>();

// Mount the proxy middleware — reads RELAY_URL from c.env (Workers binding)
app.use('/relay/*', createByokRelayMiddleware());

app.get('/', (c) => c.text('Hello from Hono + byok-relay!'));

export default app;
```

**wrangler.toml** — set the binding:
```toml
name = "my-worker"
main = "src/worker.ts"

[vars]
RELAY_URL = "https://relay.byokrelay.com"   # or your self-hosted relay
```

The browser-side code only ever talks to your Worker at `/relay/*`. The real upstream relay URL stays in `[vars]` (or a Secret for production).

---

## Quick start — Bun / Node.js

```typescript
import { Hono } from 'hono';
import { serve } from '@hono/node-server';  // or Bun's native serve
import { createRelayRoute } from '@byok-relay/hono';

const app = new Hono();

// Explicit catch-all route — forward /api/relay/* to the upstream relay
app.all('/api/relay/*', createRelayRoute({ relayUrl: process.env.RELAY_URL }));
app.all('/api/relay',   createRelayRoute({ relayUrl: process.env.RELAY_URL }));

serve(app);
```

---

## API reference

### `createByokRelayMiddleware(opts?)`

Returns a Hono `MiddlewareHandler` that intercepts any request whose path starts with `pathPrefix` and proxies it to the upstream relay.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `relayUrl` | `string` | `c.env.RELAY_URL` → managed relay | Upstream relay URL. Falls back to the Hono context env binding, then the public managed relay. |
| `pathPrefix` | `string` | `'/relay'` | Path prefix to intercept on this app. |
| `allowedAppIds` | `string[]` | — | If set, requests with an `x-app-id` header not in this list get a 403. |

```typescript
app.use('/relay/*', createByokRelayMiddleware({
  relayUrl: 'http://localhost:3000',    // explicit override
  pathPrefix: '/relay',
  allowedAppIds: ['my-app'],
}));
```

---

### `createRelayRoute(opts?)`

Returns a Hono `Handler` for use on a named catch-all route. Useful when you want explicit route registration rather than middleware.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `relayUrl` | `string` | `c.env.RELAY_URL` → managed relay | Upstream relay URL. |
| `allowedAppIds` | `string[]` | — | Optional app_id allowlist (checked via `x-app-id` header). |

```typescript
// Register both the prefix and the wildcard variant
app.all('/relay/*', createRelayRoute({ relayUrl: process.env.RELAY_URL }));
app.all('/relay',   createRelayRoute({ relayUrl: process.env.RELAY_URL }));
```

---

### `ByokRelayClient`

Plain-JS class for server-side usage (Hono route handlers, scheduled Workers, Deno scripts). Uses in-memory storage on edge runtimes (no `localStorage`). Pass `storage` to provide your own persistence (e.g. KV store on Cloudflare Workers).

```typescript
import { ByokRelayClient } from '@byok-relay/hono';

const relay = new ByokRelayClient({
  relayUrl: env.RELAY_URL,
  appId: 'my-worker',
  // Optional: custom storage for Workers KV persistence
  storage: {
    get:    async (k) => await env.KV.get(k),
    set:    async (k, v) => await env.KV.put(k, v),
    remove: async (k) => await env.KV.delete(k),
  },
});
```

#### Constructor options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `relayUrl` | `string` | managed relay | Upstream relay URL. |
| `appId` | `string` | `'default'` | Application identifier for registration and storage key namespacing. |
| `storage` | `{get,set,remove}` | in-memory | Custom storage adapter. |

#### Methods

| Method | Description |
|--------|-------------|
| `register(appId?, force?)` | Register a new user; returns `{token, expires_at}`. Short-circuits if token already cached (use `force=true` to re-register). |
| `ensureToken()` | Get the cached token or register on first call. |
| `logout()` | Clear the cached token. |
| `storeKey(provider, apiKey)` | Store an encrypted API key for a provider. |
| `listKeys()` | List stored provider names. |
| `deleteKey(provider)` | Delete a provider's key. |
| `rotateKey(provider, newKey)` | Atomic key rotation: verify new key → update stored key. |
| `relayRequest(provider, path, body?, method?)` | Low-level relay call to a specific provider path. |
| `chat(model, messages, extra?)` | Unified chat via unified routing (`POST /relay`). |
| `streamChat(model, messages, extra?, signal?)` | Streaming chat — returns an async generator yielding text chunks. |
| `health(deep?)` | Health check; `deep=true` pings upstream providers. |
| `stats(appId?)` | Usage statistics for this token. |
| `getModels()` | List available models from unified routing. |
| `deleteAccount()` | GDPR erasure — delete account and all keys. |

---

## Cloudflare Workers — streaming chat in a Worker

```typescript
import { Hono } from 'hono';
import { ByokRelayClient } from '@byok-relay/hono';

const app = new Hono<{ Bindings: { RELAY_URL: string } }>();

app.post('/chat', async (c) => {
  const { model, messages, token } = await c.req.json();

  const relay = new ByokRelayClient({ relayUrl: c.env.RELAY_URL });
  relay._token = token; // inject user's relay token directly

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Stream chunks back to the browser
  (async () => {
    for await (const chunk of relay.streamChat(model, messages)) {
      await writer.write(encoder.encode(`data: ${JSON.stringify({ content: chunk })}\n\n`));
    }
    await writer.close();
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
});

app.use('/relay/*', createByokRelayMiddleware());

export default app;
```

---

## Deno Deploy

```typescript
import { Hono } from 'npm:hono';
import { createByokRelayMiddleware } from 'npm:@byok-relay/hono';

const app = new Hono();
app.use('/relay/*', createByokRelayMiddleware({
  relayUrl: Deno.env.get('RELAY_URL'),
}));

Deno.serve(app.fetch);
```

---

## Supported providers

| Provider | Model example | Auth |
|----------|---------------|------|
| OpenAI | `gpt-4o`, `gpt-4o-mini` | `sk-...` |
| Anthropic | `claude-3-5-sonnet`, `anthropic/claude-3-haiku` | `sk-ant-...` |
| Google Gemini | `gemini-2.0-flash` | `AI...` |
| Groq | `llama-3.1-70b` | `gsk_...` |
| Mistral | `mistral-large` | `...` |
| OpenRouter | `openrouter/...` | `sk-or-...` |
| Any OpenAI-compatible | via `openai-compatible` provider | varies |

---

## Self-hosting note

`RELAY_URL` defaults to the public managed relay (`https://relay.byokrelay.com`) which is fine for development. For production, [self-host byok-relay](https://github.com/avikalpg/byok-relay) on Railway, Render, or your own server and set `RELAY_URL` to your instance.

---

## Related packages

| Package | Use case |
|---------|----------|
| [`@byok-relay/react`](https://www.npmjs.com/package/@byok-relay/react) | React hooks |
| [`@byok-relay/vue`](https://www.npmjs.com/package/@byok-relay/vue) | Vue 3 composables |
| [`@byok-relay/svelte`](https://www.npmjs.com/package/@byok-relay/svelte) | Svelte stores |
| [`@byok-relay/solid`](https://www.npmjs.com/package/@byok-relay/solid) | SolidJS stores |
| [`@byok-relay/astro`](https://www.npmjs.com/package/@byok-relay/astro) | Astro SSR middleware |
| [`@byok-relay/remix`](https://www.npmjs.com/package/@byok-relay/remix) | Remix / React Router v7 |
| [`@byok-relay/vercel-ai`](https://www.npmjs.com/package/@byok-relay/vercel-ai) | Vercel AI SDK adapter |
| [`@byok-relay/mcp`](https://www.npmjs.com/package/@byok-relay/mcp) | Claude Desktop / MCP server |
| [`@byok-relay/client`](https://www.npmjs.com/package/@byok-relay/client) | Vanilla JS client |

---

If this package saved you time, consider ⭐ [starring the repo](https://github.com/avikalpg/byok-relay).

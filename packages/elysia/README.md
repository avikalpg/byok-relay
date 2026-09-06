# @byok-relay/elysia

> Elysia plugin and route factory for [byok-relay](https://byokrelay.com) — proxy AI provider requests server-side while users bring their own API keys.

[![npm](https://img.shields.io/npm/v/@byok-relay/elysia)](https://www.npmjs.com/package/@byok-relay/elysia)
[![license](https://img.shields.io/npm/l/@byok-relay/elysia)](../../LICENSE)

Works on **Bun 1.0+** (native, recommended) and **Node.js 18+** running Elysia 1.x.

---

## What this does

Your users bring their own AI API keys (OpenAI, Anthropic, Groq, …). Those keys must never appear in frontend JavaScript. This package gives you two ways to proxy AI requests through your Elysia server so `RELAY_URL` stays in `Bun.env`/`process.env` only:

| Export | Use when |
|--------|----------|
| `byokRelayPlugin(opts?)` | You want a drop-in `app.use(...)` plugin with zero boilerplate |
| `createRelayRouteHandler(opts?)` | You want full control over route definition / grouping |
| `ByokRelayClient` | Server-side scripts, lifecycle hooks, and health checks in Bun |

---

## Install

```bash
bun add @byok-relay/elysia elysia
# or
npm install @byok-relay/elysia elysia
```

---

## Quick start — plugin (recommended)

```js
// server.js (Bun or Node.js)
const { Elysia } = require('elysia');
const { byokRelayPlugin } = require('@byok-relay/elysia');

const app = new Elysia()
  .use(byokRelayPlugin({
    relayUrl: Bun.env.RELAY_URL,  // stays server-only
  }))
  .get('/', () => 'Hello from Elysia + BYOK relay!')
  .listen(3000);

console.log(`Server running at http://localhost:3000`);
```

Now `POST http://localhost:3000/relay/*` proxies to the upstream byok-relay. The browser calls your server; your server forwards to the relay. `RELAY_URL` never leaks.

---

## Quick start — standalone route handler

For explicit route registration with guards or custom prefixes:

```js
const { Elysia } = require('elysia');
const { createRelayRouteHandler } = require('@byok-relay/elysia');

const handler = createRelayRouteHandler({
  relayUrl:      Bun.env.RELAY_URL,
  allowedAppIds: ['my-app'],       // optional allowlist
  timeoutMs:     30_000,           // default
});

const app = new Elysia()
  .all('/relay/*', handler)
  .listen(3000);
```

---

## Plugin options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `relayUrl` | `string` | `Bun.env.RELAY_URL` → managed relay | Upstream byok-relay URL |
| `pathPrefix` | `string` | `'/relay'` | Mount prefix for the catch-all route |
| `allowedAppIds` | `string[]` | `undefined` (all allowed) | Optional app_id allowlist; returns 403 on mismatch |
| `timeoutMs` | `number` | `30000` | Upstream fetch timeout (ms); returns 504 on expiry |

---

## Streaming (SSE)

The plugin returns a native `Response` with the upstream `ReadableStream` piped directly. Elysia + Bun handle SSE natively with no extra configuration:

```js
// Browser (React / vanilla JS)
const es = new EventSource('/relay/relay?stream=true');
es.onmessage = (e) => {
  if (e.data === '[DONE]') return es.close();
  const chunk = JSON.parse(e.data);
  console.log(chunk.choices[0]?.delta?.content);
};

// Or use fetch with ReadableStream
const res = await fetch('/relay/relay', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({ model: 'openai/gpt-4o', messages, stream: true }),
});
for await (const chunk of res.body) { /* ... */ }
```

---

## ByokRelayClient

Plain-JS class for server-side usage in Bun scripts, Elysia lifecycle hooks, and `onStart`/`onStop` handlers. In-memory storage on Bun/Node; `localStorage` when bundled for the browser; custom storage adapter supported.

```js
const { ByokRelayClient } = require('@byok-relay/elysia');

// Used in an Elysia lifecycle hook
const client = new ByokRelayClient({ relayUrl: Bun.env.RELAY_URL });

const app = new Elysia()
  .onStart(async () => {
    const health = await client.health(true);
    console.log('Relay health:', health);
  })
  .use(byokRelayPlugin())
  .listen(3000);
```

### API

| Method | Description |
|--------|-------------|
| `register({ appId? })` | Register a new user, receive a relay token |
| `ensureToken()` | Returns existing token or calls `register()` |
| `logout()` | Clear stored token |
| `storeKey(provider, apiKey)` | Store an encrypted API key |
| `listKeys()` | List stored provider keys |
| `deleteKey(provider)` | Delete a provider key |
| `rotateKey(provider, newKey)` | Atomically rotate a key (live-validates first) |
| `relayRequest(path, init?)` | Low-level authenticated fetch to the relay |
| `chat({ model, messages, systemPrompt?, ...})` | Non-streaming chat (returns message content) |
| `streamChat({ model, messages, systemPrompt?, signal? })` | Async generator yielding text chunks |
| `health(deep?)` | Relay liveness (`/health`) or readiness (`/health?deep=1`) |
| `stats(appId?)` | Usage stats from `GET /stats` |
| `getModels()` | Model allowlist from `GET /models` |
| `deleteAccount()` | Delete account + all keys (GDPR erasure) |

### Custom storage adapter

Replace in-memory storage with anything that has `getItem / setItem / removeItem`:

```js
// Example: Bun's SQLite or a custom KV store
const adapter = {
  getItem:    (k) => myKV.get(k),
  setItem:    (k, v) => myKV.set(k, v),
  removeItem: (k) => myKV.delete(k),
};

const client = new ByokRelayClient({
  relayUrl: Bun.env.RELAY_URL,
  storage:  adapter,
});
```

---

## Supported providers

| Provider | Key format | Model prefix |
|----------|-----------|--------------|
| OpenAI | `sk-...` | `openai/` |
| Anthropic | `sk-ant-...` | `anthropic/` |
| Groq | `gsk_...` | `groq/` |
| Mistral | `...` | `mistral/` |
| OpenRouter | `sk-or-...` | `openrouter/` |
| Google AI | `AI...` | `google/` |
| ElevenLabs | `sk_...` | `elevenlabs/` |
| Deepgram | `...` | `deepgram/` |
| HuggingFace | `hf_...` | `huggingface/` |

---

## Self-hosting

```bash
git clone https://github.com/avikalpg/byok-relay.git
cd byok-relay
bun install    # or npm install
bun run start  # RELAY_URL=http://localhost:3000 in your Elysia app
```

Or use the managed relay at `https://relay.byokrelay.com` (no setup required for development).

---

## Related packages

| Package | Framework |
|---------|-----------|
| [`@byok-relay/react`](../react) | React hooks |
| [`@byok-relay/vue`](../vue) | Vue 3 composables |
| [`@byok-relay/svelte`](../svelte) | Svelte stores |
| [`@byok-relay/hono`](../hono) | Hono / Cloudflare Workers |
| [`@byok-relay/express`](../express) | Express middleware |
| [`@byok-relay/fastify`](../fastify) | Fastify plugin |
| [`@byok-relay/next`](../next) | Next.js App Router |
| [`@byok-relay/mcp`](../mcp) | MCP server for Claude Desktop |
| [`@byok-relay/client`](../client) | Framework-agnostic JS client |

---

[Full docs & self-hosting guide →](https://byokrelay.com) · [GitHub →](https://github.com/avikalpg/byok-relay)

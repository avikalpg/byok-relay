# @byok-relay/koa

> Koa middleware and router factory for [byok-relay](https://byokrelay.com) — proxy AI provider requests server-side while your users bring their own API keys.

[![npm](https://img.shields.io/npm/v/@byok-relay/koa)](https://www.npmjs.com/package/@byok-relay/koa)
[![byok-relay](https://img.shields.io/badge/byok-relay-powered-blue)](https://byokrelay.com)

## Why

Koa apps can't embed AI API calls in the browser — the keys would be exposed. `@byok-relay/koa` puts a lightweight proxy in your Koa server so:

- `RELAY_URL` stays in `process.env` (server-only, never in the browser bundle)
- The browser only calls your `/relay` route — never the AI provider directly
- Each user's API key is stored **encrypted at rest** on the relay — your app never touches it

## Install

```bash
npm install @byok-relay/koa
```

Peer deps (optional — only needed for the specific feature you use):

```bash
npm install koa        # for the middleware
npm install @koa/router # for createRelayRouter
```

## Quick start — Koa middleware

```js
// server.js
const Koa = require('koa');
const { createByokRelayMiddleware } = require('@byok-relay/koa');

const app = new Koa();

// RELAY_URL comes from process.env — browser never sees it
app.use(createByokRelayMiddleware({
  pathPrefix: '/relay',   // default
  timeoutMs:  30_000,     // default
}));

// Your other routes
app.use(async ctx => {
  ctx.body = 'Hello from Koa!';
});

app.listen(3000);
```

Browser side:

```js
import { ByokRelayClient } from '@byok-relay/koa';

const client = new ByokRelayClient({ relayUrl: '/relay' });
await client.register('my-app');
await client.storeKey('openai', 'sk-...');

const resp = await client.chat({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(resp.choices[0].message.content);
```

## Quick start — @koa/router

```js
const Koa = require('koa');
const { createRelayRouter } = require('@byok-relay/koa');

const app = new Koa();

const relayRouter = createRelayRouter({
  pathPrefix:    '/relay',                // default
  relayUrl:      process.env.RELAY_URL,   // optional — reads env automatically
  allowedAppIds: ['my-app', 'other-app'], // optional allowlist
  timeoutMs:     30_000,                  // default
});

app.use(relayRouter.routes());
app.use(relayRouter.allowedMethods());

app.listen(3000);
```

## Streaming chat (SSE)

```js
// Browser / client script
import { ByokRelayClient } from '@byok-relay/koa';

const client = new ByokRelayClient({ relayUrl: '/relay' });

for await (const chunk of client.streamChat({
  model:    'gpt-4o',
  messages: [{ role: 'user', content: 'Tell me a story' }],
})) {
  process.stdout.write(chunk);
}
```

## Session-based token persistence (ctx.session)

```js
const { ByokRelayClient } = require('@byok-relay/koa');

// In a Koa route that uses @koa/session or koa-session:
async function getClient (ctx) {
  return new ByokRelayClient({
    appId:   'my-app',
    storage: {
      get:    key       => ctx.session[key] || null,
      set:    (key, val) => { ctx.session[key] = val; },
      remove: key       => { delete ctx.session[key]; },
    },
  });
}

// Usage in a route:
router.post('/register-key', async ctx => {
  const client = await getClient(ctx);
  await client.register();
  await client.storeKey('openai', ctx.request.body.apiKey);
  ctx.body = { ok: true };
});
```

## Middleware options

| Option | Type | Default | Description |
|---|---|---|---|
| `relayUrl` | string | `process.env.RELAY_URL` | Upstream relay base URL |
| `pathPrefix` | string | `'/relay'` | Path prefix to intercept |
| `allowedAppIds` | string[] | — | Allowlist of `x-app-id` header values (403 on mismatch) |
| `timeoutMs` | number | `30000` | Upstream fetch timeout in ms (504 on expiry) |

## `createRelayRouter` options

Same as middleware options. Returns a `@koa/router` Router instance — call `.routes()` and `.allowedMethods()` to mount.

## `ByokRelayClient` API

| Method | Description |
|---|---|
| `register(appId?)` | Register and get a relay token (shown once) |
| `ensureToken()` | Return stored token; auto-register if none |
| `logout()` | Clear stored token locally |
| `storeKey(provider, apiKey)` | Store an encrypted API key on the relay |
| `listKeys()` | List stored providers (keys never returned) |
| `deleteKey(provider)` | Delete a stored key |
| `rotateKey(provider, newKey)` | Atomically validate + replace a key |
| `relayRequest(path, body, headers?)` | Raw relay request |
| `chat({ model, messages, extraParams? })` | Chat completion (non-streaming) |
| `streamChat({ model, messages, signal? })` | Streaming chat (async generator) |
| `health(deep?)` | Liveness + readiness probe |
| `stats(appId?)` | Per-user / per-app usage stats |
| `getModels()` | List allowed models |
| `deleteAccount()` | GDPR erasure — delete account + all keys |

## Supported providers

| Provider | Model example |
|---|---|
| OpenAI | `openai/gpt-4o` |
| Anthropic | `anthropic/claude-opus-4-5` |
| Google | `google/gemini-2.5-pro` |
| Groq | `groq/llama-3.3-70b-versatile` |
| Mistral | `mistral/mistral-large-latest` |
| OpenRouter | `openrouter/meta-llama/llama-3.3-70b-instruct` |

Pass `model: 'provider/model'` or bare `model: 'gpt-4o'` (defaults to OpenAI).

## Self-hosting

Set `RELAY_URL` to your self-hosted relay URL:

```bash
RELAY_URL=https://relay.yourapp.com node server.js
```

Or use the managed relay at `https://relay.byokrelay.com` for development.

## Key differentiator vs `@byok-relay/express`

`@byok-relay/koa` uses Koa's `async (ctx, next)` middleware signature and integrates natively with `@koa/router`. Unlike Express, Koa's context object (`ctx`) merges request + response — no separate `req`/`res` parameters. The body-reading logic handles both koa-body/bodyparser raw bodies and raw stream consumption, so it works with or without a body parser middleware.

## Related packages

- [`@byok-relay/express`](https://www.npmjs.com/package/@byok-relay/express) — Express middleware + Router
- [`@byok-relay/hono`](https://www.npmjs.com/package/@byok-relay/hono) — Hono middleware for edge runtimes
- [`@byok-relay/fastify`](https://www.npmjs.com/package/@byok-relay/fastify) — Native Fastify plugin
- [`@byok-relay/nest`](https://www.npmjs.com/package/@byok-relay/nest) — NestJS module + injectable service
- [`@byok-relay/next`](https://www.npmjs.com/package/@byok-relay/next) — Next.js App Router + middleware
- [`@byok-relay/react`](https://www.npmjs.com/package/@byok-relay/react) — React hooks
- [`@byok-relay/mcp`](https://www.npmjs.com/package/@byok-relay/mcp) — MCP server for Claude Desktop

---

[byokrelay.com](https://byokrelay.com) · [GitHub](https://github.com/avikalpg/byok-relay) · [npm](https://www.npmjs.com/package/@byok-relay/koa)

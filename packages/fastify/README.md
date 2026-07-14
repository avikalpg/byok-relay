# @byok-relay/fastify

Fastify plugin and route factory for [byok-relay](https://byokrelay.com) — proxy AI provider requests server-side while your users bring their own API keys.

```
npm install @byok-relay/fastify
```

---

## What this does

Your frontend sends AI requests to `/relay/*` on your own Fastify server. The plugin forwards those requests to the byok-relay backend (managed or self-hosted), which uses the user's stored API key to call the real AI provider. The upstream relay URL stays in `process.env.RELAY_URL` — it never reaches the browser.

```
Browser  →  POST /relay/chat/completions  →  Fastify plugin  →  byok-relay  →  OpenAI / Anthropic / etc.
```

---

## Quick start

### Plugin (recommended)

Register the plugin and all `/relay/*` routes are automatically handled:

```js
const Fastify = require('fastify');
const { byokRelayPlugin } = require('@byok-relay/fastify');

const fastify = Fastify({ logger: true });

await fastify.register(byokRelayPlugin, {
  relayUrl: process.env.RELAY_URL,   // default: managed relay at relay.byokrelay.com
  pathPrefix: '/relay',               // default — intercept /relay/* requests
});

await fastify.listen({ port: 3000 });
```

After registration, `fastify.byokRelayClient` is available as a server-side client for use in other route handlers and plugins.

### Standalone route handler

For full control over route definition:

```js
const Fastify = require('fastify');
const { createRelayRouteHandler } = require('@byok-relay/fastify');

const fastify = Fastify();

fastify.all('/relay/*', createRelayRouteHandler({
  relayUrl: process.env.RELAY_URL,
}));

await fastify.listen({ port: 3000 });
```

---

## Plugin options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `relayUrl` | `string` | `process.env.RELAY_URL` | Upstream byok-relay base URL. Falls back to the managed relay. |
| `pathPrefix` | `string` | `'/relay'` | Path prefix to intercept. All sub-paths are forwarded. |
| `allowedAppIds` | `string[]` | — | Optional app_id allowlist. Requests with an unlisted `x-app-id` header are rejected with 403. |
| `timeoutMs` | `number` | `30000` | Upstream fetch timeout in ms. Returns 504 on expiry. |

---

## Browser client (frontend)

The `ByokRelayClient` class handles token registration, key storage, and making AI requests from the browser.

### Basic setup

```js
import { ByokRelayClient } from '@byok-relay/fastify';

const client = new ByokRelayClient({
  relayUrl: '/relay',  // your Fastify server's prefix (relative URL in browser)
  appId: 'my-app',
});

// Register on first visit (token persisted in localStorage)
const { token } = await client.register();

// Store the user's API key (encrypted server-side)
await client.storeKey('openai', userApiKey);

// Chat
const reply = await client.chat({
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### Streaming chat

```js
for await (const chunk of client.streamChat({
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: 'Tell me a story' }],
})) {
  process.stdout.write(chunk);
}
```

### Session-based storage adapter

In Fastify applications with session middleware (e.g., `@fastify/session`), you can store the relay token server-side:

```js
// Adapter backed by Fastify session (server-side use)
function sessionAdapter (session) {
  return {
    getItem    : (k) => session[k] || null,
    setItem    : (k, v) => { session[k] = v; },
    removeItem : (k) => { delete session[k]; },
  };
}

// In a Fastify route handler:
fastify.post('/api/register', async (request, reply) => {
  const client = new ByokRelayClient({
    relayUrl: process.env.RELAY_URL,
    storage: sessionAdapter(request.session),
  });
  const data = await client.register({ appId: 'my-app' });
  return reply.send({ ok: true });
});
```

---

## ByokRelayClient API

| Method | Description |
|--------|-------------|
| `register(opts?)` | Register a new user and persist the token. Returns `{ token, expires_at }`. |
| `ensureToken(opts?)` | Return existing token or call `register()` if none. |
| `logout()` | Clear the stored token. |
| `storeKey(provider, apiKey)` | Encrypt and store an API key server-side. |
| `listKeys()` | List stored providers. |
| `deleteKey(provider)` | Delete a stored key. |
| `rotateKey(provider, newApiKey)` | Validate and atomically replace a key. |
| `relayRequest(path, init?)` | Low-level authenticated fetch to any relay endpoint. |
| `chat(opts)` | Non-streaming chat. Returns the assistant's text content. |
| `streamChat(opts)` | Async generator yielding text chunks via SSE. |
| `health(deep?)` | Check relay liveness (and optionally upstream provider). |
| `stats(appId?)` | Fetch per-user or per-app request stats. |
| `getModels()` | List allowed models from the relay. |
| `deleteAccount()` | GDPR erasure — delete account and all stored keys. |

### `chat` options

```js
client.chat({
  model: 'openai/gpt-4o',     // 'provider/model' or bare model name
  messages: [...],             // OpenAI-format messages array
  systemPrompt: 'You are...',  // optional system message prepended
  temperature: 0.7,            // any extra provider params
})
```

### `streamChat` options

Same as `chat` plus:

| Option | Description |
|--------|-------------|
| `signal` | `AbortSignal` to cancel the stream |

---

## Supported providers

| Provider | Model prefix |
|----------|-------------|
| OpenAI | `openai/` or bare (`gpt-4o`) |
| Anthropic | `anthropic/` |
| Groq | `groq/` |
| Mistral | `mistral/` |
| OpenRouter | `openrouter/` |
| ElevenLabs | `elevenlabs/` |
| HuggingFace | `huggingface/` |
| Deepgram | `deepgram/` |

---

## Using `fastify.byokRelayClient` in other routes

After `fastify.register(byokRelayPlugin, ...)`, the instance is decorated:

```js
fastify.get('/api/ai-health', async (request, reply) => {
  const status = await fastify.byokRelayClient.health(true);
  return reply.send(status);
});
```

---

## Making the plugin non-encapsulated (fastify-plugin)

By default the plugin scopes its routes. To expose the `byokRelayClient` decoration to parent scope, wrap with `fastify-plugin`:

```js
const fp = require('fastify-plugin');
const { byokRelayPlugin } = require('@byok-relay/fastify');

module.exports = fp(byokRelayPlugin, {
  name: 'byok-relay',
  fastify: '4.x - 5.x',
});
```

---

## Self-hosting

Point `relayUrl` at your own byok-relay instance:

```bash
# .env
RELAY_URL=http://localhost:3001   # self-hosted byok-relay
```

See [byok-relay self-hosting docs](https://github.com/avikalpg/byok-relay#quickstart) for setup instructions.

---

## Related packages

| Package | For |
|---------|-----|
| [`@byok-relay/express`](https://npmjs.com/package/@byok-relay/express) | Express middleware + Router factory |
| [`@byok-relay/hono`](https://npmjs.com/package/@byok-relay/hono) | Hono / Cloudflare Workers |
| [`@byok-relay/next`](https://npmjs.com/package/@byok-relay/next) | Next.js App Router |
| [`@byok-relay/react`](https://npmjs.com/package/@byok-relay/react) | React hooks |
| [`@byok-relay/vue`](https://npmjs.com/package/@byok-relay/vue) | Vue 3 composables |
| [`@byok-relay/svelte`](https://npmjs.com/package/@byok-relay/svelte) | Svelte stores |
| [`@byok-relay/mcp`](https://npmjs.com/package/@byok-relay/mcp) | Claude Desktop / Claude Code |
| [`@byok-relay/client`](https://npmjs.com/package/@byok-relay/client) | Vanilla JS client |

---

## License

MIT — [byokrelay.com](https://byokrelay.com)

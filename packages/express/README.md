# @byok-relay/express

Express middleware and Express Router factory for [byok-relay](https://byokrelay.com) — proxy AI provider requests through your Express server while your users bring their own API keys.

`RELAY_URL` stays in `process.env` on your server. The browser never sees the upstream relay URL.

## Install

```bash
npm install @byok-relay/express
```

## Quick start — Express middleware

```js
const express = require('express');
const { createByokRelayMiddleware } = require('@byok-relay/express');

const app = express();

// Mount before your routes — RELAY_URL stays server-only
app.use(createByokRelayMiddleware({
  relayUrl:   process.env.RELAY_URL,  // or omit to use the managed relay
  pathPrefix: '/relay',               // default — client calls /relay/*
}));

app.listen(3000);
```

Client (browser):
```js
const { ByokRelayClient } = require('@byok-relay/express');
// or any framework-specific package — they all share the same client API

const client = new ByokRelayClient({ relayUrl: '/relay', appId: 'my-app' });
const { token } = await client.register();
await client.storeKey('openai', userApiKey);

const reply = await client.chat({
  model:    'openai/gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

## Quick start — Express Router

Use the Router factory when you want the relay mounted at a specific path with full Express Router capabilities:

```js
const express = require('express');
const { createRelayRouter } = require('@byok-relay/express');

const app = express();

// Mount at /relay — all traffic under /relay/* is proxied to the upstream relay
app.use('/relay', createRelayRouter({
  relayUrl:     process.env.RELAY_URL,
  timeoutMs:    30_000,           // default 30 s
  allowedAppIds: ['web', 'mobile'], // optional allowlist
}));

app.listen(3000);
```

## Streaming with Express

The middleware and router both support SSE streaming out of the box. No special configuration needed — the `ReadableStream` is piped directly to the Express response:

```js
// Express route — stream chat completions to the browser.
// Configure session middleware (for example, express-session) before this route
// because the storage adapter below uses req.session.
app.use(express.json());

app.post('/chat', async (req, res) => {
  const client = new ByokRelayClient({
    relayUrl: process.env.RELAY_URL,
    storage: {
      getItem: () => req.session.relayToken || null,
      setItem: (_key, token) => { req.session.relayToken = token; },
      removeItem: () => { delete req.session.relayToken; },
    },
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  for await (const chunk of client.streamChat({
    model:    'openai/gpt-4o',
    messages: req.body.messages,
  })) {
    res.write(chunk.split(/\r?\n/).map((line) => `data: ${line}`).join('\n') + '\n\n');
  }
  res.end();
});
```

Or let the middleware handle it transparently — the browser calls `/relay/relay` with `stream: true` and receives the SSE stream directly.

## API reference

### `createByokRelayMiddleware(opts?)`

Returns an Express `(req, res, next)` middleware.

| Option | Type | Default | Description |
|---|---|---|---|
| `relayUrl` | string | `process.env.RELAY_URL` → managed relay | Upstream relay base URL |
| `pathPrefix` | string | `'/relay'` | Path prefix to intercept |
| `allowedAppIds` | string[] | — | If set, every request must include an allowed `x-app-id` header or `app_id` query value; missing or unlisted IDs get 403. `ByokRelayClient({ appId })` sends the header automatically. |
| `timeoutMs` | number | `30000` | Upstream fetch timeout |

### `createRelayRouter(opts?)`

Returns an Express Router. Mount with `app.use('/relay', createRelayRouter(...))`.

Same options as `createByokRelayMiddleware`.

### `ByokRelayClient`

Plain-JS class. Works in Express route handlers, middleware, and (when bundled) browsers.

```js
const client = new ByokRelayClient({
  relayUrl: string,    // default: process.env.RELAY_URL → managed relay
  appId:    string,    // default: 'default'; sent as x-app-id on client requests
  storage:  object,    // custom { getItem, setItem, removeItem } adapter
  storageKey: string,  // optional token-storage key; defaults to relay URL + app ID namespace
});
```

| Method | Description |
|---|---|
| `register()` | Create a relay user for the client’s configured `appId`; stores token |
| `ensureToken()` | Register if not yet registered; return token |
| `logout()` | Clear stored token |
| `storeKey(provider, apiKey)` | Encrypt and store an API key |
| `listKeys()` | List stored providers |
| `deleteKey(provider)` | Delete a stored key |
| `rotateKey(provider, newApiKey)` | Live-validate and atomically swap a key |
| `relayRequest(path, fetchInit)` | Low-level relay fetch |
| `chat({ model, messages, systemPrompt?, ...extra })` | One-shot chat completion |
| `streamChat({ model, messages, systemPrompt?, signal? })` | Async generator; yields text chunks |
| `health(deep?)` | Liveness / readiness probe |
| `stats(appId?)` | Request counts per user or app |
| `getModels()` | List allowed models |
| `deleteAccount()` | GDPR erasure — deletes user + all keys |

## Custom storage adapter (cookie / session)

In Express apps you may want to persist the relay token in the session rather than localStorage. Configure JSON parsing and session middleware (such as [`express-session`](https://www.npmjs.com/package/express-session)) before routes that use this adapter.

```js
const session = require('express-session');

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));

// Per-request client with session storage
function relayClientFromSession (req) {
  return new ByokRelayClient({
    relayUrl: process.env.RELAY_URL,
    storage: {
      getItem    : (k) => req.session[k] || null,
      setItem    : (k, v) => { req.session[k] = v; },
      removeItem : (k) => { delete req.session[k]; },
    },
  });
}

app.post('/api/chat', async (req, res) => {
  const client = relayClientFromSession(req);
  const reply  = await client.chat({
    model:    'openai/gpt-4o-mini',
    messages: req.body.messages,
  });
  res.json({ reply });
});
```

## Supported AI providers

| Provider | Model prefix | Key format |
|---|---|---|
| OpenAI | `openai/` | `sk-…` |
| Anthropic | `anthropic/` | `sk-ant-…` |
| Groq | `groq/` | `gsk_…` |
| Mistral | `mistral/` | `…` |
| OpenRouter | `openrouter/` | `sk-or-…` |
| Custom OpenAI-compatible | `openai-compatible/` | any |
| ElevenLabs | `elevenlabs/` | `…` |
| HuggingFace | `huggingface/` | `hf_…` |
| Deepgram | `deepgram/` | `…` |

## Self-hosting

Run byok-relay yourself for full control:

```bash
docker compose up -d
# or
npx byok-relay
```

Set `RELAY_URL` to your self-hosted instance. See the [main repo](https://github.com/avikalpg/byok-relay) for deployment options (Railway, Render, Docker, npm).

## Related packages

| Package | Use case |
|---|---|
| [`@byok-relay/client`](https://npmjs.com/package/@byok-relay/client) | Framework-agnostic client |
| [`@byok-relay/react`](https://npmjs.com/package/@byok-relay/react) | React hooks |
| [`@byok-relay/next`](https://npmjs.com/package/@byok-relay/next) | Next.js App Router + hooks |
| [`@byok-relay/hono`](https://npmjs.com/package/@byok-relay/hono) | Hono (Cloudflare Workers, Deno, Bun) |
| [`@byok-relay/nuxt`](https://npmjs.com/package/@byok-relay/nuxt) | Nuxt 3 module + composables |
| [`@byok-relay/mcp`](https://npmjs.com/package/@byok-relay/mcp) | MCP server for Claude Desktop |

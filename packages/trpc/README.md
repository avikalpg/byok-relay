# @byok-relay/trpc

> tRPC v11 router adapter, context factory, and middleware for [byok-relay](https://byokrelay.com).
> `RELAY_URL` stays in `process.env` — users' AI keys stay encrypted on your relay, never in your bundle.

[![npm](https://img.shields.io/npm/v/@byok-relay/trpc)](https://www.npmjs.com/package/@byok-relay/trpc)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](../../LICENSE)

---

## What it does

- **`createByokRelayRouter(t)`** — pre-built tRPC router with procedures for health, register, storeKey, listKeys, deleteKey, rotateKey, chat, stats, and models. Merge into your app router in one line.
- **`createByokRelayContext(opts)`** — context factory that injects `ByokRelayClient` into every tRPC request. `RELAY_URL` stays server-side.
- **`createRelayProcedure(t.procedure, opts)`** — middleware factory: adds `ctx.relay` to individual procedures without adopting the full pre-built router.
- **`createByokRelayFetchHandler(opts)`** — fetch-compatible tRPC handler for Next.js App Router, Cloudflare Workers, Deno Deploy.
- **`ByokRelayClient`** — plain-JS class. Use in guards, interceptors, scripts, and tests.

---

## Install

```bash
npm install @byok-relay/trpc @trpc/server @trpc/client
```

---

## Quick-start — Next.js App Router + tRPC v11

### 1. Create the tRPC instance with byok-relay context

```js
// trpc/init.js
const { initTRPC } = require('@trpc/server');
const { createByokRelayContext } = require('@byok-relay/trpc');

const createContext = createByokRelayContext({
  relayUrl: process.env.RELAY_URL, // server-only env var
  appId: 'my-next-app',
});

const t = initTRPC.context().create();

module.exports = { t, createContext };
```

### 2. Build the app router with relay procedures merged in

```js
// trpc/router.js
const { t } = require('./init');
const { createByokRelayRouter } = require('@byok-relay/trpc');

const relayRouter = createByokRelayRouter(t);

// Merge with your own procedures
const appRouter = t.router({
  relay: relayRouter,             // all relay procedures under relay.*
  // yourProcedure: t.procedure.query(...),
});

module.exports = { appRouter };
```

### 3. Wire up the App Router API route

```js
// app/api/trpc/[trpc]/route.js
const { createByokRelayFetchHandler } = require('@byok-relay/trpc');
const { appRouter } = require('../../../../trpc/router');

const handler = createByokRelayFetchHandler({
  router:   appRouter,
  relayUrl: process.env.RELAY_URL,  // stays server-side
  endpoint: '/api/trpc',
});

module.exports = { GET: handler, POST: handler };
```

### 4. Use from the client

```js
// app/components/ChatWidget.jsx
'use client';
import { trpc } from '../utils/trpc';

export function ChatWidget() {
  const chat = trpc.relay.chat.useMutation();

  async function ask() {
    const { reply } = await chat.mutateAsync({
      model:    'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello!' }],
    });
    console.log(reply);
  }

  return <button onClick={ask}>Ask AI</button>;
}
```

---

## Quick-start — selective procedures with `createRelayProcedure`

Use when you want relay capability on specific procedures without the full pre-built router:

```js
// trpc/router.js
const { initTRPC } = require('@trpc/server');
const { createRelayProcedure } = require('@byok-relay/trpc');
const z = require('zod');

const t = initTRPC.context().create();

// Procedure that injects ctx.relay automatically
const relayProcedure = createRelayProcedure(t.procedure, {
  relayUrl: process.env.RELAY_URL,
  appId:    'my-app',
});

const appRouter = t.router({
  // Any procedure using relayProcedure gets ctx.relay: ByokRelayClient
  askAI: relayProcedure
    .input(z.object({ question: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const reply = await ctx.relay.chat({
        model:    'openai/gpt-4o',
        messages: [{ role: 'user', content: input.question }],
      });
      return { reply };
    }),

  storeKey: relayProcedure
    .input(z.object({ provider: z.string(), apiKey: z.string() }))
    .mutation(async ({ input, ctx }) => {
      return ctx.relay.storeKey(input.provider, input.apiKey);
    }),
});
```

---

## Pre-built procedures reference

| Procedure | Type | Input | Returns |
|---|---|---|---|
| `relay.health` | query | `{ deep?: boolean, provider?: string }` | Health object |
| `relay.register` | mutation | `{ appId?: string }` | `{ token }` |
| `relay.storeKey` | mutation | `{ provider, apiKey }` | `{ ok }` |
| `relay.listKeys` | query | — | `string[]` provider names |
| `relay.deleteKey` | mutation | `{ provider }` | `{ ok }` |
| `relay.rotateKey` | mutation | `{ provider, newApiKey }` | `{ ok, rotated }` |
| `relay.chat` | mutation | `{ model, messages, extra? }` | `{ reply }` |
| `relay.stats` | query | `{ appId? }` | Usage stats object |
| `relay.models` | query | — | Available models |

---

## ByokRelayClient API

```js
const { ByokRelayClient } = require('@byok-relay/trpc');

const client = new ByokRelayClient({
  relayUrl: process.env.RELAY_URL, // default: managed relay
  appId:    'my-app',
  storage:  customAdapter,         // optional: { get(k), set(k,v), remove(k) }
});

// Token management
const token = await client.ensureToken();   // get or create
const token = await client.register();      // always register new
client.logout();                            // clear local token

// Key management
await client.storeKey('openai', 'sk-...');
const keys = await client.listKeys();       // ['openai', 'anthropic']
await client.deleteKey('openai');
await client.rotateKey('openai', 'sk-new-...');

// AI calls
const reply  = await client.chat({ model: 'openai/gpt-4o', messages });
for await (const chunk of client.streamChat({ model: 'anthropic/claude-opus-4-5', messages })) {
  process.stdout.write(chunk);
}

// Utility
const health = await client.health(true);   // deep=true pings upstream
const stats  = await client.stats();
const models = await client.getModels();
await client.deleteAccount();               // GDPR erasure
```

---

## Supported providers

| Provider | Model examples |
|---|---|
| `openai` | `gpt-4o`, `gpt-4o-mini`, `o3` |
| `anthropic` | `claude-opus-4-5`, `claude-sonnet-4-5` |
| `groq` | `llama-3.3-70b-versatile`, `mixtral-8x7b` |
| `mistral` | `mistral-large-latest`, `mistral-medium` |
| `openrouter` | Any OpenRouter model slug |
| Any OpenAI-compatible | Ollama, LiteLLM, Perplexity, Together AI, … |

Use `provider/model` syntax: `'openai/gpt-4o'`, `'anthropic/claude-opus-4-5'`, or a bare model name.

---

## Key differentiators vs raw tRPC fetch

| | Raw tRPC | @byok-relay/trpc |
|---|---|---|
| `RELAY_URL` exposure | Leaks to client bundle unless guarded | Always server-only (process.env) |
| Key management procedures | Build yourself | Pre-built: storeKey, listKeys, rotateKey |
| Streaming | Implement SSE manually | `ByokRelayClient.streamChat()` ready |
| Context injection | Manual per procedure | `createRelayProcedure` one-liner |
| Storage adapter | Roll your own | In-memory / localStorage / custom |

---

## Self-hosting

Set `RELAY_URL` to your own byok-relay instance:

```bash
RELAY_URL=https://relay.my-domain.com
```

See [byok-relay](https://github.com/avikalpg/byok-relay) for self-hosting docs (Docker, Railway, Render, Fly.io).

---

## Related packages

| Package | Use case |
|---|---|
| [`@byok-relay/next`](../next) | Next.js App Router route handler + hooks |
| [`@byok-relay/hono`](../hono) | Hono middleware for Cloudflare Workers / Bun |
| [`@byok-relay/express`](../express) | Express middleware + Router factory |
| [`@byok-relay/react`](../react) | React hooks (useChat, useStreamingChat) |
| [`@byok-relay/vercel-ai`](../vercel-ai) | Vercel AI SDK custom provider |
| [`@byok-relay/mcp`](../mcp) | MCP server for Claude Desktop / Claude Code |
| [`@byok-relay/client`](../client) | Framework-agnostic JS client |

---

Apache 2.0 — [byokrelay.com](https://byokrelay.com) · [GitHub](https://github.com/avikalpg/byok-relay)

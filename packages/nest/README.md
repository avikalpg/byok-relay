# @byok-relay/nest

> NestJS module, middleware, and injectable service for [byok-relay](https://byokrelay.com).
> Proxy AI provider requests server-side while your users bring their own API keys.

```bash
npm install @byok-relay/nest
```

`RELAY_URL` stays in `process.env` — the browser only ever calls your own NestJS server.

---

## Quick start — ByokRelayModule

```js
// app.module.js
const { Module }          = require('@nestjs/common');
const { ByokRelayModule } = require('@byok-relay/nest');

class AppModule {}
Module({
  imports: [
    ByokRelayModule.forRoot({
      relayUrl:   process.env.RELAY_URL,   // default: managed relay at byokrelay.com
      pathPrefix: '/relay',                // default
      timeoutMs:  30_000,                  // default
    }),
  ],
})(AppModule);

module.exports = { AppModule };
```

```js
// app.module.js — also apply middleware in one step
const { Module, NestModule, MiddlewareConsumer } = require('@nestjs/common');
const { ByokRelayModule, ByokRelayMiddleware }   = require('@byok-relay/nest');

class AppModule {
  configure(consumer) {
    consumer
      .apply(ByokRelayMiddleware)
      .forRoutes('/relay');         // intercept all /relay/* routes
  }
}
Module({
  imports: [ByokRelayModule.forRoot({ relayUrl: process.env.RELAY_URL })],
})(AppModule);
NestModule.call(AppModule.prototype);   // TypeScript interface — omit in TS projects
module.exports = { AppModule };
```

---

## ByokRelayService — inject anywhere

After registering `ByokRelayModule`, inject `ByokRelayService` into any provider:

```js
const { Injectable, Inject } = require('@nestjs/common');
const { ByokRelayService }   = require('@byok-relay/nest');

class AiChatService {
  constructor(relay) {
    this.relay = relay;                    // NestJS injects ByokRelayService
  }

  async chat(messages) {
    // Register a user + store their key on first call (or use ensureToken)
    await this.relay.ensureToken({ appId: 'my-nest-app' });
    return this.relay.chat({
      model:    'openai/gpt-4o',
      messages,
    });
  }

  streamChat(messages) {
    return this.relay.streamChat({        // async generator — yield chunks
      model:    'openai/gpt-4o',
      messages,
    });
  }
}
Injectable()(AiChatService);
Inject(ByokRelayService)(AiChatService.prototype, undefined, 0);

module.exports = { AiChatService };
```

---

## Async configuration (`forRootAsync`)

Use with `@nestjs/config` or any async provider:

```js
const { ConfigModule, ConfigService } = require('@nestjs/config');
const { ByokRelayModule }             = require('@byok-relay/nest');

ByokRelayModule.forRootAsync({
  imports:    [ConfigModule],
  useFactory: (config) => ({
    relayUrl:      config.get('RELAY_URL'),
    allowedAppIds: config.get('ALLOWED_APP_IDS')?.split(','),
    timeoutMs:     Number(config.get('RELAY_TIMEOUT_MS') || 30_000),
  }),
  inject: [ConfigService],
})
```

---

## ByokRelayMiddleware — standalone (without ByokRelayModule)

Configure once at bootstrap, then apply as a standard NestJS middleware:

```js
const { ByokRelayMiddleware } = require('@byok-relay/nest');

// Configure before middleware registration
ByokRelayMiddleware.configure({
  relayUrl:      process.env.RELAY_URL,
  pathPrefix:    '/relay',
  allowedAppIds: ['app-prod', 'app-staging'],   // optional allowlist
  timeoutMs:     30_000,
});

// In your module's configure() method:
class AppModule {
  configure(consumer) {
    consumer.apply(ByokRelayMiddleware).forRoutes('/relay');
  }
}
```

---

## ByokRelayClient — plain-JS class

Works in NestJS guards, interceptors, scripts, and tests without the DI container:

```js
const { ByokRelayClient } = require('@byok-relay/nest');

const client = new ByokRelayClient({
  relayUrl: process.env.RELAY_URL,   // optional; falls back to managed relay
  appId:    'my-nest-app',
  storage:  customAdapter,           // optional; in-memory default on Node.js
});

// Register once, reuse the token
const { token } = await client.register();

// Store a user's API key (AES-256-GCM encrypted at rest)
await client.storeKey('openai', userProvidedKey);

// Chat
const reply = await client.chat({
  model:    'openai/gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
});

// Streaming
for await (const chunk of client.streamChat({
  model:    'anthropic/claude-opus-4-5',
  messages: [{ role: 'user', content: 'Tell me a story' }],
})) {
  process.stdout.write(chunk);
}
```

---

## SSE streaming in a NestJS controller

```js
const { Controller, Get, Res, Inject } = require('@nestjs/common');
const { ByokRelayService }              = require('@byok-relay/nest');

class ChatController {
  constructor(relay) { this.relay = relay; }

  async streamEndpoint(res) {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');

    for await (const chunk of this.relay.streamChat({
      model:    'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello streaming world' }],
    })) {
      res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
    }
    res.end();
  }
}
Controller('chat')(ChatController);
Get('stream')(ChatController.prototype, 'streamEndpoint', Object.getOwnPropertyDescriptor(ChatController.prototype, 'streamEndpoint'));
Res()(ChatController.prototype, 'streamEndpoint', 0);
Inject(ByokRelayService)(ChatController.prototype, undefined, 0);
```

---

## ByokRelayService API

| Method | Description |
|--------|-------------|
| `register(opts?)` | Register a new relay user; returns `{ token, user_id, expires_at }` |
| `ensureToken(opts?)` | Register only if no token exists; returns token string |
| `logout()` | Clear the stored token |
| `storeKey(provider, apiKey)` | Store an encrypted API key |
| `listKeys()` | List stored provider keys for this user |
| `deleteKey(provider)` | Delete a provider key |
| `rotateKey(provider, newApiKey)` | Atomically validate + replace a key |
| `relayRequest(path, init?)` | Low-level fetch to any relay endpoint |
| `chat(opts)` | Unified chat (non-streaming) across all providers |
| `streamChat(opts)` | Async generator yielding SSE text chunks |
| `health(deep?)` | Relay liveness + optional upstream readiness probe |
| `stats(appId?)` | Per-user or per-app_id usage stats |
| `getModels()` | List allowed models from the relay |
| `deleteAccount()` | Delete account + all keys (GDPR Art. 17) |
| `.client` | Access the underlying `ByokRelayClient` instance |

---

## ByokRelayModule options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `relayUrl` | `string` | `process.env.RELAY_URL` → managed relay | Upstream relay base URL |
| `pathPrefix` | `string` | `'/relay'` | URL prefix the middleware intercepts |
| `allowedAppIds` | `string[]` | none | Optional app_id allowlist (403 on mismatch) |
| `timeoutMs` | `number` | `30000` | Upstream fetch timeout in ms |
| `appId` | `string` | `'default'` | App identifier for ByokRelayService registration |
| `global` | `boolean` | `false` | Make the module global (no re-import needed) |

---

## Supported AI providers

| Provider | Model prefix | Example model |
|----------|-------------|---------------|
| OpenAI | `openai/` | `openai/gpt-4o` |
| Anthropic | `anthropic/` | `anthropic/claude-opus-4-5` |
| Groq | `groq/` | `groq/llama-3.1-70b-versatile` |
| Mistral | `mistral/` | `mistral/mistral-large-latest` |
| OpenRouter | `openrouter/` | `openrouter/meta-llama/llama-3.1-405b` |
| HuggingFace | `huggingface/` | `huggingface/mistralai/Mixtral-8x7B` |
| ElevenLabs | `elevenlabs/` | `elevenlabs/tts/v1/text-to-speech/:voice_id` |
| Deepgram | `deepgram/` | `deepgram/v1/listen` |

---

## Self-hosting

Point `relayUrl` at your own relay instance:

```bash
docker compose up -d   # starts relay on port 3000
```

```js
ByokRelayModule.forRoot({ relayUrl: 'http://localhost:3000' })
```

See the [byok-relay repo](https://github.com/avikalpg/byok-relay) for full self-hosting docs.

---

## Related packages

| Package | For |
|---------|-----|
| [`@byok-relay/client`](https://npmjs.com/package/@byok-relay/client) | Universal plain-JS client |
| [`@byok-relay/express`](https://npmjs.com/package/@byok-relay/express) | Express middleware + Router |
| [`@byok-relay/fastify`](https://npmjs.com/package/@byok-relay/fastify) | Fastify plugin + handler |
| [`@byok-relay/hono`](https://npmjs.com/package/@byok-relay/hono) | Hono middleware (Cloudflare Workers, Deno, Bun) |
| [`@byok-relay/elysia`](https://npmjs.com/package/@byok-relay/elysia) | Elysia plugin (Bun-native) |
| [`@byok-relay/react`](https://npmjs.com/package/@byok-relay/react) | React hooks |
| [`@byok-relay/next`](https://npmjs.com/package/@byok-relay/next) | Next.js App Router |
| [`@byok-relay/mcp`](https://npmjs.com/package/@byok-relay/mcp) | MCP server for Claude Desktop |
| [`@byok-relay/vercel-ai`](https://npmjs.com/package/@byok-relay/vercel-ai) | Vercel AI SDK provider |

---

MIT · [byokrelay.com](https://byokrelay.com)

# `@byok-relay/client`

Framework-agnostic JavaScript client for [byok-relay](https://byokrelay.com).

Works in **browsers** (localStorage default), **Node.js** (in-memory default), and any environment
that supplies a custom storage adapter.

---

## Install

```bash
npm install @byok-relay/client
# or
pnpm add @byok-relay/client
# or
yarn add @byok-relay/client
```

---

## Quick start

### Browser (Vite / CRA / Next.js)

```js
import { createClient } from '@byok-relay/client'

const relay = createClient({
  relayUrl: import.meta.env.VITE_RELAY_URL ?? 'https://relay.byokrelay.com',
  appId: 'my-app',
})

// Let your user enter their API key once
await relay.storeKey('openai', userApiKey)

// Then stream chat completions — no backend required
const fullText = await relay.streamChat({
  provider: 'openai',
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello!' }],
  onChunk: (delta) => console.log(delta),
})
```

### Node.js

```js
const { createClient } = require('@byok-relay/client')

const relay = createClient({
  relayUrl: process.env.RELAY_URL,
  appId: 'my-service',
})
```

---

## API

### `createClient(opts?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `relayUrl` | `string` | `'http://localhost:3000'` | Base URL of the relay server |
| `appId` | `string` | `'app'` | Identifier used when auto-registering |
| `storage` | `StorageAdapter \| null` | `localStorage` or in-memory | Custom key-value storage (pass `null` to disable persistence) |

Returns a **RelayClient** with the methods below.

---

### Token management

```ts
relay.getToken(): string | null
relay.clearToken(): void
relay.ensureToken(appId?: string): Promise<string>
```

`ensureToken` auto-registers a user if no token is stored and returns the relay token.

---

### Key management

```ts
relay.storeKey(provider: string, apiKey: string): Promise<object>
relay.listKeys(): Promise<string[]>
relay.deleteKey(provider: string): Promise<void>
relay.deleteAccount(): Promise<void>   // GDPR Art. 17 — clears token too
```

---

### Chat (high-level)

```ts
// Per-provider streaming (Anthropic + OpenAI)
relay.streamChat({ provider, model, messages, onChunk?, maxTokens? }): Promise<string>

// Unified model routing — requires byok-relay v1.1+
relay.chat({ model, messages, onChunk?, maxTokens? }): Promise<string | object>
```

`onChunk(delta: string)` is called for each SSE text token. Omit it for a non-streaming call.

```js
// Non-streaming
const response = await relay.chat({ model: 'gpt-4o-mini', messages })

// Streaming
const full = await relay.chat({
  model: 'anthropic/claude-haiku-4-5',
  messages,
  onChunk: (delta) => process.stdout.write(delta),
})
```

---

### Low-level relay

```ts
relay.relayRequest({ provider, path, body, headers?, onChunk? }): Promise<object | string>
```

Useful for non-chat endpoints (embeddings, TTS, image generation, etc.).

```js
// Embeddings
const result = await relay.relayRequest({
  provider: 'openai',
  path: '/v1/embeddings',
  body: { model: 'text-embedding-3-small', input: 'hello world' },
})

// ElevenLabs TTS (binary response — handle via relayRequest raw fetch if needed)
```

---

### Info endpoints

```ts
relay.health(): Promise<object>
relay.getModels(): Promise<object[]>   // byok-relay v1.1+
relay.getStats(): Promise<object>      // byok-relay v1.2+
```

---

## Custom storage adapter

Any object with `getItem`, `setItem`, and `removeItem` works:

```js
// Example: sessionStorage instead of localStorage
const relay = createClient({
  relayUrl: '...',
  storage: sessionStorage,
})

// Example: custom in-memory store (test isolation)
import { createMemoryStorage } from '@byok-relay/client'
const relay = createClient({ storage: createMemoryStorage() })
```

---

## Providers

Out of the box: `openai`, `anthropic`, `google`, `groq`, `mistral`, `together`, `fireworks`,
`elevenlabs`, `huggingface`, `deepgram`, `openai-compatible`.

---

## License

Apache-2.0 — same as byok-relay.

# @byok-relay/openai

> Drop-in OpenAI SDK-compatible client for [byok-relay](https://byokrelay.com).
> Replace `new OpenAI(...)` with `new ByokRelayOpenAI(...)` — users' API keys are stored **encrypted in the relay**, never in your app.

[![npm](https://img.shields.io/npm/v/@byok-relay/openai)](https://www.npmjs.com/package/@byok-relay/openai)
[![byok-relay](https://img.shields.io/badge/powered%20by-byok--relay-blue)](https://byokrelay.com)

## Why?

The `openai` SDK needs an API key. In a browser app that key can end up in your bundle or localStorage, visible to anyone who opens DevTools. byok-relay receives the key from `storeKey`, stores it **encrypted server-side**, and forwards requests on the user's behalf; your application server does not receive the stored key.

`@byok-relay/openai` supports the documented OpenAI-compatible namespaces, so migration for those APIs is a small swap.

## Install

```bash
npm install @byok-relay/openai
```

## Quick start

```js
// Before (openai SDK — key in your app):
import OpenAI from 'openai';
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// After (@byok-relay/openai — key stored in relay, never in your app):
import { ByokRelayOpenAI } from '@byok-relay/openai';
const client = new ByokRelayOpenAI();
```

Then use the client **exactly like the openai SDK**:

```js
const completion = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(completion.choices[0].message.content);
```

## BYOK setup — user stores their own key

Add a settings screen where users paste their OpenAI key once:

```js
// In your settings UI:
await client.storeKey('openai', userApiKey);
// Key is AES-256-GCM encrypted in the relay — never stored in your app
```

After `storeKey`, all subsequent `chat.completions.create()` calls use the user's key automatically.

## Streaming

Identical to the openai SDK — `for await` over the stream:

```js
const stream = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Tell me a story' }],
  stream: true,
});

// Node.js example:
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
```

Or collect everything at once:

```js
const stream = await client.chat.completions.create({ model: 'gpt-4o', messages, stream: true });
const final = await stream.finalChatCompletion();
console.log(final.choices[0].message.content);
```

## Multi-provider routing

Prefix the model name with the provider to route to Anthropic, Groq, Mistral, etc.:

```js
// Route to Anthropic Claude
const client = new ByokRelayOpenAI();

await client.storeKey('anthropic', userAnthropicApiKey);

const completion = await client.chat.completions.create({
  model: 'anthropic/claude-3-5-sonnet-20241022',   // provider/model
  messages: [{ role: 'user', content: 'Hello!' }],
});

// Or set provider at construction time:
const anthropicClient = new ByokRelayOpenAI({
  relayUrl: process.env.RELAY_URL,
  provider: 'anthropic',
});
await anthropicClient.storeKey('anthropic', userAnthropicKey);
const completion2 = await anthropicClient.chat.completions.create({
  model: 'claude-3-5-sonnet-20241022',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

## Embeddings

```js
const result = await client.embeddings.create({
  model: 'text-embedding-3-small',
  input: ['The food was great!', 'The service was slow.'],
});
console.log(result.data[0].embedding); // number[]
```

## Tool calling / function calling

```js
const tools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the weather for a location',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string' } },
        required: ['location'],
      },
    },
  },
];

const completion = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
  tools,
  tool_choice: 'auto',
});

const toolCall = completion.choices[0].message.tool_calls?.[0];
if (toolCall) {
  const args = JSON.parse(toolCall.function.arguments);
  // call your function, then continue the conversation...
}
```

## Image generation

```js
const image = await client.images.generate({
  model: 'dall-e-3',
  prompt: 'A cozy coffee shop in Tokyo at night',
  size: '1024x1024',
  quality: 'standard',
  n: 1,
});
console.log(image.data[0].url);
```

## Models list

```js
const models = await client.models.list();
console.log(models.allowed_models);
```

## Migration passthrough mode

If you want to test routing but still use a raw API key temporarily:

```js
const client = new ByokRelayOpenAI({
  relayUrl: process.env.RELAY_URL,
  apiKey: process.env.OPENAI_API_KEY,  // forwarded as Authorization header
});
// Remove apiKey once users store their own keys via storeKey()
```

## API reference

### `new ByokRelayOpenAI(opts)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `relayUrl` | `string` | `https://relay.byokrelay.com` | byok-relay base URL |
| `provider` | `string` | `'openai'` | Default provider (used when model has no prefix) |
| `appId` | `string` | `'byok-relay-openai'` | App identifier sent as `X-App-Id` |
| `storage` | `object` | localStorage / in-memory | Custom storage adapter `{ getItem, setItem, removeItem }` |
| `apiKey` | `string` | — | Raw API key passthrough (migration/testing only) |

### Supported namespaces

| Namespace | Methods | Notes |
|-----------|---------|-------|
| `chat.completions` | `.create(params)` | Streaming: pass `stream: true`, iterate with `for await` |
| `completions` | `.create(params)` | Legacy non-chat completions |
| `embeddings` | `.create(params)` | Batch or single input |
| `images` | `.generate(params)`, `.edit(params)` | |
| `models` | `.list()`, `.retrieve(model)` | |
| `audio.transcriptions` | `.create(params)` | Multipart/form-data audio files |
| `audio.speech` | `.create(params)` | Returns raw binary Response |

### Key management methods

| Method | Description |
|--------|-------------|
| `storeKey(provider, apiKey)` | Store a provider API key (encrypted at rest) |
| `listKeys()` | List stored provider keys |
| `deleteKey(provider)` | Delete a stored provider key |
| `rotateKey(provider, newKey)` | Live-validate + atomically replace a key |
| `register()` | Register and get a relay token |
| `ensureToken()` | Get stored token, auto-registering if needed |
| `logout()` | Clear local token |
| `health(deep?)` | Relay health check |
| `stats(appId?)` | Per-user usage stats |
| `deleteAccount()` | Delete account + all keys (GDPR) |

### ByokRelayStream

Returned by `chat.completions.create({ stream: true })`.

```js
const stream = await client.chat.completions.create({ ..., stream: true });

// Iterate chunks (identical to openai SDK):
for await (const chunk of stream) { ... }

// Or collect into a final completion object:
const final = await stream.finalChatCompletion();
// { id, object, model, choices: [{ message: { role, content, tool_calls }, finish_reason }] }
```

## Providers supported

| Provider | `provider` value | Key format |
|----------|------------------|------------|
| OpenAI | `openai` | `sk-...` |
| Anthropic | `anthropic` | `sk-ant-...` |
| Groq | `groq` | `gsk_...` |
| Mistral | `mistral` | 32-char hex |
| OpenRouter | `openrouter` | `sk-or-...` |
| ElevenLabs | `elevenlabs` | 32-char hex |
| HuggingFace | `huggingface` | `hf_...` |
| Deepgram | `deepgram` | 40-char hex |

## Self-hosting

```bash
# Run your own relay
npx byok-relay
# or: docker compose up

# Point the client at it
const client = new ByokRelayOpenAI({ relayUrl: 'http://localhost:3000' });
```

See [byok-relay](https://github.com/avikalpg/byok-relay) for full self-hosting docs.

## Related packages

| Package | Use case |
|---------|----------|
| [`@byok-relay/client`](../client) | Low-level relay client (no SDK compat layer) |
| [`@byok-relay/react`](../react) | React hooks (`useChat`, `useStreamingChat`) |
| [`@byok-relay/vercel-ai`](../vercel-ai) | Vercel AI SDK custom provider |
| [`@byok-relay/langchain`](../langchain) | LangChain.js chat model + embeddings |
| [`@byok-relay/llamaindex`](../llamaindex) | LlamaIndex.TS LLM + embedding |
| [`@byok-relay/next`](../next) | Next.js App Router route handlers + hooks |
| [`@byok-relay/hono`](../hono) | Hono middleware for edge runtimes |
| [`@byok-relay/mcp`](../mcp) | MCP server for Claude Desktop / Claude Code |

# @byok-relay/llamaindex

LlamaIndex.TS custom LLM and embedding adapter for [byok-relay](https://byokrelay.com) — the open-source BYOK AI relay.

Use any LlamaIndex pipeline (RAG, agents, query engines) with user-supplied API keys stored securely on a relay — no backend code required.

```bash
npm install @byok-relay/llamaindex
# peer dep (optional — shim loads without it)
npm install llamaindex
```

---

## Quick start — Chat

```js
import { ByokRelayLLM } from '@byok-relay/llamaindex';

const llm = new ByokRelayLLM({ model: 'openai/gpt-4o' });

// Store the user's API key (once — persisted in localStorage)
await llm.storeKey('openai', 'sk-...');

// Non-streaming chat
const response = await llm.chat({
  messages: [{ role: 'user', content: 'Explain BYOK in one sentence.' }],
});
console.log(response.message.content);
```

---

## Quick start — Streaming

```js
const llm = new ByokRelayLLM({ model: 'anthropic/claude-opus-4-5' });
await llm.storeKey('anthropic', 'sk-ant-...');

for await (const chunk of llm.stream({
  messages: [{ role: 'user', content: 'Tell me a story.' }],
})) {
  process.stdout.write(chunk.delta);
}
```

---

## Quick start — Embeddings + VectorStoreIndex

```js
import { ByokRelayEmbedding } from '@byok-relay/llamaindex';
import { VectorStoreIndex, Document } from 'llamaindex';

const embed = new ByokRelayEmbedding({ model: 'openai/text-embedding-3-small' });
await embed.storeKey('openai', 'sk-...');

const docs  = [new Document({ text: 'byok-relay lets users bring their own API keys.' })];
const index = await VectorStoreIndex.fromDocuments(docs, { embedModel: embed });

const llm   = new ByokRelayLLM({ model: 'openai/gpt-4o' });
const engine = index.asQueryEngine({ llm });
const result = await engine.query({ query: 'What does byok-relay do?' });
console.log(result.response);
```

---

## Quick start — Tool calling

```js
import { ByokRelayLLM } from '@byok-relay/llamaindex';

const llm = new ByokRelayLLM({ model: 'openai/gpt-4o' });
await llm.storeKey('openai', 'sk-...');

const weatherTool = {
  name:        'get_weather',
  description: 'Get current weather for a city',
  parameters: {
    type:       'object',
    properties: {
      city: { type: 'string', description: 'City name' },
    },
    required: ['city'],
  },
};

const response = await llm.chat({
  messages: [{ role: 'user', content: 'Weather in Tokyo?' }],
  tools:    [weatherTool],
});

const toolCalls = response.message.options?.toolCall || [];
console.log(toolCalls[0]?.name);  // 'get_weather'
console.log(toolCalls[0]?.input); // { city: 'Tokyo' }
```

---

## Quick start — ReActAgent

```js
import { ByokRelayLLM } from '@byok-relay/llamaindex';
import { ReActAgent, FunctionTool } from 'llamaindex';

const llm = new ByokRelayLLM({ model: 'openai/gpt-4o' });
await llm.storeKey('openai', 'sk-...');

const multiply = FunctionTool.from(
  ({ a, b }) => String(a * b),
  {
    name:        'multiply',
    description: 'Multiply two numbers',
    parameters: {
      type:       'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
  }
);

const agent    = new ReActAgent({ llm, tools: [multiply] });
const response = await agent.chat({ message: 'What is 7 times 8?' });
console.log(response.response); // '56'
```

---

## Quick start — withTools (bound tools)

```js
const llmWithTools = llm.withTools([weatherTool, calendarTool]);

// Tools are forwarded automatically on every call
const response = await llmWithTools.chat({
  messages: [{ role: 'user', content: 'Am I free tomorrow?' }],
});
```

---

## ByokRelayLLM options

| Option | Type | Default | Description |
|---|---|---|---|
| `model` | `string` | `'openai/gpt-4o'` | `"provider/model"` or bare model name |
| `relayUrl` | `string` | managed relay | Relay base URL |
| `appId` | `string` | `'llamaindex-app'` | App identifier (groups users in stats) |
| `storage` | `object` | `localStorage` / in-memory | Custom storage adapter `{ getItem, setItem, removeItem }` |
| `maxTokens` | `number` | — | `max_tokens` forwarded to provider |
| `temperature` | `number` | — | `temperature` forwarded to provider |
| `extraParams` | `object` | `{}` | Additional body params forwarded to provider |

---

## ByokRelayLLM methods

| Method | Description |
|---|---|
| `chat({ messages, tools? })` | Non-streaming chat → `ChatResponse` |
| `stream({ messages, tools? })` | Async-generator streaming → yields `{ delta, raw, options }` |
| `complete({ prompt, stream? })` | Single-turn completion |
| `withTools(tools)` | Return new LLM instance with bound ToolMetadata array |
| `storeKey(provider, apiKey)` | Store/update provider API key on relay |
| `listKeys()` | List stored provider keys |
| `deleteKey(provider)` | Delete a stored provider key |
| `rotateKey(provider, newKey)` | Atomically rotate provider key (validates live before swap) |
| `health(deep?)` | Relay liveness / readiness probe |
| `stats(appId?)` | Per-user or operator aggregate usage stats |
| `deleteAccount()` | GDPR erasure — deletes all keys + token |

---

## ByokRelayEmbedding options

| Option | Type | Default | Description |
|---|---|---|---|
| `model` | `string` | `'openai/text-embedding-3-small'` | `"provider/model"` |
| `relayUrl` | `string` | managed relay | Relay base URL |
| `appId` | `string` | `'llamaindex-app'` | App identifier |
| `storage` | `object` | `localStorage` / in-memory | Custom storage adapter |
| `batchSize` | `number` | `512` | Documents per batch |
| `encodingFormat` | `string` | `'float'` | `'float'` or `'base64'` |

---

## ByokRelayEmbedding methods

| Method | Description |
|---|---|
| `getQueryEmbedding(text)` | Single query embedding → `number[]` |
| `getTextEmbedding(text)` | Single document embedding → `number[]` |
| `getTextEmbeddings(texts)` | Batch with auto-batching → `number[][]` |
| `storeKey(provider, apiKey)` | Store provider API key |
| `listKeys()` | List stored keys |
| `deleteKey(provider)` | Delete a stored key |
| `health(deep?)` | Relay health probe |

---

## ByokRelayClient (plain JS, no LlamaIndex dep)

```js
import { ByokRelayClient } from '@byok-relay/llamaindex';

const client = new ByokRelayClient({
  relayUrl: 'https://your-relay.example.com',
  appId:    'my-app',
});

const token = await client.ensureToken();
await client.storeKey('openai', 'sk-...');

// Forward any provider API call
const res  = await client.relayRequest('openai', 'chat/completions', {
  method:  'POST',
  headers: { 'Content-Type': 'application/json' },
  body:    JSON.stringify({ model: 'gpt-4o', messages: [...] }),
});
const data = await res.json();
```

### ByokRelayClient API

| Method | Description |
|---|---|
| `ensureToken()` | Get or create relay token |
| `register()` | Force new registration |
| `logout()` | Clear token from storage |
| `storeKey(provider, key)` | Store provider API key |
| `listKeys()` | List stored keys |
| `deleteKey(provider)` | Delete a stored key |
| `rotateKey(provider, newKey)` | Rotate provider key |
| `relayRequest(provider, path, init)` | Raw fetch to `/relay/:provider/:path` |
| `health(deep?)` | Relay health probe |
| `stats(appId?)` | Usage stats |
| `getModels()` | List allowed models |
| `deleteAccount()` | Delete account + all keys |

---

## Supported providers

| Provider | `model` prefix | Key format |
|---|---|---|
| OpenAI | `openai/` | `sk-...` |
| Anthropic | `anthropic/` | `sk-ant-...` |
| Groq | `groq/` | `gsk_...` |
| Mistral | `mistral/` | `...` |
| Cohere | `cohere/` | `...` |
| OpenRouter | `openrouter/` | `sk-or-...` |
| HuggingFace | `huggingface/` | `hf_...` |

---

## Self-hosting

Set `relayUrl` to your own relay instance:

```js
const llm = new ByokRelayLLM({
  model:    'openai/gpt-4o',
  relayUrl: 'https://your-relay.example.com',
});
```

Deploy in one command:

```bash
docker compose up -d   # see byok-relay repo for docker-compose.yml
```

---

## Key differentiator vs `@byok-relay/langchain`

| | `@byok-relay/llamaindex` | `@byok-relay/langchain` |
|---|---|---|
| Framework | LlamaIndex.TS | LangChain.js |
| LLM base | `BaseLLM` | `BaseChatModel` |
| Embedding base | `BaseEmbedding` | `Embeddings` |
| Tool calling | `withTools()` + per-call `tools` | `bindTools()` |
| VectorStore | `VectorStoreIndex.fromDocuments({ embedModel })` | `FAISS.fromTexts({ embeddings })` |
| Streaming | async-generator yielding `{ delta }` | async-generator yielding `AIMessageChunk` |

---

## Related packages

- [`@byok-relay/langchain`](https://npmjs.com/package/@byok-relay/langchain) — LangChain.js chat model + embeddings
- [`@byok-relay/react`](https://npmjs.com/package/@byok-relay/react) — React hooks
- [`@byok-relay/vercel-ai`](https://npmjs.com/package/@byok-relay/vercel-ai) — Vercel AI SDK provider
- [`@byok-relay/next`](https://npmjs.com/package/@byok-relay/next) — Next.js App Router
- [`@byok-relay/mcp`](https://npmjs.com/package/@byok-relay/mcp) — Claude Desktop / Claude Code MCP server
- [`byok-relay`](https://npmjs.com/package/byok-relay) — Self-hosted relay server

---

## License

MIT — [byokrelay.com](https://byokrelay.com)

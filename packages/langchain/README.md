# @byok-relay/langchain

LangChain.js custom chat model and embeddings adapter for [byok-relay](https://github.com/avikalpg/byok-relay).

Use **user-supplied AI provider keys** in your LangChain chains, agents, and RAG pipelines — without storing keys server-side. Keys are encrypted at rest in the relay; your server only sees a relay token.

```bash
npm install @byok-relay/langchain @langchain/core
```

---

## Quick start — chat model

```js
import { ByokRelayChatModel } from '@byok-relay/langchain';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

// Point at your relay (self-hosted or managed)
const model = new ByokRelayChatModel({
  relayUrl:   process.env.RELAY_URL,   // or 'https://relay.byokrelay.com'
  modelName:  'openai/gpt-4o',         // 'provider/model' or bare model name
  temperature: 0.7,
});

// One-time setup: user supplies their key through your settings UI
await model.storeKey('openai', 'sk-...');

// Use in any LangChain chain
const result = await model.invoke([
  new SystemMessage('You are a helpful assistant.'),
  new HumanMessage('Explain BYOK in one sentence.'),
]);
console.log(result.content);
```

---

## Streaming

```js
import { ByokRelayChatModel } from '@byok-relay/langchain';
import { HumanMessage } from '@langchain/core/messages';

const model = new ByokRelayChatModel({ modelName: 'anthropic/claude-3-5-sonnet-20241022' });
await model.storeKey('anthropic', 'sk-ant-...');

const stream = await model.stream([new HumanMessage('Write a haiku about relay proxies.')]);
for await (const chunk of stream) {
  process.stdout.write(chunk.content);
}
```

---

## Tool calling

```js
import { ByokRelayChatModel } from '@byok-relay/langchain';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';

const weatherTool = {
  name:        'get_weather',
  description: 'Get current weather for a city',
  schema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' },
    },
    required: ['city'],
  },
};

const model = new ByokRelayChatModel({ modelName: 'openai/gpt-4o' });
const modelWithTools = model.bindTools([weatherTool]);

const result = await modelWithTools.invoke([new HumanMessage('Weather in Tokyo?')]);
// result.tool_calls → [{ name: 'get_weather', args: { city: 'Tokyo' }, id: 'call_...' }]

// Execute tool and continue
const toolResult = await getWeather(result.tool_calls[0].args);
const final = await modelWithTools.invoke([
  new HumanMessage('Weather in Tokyo?'),
  result,
  new ToolMessage(JSON.stringify(toolResult), result.tool_calls[0].id),
]);
```

---

## Embeddings

```js
import { ByokRelayEmbeddings } from '@byok-relay/langchain';

const embeddings = new ByokRelayEmbeddings({
  relayUrl:  process.env.RELAY_URL,
  modelName: 'openai/text-embedding-3-small',
  batchSize: 512,  // texts per request (default: 512)
});

await embeddings.storeKey('openai', 'sk-...');

// Embed documents for a vector store
const vectors = await embeddings.embedDocuments([
  'BYOK means users bring their own API keys.',
  'byok-relay stores keys encrypted with AES-256-GCM.',
]);

// Embed a query
const queryVec = await embeddings.embedQuery('how are keys stored?');
```

### With LangChain vector stores (FAISS, Chroma, etc.)

```js
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { ByokRelayEmbeddings } from '@byok-relay/langchain';

const embeddings = new ByokRelayEmbeddings({ modelName: 'openai/text-embedding-3-small' });
await embeddings.storeKey('openai', 'sk-...');

const store = await MemoryVectorStore.fromTexts(
  ['byok-relay is a BYOK AI gateway', 'keys are AES-256-GCM encrypted'],
  [{ id: 1 }, { id: 2 }],
  embeddings,
);

const results = await store.similaritySearch('how are keys protected?', 1);
```

---

## LangChain Expression Language (LCEL)

```js
import { ByokRelayChatModel } from '@byok-relay/langchain';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';

const model  = new ByokRelayChatModel({ modelName: 'openai/gpt-4o' });
const prompt = ChatPromptTemplate.fromMessages([
  ['system', 'You are a concise technical writer.'],
  ['human', '{input}'],
]);
const parser = new StringOutputParser();

const chain = prompt.pipe(model).pipe(parser);

const answer = await chain.invoke({ input: 'What is BYOK?' });
```

### Streaming with LCEL

```js
const stream = await chain.stream({ input: 'Explain LLM proxies.' });
for await (const chunk of stream) {
  process.stdout.write(chunk);
}
```

---

## ReAct agent

```js
import { ByokRelayChatModel } from '@byok-relay/langchain';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const model = new ByokRelayChatModel({ modelName: 'openai/gpt-4o' });

const searchTool = tool(
  async ({ query }) => `Results for: ${query}`,
  {
    name:        'web_search',
    description: 'Search the web for information',
    schema:      z.object({ query: z.string() }),
  },
);

const agent = createReactAgent({ llm: model, tools: [searchTool] });

const result = await agent.invoke({
  messages: [{ role: 'user', content: 'Search for byok-relay GitHub stats' }],
});
```

---

## API reference

### `ByokRelayChatModel`

Extends `BaseChatModel` from `@langchain/core`. Compatible with all LangChain chains, agents, and LCEL pipelines.

| Constructor option | Type     | Default                               | Description                                      |
|--------------------|----------|---------------------------------------|--------------------------------------------------|
| `relayUrl`         | `string` | `RELAY_URL` env or managed relay      | Upstream relay base URL                          |
| `appId`            | `string` | `'langchain-app'`                     | App identifier (scopes localStorage key)         |
| `modelName`        | `string` | `'openai/gpt-4o'`                     | `'provider/model'` or bare model name            |
| `temperature`      | `number` | `0.7`                                 |                                                  |
| `maxTokens`        | `number` | `undefined`                           | `max_tokens` forwarded to provider               |
| `storage`          | `object` | `localStorage` / in-memory fallback   | Custom `{ get, set, remove }` adapter            |

| Method                              | Description                                            |
|-------------------------------------|--------------------------------------------------------|
| `storeKey(provider, apiKey)`        | Encrypt and store a provider API key in the relay      |
| `listKeys()`                        | List stored provider key names for this app            |
| `bindTools(tools, kwargs?)`         | Return new model with tools bound for tool calling     |
| `invoke(messages, opts?)`           | Non-streaming completion (LangChain standard)          |
| `stream(messages, opts?)`           | Streaming completion (LangChain standard)              |
| `_generate(messages, opts?)`        | Internal; called by LangChain BaseChain                |
| `_stream(messages, opts?)`          | Internal; called by LangChain streaming                |

### `ByokRelayEmbeddings`

Extends `Embeddings` from `@langchain/core`. Drop-in for any LangChain vector store.

| Constructor option | Type     | Default                           | Description                        |
|--------------------|----------|-----------------------------------|------------------------------------|
| `relayUrl`         | `string` | `RELAY_URL` env or managed relay  | Upstream relay base URL            |
| `appId`            | `string` | `'langchain-app'`                 |                                    |
| `modelName`        | `string` | `'openai/text-embedding-3-small'` | `'provider/model'`                 |
| `batchSize`        | `number` | `512`                             | Texts per embeddings request       |
| `storage`          | `object` | localStorage / in-memory          | Custom `{ get, set, remove }`      |

| Method                              | Description                                 |
|-------------------------------------|---------------------------------------------|
| `storeKey(provider, apiKey)`        | Store provider key                          |
| `embedDocuments(texts)`             | Embed array of texts (auto-batches)         |
| `embedQuery(text)`                  | Embed a single query string                 |

### `ByokRelayClient`

Plain-JS key management client — no LangChain dependency.

| Method                              | Description                                        |
|-------------------------------------|----------------------------------------------------|
| `register(appId?)`                  | Create account, get relay token                    |
| `ensureToken()`                     | Return cached or auto-register token               |
| `logout()`                          | Remove cached token                                |
| `storeKey(provider, apiKey)`        | Store encrypted provider API key                   |
| `listKeys()`                        | List stored providers                              |
| `deleteKey(provider)`               | Delete a stored key                                |
| `rotateKey(provider, newKey)`       | Atomically rotate a provider key (validates first) |
| `relayRequest(path, body, headers)` | Low-level relay forward                            |
| `chat({ model, messages })`         | Unified model routing (non-streaming)              |
| `streamChat({ model, messages })`   | Streaming (async generator)                        |
| `health(deep?)`                     | Relay liveness / readiness                         |
| `stats(appId?)`                     | Per-user/app usage stats                           |
| `getModels()`                       | List allowed models                                |
| `deleteAccount()`                   | GDPR erasure — delete account + all keys           |

---

## Supported providers

| Provider    | modelName prefix  | Example model                           |
|-------------|-------------------|-----------------------------------------|
| OpenAI      | `openai/`         | `openai/gpt-4o`, `openai/gpt-4o-mini`  |
| Anthropic   | `anthropic/`      | `anthropic/claude-3-5-sonnet-20241022`  |
| Groq        | `groq/`           | `groq/llama-3.1-70b-versatile`          |
| Mistral     | `mistral/`        | `mistral/mistral-large-latest`          |
| OpenRouter  | `openrouter/`     | `openrouter/meta-llama/llama-3.1-70b`  |
| HuggingFace | `huggingface/`    | `huggingface/mistralai/Mixtral-8x7B-v0.1` |

Bare model names (e.g. `gpt-4o`) default to the OpenAI provider.

---

## Self-hosting

```bash
# Start relay locally
git clone https://github.com/avikalpg/byok-relay
cd byok-relay && npm install && npm start

# Point your model at localhost
const model = new ByokRelayChatModel({ relayUrl: 'http://localhost:3000' });
```

Or use the managed relay at `https://relay.byokrelay.com` (keys never leave your encrypted store).

---

## Related packages

| Package                      | Use case                              |
|------------------------------|---------------------------------------|
| `@byok-relay/react`          | React hooks                           |
| `@byok-relay/next`           | Next.js App Router                    |
| `@byok-relay/vercel-ai`      | Vercel AI SDK custom provider         |
| `@byok-relay/express`        | Express middleware                    |
| `@byok-relay/hono`           | Hono / Cloudflare Workers             |
| `@byok-relay/mcp`            | Claude Desktop / Claude Code MCP      |
| `@byok-relay/client`         | Vanilla JS / framework-agnostic       |

Full list: [github.com/avikalpg/byok-relay](https://github.com/avikalpg/byok-relay)

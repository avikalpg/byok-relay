# @byok-relay/vercel-ai

**Vercel AI SDK custom provider adapter for [byok-relay](https://byokrelay.com)**

Route `generateText`, `streamText`, `generateObject`, and any other Vercel AI SDK function through **byok-relay** so your users bring their own API keys — no vendor lock-in, no you-pay-the-bill.

```bash
npm install @byok-relay/vercel-ai
```

---

## How it works

```
Your App ──► @byok-relay/vercel-ai ──► byok-relay ──► OpenAI / Anthropic / Groq / …
```

1. The user's API key is stored in byok-relay (AES-256-GCM encrypted at rest)
2. Your app uses `generateText` / `streamText` exactly as usual
3. byok-relay forwards requests to the real provider using the user's key
4. **You never touch the API key** — no server-side secret management needed

---

## Quick start (Next.js App Router)

```ts
// app/api/chat/route.ts
import { createByokRelayProviderSync } from '@byok-relay/vercel-ai';
import { streamText } from 'ai';

const byokProvider = createByokRelayProviderSync({
  relayUrl: process.env.BYOK_RELAY_URL ?? 'https://relay.byokrelay.com',
  appId: 'my-chat-app',
});

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: byokProvider.languageModel('openai/gpt-4o'),
    messages,
  });

  return result.toDataStreamResponse();
}
```

```tsx
// app/page.tsx
'use client';
import { useChat } from 'ai/react';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat();

  return (
    <form onSubmit={handleSubmit}>
      {messages.map(m => (
        <p key={m.id}><strong>{m.role}:</strong> {m.content}</p>
      ))}
      <input value={input} onChange={handleInputChange} placeholder="Chat…" />
      <button type="submit">Send</button>
    </form>
  );
}
```

---

## One-time setup: store the user's API key

Call `storeKey()` once when the user enters their API key (e.g. in a settings page):

```ts
const byokProvider = createByokRelayProviderSync({ relayUrl, appId: 'my-app' });

// Store key (call once from a settings form)
await byokProvider.storeKey('openai', userEnteredOpenAIKey);

// From now on, all generateText / streamText calls use that key automatically
const { text } = await generateText({
  model: byokProvider.languageModel('openai/gpt-4o'),
  prompt: 'Hello!',
});
```

---

## API

### `createByokRelayProviderSync(config)` _(synchronous factory)_

Returns a provider immediately. Token registration happens lazily on first use.
Best for module-scope initialization in Next.js / SvelteKit / Nuxt.

```ts
const provider = createByokRelayProviderSync({
  relayUrl: 'https://relay.byokrelay.com', // Required
  appId: 'my-app',                          // Optional, default: 'vercel-ai'
  storage: customStorage,                   // Optional, default: localStorage / in-memory
  settings: { temperature: 0.7 },          // Optional default model settings
});
```

### `createByokRelayProvider(config)` _(async factory)_

Same as above but awaits token registration before returning. Use when you need the token immediately.

```ts
const provider = await createByokRelayProvider({ relayUrl, appId: 'my-app' });
```

### `provider.languageModel(modelId, overrides?)`

Returns a `LanguageModelV1`-compatible model for any AI SDK function.

```ts
// 'provider/model' format — explicit provider
provider.languageModel('openai/gpt-4o')
provider.languageModel('anthropic/claude-3-5-sonnet-20241022')
provider.languageModel('groq/llama3-70b-8192')
provider.languageModel('mistral/mistral-large-latest')
provider.languageModel('openrouter/meta-llama/llama-3.1-405b-instruct')

// Bare model name — defaults to OpenAI
provider.languageModel('gpt-4o-mini')

// Per-model settings override
provider.languageModel('openai/gpt-4o', { temperature: 0.2, maxTokens: 500 })
```

### `provider.chat(modelId, overrides?)`

Alias for `languageModel()` — matches the `@ai-sdk/openai` API shape.

### `provider.storeKey(providerName, apiKey)`

Store a provider API key in byok-relay for this user.

```ts
await provider.storeKey('openai', 'sk-...');
await provider.storeKey('anthropic', 'sk-ant-...');
await provider.storeKey('groq', 'gsk_...');
```

### `provider.health(deep?)`

Check relay health. Pass `deep=true` to include upstream provider ping.

```ts
const { status, checks } = await provider.health();
const { status, checks } = await provider.health(true); // deep=readiness probe
```

### `provider.stats(appId?)`

Get usage stats for this user (or aggregate for an app_id).

```ts
const stats = await provider.stats();
```

### `provider.deleteAccount()`

Delete the user's byok-relay account and all stored keys (GDPR Art. 17).

---

## Supported providers

All providers supported by byok-relay work automatically:

| Provider | Model ID prefix | Key format |
|---|---|---|
| **OpenAI** | `openai/` | `sk-...` |
| **Anthropic** | `anthropic/` | `sk-ant-...` |
| **Groq** | `groq/` | `gsk_...` |
| **Mistral** | `mistral/` | `...` |
| **OpenRouter** | `openrouter/` | `sk-or-...` |
| **Google Gemini** | `google/` | `AIza...` |
| **Any OpenAI-compatible** | custom prefix | — |

---

## Usage with AI SDK features

Works with all AI SDK core functions out of the box:

```ts
import { generateText, streamText, generateObject } from 'ai';
import { z } from 'zod';

const model = provider.languageModel('openai/gpt-4o');

// Text generation
const { text } = await generateText({ model, prompt: 'Write a haiku.' });

// Streaming
const result = streamText({ model, messages });
for await (const chunk of result.textStream) process.stdout.write(chunk);

// Structured output
const { object } = await generateObject({
  model,
  schema: z.object({ name: z.string(), age: z.number() }),
  prompt: 'Generate a person.',
});

// Tool calling
const { text: toolText } = await generateText({
  model,
  tools: {
    getWeather: tool({
      description: 'Get current weather',
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ temp: 22, city }),
    }),
  },
  prompt: 'What is the weather in Tokyo?',
});
```

---

## SvelteKit example

```ts
// src/routes/api/chat/+server.ts
import { createByokRelayProviderSync } from '@byok-relay/vercel-ai';
import { streamText } from 'ai';
import type { RequestHandler } from './$types';

const provider = createByokRelayProviderSync({
  relayUrl: import.meta.env.VITE_BYOK_RELAY_URL,
  appId: 'svelte-chat',
});

export const POST: RequestHandler = async ({ request }) => {
  const { messages } = await request.json();
  const result = streamText({ model: provider.languageModel('anthropic/claude-3-5-haiku-20241022'), messages });
  return result.toDataStreamResponse();
};
```

---

## Nuxt 3 example

```ts
// server/api/chat.post.ts
import { createByokRelayProviderSync } from '@byok-relay/vercel-ai';
import { streamText } from 'ai';

const provider = createByokRelayProviderSync({
  relayUrl: process.env.BYOK_RELAY_URL!,
  appId: 'nuxt-chat',
});

export default defineEventHandler(async (event) => {
  const { messages } = await readBody(event);
  const result = streamText({ model: provider.languageModel('groq/llama3-70b-8192'), messages });
  return result.toDataStreamResponse();
});
```

---

## Self-hosting

```bash
# Start your own relay instance
docker compose up -d   # or: npx byok-relay

# Point the provider at it
const provider = createByokRelayProviderSync({
  relayUrl: 'http://localhost:3000',
  appId: 'my-app',
});
```

See [byok-relay self-hosting docs](https://github.com/avikalpg/byok-relay#self-hosting) for full setup.

---

## Related packages

| Package | Use case |
|---|---|
| [`@byok-relay/react`](https://www.npmjs.com/package/@byok-relay/react) | React hooks |
| [`@byok-relay/vue`](https://www.npmjs.com/package/@byok-relay/vue) | Vue 3 composables |
| [`@byok-relay/svelte`](https://www.npmjs.com/package/@byok-relay/svelte) | Svelte stores |
| [`@byok-relay/solid`](https://www.npmjs.com/package/@byok-relay/solid) | SolidJS stores |
| [`@byok-relay/angular`](https://www.npmjs.com/package/@byok-relay/angular) | Angular services |
| [`@byok-relay/mcp`](https://www.npmjs.com/package/@byok-relay/mcp) | Claude Desktop / Claude Code |
| [`@byok-relay/client`](https://www.npmjs.com/package/@byok-relay/client) | Framework-agnostic JS client |

---

If this package saved you time, consider ⭐ starring [byok-relay on GitHub](https://github.com/avikalpg/byok-relay).

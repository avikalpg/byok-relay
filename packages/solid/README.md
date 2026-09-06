# @byok-relay/solid

> SolidJS reactive stores for [byok-relay](https://byokrelay.com) — drop-in BYOK AI in any SolidJS or SolidStart app.

[![npm](https://img.shields.io/npm/v/@byok-relay/solid)](https://www.npmjs.com/package/@byok-relay/solid)
[![byok-relay](https://img.shields.io/badge/byok--relay-powered-blue)](https://byokrelay.com)

Gives your SolidJS app four reactive stores that handle the full BYOK lifecycle: token registration, encrypted key storage, non-streaming chat, SSE streaming chat, and relay health polling — all with SolidJS's signal contract (`[getter, setter]`).

Works with SolidJS 1.x, SolidStart (SSR-safe via `typeof window` guard), and plain JavaScript (no SolidJS required — signals degrade to plain getters/setters).

---

## Install

```bash
npm install @byok-relay/solid
```

solid-js is an optional peer dependency. Install it if you haven't already:

```bash
npm install solid-js
```

---

## Quick start

```jsx
// App.jsx (SolidJS)
import { createSignal, For, Show } from 'solid-js';
import { createByokRelayStore, createStreamingChatStore } from '@byok-relay/solid';

export default function App() {
  const relay = createByokRelayStore({ appId: 'my-app' });
  const chat  = createStreamingChatStore({ provider: 'openai', model: 'gpt-4o-mini' });

  const [apiKey, setApiKey] = createSignal('');
  const [input,  setInput]  = createSignal('');

  async function handleSaveKey() {
    await relay.storeKey('openai', apiKey());
  }

  async function handleSend() {
    if (!relay.token()) await relay.register();
    await chat.sendMessage(input(), relay.token());
    setInput('');
  }

  return (
    <div>
      {/* API key setup */}
      <Show when={!relay.providers().includes('openai')}>
        <input
          type="password"
          placeholder="Paste your OpenAI API key"
          onInput={e => setApiKey(e.target.value)}
        />
        <button onClick={handleSaveKey}>Save key</button>
      </Show>

      {/* Chat */}
      <For each={chat.messages()}>
        {msg => <p><strong>{msg.role}</strong>: {msg.content}</p>}
      </For>
      <Show when={chat.streamingContent()}>
        <p><strong>assistant</strong>: {chat.streamingContent()}<span>▋</span></p>
      </Show>

      <input value={input()} onInput={e => setInput(e.target.value)} />
      <button onClick={handleSend} disabled={chat.loading()}>Send</button>
      <Show when={chat.loading()}>
        <button onClick={chat.stopStreaming}>Stop</button>
      </Show>
    </div>
  );
}
```

---

## SolidStart (SSR-safe)

All stores guard `localStorage` access with `typeof window !== 'undefined'`, so they are safe to import in SolidStart SSR routes. Token registration and key storage only run client-side.

```jsx
// src/routes/index.jsx
import { createByokRelayStore } from '@byok-relay/solid';

export default function Home() {
  // Safe to call in a SolidStart route — no SSR crash
  const relay = createByokRelayStore({ appId: 'solidstart-app' });
  // ...
}
```

---

## Stores

### `createByokRelayStore(opts)` — token + key management

```js
const relay = createByokRelayStore({
  relayUrl: 'https://relay.byokrelay.com', // default
  appId:    'my-app',                       // required: namespaces localStorage key
  storage:  { get, set, remove },           // optional: custom storage adapter
});

relay.token()              // Signal<string|null>   — current relay token
relay.loading()            // Signal<boolean>       — request in flight
relay.error()              // Signal<string|null>   — last error message
relay.providers()          // Signal<string[]>      — providers with stored keys

await relay.register()     // POST /users → get token (auto-called by storeKey if needed)
relay.logout()             // clear token + providers from storage
await relay.storeKey(provider, key)   // POST /keys/:provider
await relay.listKeys()                // GET  /keys
await relay.deleteKey(provider)       // DELETE /keys/:provider
await relay.health({ deep, provider }) // GET /health[?deep=1&provider=...]
```

### `createChatStore(opts)` — non-streaming stateful chat

```js
const chat = createChatStore({
  relayUrl:     'https://relay.byokrelay.com',
  provider:     'openai',       // openai | anthropic | groq | mistral | openrouter
  model:        'gpt-4o-mini',
  systemPrompt: 'You are helpful.',
  extraParams:  { temperature: 0.7 },
});

chat.messages()   // Signal<Array<{role, content}>>
chat.loading()    // Signal<boolean>
chat.error()      // Signal<string|null>

await chat.sendMessage(content, relayToken)
chat.clearMessages()
```

### `createStreamingChatStore(opts)` — SSE streaming with live signal

```js
const chat = createStreamingChatStore({
  relayUrl:     'https://relay.byokrelay.com',
  provider:     'openai',
  model:        'gpt-4o-mini',
  systemPrompt: 'You are helpful.',
  extraParams:  {},
});

chat.messages()          // Signal<Array<{role, content}>>  — committed messages
chat.streamingContent()  // Signal<string>                  — live partial text
chat.loading()           // Signal<boolean>
chat.error()             // Signal<string|null>

await chat.sendMessage(content, relayToken)
chat.stopStreaming()  // AbortController abort + commit partial
chat.clearMessages()  // stops stream + clears all
```

### `createRelayHealthStore(opts)` — relay health polling

```js
const health = createRelayHealthStore({
  relayUrl:   'https://relay.byokrelay.com',
  intervalMs: 60_000, // default: 60s; 0 = no polling
  deep:       false,  // true = upstream provider ping
  provider:   'openai',
});

health.status()   // Signal<'ok'|'error'|'loading'|null>
health.health()   // Signal<object|null>  — raw /health response
health.error()    // Signal<string|null>

await health.refetch()
health.destroy()   // stop polling (call in onCleanup())
```

#### SolidJS cleanup example

```jsx
import { onCleanup } from 'solid-js';
import { createRelayHealthStore } from '@byok-relay/solid';

function StatusBadge() {
  const h = createRelayHealthStore({ intervalMs: 30_000 });
  onCleanup(() => h.destroy());
  return <span>{h.status() === 'ok' ? '🟢 Online' : '🔴 Offline'}</span>;
}
```

---

## Supported providers

| Provider | `provider` value | Notes |
|---|---|---|
| OpenAI | `openai` | GPT-4o, GPT-4o-mini, o1, o3-mini |
| Anthropic | `anthropic` | Claude 3.5 Haiku, Sonnet, Opus |
| Groq | `groq` | Llama 3, Mixtral (fast inference) |
| Mistral | `mistral` | mistral-large-latest |
| OpenRouter | `openrouter` | Any model via openrouter.ai |

---

## Self-hosting

Point `relayUrl` at your own byok-relay instance:

```js
const relay = createByokRelayStore({
  relayUrl: 'https://relay.yourdomain.com',
  appId:    'my-app',
});
```

Deploy in under 5 minutes:

```bash
git clone https://github.com/avikalpg/byok-relay.git && cd byok-relay
echo "ENCRYPTION_SECRET=$(openssl rand -hex 32)" > .env
echo "ALLOWED_ORIGINS=https://my-solidjs-app.com" >> .env
npm install && npm start
```

Or use [Railway one-click deploy](https://byokrelay.com) (persistent SQLite, recommended for production).

---

## Related packages

| Package | Framework |
|---|---|
| [`@byok-relay/react`](https://www.npmjs.com/package/@byok-relay/react) | React hooks |
| [`@byok-relay/vue`](https://www.npmjs.com/package/@byok-relay/vue) | Vue 3 composables |
| [`@byok-relay/svelte`](https://www.npmjs.com/package/@byok-relay/svelte) | Svelte stores |
| [`@byok-relay/solid`](https://www.npmjs.com/package/@byok-relay/solid) | SolidJS signals ← you are here |
| [`@byok-relay/mcp`](https://www.npmjs.com/package/@byok-relay/mcp) | MCP server (Claude Desktop) |
| [`@byok-relay/client`](https://www.npmjs.com/package/@byok-relay/client) | Universal JS client |

---

## License

Apache-2.0 — [byokrelay.com](https://byokrelay.com)

If this package saved you time, consider ⭐ starring [avikalpg/byok-relay](https://github.com/avikalpg/byok-relay).

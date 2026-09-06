# @byok-relay/preact

Preact hooks for [byok-relay](https://byokrelay.com) — the BYOK AI relay that lets your users supply their own API keys from any frontend app.

Works in **Preact**, **Astro component islands**, **Vite apps**, and anywhere Preact (or React) runs. SSR-safe out of the box.

```
npm install @byok-relay/preact
```

---

## Quick start

```jsx
import { useByokRelay, useStreamingChat } from '@byok-relay/preact';

export function App() {
  const { token, getToken, storeKey } = useByokRelay({
    relayUrl: 'https://relay.byokrelay.com',
    appId: 'my-app',
  });

  const { messages, streamingContent, isStreaming, sendMessage } = useStreamingChat({
    relayUrl: 'https://relay.byokrelay.com',
    appId: 'my-app',
    provider: 'openai',
    model: 'gpt-4o-mini',
  });

  return (
    <div>
      {messages.map((m, i) => <p key={i}><b>{m.role}:</b> {m.content}</p>)}
      {isStreaming && <p><em>{streamingContent}</em></p>}
      <button onClick={() => sendMessage('Hello!')}>Send</button>
    </div>
  );
}
```

---

## Astro component island

```astro
---
// src/pages/index.astro
import ChatWidget from '../components/ChatWidget.jsx';
---

<ChatWidget client:load />
```

```jsx
// src/components/ChatWidget.jsx
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { useStreamingChat, useByokRelay } from '@byok-relay/preact';

export default function ChatWidget() {
  const { storeKey, listKeys } = useByokRelay({
    relayUrl: import.meta.env.PUBLIC_RELAY_URL,
    appId: 'astro-app',
  });

  const { messages, streamingContent, isStreaming, sendMessage, stopStreaming } = useStreamingChat({
    relayUrl: import.meta.env.PUBLIC_RELAY_URL,
    appId: 'astro-app',
    provider: 'openai',
    model: 'gpt-4o-mini',
  });

  const [input, setInput] = useState('');

  return (
    <div>
      <div>
        {messages.map((m, i) => (
          <div key={i} class={`msg ${m.role}`}>
            <strong>{m.role}:</strong> {m.content}
          </div>
        ))}
        {isStreaming && <div class="msg assistant streaming">{streamingContent}</div>}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); sendMessage(input); setInput(''); }}>
        <input value={input} onInput={(e) => setInput(e.target.value)} placeholder="Type a message..." />
        {isStreaming
          ? <button type="button" onClick={stopStreaming}>Stop</button>
          : <button type="submit">Send</button>
        }
      </form>
    </div>
  );
}
```

**`astro.config.mjs`:**

```js
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';

export default defineConfig({
  integrations: [preact()],
});
```

---

## Hooks

### `useByokRelay(opts)`

Core relay hook — token registration, key management, logout.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `relayUrl` | `string` | — | byok-relay server base URL |
| `appId` | `string` | — | Your application ID |
| `storageKey` | `string` | `"byok_relay"` | localStorage key prefix |

Returns:

| Property | Type | Description |
|----------|------|-------------|
| `token` | `string\|null` | Current relay token |
| `loading` | `boolean` | Registration in progress |
| `error` | `string\|null` | Last error message |
| `getToken()` | `() => Promise<string\|null>` | Get cached token or register a new user |
| `storeKey(provider, apiKey)` | `(string, string) => Promise<{ok, ...}>` | Store a provider API key |
| `deleteKey(provider)` | `(string) => Promise<{ok}>` | Delete a stored key |
| `listKeys()` | `() => Promise<string[]>` | List stored key names |
| `logout()` | `() => void` | Remove token from storage |

---

### `useChat(opts)`

Non-streaming chat hook with persistent message history.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `relayUrl` | `string` | — | byok-relay server base URL |
| `appId` | `string` | — | Your application ID |
| `provider` | `string` | `"openai"` | `"openai"` \| `"anthropic"` \| `"groq"` \| `"mistral"` \| `"openrouter"` |
| `model` | `string` | `"gpt-4o-mini"` | Model name |
| `systemPrompt` | `string` | — | Optional system message |
| `extraParams` | `object` | `{}` | Extra body params forwarded to the provider |

Returns `{ messages, loading, error, sendMessage(content), clearMessages() }`.

---

### `useStreamingChat(opts)`

SSE streaming chat hook. Same options as `useChat`.

Returns:

| Property | Description |
|----------|-------------|
| `messages` | Completed message history `[{role, content}]` |
| `streamingContent` | Live partial content while streaming |
| `isStreaming` | `true` while a stream is active |
| `error` | Last error string |
| `sendMessage(content)` | Start a new user turn |
| `stopStreaming()` | Abort the active stream |
| `clearMessages()` | Reset history and streaming state |

---

### `useRelayHealth(opts)`

Polls the relay `/health` endpoint.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `relayUrl` | `string` | — | byok-relay server base URL |
| `intervalMs` | `number` | `30000` | Poll interval in ms; `0` = one-shot |
| `deep` | `boolean` | `false` | Use `?deep=1` readiness probe |

Returns `{ health, loading, error, check(deep?) }`.

---

## Supported providers

| Provider | `provider` value | Notes |
|----------|-----------------|-------|
| OpenAI | `"openai"` | GPT-4o, GPT-4o-mini, o1, ... |
| Anthropic | `"anthropic"` | Claude 3.5 Sonnet, Haiku, ... |
| Groq | `"groq"` | Llama, Mixtral (fast inference) |
| Mistral | `"mistral"` | Mistral Large, Small, ... |
| OpenRouter | `"openrouter"` | 200+ models via one key |

---

## Self-hosting

Point `relayUrl` at your own instance:

```bash
docker compose up -d   # or: npx byok-relay
```

See the [byok-relay docs](https://byokrelay.com) for full setup.

---

## Related packages

| Package | Description |
|---------|-------------|
| [`@byok-relay/react`](../react) | React hooks |
| [`@byok-relay/vue`](../vue) | Vue 3 composables |
| [`@byok-relay/svelte`](../svelte) | Svelte stores |
| [`@byok-relay/solid`](../solid) | SolidJS stores |
| [`@byok-relay/angular`](../angular) | Angular injectable services |
| [`@byok-relay/vercel-ai`](../vercel-ai) | Vercel AI SDK custom provider |
| [`@byok-relay/mcp`](../mcp) | MCP server for Claude Desktop |
| [`@byok-relay/client`](../client) | Vanilla JS client |

---

If this package saved you time, consider ⭐ [starring the repo](https://github.com/avikalpg/byok-relay).

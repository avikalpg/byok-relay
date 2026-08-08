# @byok-relay/react

React hooks for [byok-relay](https://byokrelay.com) — drop-in BYOK AI in any React app.

No backend. No API key in your code. Users bring their own keys; you ship the UI.

```bash
npm install @byok-relay/react
```

> **Peer dependency:** React ≥ 17

---

## Hooks

| Hook | What it does |
|------|-------------|
| [`useByokRelay`](#usebyokrelay) | Core — token registration, key storage, key deletion |
| [`useChat`](#usechat) | Stateful chat with message history (non-streaming) |
| [`useStreamingChat`](#usestreamingchat) | Streaming chat — tokens arrive in real time |
| [`useRelayHealth`](#userelayhealth) | Poll relay `/health` endpoint |

---

## Quick start

```jsx
import { useChat } from '@byok-relay/react';

export function ChatWidget() {
  const { messages, sendMessage, isLoading } = useChat({
    appId: 'my-app',
    provider: 'openai',
    model: 'gpt-4o',
    // relayUrl defaults to https://relay.byokrelay.com (free managed relay)
    // For production: self-host byok-relay and point relayUrl to your server
  });

  const [input, setInput] = React.useState('');

  return (
    <div>
      <div className="messages">
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>{m.content}</div>
        ))}
      </div>
      <input value={input} onChange={e => setInput(e.target.value)} />
      <button
        disabled={isLoading}
        onClick={() => { sendMessage(input); setInput(''); }}
      >
        {isLoading ? '…' : 'Send'}
      </button>
    </div>
  );
}
```

Add a key-entry form so users can paste in their own OpenAI key:

```jsx
import { useByokRelay } from '@byok-relay/react';

export function ApiKeyForm() {
  const { storeKey, isRegistered } = useByokRelay({ appId: 'my-app' });
  const [key, setKey] = React.useState('');
  const [saved, setSaved] = React.useState(false);

  async function handleSave() {
    await storeKey('openai', key);
    setSaved(true);
  }

  return (
    <div>
      <input
        type="password"
        placeholder="sk-…"
        value={key}
        onChange={e => setKey(e.target.value)}
      />
      <button onClick={handleSave}>{saved ? '✅ Saved' : 'Save key'}</button>
      <p>Your key is encrypted and stored on the relay. It never appears in your code.</p>
    </div>
  );
}
```

---

## API

### `useByokRelay`

Manages relay token (auto-stored in `localStorage`) and key CRUD.

```jsx
const {
  token,         // string | null — current relay token
  isRegistered,  // boolean
  register,      // () => Promise<string> — get a new relay token
  storeKey,      // (provider, apiKey) => Promise<void>
  deleteKey,     // (provider) => Promise<void>
  listProviders, // () => Promise<string[]>
  logout,        // () => void — clear token from localStorage
  error,         // string | null
} = useByokRelay({ relayUrl?, appId });
```

**Options**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `relayUrl` | string | `https://relay.byokrelay.com` | Your relay server URL |
| `appId` | string | required | Your app identifier |

---

### `useChat`

Stateful chat — manages message list, sends requests, returns assistant reply.

```jsx
const {
  messages,      // Array<{ role: 'user'|'assistant', content: string }>
  sendMessage,   // (content: string) => Promise<string>
  isLoading,     // boolean
  error,         // string | null
  clearMessages, // () => void
} = useChat({ relayUrl?, appId, provider?, model?, systemPrompt?, extraParams? });
```

**Options**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `relayUrl` | string | managed relay | Your relay server URL |
| `appId` | string | required | App identifier |
| `provider` | string | `'openai'` | `openai` \| `anthropic` \| `groq` \| `mistral` \| `openrouter` |
| `model` | string | `'gpt-4o'` | Model name |
| `systemPrompt` | string | — | Prepended as system message |
| `extraParams` | object | `{}` | Extra body params forwarded to provider |

**Example — Anthropic**

```jsx
const chat = useChat({
  appId: 'my-app',
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  systemPrompt: 'You are a concise assistant.',
});
```

---

### `useStreamingChat`

Streaming variant — tokens stream in real time via SSE.

```jsx
const {
  messages,          // completed messages
  sendMessage,       // (content: string) => Promise<string>
  streamingContent,  // string — in-progress assistant text
  isStreaming,       // boolean
  stopStreaming,     // () => void — abort in-flight stream
  error,             // string | null
  clearMessages,     // () => void
} = useStreamingChat({ relayUrl?, appId, provider?, model?, systemPrompt?, extraParams? });
```

**Example**

```jsx
export function StreamingDemo() {
  const { messages, sendMessage, streamingContent, isStreaming, stopStreaming } =
    useStreamingChat({ appId: 'my-app', provider: 'openai', model: 'gpt-4o' });

  return (
    <div>
      {messages.map((m, i) => <div key={i}><b>{m.role}:</b> {m.content}</div>)}
      {isStreaming && <div className="streaming">{streamingContent}<span className="cursor">▍</span></div>}
      {isStreaming && <button onClick={stopStreaming}>Stop</button>}
    </div>
  );
}
```

---

### `useRelayHealth`

Polls relay `/health` to check liveness.

```jsx
const {
  status,    // 'ok' | 'error' | null
  data,      // JSON response from /health
  isLoading, // boolean
  refetch,   // () => Promise<void>
} = useRelayHealth({ relayUrl?, deep? });
```

---

## Providers

| `provider` value | Provider |
|---------|----------|
| `openai` | OpenAI (GPT-4o, GPT-4, …) |
| `anthropic` | Anthropic (Claude 3.5, …) |
| `groq` | Groq |
| `mistral` | Mistral AI |
| `openrouter` | OpenRouter (200+ models) |
| any string | Passed as-is to the relay path |

---

## Self-hosting

The managed relay at `https://relay.byokrelay.com` is fine for development, but for production with real users, self-host:

```bash
git clone https://github.com/avikalpg/byok-relay.git && cd byok-relay
echo "ENCRYPTION_SECRET=$(openssl rand -hex 32)" > .env
docker compose up -d
```

Then point `relayUrl` at your server.

---

## Lovable / Bolt / Vite

Works in any React environment — Lovable, Bolt.new, Vite, Next.js, Remix, CRA.

```jsx
// In Lovable/Bolt: import directly, no config needed
import { useChat, useByokRelay } from '@byok-relay/react';
```

---

## License

MIT — [byok-relay on GitHub](https://github.com/avikalpg/byok-relay)

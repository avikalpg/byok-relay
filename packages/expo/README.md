# @byok-relay/expo

React Native / Expo hooks and client for [byok-relay](https://byokrelay.com) — BYOK AI in mobile apps with no server code.

```bash
npx expo install @byok-relay/expo @react-native-async-storage/async-storage
```

```tsx
import { useStreamingChat, useByokRelay } from '@byok-relay/expo';

export function ChatScreen() {
  const { token, register, storeKey } = useByokRelay({ relayUrl: 'https://relay.byokrelay.com' });
  const { messages, streamingContent, loading, sendMessage } = useStreamingChat({
    relayUrl: 'https://relay.byokrelay.com',
    model: 'openai/gpt-4o',
  });

  return (
    <View>
      <FlatList data={messages} renderItem={({ item }) => <Text>{item.content}</Text>} />
      {streamingContent ? <Text>{streamingContent}</Text> : null}
      <TextInput onSubmitEditing={e => sendMessage(e.nativeEvent.text)} />
    </View>
  );
}
```

## Why this package?

Mobile apps face the same BYOK problem as frontend apps — you can't ship API keys in your bundle. `@byok-relay/expo` is `@byok-relay/react` adapted for React Native:

- **AsyncStorage persistence** — relay token survives app restarts (`@react-native-async-storage/async-storage`)
- **fetch-based SSE streaming** — uses React Native's built-in `fetch` + `ReadableStream`; no `EventSource` polyfill needed
- **Hermes-safe** — no `window`, no `localStorage`, no browser globals assumed
- **Expo SecureStore** — drop-in adapter for credential-grade key storage

## Installation

```bash
# Expo managed workflow (recommended)
npx expo install @byok-relay/expo @react-native-async-storage/async-storage

# Bare React Native
npm install @byok-relay/expo @react-native-async-storage/async-storage
npx react-native link @react-native-async-storage/async-storage   # RN <0.60
```

> **AsyncStorage is optional** — if not installed, tokens are kept in memory (lost on app restart, not recommended for production).

## Quick start — Expo

```tsx
// 1. Store the user's API key once (e.g. in a settings screen)
import { useByokRelay } from '@byok-relay/expo';

function ApiKeySettings() {
  const { token, register, storeKey, listKeys } = useByokRelay({
    relayUrl: 'https://relay.byokrelay.com',
    appId: 'my-expo-app',
  });

  const handleSave = async (apiKey: string) => {
    if (!token) await register();
    await storeKey('openai', apiKey);
    alert('Key saved!');
  };

  return (
    <View>
      <Text>Enter your OpenAI key:</Text>
      <TextInput secureTextEntry onSubmitEditing={e => handleSave(e.nativeEvent.text)} />
    </View>
  );
}

// 2. Chat in any screen
import { useStreamingChat } from '@byok-relay/expo';

function ChatScreen() {
  const [input, setInput] = React.useState('');
  const { messages, streamingContent, loading, sendMessage } = useStreamingChat({
    relayUrl: 'https://relay.byokrelay.com',
    model: 'openai/gpt-4o',
    systemPrompt: 'You are a helpful assistant.',
  });

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={messages}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => (
          <View style={{ padding: 8 }}>
            <Text style={{ fontWeight: item.role === 'user' ? 'bold' : 'normal' }}>
              {item.content}
            </Text>
          </View>
        )}
      />
      {streamingContent ? <Text style={{ opacity: 0.7 }}>{streamingContent}</Text> : null}
      <View style={{ flexDirection: 'row' }}>
        <TextInput
          style={{ flex: 1 }}
          value={input}
          onChangeText={setInput}
          placeholder="Type a message..."
        />
        <Button title={loading ? '…' : 'Send'} onPress={() => { sendMessage(input); setInput(''); }} />
      </View>
    </View>
  );
}
```

## With Expo SecureStore (recommended for production)

Use `expo-secure-store` for credential-grade encrypted storage — the API key UI in your settings screen, and the relay token, are stored in the device secure enclave.

```bash
npx expo install expo-secure-store
```

```tsx
import * as SecureStore from 'expo-secure-store';
import { ByokRelayClient, createAsyncStorage } from '@byok-relay/expo';

// Wrap SecureStore in the byok-relay storage adapter contract
const secureAdapter = {
  getItem:    (key: string) => SecureStore.getItemAsync(key),
  setItem:    (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

// Use with the plain-JS client
const client = new ByokRelayClient({
  relayUrl: 'https://relay.byokrelay.com',
  storage: secureAdapter,
});

// Or with the hooks
function MyScreen() {
  const { token, register } = useByokRelay({
    relayUrl: 'https://relay.byokrelay.com',
    storage: secureAdapter,
  });
  // ...
}
```

## API Reference

### `useByokRelay(opts)`

Core hook — token registration, key CRUD, and logout. Persists the relay token to AsyncStorage.

```tsx
const {
  token,      // string | null — relay token (null until registered or restored)
  loading,    // boolean — true while registering or restoring token
  error,      // string | null — last error message
  register,   // (appId?: string) => Promise<void>
  storeKey,   // (provider: string, apiKey: string) => Promise<void>
  listKeys,   // () => Promise<KeyMeta[]>
  deleteKey,  // (provider: string) => Promise<void>
  rotateKey,  // (provider: string, newKey: string) => Promise<void>
  logout,     // () => Promise<void>
  client,     // ByokRelayClient instance for advanced use
} = useByokRelay({
  relayUrl?: string,    // default: 'https://relay.byokrelay.com'
  appId?: string,       // default: 'expo-app'
  storage?: StorageAdapter,  // default: AsyncStorage (or in-memory fallback)
});
```

---

### `useChat(opts)`

Stateful non-streaming chat. Rolls back the user message on error.

```tsx
const {
  messages,       // { role: 'user'|'assistant', content: string }[]
  loading,        // boolean
  error,          // string | null
  sendMessage,    // (content: string) => Promise<void>
  clearMessages,  // () => void
} = useChat({
  relayUrl?: string,
  model?: string,        // default: 'openai/gpt-4o'
  systemPrompt?: string,
  storage?: StorageAdapter,
  extraParams?: object,  // passed to the provider API (temperature, max_tokens, …)
});
```

---

### `useStreamingChat(opts)`

Streaming chat using `fetch` + `ReadableStream`. Compatible with React Native Hermes.

```tsx
const {
  messages,          // committed message history
  streamingContent,  // live string accumulating during stream
  loading,           // boolean
  error,             // string | null
  sendMessage,       // (content: string) => Promise<void>
  stopStreaming,      // () => void — abort in-progress stream
  clearMessages,     // () => void
} = useStreamingChat({
  relayUrl?: string,
  model?: string,
  systemPrompt?: string,
  storage?: StorageAdapter,
  extraParams?: object,
});
```

---

### `useRelayHealth(opts)`

Poll `/health` at a configurable interval.

```tsx
const {
  status,   // 'ok' | 'error' | 'unknown'
  data,     // raw /health response object
  loading,  // boolean
  refetch,  // () => Promise<void>
  check,    // (deep?: boolean, provider?: string) => Promise<object>
} = useRelayHealth({
  relayUrl?: string,
  intervalMs?: number,  // default: 30000; set to 0 to disable polling
});
```

---

### `ByokRelayClient`

Plain-JS class. Works in React Native, Expo, and Node.js test environments.

```ts
const client = new ByokRelayClient({
  relayUrl?: string,
  appId?: string,
  storage?: StorageAdapter,   // { getItem, setItem, removeItem } returning Promises
});

// Token
await client.register(appId?)              // → token string
await client.ensureToken(appId?)           // → token string (from memory, storage, or new registration)
await client.logout()                      // clears token from memory + storage

// Keys
await client.storeKey(provider, apiKey)    // → { ok }
await client.listKeys()                    // → KeyMeta[]
await client.deleteKey(provider)           // → { ok }
await client.rotateKey(provider, newKey)   // → { ok, rotated }

// Relay
await client.relayRequest(provider, path, body, method?)   // low-level
await client.chat(modelId, messages, extra?)               // non-streaming
for await (const chunk of client.streamChat(modelId, messages, { signal?, extra? }))
  // streaming text deltas

// Health & meta
await client.health(deep?, provider?)   // → /health response
await client.stats(appId?)             // → /stats response
await client.getModels()               // → /models response
await client.deleteAccount()           // GDPR erasure; clears token
```

---

### `createAsyncStorage(asyncStorage?)`

Create a storage adapter from an AsyncStorage instance.

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStorage } from '@byok-relay/expo';

const storage = createAsyncStorage(AsyncStorage);
// or: auto-detect installed AsyncStorage
const storage = createAsyncStorage();
```

**StorageAdapter interface:**

```ts
interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
```

## Model IDs

All hooks and `ByokRelayClient` accept:

| Format | Example |
|--------|---------|
| `provider/model` | `openai/gpt-4o`, `anthropic/claude-opus-4-5` |
| Bare model name | `claude-opus-4-5` → anthropic, `gemini-2.5-pro` → google |

Supported providers: `openai`, `anthropic`, `google`, `groq`, `mistral`, `openrouter`, or any `openai-compatible` provider.

## Self-hosting

Point `relayUrl` at your own relay instance. See the [byok-relay README](https://github.com/avikalpg/byok-relay) for self-hosting instructions (Docker, Railway, Render).

```tsx
useStreamingChat({ relayUrl: 'https://relay.myapp.com', model: 'openai/gpt-4o' })
```

## Related packages

| Package | Use case |
|---------|----------|
| [`@byok-relay/react`](../react) | React hooks (browser / Next.js) |
| [`@byok-relay/next`](../next) | Next.js App Router route handlers |
| [`@byok-relay/client`](../client) | Plain-JS client (no framework) |
| [`@byok-relay/mcp`](../mcp) | MCP server for Claude Desktop / Claude Code |
| [byok-relay](https://github.com/avikalpg/byok-relay) | Self-hosted relay server |

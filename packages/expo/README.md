# @byok-relay/expo

React Native / Expo hooks and client for [byok-relay](https://byokrelay.com) — BYOK AI in mobile apps with no server code.

```bash
npx expo install @byok-relay/expo @react-native-async-storage/async-storage
```

```tsx
import { useStreamingChat, useByokRelay } from '@byok-relay/expo';
import { FlatList, Text, TextInput, View } from 'react-native';

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
- **fetch-based SSE streaming** — Expo SDK 52+ provides `expo/fetch` and `ReadableStream` support automatically; older Expo SDKs or bare React Native apps should pass an explicit ReadableStream-capable `fetch` override; no `EventSource` polyfill needed
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
>
> **Streaming fetch:** Expo SDK 52+ provides `expo/fetch` and `ReadableStream` support automatically. Use `expo/fetch` there:
>
> ```tsx
> import { fetch as expoFetch } from 'expo/fetch';
> import { useStreamingChat } from '@byok-relay/expo';
>
> const chat = useStreamingChat({ relayUrl: 'https://relay.byokrelay.com', model: 'openai/gpt-4o', fetch: expoFetch });
> ```
>
> Older Expo SDKs and bare React Native apps must pass their own ReadableStream-capable `fetch` implementation or polyfill instead of `expo/fetch`.

## Quick start — Expo

```tsx
import { useState } from 'react';
import { Button, FlatList, Text, TextInput, View } from 'react-native';
import { useByokRelay, useStreamingChat } from '@byok-relay/expo';

// 1. Store the user's API key once (e.g. in a settings screen)
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
function ChatScreen() {
  const [input, setInput] = useState('');
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

Use `expo-secure-store` for credential-grade storage of the relay token. The adapter stores the relay-scoped `byok_relay_token:<encoded relay URL>` token through platform secure storage: Android Keystore-managed encryption on Android and iOS Keychain on iOS. `storeKey` still sends the user's API key to the relay for encrypted server-side storage; this adapter does not store provider API keys locally.

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
type UseByokRelayOptions = {
  relayUrl?: string;          // default: 'https://relay.byokrelay.com'
  appId?: string;             // default: 'expo-app'
  storage?: StorageAdapter;   // default: AsyncStorage (or in-memory fallback)
  fetch?: typeof fetch;       // optional streaming-capable fetch override
};

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
  relayUrl: 'https://relay.byokrelay.com',
  appId: 'my-expo-app',
});
```

---

### `useChat(opts)`

Stateful non-streaming chat. Rolls back the user message on error.

```tsx
type UseChatOptions = {
  relayUrl?: string;
  model?: string;          // default: 'openai/gpt-4o'
  systemPrompt?: string;
  storage?: StorageAdapter;
  extraParams?: object;    // passed to the provider API (temperature, max_tokens, …)
  fetch?: typeof fetch;
};

const {
  messages,       // { role: 'user'|'assistant', content: string }[]
  loading,        // boolean
  error,          // string | null
  sendMessage,    // (content: string) => Promise<void>
  clearMessages,  // () => void
} = useChat({
  relayUrl: 'https://relay.byokrelay.com',
  model: 'openai/gpt-4o',
});
```

---

### `useStreamingChat(opts)`

Streaming chat using `fetch` + `ReadableStream`. Expo SDK 52+ provides `expo/fetch` and `ReadableStream` support automatically; older Expo SDKs and bare React Native projects must provide a streaming-capable fetch implementation or polyfill.

```tsx
type UseStreamingChatOptions = {
  relayUrl?: string;
  model?: string;
  systemPrompt?: string;
  storage?: StorageAdapter;
  extraParams?: object;
  fetch?: typeof fetch;     // must support ReadableStream response bodies
};

const {
  messages,          // committed message history
  streamingContent,  // live string accumulating during stream
  loading,           // boolean
  error,             // string | null
  sendMessage,       // (content: string) => Promise<void>
  stopStreaming,      // () => void — abort in-progress stream
  clearMessages,     // () => void
} = useStreamingChat({
  relayUrl: 'https://relay.byokrelay.com',
  model: 'openai/gpt-4o',
});
```

---

### `useRelayHealth(opts)`

Poll `/health` at a configurable interval.

```tsx
type UseRelayHealthOptions = {
  relayUrl?: string;
  intervalMs?: number;  // default: 30000; set to 0 to disable polling
  fetch?: typeof fetch;
};

const {
  status,   // 'ok' | 'error' | 'unknown'
  data,     // raw /health response object
  loading,  // boolean
  refetch,  // () => Promise<void>
  check,    // (deep?: boolean, provider?: string) => Promise<object>
} = useRelayHealth({
  relayUrl: 'https://relay.byokrelay.com',
});

await check(false, 'openai'); // GET /health?provider=openai
```

---

### `ByokRelayClient`

Plain-JS class. Works in React Native, Expo, and Node.js test environments.

```ts
type ByokRelayClientOptions = {
  relayUrl?: string;
  appId?: string;
  storage?: StorageAdapter;   // { getItem, setItem, removeItem } returning Promises
  fetch?: typeof fetch;       // use expo/fetch or another streaming-capable fetch
};

const client = new ByokRelayClient({
  relayUrl: 'https://relay.byokrelay.com',
});

// Token
await client.register('my-expo-app')        // → token string
await client.ensureToken('my-expo-app')     // → token string (from memory, storage, or new registration)
await client.logout()                       // clears token from memory + storage

// Keys
await client.storeKey('openai', 'sk-...')   // → { ok }
await client.listKeys()                     // → KeyMeta[]
await client.deleteKey('openai')            // → { ok }
await client.rotateKey('openai', 'sk-new')  // → { ok, rotated }

// Relay
await client.relayRequest('openai', 'chat/completions', body, 'POST') // low-level
await client.chat('openai/gpt-4o', messages, { temperature: 0.7 })    // non-streaming
const signal = new AbortController().signal;
const extra = { temperature: 0.7 };
for await (const chunk of client.streamChat('openai/gpt-4o', messages, { signal, extra })) {
  appendStreamingText(chunk);
}

// Health & meta
await client.health(false, 'openai')    // → /health?provider=openai response
await client.stats()                    // → authenticated user's /stats response
await client.getModels()                // → /models response
await client.deleteAccount()            // GDPR erasure; clears token
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

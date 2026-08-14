# @byok-relay/vue

> Vue 3 composables for [byok-relay](https://byokrelay.com) — drop-in BYOK AI in any Vue or Nuxt app.

No backend required. Your users bring their own API keys; this package handles token registration, encrypted key storage, and AI provider relay — all from the browser.

---

## Install

```bash
npm install @byok-relay/vue
# or
yarn add @byok-relay/vue
# or
pnpm add @byok-relay/vue
```

Requires Vue 3 (`>=3.0.0`) as a peer dependency.

---

## Quick start

```vue
<script setup>
import { useByokRelay, useStreamingChat } from '@byok-relay/vue'

const relay = useByokRelay({ appId: 'my-app' })
const chat  = useStreamingChat({ token: relay.token, provider: 'openai', model: 'gpt-4o-mini' })

async function onSave(key) {
  if (!relay.isRegistered.value) await relay.register()
  await relay.storeKey('openai', key)
}
</script>

<template>
  <div>
    <input v-if="!relay.isRegistered.value" @blur="e => onSave(e.target.value)" placeholder="Paste OpenAI key" />

    <div v-for="msg in chat.messages.value" :key="msg.role + msg.content">
      <strong>{{ msg.role }}:</strong> {{ msg.content }}
    </div>
    <p v-if="chat.streamingContent.value" style="opacity:.6">{{ chat.streamingContent.value }}</p>

    <input @keydown.enter="e => chat.sendMessage(e.target.value)" placeholder="Ask anything…" />
    <button v-if="chat.isStreaming.value" @click="chat.stopStreaming()">Stop</button>
  </div>
</template>
```

---

## Composables

### `useByokRelay(opts)`

Manages the relay token and provider key storage. Persists the token to `localStorage` automatically.

```js
const relay = useByokRelay({
  relayUrl: 'https://relay.byokrelay.com', // optional, default shown
  appId: 'my-app',                         // required — namespaces localStorage key
})
```

**Returns:**

| Name | Type | Description |
|------|------|-------------|
| `token` | `Ref<string\|null>` | Relay token (readonly) |
| `isRegistered` | `ComputedRef<boolean>` | Whether a token is stored |
| `error` | `Ref<string\|null>` | Last error message (readonly) |
| `register()` | `async () => void` | Obtain a new relay token |
| `storeKey(provider, apiKey)` | `async () => void` | Encrypt and store an API key server-side |
| `deleteKey(provider)` | `async () => void` | Delete a stored API key |
| `listProviders()` | `async () => string[]` | List providers with a stored key |
| `logout()` | `() => void` | Clear the token from state + localStorage |

**Example — API key settings component:**

```vue
<script setup>
import { ref } from 'vue'
import { useByokRelay } from '@byok-relay/vue'

const relay = useByokRelay({ appId: 'my-app' })
const keyInput = ref('')
const saving = ref(false)

async function save() {
  saving.value = true
  if (!relay.isRegistered.value) await relay.register()
  await relay.storeKey('openai', keyInput.value)
  keyInput.value = ''
  saving.value = false
}
</script>

<template>
  <form @submit.prevent="save">
    <input v-model="keyInput" type="password" placeholder="sk-..." />
    <button :disabled="saving">{{ saving ? 'Saving…' : 'Save key' }}</button>
    <p v-if="relay.error.value" style="color:red">{{ relay.error.value }}</p>
  </form>
</template>
```

---

### `useChat(opts)`

Stateful non-streaming chat. Maintains message history and handles provider differences transparently.

```js
const chat = useChat({
  token:        relay.token,          // Ref<string> or plain string
  relayUrl:     'https://relay.byokrelay.com', // optional
  provider:     'openai',             // 'openai' | 'anthropic' | 'groq' | 'mistral' | 'openrouter' | 'google'
  model:        'gpt-4o-mini',        // any model name your key can access
  systemPrompt: 'You are helpful.',   // optional
  extraParams:  {},                   // optional extra body params forwarded to the provider
})
```

**Returns:**

| Name | Type | Description |
|------|------|-------------|
| `messages` | `Ref<Array<{role, content}>>` | Message history (readonly) |
| `isLoading` | `Ref<boolean>` | Whether a request is in-flight |
| `error` | `Ref<string\|null>` | Last error message |
| `sendMessage(content)` | `async () => void` | Send a user message and wait for reply |
| `clearMessages()` | `() => void` | Clear all messages and reset state |

**Example:**

```vue
<script setup>
import { useByokRelay, useChat } from '@byok-relay/vue'

const relay = useByokRelay({ appId: 'my-app' })
const chat = useChat({ token: relay.token, provider: 'anthropic', model: 'claude-haiku-3-5' })
</script>

<template>
  <ul>
    <li v-for="m in chat.messages.value" :key="m.role + m.content">
      <b>{{ m.role }}:</b> {{ m.content }}
    </li>
  </ul>
  <input @keydown.enter="e => chat.sendMessage(e.target.value)" :disabled="chat.isLoading.value" />
</template>
```

---

### `useStreamingChat(opts)`

SSE streaming chat. The `streamingContent` ref updates token-by-token as the response streams in.

```js
const chat = useStreamingChat({
  token:        relay.token,
  relayUrl:     'https://relay.byokrelay.com', // optional
  provider:     'openai',
  model:        'gpt-4o-mini',
  systemPrompt: 'You are concise.',   // optional
  extraParams:  {},                   // optional
})
```

**Returns:**

| Name | Type | Description |
|------|------|-------------|
| `messages` | `Ref<Array<{role, content}>>` | Completed message history (readonly) |
| `streamingContent` | `Ref<string>` | Live partial response (empty when not streaming) |
| `isStreaming` | `Ref<boolean>` | Whether a stream is active |
| `error` | `Ref<string\|null>` | Last error message |
| `sendMessage(content)` | `async () => void` | Send a user message and stream the reply |
| `stopStreaming()` | `() => void` | Abort the current stream (partial response is committed) |
| `clearMessages()` | `() => void` | Clear all messages and abort any active stream |

> In-flight streams are automatically aborted when the component unmounts (`onUnmounted`).

**Example with live typing indicator:**

```vue
<script setup>
import { useByokRelay, useStreamingChat } from '@byok-relay/vue'

const relay = useByokRelay({ appId: 'my-app' })
const chat = useStreamingChat({ token: relay.token, provider: 'openai', model: 'gpt-4o-mini' })
</script>

<template>
  <div>
    <div v-for="m in chat.messages.value" :key="m.role + m.content">
      <b>{{ m.role }}:</b> {{ m.content }}
    </div>
    <!-- Live typing cursor -->
    <div v-if="chat.isStreaming.value" style="opacity:.6">
      {{ chat.streamingContent.value }}<span class="cursor">▌</span>
    </div>
    <div style="display:flex; gap:8px">
      <input @keydown.enter="e => chat.sendMessage(e.target.value)" />
      <button v-if="chat.isStreaming.value" @click="chat.stopStreaming()">■ Stop</button>
    </div>
  </div>
</template>
```

---

### `useRelayHealth(opts)`

Polls the relay `/health` endpoint and exposes liveness + optional readiness state. Polling starts on `onMounted` and stops on `onUnmounted`; set `intervalMs: 0` to disable repeated polling after manual or initial checks.

```js
const health = useRelayHealth({
  relayUrl:   'https://relay.byokrelay.com', // optional
  intervalMs: 30_000,                        // optional, 0 = no polling
  deep:       false,                         // optional, true = upstream provider check
  provider:   'openai',                      // optional, provider to check when deep=true
})
```

**Returns:**

| Name | Type | Description |
|------|------|-------------|
| `isHealthy` | `Ref<boolean\|null>` | `null` = not yet checked |
| `status` | `Ref<object\|null>` | Full response from `/health` |
| `isLoading` | `Ref<boolean>` | Whether a health check is in-flight |
| `error` | `Ref<string\|null>` | Network or parse error |
| `refetch()` | `async () => void` | Trigger an immediate health check |

**Example:**

```vue
<script setup>
import { useRelayHealth } from '@byok-relay/vue'

const health = useRelayHealth({ intervalMs: 60_000 })
</script>

<template>
  <span :class="health.isHealthy.value ? 'green' : 'red'">
    {{ health.isHealthy.value === null ? '…' : health.isHealthy.value ? '✅ Relay online' : '❌ Relay offline' }}
  </span>
</template>
```

---

## Nuxt 3 usage

```ts
// composables/useAI.ts  (auto-imported in Nuxt)
import { useByokRelay, useStreamingChat } from '@byok-relay/vue'

export function useAI() {
  const relay = useByokRelay({ appId: useRuntimeConfig().public.appId })
  const chat  = useStreamingChat({ token: relay.token, provider: 'openai', model: 'gpt-4o-mini' })
  return { relay, chat }
}
```

```vue
<!-- pages/chat.vue -->
<script setup>
const { relay, chat } = useAI()
onMounted(() => { if (!relay.isRegistered.value) relay.register() })
</script>
```

---

## Supported providers

| Provider | `provider` value | Notes |
|----------|-----------------|-------|
| OpenAI | `openai` | GPT-4o, o1, o3, etc. |
| Anthropic | `anthropic` | Claude 3.5/4 |
| Groq | `groq` | Llama, Mixtral (fast inference) |
| Mistral | `mistral` | Mistral 7B–Large |
| OpenRouter | `openrouter` | 100+ models |
| Google | `google` | Gemini via AI Studio key |

---

## Self-hosting

By default the composables talk to the managed relay at `https://relay.byokrelay.com` (suitable for development and prototyping). For production apps with paying users, self-host:

```bash
# One command — spins up byok-relay with a persistent SQLite volume
docker compose up -d
```

Then point all composables at your relay:

```js
const RELAY_URL = import.meta.env.VITE_RELAY_URL || 'https://relay.byokrelay.com'

const relay = useByokRelay({ relayUrl: RELAY_URL, appId: 'my-app' })
const chat  = useStreamingChat({ token: relay.token, relayUrl: RELAY_URL })
```

See [byokrelay.com](https://byokrelay.com) for full self-hosting docs.

---

## Links

- [byok-relay on GitHub](https://github.com/avikalpg/byok-relay)
- [byokrelay.com](https://byokrelay.com) — managed relay + docs
- [SKILL.md](https://byokrelay.com/skill) — for AI coding agents
- [@byok-relay/react](https://www.npmjs.com/package/@byok-relay/react) — React hooks
- [@byok-relay/client](https://www.npmjs.com/package/@byok-relay/client) — framework-agnostic client
- [@byok-relay/mcp](https://www.npmjs.com/package/@byok-relay/mcp) — MCP server for Claude Desktop

---

## License

Apache-2.0

---

*If this composable saved you time, consider ⭐ [starring the repo](https://github.com/avikalpg/byok-relay).*

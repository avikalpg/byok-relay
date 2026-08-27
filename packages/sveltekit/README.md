# @byok-relay/sveltekit

> SvelteKit `handle` hook, `+server.js` route handlers, and `ByokRelayClient` for [byok-relay](https://byokrelay.com).

Proxy AI provider requests **server-side** while your users bring their own API keys. Works with all SvelteKit adapters: `adapter-node`, `adapter-vercel`, `adapter-cloudflare`, `adapter-netlify`.

```bash
npm install @byok-relay/sveltekit
```

---

## Quick start — `handle` hook (recommended)

The simplest integration. Add one line to `src/hooks.server.js` and every request under `/relay` is proxied to the upstream relay. Your `RELAY_URL` stays in `process.env` and is never bundled into the browser.

```js
// src/hooks.server.js
import { createByokRelayHandle } from '@byok-relay/sveltekit';

export const handle = createByokRelayHandle();
```

Set `RELAY_URL` in your `.env` (or adapter secrets):

```
RELAY_URL=https://relay.byokrelay.com   # or your self-hosted instance
```

That's it. Your frontend can now relay requests to `/relay/openai/chat/completions`, `/relay/anthropic/messages`, etc.

---

## Quick start — `+server.js` catch-all route

If you need more control (per-route middleware, SvelteKit `load` data), use the route handler factory instead.

**1. Create the catch-all route file:**

```
src/routes/relay/[...path]/+server.js
```

**2. Export the handlers:**

```js
// src/routes/relay/[...path]/+server.js
import { createRelayRouteHandlers } from '@byok-relay/sveltekit';

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } =
  createRelayRouteHandlers();
```

**3. Done.** Requests to `/relay/*` are proxied to the upstream relay.

---

## Chaining with `sequence()`

Use SvelteKit's built-in `sequence()` to combine the relay handle with your auth or logging hooks:

```js
// src/hooks.server.js
import { sequence } from '@sveltejs/kit/hooks';
import { createByokRelayHandle } from '@byok-relay/sveltekit';
import { authHandle } from './auth';

export const handle = sequence(
  createByokRelayHandle(),  // relay goes first
  authHandle,
);
```

---

## Streaming chat in a Svelte component

```svelte
<!-- src/routes/chat/+page.svelte -->
<script>
  import { ByokRelayClient } from '@byok-relay/sveltekit';

  const client = new ByokRelayClient({ relayUrl: '/relay' });

  let messages = [];
  let streamingContent = '';
  let isStreaming = false;
  let abortController;

  async function sendMessage(userText) {
    messages = [...messages, { role: 'user', content: userText }];
    isStreaming = true;
    streamingContent = '';
    abortController = new AbortController();

    try {
      for await (const chunk of client.streamChat({
        model: 'openai/gpt-4o',
        messages,
        signal: abortController.signal,
      })) {
        streamingContent += chunk;
      }
      messages = [...messages, { role: 'assistant', content: streamingContent }];
    } catch (err) {
      if (err.name !== 'AbortError') console.error(err);
    } finally {
      isStreaming = false;
      streamingContent = '';
    }
  }

  function stop() {
    abortController?.abort();
  }
</script>

{#each messages as msg}
  <div class={msg.role}>{msg.content}</div>
{/each}

{#if isStreaming}
  <div class="assistant streaming">{streamingContent}</div>
  <button on:click={stop}>Stop</button>
{/if}
```

---

## API key settings component

```svelte
<!-- src/lib/ApiKeySettings.svelte -->
<script>
  import { ByokRelayClient } from '@byok-relay/sveltekit';
  import { onMount } from 'svelte';

  const client = new ByokRelayClient({ relayUrl: '/relay' });

  let provider = 'openai';
  let apiKey = '';
  let savedProviders = [];
  let status = '';

  onMount(async () => {
    const { keys } = await client.listKeys();
    savedProviders = keys.map(k => k.provider);
  });

  async function saveKey() {
    await client.storeKey(provider, apiKey);
    status = `✅ ${provider} key saved`;
    apiKey = '';
    const { keys } = await client.listKeys();
    savedProviders = keys.map(k => k.provider);
  }
</script>

<select bind:value={provider}>
  <option value="openai">OpenAI</option>
  <option value="anthropic">Anthropic</option>
  <option value="groq">Groq</option>
  <option value="mistral">Mistral</option>
  <option value="openrouter">OpenRouter</option>
</select>
<input type="password" bind:value={apiKey} placeholder="sk-..." />
<button on:click={saveKey}>Save key</button>
{#if status}<p>{status}</p>{/if}
```

---

## Cookie-session storage adapter (server load functions)

Use `ByokRelayClient` in SvelteKit `+page.server.js` load functions with a cookie storage adapter to persist the relay token server-side:

```js
// src/routes/+page.server.js
import { ByokRelayClient } from '@byok-relay/sveltekit';

export async function load({ cookies }) {
  const client = new ByokRelayClient({
    relayUrl: process.env.RELAY_URL,
    storage: {
      get:    (key) => cookies.get(key) ?? null,
      set:    (key, val) => cookies.set(key, val, { path: '/', httpOnly: true, sameSite: 'strict' }),
      remove: (key) => cookies.delete(key, { path: '/' }),
    },
  });

  const keys = await client.listKeys();
  return { savedProviders: keys.map(k => k.provider) };
}
```

---

## Options reference

### `createByokRelayHandle(opts?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `relayUrl` | `string` | `process.env.RELAY_URL` | Upstream relay base URL |
| `pathPrefix` | `string` | `'/relay'` | URL prefix to intercept |
| `allowedAppIds` | `string[]` | — | If set, only these `x-app-id` header values pass (403 otherwise) |
| `timeoutMs` | `number` | `30000` | Upstream fetch timeout in ms |

### `createRelayRouteHandlers(opts?)`

Returns `{ GET, POST, PUT, PATCH, DELETE, OPTIONS }` SvelteKit `RequestHandler` functions. The SvelteKit route mount point defines the relay path prefix.

| Option | Type | Default | Description |
|---|---|---|---|
| `relayUrl` | `string` | `process.env.RELAY_URL` | Upstream relay base URL |
| `allowedAppIds` | `string[]` | — | If set, only these `x-app-id` header values pass (403 otherwise) |
| `timeoutMs` | `number` | `30000` | Upstream fetch timeout in ms |

### `new ByokRelayClient(opts?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `relayUrl` | `string` | `process.env.RELAY_URL` | Relay base URL |
| `appId` | `string` | `'sveltekit-app'` | Your app identifier |
| `storage` | `StorageAdapter` | localStorage (browser) / in-memory (server) | Custom storage for token persistence |

#### `StorageAdapter` interface

```ts
interface StorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}
```

---

## ByokRelayClient API

| Method | Description |
|---|---|
| `register(appId?)` | Register + get relay token (call once per user) |
| `ensureToken()` | Return cached token or auto-register |
| `logout()` | Clear stored token locally |
| `storeKey(provider, apiKey)` | Store a provider API key (AES-256-GCM encrypted at rest) |
| `listKeys()` | List stored provider keys (names only, not values) |
| `deleteKey(provider)` | Delete a stored provider key |
| `rotateKey(provider, newApiKey)` | Atomically rotate a provider key (verify → swap) |
| `relayRequest(providerPath, body, headers?)` | Forward a raw request to any provider endpoint |
| `chat({ model, messages, extraParams? })` | Unified model routing chat completion |
| `streamChat({ model, messages, extraParams?, signal? })` | SSE streaming chat (async generator) |
| `health(deep?)` | Liveness check (`/health`); `deep=true` pings upstream providers |
| `stats(appId?)` | Per-user or per-app_id usage stats |
| `getModels()` | List available models + routing config |
| `deleteAccount()` | Delete account + all keys (GDPR Art. 17) |

---

## Supported providers

| Provider | Model prefix | Example model |
|---|---|---|
| OpenAI | `openai/` | `openai/gpt-4o` |
| Anthropic | `anthropic/` | `anthropic/claude-opus-4-5` |
| Groq | `groq/` | `groq/llama-3.3-70b-versatile` |
| Mistral | `mistral/` | `mistral/mistral-large-latest` |
| OpenRouter | `openrouter/` | `openrouter/google/gemini-flash-1.5` |
| Google | `google/` | `google/gemini-2.5-flash` |
| Cohere | `cohere/` | `cohere/command-r-plus` |
| Hugging Face | `huggingface/` | `huggingface/meta-llama/...` |
| ElevenLabs | `elevenlabs/` | (TTS/STT) |
| Deepgram | `deepgram/` | (STT/TTS) |

---

## Self-hosting

Point `RELAY_URL` at your own instance:

```
RELAY_URL=https://relay.example.com
```

Self-host in one command:

```bash
docker compose up -d
```

See [byok-relay](https://github.com/avikalpg/byok-relay) for full self-hosting docs.

---

## Key differentiator vs `@byok-relay/svelte`

| | `@byok-relay/svelte` | `@byok-relay/sveltekit` |
|---|---|---|
| Target | Svelte stores (client-side) | SvelteKit `handle` hook + route handlers (server-side) |
| `RELAY_URL` | Visible in browser bundle | Stays in `process.env` (never shipped to browser) |
| Token persistence | `localStorage` | `localStorage` (browser) or cookie storage adapter (server load) |
| Best for | Client-only SPAs | Full-stack SvelteKit apps |

---

## Related packages

| Package | For |
|---|---|
| [`@byok-relay/svelte`](https://npmjs.com/package/@byok-relay/svelte) | Svelte stores (client-only apps) |
| [`@byok-relay/react`](https://npmjs.com/package/@byok-relay/react) | React hooks |
| [`@byok-relay/vue`](https://npmjs.com/package/@byok-relay/vue) | Vue 3 composables |
| [`@byok-relay/nuxt`](https://npmjs.com/package/@byok-relay/nuxt) | Nuxt 3 module + H3 server routes |
| [`@byok-relay/next`](https://npmjs.com/package/@byok-relay/next) | Next.js App Router handlers + hooks |
| [`@byok-relay/hono`](https://npmjs.com/package/@byok-relay/hono) | Hono middleware (Cloudflare Workers, Deno, Bun) |
| [`@byok-relay/client`](https://npmjs.com/package/@byok-relay/client) | Framework-agnostic JS client |

---

## License

MIT

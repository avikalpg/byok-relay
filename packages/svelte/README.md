# @byok-relay/svelte

> Svelte stores for [byok-relay](https://byokrelay.com) — drop-in BYOK AI in any Svelte or SvelteKit app.

[![npm](https://img.shields.io/npm/v/@byok-relay/svelte)](https://www.npmjs.com/package/@byok-relay/svelte)
[![license](https://img.shields.io/github/license/avikalpg/byok-relay)](../../LICENSE)

**Let your users bring their own OpenAI/Anthropic/Groq API keys. Zero backend code. Full streaming.**

---

## Install

```bash
npm install @byok-relay/svelte
```

Or use the managed relay without installing anything — just import from a CDN:

```html
<script type="module">
  import { createByokRelayStore } from 'https://esm.sh/@byok-relay/svelte';
</script>
```

---

## Quick start

```svelte
<!-- ApiKeySettings.svelte -->
<script>
  import { createByokRelayStore } from '@byok-relay/svelte';
  import { onMount } from 'svelte';

  const relay = createByokRelayStore({ appId: 'myapp' });

  let apiKey = '';
  let saved  = false;

  onMount(() => relay.register());

  async function saveKey() {
    await relay.storeKey('openai', apiKey);
    apiKey = '';
    saved  = true;
  }
</script>

{#if $relay.isRegistered}
  <label>
    OpenAI API key
    <input type="password" bind:value={apiKey} placeholder="sk-..." />
  </label>
  <button on:click={saveKey} disabled={!apiKey}>Save key</button>
  {#if saved}<p>Key saved ✓</p>{/if}
{:else}
  <button on:click={relay.register}>Connect to relay</button>
{/if}
{#if $relay.error}<p class="error">{$relay.error}</p>{/if}
```

---

## Stores

### `createByokRelayStore(opts)`

Core store — manages relay token registration and encrypted API key storage.

**Options**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `relayUrl` | `string` | `https://relay.byokrelay.com` | Relay base URL (use your own for self-hosted) |
| `appId` | `string` | required | App identifier — used to namespace tokens in localStorage |

**State** (`$relay`)

| Field | Type | Description |
|-------|------|-------------|
| `token` | `string \| null` | Relay token (persisted in localStorage) |
| `isRegistered` | `boolean` | `true` when token is present |
| `error` | `string \| null` | Last error message, or `null` |

**Methods**

| Method | Description |
|--------|-------------|
| `relay.register()` | Register a new relay token (or reload from localStorage) |
| `relay.storeKey(provider, apiKey)` | Store an encrypted API key for a provider |
| `relay.deleteKey(provider)` | Delete the stored key for a provider |
| `relay.listProviders()` | Returns `string[]` of providers with stored keys |
| `relay.logout()` | Clear token and state (does not delete stored keys) |

---

### `createChatStore(opts)`

Non-streaming chat — stateful message list for any supported provider.

**Options**

| Option | Default | Description |
|--------|---------|-------------|
| `relayUrl` | `https://relay.byokrelay.com` | Relay base URL |
| `appId` | required | App identifier |
| `provider` | `'openai'` | AI provider |
| `model` | provider default | Model override |
| `systemPrompt` | `undefined` | System prompt |
| `extraParams` | `{}` | Extra body params forwarded on every request |

**State** (`$chat`)

| Field | Type | Description |
|-------|------|-------------|
| `messages` | `Array<{role, content}>` | Full conversation history |
| `loading` | `boolean` | `true` while request is in-flight |
| `error` | `string \| null` | Last error message |

**Methods**

| Method | Description |
|--------|-------------|
| `chat.send(content, opts?)` | Send a user message; appends assistant reply when done |
| `chat.clear()` | Reset messages, loading, error |

**Full example**

```svelte
<script>
  import { createByokRelayStore, createChatStore } from '@byok-relay/svelte';
  import { onMount } from 'svelte';

  const relay = createByokRelayStore({ appId: 'myapp' });
  const chat  = createChatStore({
    appId:        'myapp',
    provider:     'openai',
    model:        'gpt-4o-mini',
    systemPrompt: 'You are a helpful assistant.',
  });

  let input = '';

  onMount(() => relay.register());

  async function submit() {
    const msg = input.trim();
    if (!msg) return;
    input = '';
    await chat.send(msg);
  }
</script>

<div class="messages">
  {#each $chat.messages as msg}
    <div class="message {msg.role}">{msg.content}</div>
  {/each}
  {#if $chat.loading}<div class="loading">Thinking…</div>{/if}
  {#if $chat.error}<div class="error">{$chat.error}</div>{/if}
</div>

<form on:submit|preventDefault={submit}>
  <input bind:value={input} placeholder="Type a message…" disabled={$chat.loading} />
  <button type="submit" disabled={$chat.loading || !input.trim()}>Send</button>
</form>
```

---

### `createStreamingChatStore(opts)`

SSE streaming chat — live token streaming with AbortController cancel support.

Same options as `createChatStore`.

**State** (`$chat`)

| Field | Type | Description |
|-------|------|-------------|
| `messages` | `Array<{role, content}>` | Completed messages |
| `streamingContent` | `string` | Live content being streamed (empty when not streaming) |
| `isStreaming` | `boolean` | `true` while SSE stream is open |
| `error` | `string \| null` | Last error message |

**Methods**

| Method | Description |
|--------|-------------|
| `chat.send(content, opts?)` | Send a user message; streams reply in real time |
| `chat.stopStreaming()` | Abort the active stream (partial reply committed to `messages`) |
| `chat.clear()` | Stop streaming + reset all state |

**Full example**

```svelte
<script>
  import { createByokRelayStore, createStreamingChatStore } from '@byok-relay/svelte';
  import { onMount } from 'svelte';

  const relay = createByokRelayStore({ appId: 'myapp' });
  const chat  = createStreamingChatStore({
    appId:    'myapp',
    provider: 'anthropic',
    model:    'claude-3-haiku-20240307',
  });

  let input = '';
  onMount(() => relay.register());
</script>

<div class="messages">
  {#each $chat.messages as msg}
    <div class="message {msg.role}">{msg.content}</div>
  {/each}

  {#if $chat.isStreaming}
    <div class="message assistant streaming">
      {$chat.streamingContent}<span class="cursor">▋</span>
    </div>
    <button on:click={chat.stopStreaming}>Stop</button>
  {/if}

  {#if $chat.error}<div class="error">{$chat.error}</div>{/if}
</div>

<form on:submit|preventDefault={() => { chat.send(input); input = ''; }}>
  <input bind:value={input} placeholder="Type a message…" disabled={$chat.isStreaming} />
  <button type="submit" disabled={$chat.isStreaming || !input.trim()}>Send</button>
</form>
```

---

### `createRelayHealthStore(opts)`

Polls `/health` on the relay — tracks liveness and readiness.

**Options**

| Option | Default | Description |
|--------|---------|-------------|
| `relayUrl` | `https://relay.byokrelay.com` | Relay base URL |
| `pollIntervalMs` | `30000` | Polling interval ms (`0` = no polling) |
| `deep` | `false` | If `true`, also pings upstream provider |
| `provider` | `undefined` | Provider to deep-check (e.g. `'openai'`) |

**State** (`$health`)

| Field | Type | Description |
|-------|------|-------------|
| `status` | `string` | `'ok'` \| `'error'` \| `'unreachable'` \| `'unknown'` |
| `ok` | `boolean` | `true` when relay is healthy |
| `uptime` | `number \| null` | Relay process uptime in seconds |
| `warnings` | `string[]` | Non-fatal warnings from the relay |
| `error` | `string \| null` | Network error message |

**Methods**

| Method | Description |
|--------|-------------|
| `health.refetch()` | Manually trigger a health check |
| `health.destroy()` | Stop the polling timer (call in `onDestroy`) |

**Example**

```svelte
<script>
  import { createRelayHealthStore } from '@byok-relay/svelte';
  import { onDestroy } from 'svelte';

  const health = createRelayHealthStore({ pollIntervalMs: 60_000 });
  onDestroy(health.destroy);
</script>

<span class="badge" class:green={$health.ok} class:red={!$health.ok}>
  {$health.ok ? '● Relay live' : '● Relay down'}
</span>
{#if $health.warnings.length}
  <ul>{#each $health.warnings as w}<li>{w}</li>{/each}</ul>
{/if}
```

---

## Supported providers

| Provider | `provider` value | Notes |
|----------|-----------------|-------|
| OpenAI | `'openai'` | GPT-4o, GPT-4o-mini, o1, o3, … |
| Anthropic | `'anthropic'` | Claude 3, Claude 3.5, Claude 4, … |
| Groq | `'groq'` | Llama 3, Mixtral, … |
| Mistral | `'mistral'` | Mistral 7B, Mixtral, … |
| OpenRouter | `'openrouter'` | Any model via OpenRouter |
| Google | `'google'` | Gemini (pass model as `models/gemini-pro`) |

---

## SvelteKit usage

All stores are SSR-safe. localStorage access is guarded by `typeof window !== 'undefined'`.

**+page.svelte with onMount**

```svelte
<script>
  import { createByokRelayStore, createStreamingChatStore } from '@byok-relay/svelte';
  import { onMount, onDestroy } from 'svelte';

  const relay  = createByokRelayStore({ appId: 'myapp' });
  const chat   = createStreamingChatStore({ appId: 'myapp', provider: 'openai' });
  const health = createRelayHealthStore({ pollIntervalMs: 60_000 });

  onMount(() => relay.register());
  onDestroy(health.destroy);
</script>
```

**Self-hosted relay** (set `relayUrl` to your own instance):

```svelte
<script>
  import { createByokRelayStore } from '@byok-relay/svelte';
  const relay = createByokRelayStore({
    relayUrl: 'https://relay.yourapp.com',
    appId:    'myapp',
  });
</script>
```

---

## Svelte 5 / Runes

These stores work unchanged in Svelte 5 via the `$` auto-subscription syntax.
For Svelte 5 rune-based reactivity, wrap with `$derived`:

```svelte
<script>
  import { createByokRelayStore } from '@byok-relay/svelte';
  const relay   = createByokRelayStore({ appId: 'myapp' });
  const isReady = $derived($relay.isRegistered);  // Svelte 5 rune
</script>
```

---

## Self-hosting

To run your own relay:

```bash
docker run -p 3000:3000 \
  -e ENCRYPTION_SECRET=your-secret-min-32-chars \
  -e ALLOWED_ORIGINS=https://yourapp.com \
  ghcr.io/avikalpg/byok-relay
```

Then pass `relayUrl: 'http://localhost:3000'` to each store factory.

See [byok-relay](https://github.com/avikalpg/byok-relay) for full self-hosting docs.

---

## Related packages

| Package | Description |
|---------|-------------|
| [`@byok-relay/client`](https://www.npmjs.com/package/@byok-relay/client) | Vanilla JS / Node.js client |
| [`@byok-relay/react`](https://www.npmjs.com/package/@byok-relay/react) | React hooks |
| [`@byok-relay/vue`](https://www.npmjs.com/package/@byok-relay/vue) | Vue 3 composables |
| [`@byok-relay/mcp`](https://www.npmjs.com/package/@byok-relay/mcp) | MCP server for Claude Desktop |

---

If this saved you time, consider [⭐ starring the repo](https://github.com/avikalpg/byok-relay).

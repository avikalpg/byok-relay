/**
 * @byok-relay/svelte
 *
 * Svelte stores for byok-relay — drop-in BYOK AI in any Svelte or SvelteKit app.
 *
 * Usage:
 *   import {
 *     createByokRelayStore,
 *     createChatStore,
 *     createStreamingChatStore,
 *     createRelayHealthStore
 *   } from '@byok-relay/svelte';
 *
 * No build step required. Svelte peer dep optional — stores work in plain JS too.
 * For SvelteKit SSR: stores are browser-safe (localStorage guarded by `typeof window`).
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';

const PROVIDER_PATHS = {
  openai:     'chat/completions',
  anthropic:  'messages',
  google:     'models/{model}:generateContent',
  groq:       'chat/completions',
  mistral:    'chat/completions',
  openrouter: 'chat/completions',
};

// ─── Store factory helpers ────────────────────────────────────────────────────

/**
 * Create a minimal Svelte-compatible writable store.
 * Works with Svelte's `$store` auto-subscription syntax and plain JS `.subscribe()`.
 */
function writable(initial) {
  // Try to use Svelte's writable if available (tree-shaken out when not bundled with Svelte)
  if (typeof globalThis !== 'undefined' && globalThis.__svelteStoreWritable) {
    return globalThis.__svelteStoreWritable(initial);
  }

  let value = initial;
  const subscribers = new Set();

  function subscribe(run, invalidate = () => {}) {
    subscribers.add(run);
    run(value);
    return () => subscribers.delete(run);
  }

  function set(newValue) {
    value = newValue;
    subscribers.forEach(run => run(value));
  }

  function update(fn) {
    set(fn(value));
  }

  function get() {
    return value;
  }

  return { subscribe, set, update, get };
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

function isBrowser() {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function storageGet(key) {
  try { return isBrowser() ? localStorage.getItem(key) : null; }
  catch { return null; }
}

function storageSet(key, value) {
  try { if (isBrowser()) localStorage.setItem(key, value); }
  catch { /* ignore */ }
}

function storageRemove(key) {
  try { if (isBrowser()) localStorage.removeItem(key); }
  catch { /* ignore */ }
}

// ─── SSE parsing ─────────────────────────────────────────────────────────────

function* parseSSE(chunk) {
  const lines = chunk.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { yield null; continue; }
    try { yield JSON.parse(data); } catch { /* skip malformed */ }
  }
}

function extractDelta(event, provider) {
  if (!event) return '';
  if (provider === 'anthropic') {
    if (event.type === 'content_block_delta') return event.delta?.text || '';
    return '';
  }
  // OpenAI-style
  return event.choices?.[0]?.delta?.content || '';
}

// ─── createByokRelayStore ─────────────────────────────────────────────────────

/**
 * Core store — manages relay token registration and API key CRUD.
 *
 * @param {object} opts
 * @param {string} [opts.relayUrl]  Relay base URL (default: https://relay.byokrelay.com)
 * @param {string}  opts.appId      Your app identifier (used for token namespacing in localStorage)
 *
 * @returns {{
 *   subscribe: Function,       // Svelte store subscribe — state: { token, isRegistered, error }
 *   register:  () => Promise<void>,
 *   storeKey:  (provider: string, apiKey: string) => Promise<void>,
 *   deleteKey: (provider: string) => Promise<void>,
 *   listProviders: () => Promise<string[]>,
 *   logout:    () => void
 * }}
 *
 * @example
 * // +page.svelte
 * <script>
 *   import { createByokRelayStore } from '@byok-relay/svelte';
 *   const relay = createByokRelayStore({ appId: 'myapp' });
 *   // Auto-register on mount
 *   import { onMount } from 'svelte';
 *   onMount(() => relay.register());
 * </script>
 * {#if $relay.isRegistered}
 *   <p>Connected ✓</p>
 * {:else}
 *   <button on:click={relay.register}>Connect</button>
 * {/if}
 * {#if $relay.error}<p class="error">{$relay.error}</p>{/if}
 */
function createByokRelayStore({ relayUrl = DEFAULT_RELAY_URL, appId } = {}) {
  const tokenKey = `byok_relay_token_${appId}`;
  const storedToken = storageGet(tokenKey);

  const store = writable({
    token:        storedToken,
    isRegistered: Boolean(storedToken),
    error:        null,
  });

  function _patch(patch) {
    store.update(s => ({ ...s, ...patch }));
  }

  function _getToken() {
    return store.get().token;
  }

  async function register() {
    _patch({ error: null });
    try {
      const res = await fetch(`${relayUrl}/users`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ app_id: appId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Registration failed (${res.status})`);
      const token = data.token;
      storageSet(tokenKey, token);
      _patch({ token, isRegistered: true, error: null });
    } catch (err) {
      _patch({ error: err.message });
      throw err;
    }
  }

  async function storeKey(provider, apiKey) {
    const token = _getToken();
    if (!token) throw new Error('Not registered — call register() first');
    _patch({ error: null });
    try {
      const res = await fetch(`${relayUrl}/keys/${provider}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body:    JSON.stringify({ api_key: apiKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to store key (${res.status})`);
    } catch (err) {
      _patch({ error: err.message });
      throw err;
    }
  }

  async function deleteKey(provider) {
    const token = _getToken();
    if (!token) throw new Error('Not registered');
    _patch({ error: null });
    try {
      const res = await fetch(`${relayUrl}/keys/${provider}`, {
        method:  'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to delete key (${res.status})`);
      }
    } catch (err) {
      _patch({ error: err.message });
      throw err;
    }
  }

  async function listProviders() {
    const token = _getToken();
    if (!token) return [];
    try {
      const res = await fetch(`${relayUrl}/keys`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.providers || [];
    } catch {
      return [];
    }
  }

  function logout() {
    storageRemove(tokenKey);
    _patch({ token: null, isRegistered: false, error: null });
  }

  return {
    subscribe: store.subscribe,
    register,
    storeKey,
    deleteKey,
    listProviders,
    logout,
  };
}

// ─── createChatStore ──────────────────────────────────────────────────────────

/**
 * Non-streaming chat store — stateful message list for any provider.
 *
 * @param {object} opts
 * @param {string} [opts.relayUrl]      Relay base URL
 * @param {string}  opts.appId          App identifier
 * @param {string} [opts.provider]      Default provider ('openai' | 'anthropic' | 'groq' | 'mistral' | 'openrouter')
 * @param {string} [opts.model]         Default model override
 * @param {string} [opts.systemPrompt]  System prompt
 * @param {object} [opts.extraParams]   Extra body params forwarded on every request
 *
 * @returns {{
 *   subscribe: Function,    // state: { messages, loading, error }
 *   send:      (content: string, opts?: { provider?, model?, extraParams? }) => Promise<void>,
 *   clear:     () => void,
 * }}
 *
 * @example
 * <script>
 *   import { createByokRelayStore, createChatStore } from '@byok-relay/svelte';
 *   const relay = createByokRelayStore({ appId: 'myapp' });
 *   const chat  = createChatStore({ appId: 'myapp', provider: 'openai', model: 'gpt-4o-mini' });
 *   let input = '';
 *   async function submit() { await chat.send(input); input = ''; }
 * </script>
 * {#each $chat.messages as msg}
 *   <div class={msg.role}>{msg.content}</div>
 * {/each}
 * <input bind:value={input} on:keydown={e => e.key === 'Enter' && submit()} />
 */
function createChatStore({
  relayUrl    = DEFAULT_RELAY_URL,
  appId,
  provider:   defaultProvider = 'openai',
  model:      defaultModel,
  systemPrompt,
  extraParams = {},
} = {}) {
  const tokenKey = `byok_relay_token_${appId}`;

  const store = writable({ messages: [], loading: false, error: null });

  function _patch(patch) {
    store.update(s => ({ ...s, ...patch }));
  }

  async function send(content, opts = {}) {
    const provider = opts.provider || defaultProvider;
    const model    = opts.model    || defaultModel;
    const extra    = { ...extraParams, ...(opts.extraParams || {}) };
    const token    = storageGet(tokenKey);

    if (!token) { _patch({ error: 'Not registered — call relay.register() first' }); return; }

    _patch({ error: null, loading: true });
    store.update(s => ({
      ...s,
      messages: [...s.messages, { role: 'user', content }],
    }));

    try {
      const path = (PROVIDER_PATHS[provider] || 'chat/completions').replace('{model}', model || '');
      let body;

      if (provider === 'anthropic') {
        body = {
          model:      model || 'claude-3-haiku-20240307',
          max_tokens: 1024,
          messages:   store.get().messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
          ...(systemPrompt ? { system: systemPrompt } : {}),
          ...extra,
        };
      } else {
        const msgs = [];
        if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
        msgs.push(...store.get().messages.map(m => ({ role: m.role, content: m.content })));
        body = { model: model || 'gpt-4o-mini', messages: msgs, ...extra };
      }

      const res = await fetch(`${relayUrl}/relay/${provider}/${path}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body:    JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

      const reply =
        provider === 'anthropic'
          ? data.content?.[0]?.text || ''
          : data.choices?.[0]?.message?.content || '';

      store.update(s => ({
        ...s,
        loading:  false,
        messages: [...s.messages, { role: 'assistant', content: reply }],
      }));
    } catch (err) {
      _patch({ loading: false, error: err.message });
    }
  }

  function clear() {
    store.set({ messages: [], loading: false, error: null });
  }

  return { subscribe: store.subscribe, send, clear };
}

// ─── createStreamingChatStore ─────────────────────────────────────────────────

/**
 * SSE streaming chat store — live token streaming with AbortController cancel.
 *
 * @param {object} opts
 * @param {string} [opts.relayUrl]
 * @param {string}  opts.appId
 * @param {string} [opts.provider]
 * @param {string} [opts.model]
 * @param {string} [opts.systemPrompt]
 * @param {object} [opts.extraParams]
 *
 * @returns {{
 *   subscribe:      Function,   // state: { messages, streamingContent, isStreaming, error }
 *   send:           (content: string, opts?) => Promise<void>,
 *   stopStreaming:  () => void,
 *   clear:          () => void,
 * }}
 *
 * @example
 * <script>
 *   import { createStreamingChatStore } from '@byok-relay/svelte';
 *   const chat = createStreamingChatStore({ appId: 'myapp', provider: 'openai' });
 *   let input = '';
 * </script>
 * {#each $chat.messages as msg}
 *   <div class={msg.role}>{msg.content}</div>
 * {/each}
 * {#if $chat.isStreaming}
 *   <div class="assistant streaming">{$chat.streamingContent}<span class="cursor">▋</span></div>
 *   <button on:click={chat.stopStreaming}>Stop</button>
 * {/if}
 * <input bind:value={input} on:keydown={e => e.key === 'Enter' && chat.send(input)} />
 */
function createStreamingChatStore({
  relayUrl    = DEFAULT_RELAY_URL,
  appId,
  provider:   defaultProvider = 'openai',
  model:      defaultModel,
  systemPrompt,
  extraParams = {},
} = {}) {
  const tokenKey = `byok_relay_token_${appId}`;

  const store = writable({
    messages:         [],
    streamingContent: '',
    isStreaming:      false,
    error:            null,
  });

  let _controller = null;

  function _patch(patch) {
    store.update(s => ({ ...s, ...patch }));
  }

  async function send(content, opts = {}) {
    const provider = opts.provider || defaultProvider;
    const model    = opts.model    || defaultModel;
    const extra    = { ...extraParams, ...(opts.extraParams || {}) };
    const token    = storageGet(tokenKey);

    if (!token) { _patch({ error: 'Not registered — call relay.register() first' }); return; }
    if (store.get().isStreaming) stopStreaming();

    _patch({ error: null, isStreaming: true, streamingContent: '' });
    store.update(s => ({
      ...s,
      messages: [...s.messages, { role: 'user', content }],
    }));

    _controller = new AbortController();

    try {
      const path = (PROVIDER_PATHS[provider] || 'chat/completions').replace('{model}', model || '');
      let body;

      if (provider === 'anthropic') {
        body = {
          model:      model || 'claude-3-haiku-20240307',
          max_tokens: 1024,
          stream:     true,
          messages:   store.get().messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
          ...(systemPrompt ? { system: systemPrompt } : {}),
          ...extra,
        };
      } else {
        const msgs = [];
        if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
        msgs.push(...store.get().messages.map(m => ({ role: m.role, content: m.content })));
        body = { model: model || 'gpt-4o-mini', messages: msgs, stream: true, ...extra };
      }

      const res = await fetch(`${relayUrl}/relay/${provider}/${path}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body:    JSON.stringify(body),
        signal:  _controller.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';
      let   full    = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (raw === '[DONE]') break;
          try {
            const event = JSON.parse(raw);
            const delta = extractDelta(event, provider);
            if (delta) {
              full += delta;
              _patch({ streamingContent: full });
            }
          } catch { /* skip malformed */ }
        }
      }

      store.update(s => ({
        ...s,
        isStreaming:      false,
        streamingContent: '',
        messages:         [...s.messages, { role: 'assistant', content: full }],
      }));
    } catch (err) {
      if (err.name === 'AbortError') {
        // User stopped — commit whatever was streamed
        const partial = store.get().streamingContent;
        store.update(s => ({
          ...s,
          isStreaming:      false,
          streamingContent: '',
          messages:         partial
            ? [...s.messages, { role: 'assistant', content: partial }]
            : s.messages,
        }));
      } else {
        _patch({ isStreaming: false, streamingContent: '', error: err.message });
      }
    } finally {
      _controller = null;
    }
  }

  function stopStreaming() {
    if (_controller) { _controller.abort(); _controller = null; }
  }

  function clear() {
    stopStreaming();
    store.set({ messages: [], streamingContent: '', isStreaming: false, error: null });
  }

  return { subscribe: store.subscribe, send, stopStreaming, clear };
}

// ─── createRelayHealthStore ───────────────────────────────────────────────────

/**
 * Health polling store — tracks relay liveness and readiness.
 *
 * @param {object} opts
 * @param {string} [opts.relayUrl]         Relay base URL
 * @param {number} [opts.pollIntervalMs]   Polling interval ms (default: 30 000; 0 = no polling)
 * @param {boolean}[opts.deep]             If true, also pings upstream provider (/health?deep=1)
 * @param {string} [opts.provider]         Provider to deep-check (e.g. 'openai')
 *
 * @returns {{
 *   subscribe: Function,   // state: { status, ok, uptime, warnings, error }
 *   refetch:   () => Promise<void>,
 *   destroy:   () => void,   // call in onDestroy to stop polling
 * }}
 *
 * @example
 * <script>
 *   import { createRelayHealthStore } from '@byok-relay/svelte';
 *   import { onDestroy } from 'svelte';
 *   const health = createRelayHealthStore({ pollIntervalMs: 60_000 });
 *   onDestroy(health.destroy);
 * </script>
 * <span class:green={$health.ok} class:red={!$health.ok}>
 *   {$health.ok ? '● Live' : '● Down'}
 * </span>
 */
function createRelayHealthStore({
  relayUrl       = DEFAULT_RELAY_URL,
  pollIntervalMs = 30_000,
  deep           = false,
  provider,
} = {}) {
  const store = writable({ status: 'unknown', ok: false, uptime: null, warnings: [], error: null });
  let _timer = null;

  async function refetch() {
    try {
      let url = `${relayUrl}/health`;
      if (deep) { url += '?deep=1'; if (provider) url += `&provider=${provider}`; }
      const res  = await fetch(url);
      const data = await res.json();
      store.set({
        status:   data.status   || (res.ok ? 'ok' : 'error'),
        ok:       res.ok && data.status === 'ok',
        uptime:   data.uptime   || null,
        warnings: data.warnings || [],
        error:    null,
      });
    } catch (err) {
      store.update(s => ({ ...s, status: 'unreachable', ok: false, error: err.message }));
    }
  }

  refetch();

  if (pollIntervalMs > 0) {
    _timer = setInterval(refetch, pollIntervalMs);
  }

  function destroy() {
    if (_timer) { clearInterval(_timer); _timer = null; }
  }

  return { subscribe: store.subscribe, refetch, destroy };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  createByokRelayStore,
  createChatStore,
  createStreamingChatStore,
  createRelayHealthStore,
};

/**
 * @byok-relay/vue
 *
 * Vue 3 composables for byok-relay — drop-in BYOK AI in any Vue or Nuxt app.
 *
 * Usage:
 *   import { useByokRelay, useChat, useStreamingChat, useRelayHealth } from '@byok-relay/vue';
 *
 * No build step required. Peer dep: vue >=3.
 */

'use strict';

const { ref, computed, onMounted, onUnmounted, readonly } = require('vue');

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';

// Provider → endpoint path mapping for standard relay requests
const PROVIDER_PATHS = {
  openai:      'chat/completions',
  anthropic:   'messages',
  google:      'models/{model}:generateContent',
  groq:        'chat/completions',
  mistral:     'chat/completions',
  openrouter:  'chat/completions',
};

// ─── Storage helpers ──────────────────────────────────────────────────────────

function storageGet(key) {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; }
  catch { return null; }
}

function storageSet(key, value) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); }
  catch { /* ignore */ }
}

function storageRemove(key) {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(key); }
  catch { /* ignore */ }
}

function legacyTokenStorageKey(appId) {
  return `byok_relay_token_${appId}`;
}

function normalizeRelayUrl(relayUrl) {
  const baseUrl = String(relayUrl || DEFAULT_RELAY_URL).replace(/\/+$/, '');
  if (!baseUrl) throw new Error('relayUrl must not be empty');
  return baseUrl;
}

function tokenStorageKey(relayUrl, appId) {
  const relayScope = normalizeRelayUrl(relayUrl);
  const appScope = appId == null || appId === '' ? 'default' : String(appId);
  return `byok_relay_token_v2_${encodeURIComponent(JSON.stringify([relayScope, appScope]))}`;
}

function readStoredToken(tokenKey, legacyTokenKey) {
  const existing = storageGet(tokenKey);
  if (existing) return existing;

  if (legacyTokenKey && legacyTokenKey !== tokenKey) {
    const legacy = storageGet(legacyTokenKey);
    if (legacy) {
      storageSet(tokenKey, legacy);
      return legacy;
    }
  }

  return null;
}

function removeStoredToken(tokenKey, legacyTokenKey) {
  storageRemove(tokenKey);
  if (legacyTokenKey && legacyTokenKey !== tokenKey) storageRemove(legacyTokenKey);
}

// ─── useByokRelay ─────────────────────────────────────────────────────────────

/**
 * Core composable — manages relay token + key storage.
 *
 * @param {object} opts
 * @param {string} [opts.relayUrl]   Relay base URL (default: https://relay.byokrelay.com)
 * @param {string}  opts.appId       Your app identifier (used for token namespacing)
 *
 * @returns {{
 *   token: Ref<string|null>,
 *   isRegistered: ComputedRef<boolean>,
 *   error: Ref<string|null>,
 *   register: () => Promise<void>,
 *   storeKey: (provider: string, apiKey: string) => Promise<void>,
 *   deleteKey: (provider: string) => Promise<void>,
 *   listProviders: () => Promise<string[]>,
 *   logout: () => void
 * }}
 */
function useByokRelay({ relayUrl = DEFAULT_RELAY_URL, appId } = {}) {
  const baseUrl = normalizeRelayUrl(relayUrl);
  const tokenKey = tokenStorageKey(baseUrl, appId);
  const legacyTokenKey = legacyTokenStorageKey(appId);

  const token = ref(readStoredToken(tokenKey, legacyTokenKey));
  const error = ref(null);

  const isRegistered = computed(() => Boolean(token.value));

  /** Register a new relay token (or load an existing one from localStorage). */
  async function register() {
    error.value = null;
    try {
      const res = await fetch(`${baseUrl}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Registration failed (${res.status})`);
      }
      const { token: t } = await res.json();
      storageSet(tokenKey, t);
      token.value = t;
    } catch (err) {
      error.value = err.message;
    }
  }

  /**
   * Store an API key for a provider.
   * @param {string} provider  e.g. 'openai', 'anthropic', 'groq'
   * @param {string} apiKey    The provider API key entered by the user
   */
  async function storeKey(provider, apiKey) {
    error.value = null;
    if (!token.value) throw new Error('Not registered — call register() first');
    const res = await fetch(`${baseUrl}/keys/${provider}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token.value}`,
      },
      body: JSON.stringify({ api_key: apiKey }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Failed to store key (${res.status})`);
    }
  }

  /**
   * Delete a stored provider key.
   * @param {string} provider  e.g. 'openai'
   */
  async function deleteKey(provider) {
    error.value = null;
    if (!token.value) throw new Error('Not registered');
    const res = await fetch(`${baseUrl}/keys/${provider}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token.value}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Failed to delete key (${res.status})`);
    }
  }

  /**
   * List providers for which a key is stored.
   * @returns {Promise<string[]>}
   */
  async function listProviders() {
    error.value = null;
    if (!token.value) return [];
    const res = await fetch(`${baseUrl}/keys`, {
      headers: { 'Authorization': `Bearer ${token.value}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      error.value = body.error || `Failed to list providers (${res.status})`;
      return [];
    }
    const body = await res.json();
    return body.providers || [];
  }

  /** Clear the relay token from state and localStorage. */
  function logout() {
    removeStoredToken(tokenKey, legacyTokenKey);
    token.value = null;
    error.value = null;
  }

  return { token: readonly(token), isRegistered, error: readonly(error), register, storeKey, deleteKey, listProviders, logout };
}

// ─── useChat ──────────────────────────────────────────────────────────────────

/**
 * Stateful non-streaming chat composable.
 *
 * @param {object} opts
 * @param {Ref<string>|string}  opts.token        Relay token (from useByokRelay)
 * @param {string}             [opts.relayUrl]    Relay base URL
 * @param {string}             [opts.provider]    AI provider (default: 'openai')
 * @param {string}             [opts.model]       Model name (default: 'gpt-4o-mini')
 * @param {string}             [opts.systemPrompt] Optional system prompt
 * @param {object}             [opts.extraParams] Extra body params forwarded to the provider
 *
 * @returns {{
 *   messages: Ref<Array<{role, content}>>,
 *   isLoading: Ref<boolean>,
 *   error: Ref<string|null>,
 *   sendMessage: (content: string) => Promise<void>,
 *   clearMessages: () => void
 * }}
 */
function useChat({
  token,
  relayUrl = DEFAULT_RELAY_URL,
  provider = 'openai',
  model    = 'gpt-4o-mini',
  systemPrompt,
  extraParams = {},
} = {}) {
  const messages  = ref([]);
  const isLoading = ref(false);
  const error     = ref(null);

  function getToken() {
    return typeof token === 'object' && token !== null && 'value' in token ? token.value : token;
  }

  function buildBody(userMessages) {
    if (provider === 'anthropic') {
      const body = {
        model,
        max_tokens: 1024,
        messages: userMessages,
        ...extraParams,
      };
      if (systemPrompt) body.system = systemPrompt;
      return body;
    }
    const msgs = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...userMessages]
      : userMessages;
    return { model, messages: msgs, ...extraParams };
  }

  function extractContent(data) {
    if (provider === 'anthropic') {
      return data?.content?.[0]?.text ?? '';
    }
    return data?.choices?.[0]?.message?.content ?? '';
  }

  function buildPath() {
    const path = PROVIDER_PATHS[provider] || 'chat/completions';
    return path.replace('{model}', encodeURIComponent(model));
  }

  async function sendMessage(content) {
    error.value = null;
    const t = getToken();
    if (!t) { error.value = 'Not registered'; return; }

    const userMsg = { role: 'user', content };
    messages.value = [...messages.value, userMsg];
    isLoading.value = true;

    try {
      const res = await fetch(`${relayUrl}/relay/${provider}/${buildPath()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${t}`,
        },
        body: JSON.stringify(buildBody(messages.value)),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Provider error (${res.status})`);
      }
      const data = await res.json();
      const assistantContent = extractContent(data);
      messages.value = [...messages.value, { role: 'assistant', content: assistantContent }];
    } catch (err) {
      error.value = err.message;
      // Remove the user message that failed
      messages.value = messages.value.slice(0, -1);
    } finally {
      isLoading.value = false;
    }
  }

  function clearMessages() {
    messages.value = [];
    error.value = null;
  }

  return { messages: readonly(messages), isLoading: readonly(isLoading), error: readonly(error), sendMessage, clearMessages };
}

// ─── useStreamingChat ─────────────────────────────────────────────────────────

/**
 * SSE-streaming chat composable. Streams assistant response token-by-token.
 *
 * @param {object} opts
 * @param {Ref<string>|string}  opts.token         Relay token (from useByokRelay)
 * @param {string}             [opts.relayUrl]     Relay base URL
 * @param {string}             [opts.provider]     AI provider (default: 'openai')
 * @param {string}             [opts.model]        Model name (default: 'gpt-4o-mini')
 * @param {string}             [opts.systemPrompt] Optional system prompt
 * @param {object}             [opts.extraParams]  Extra body params
 *
 * @returns {{
 *   messages: Ref<Array<{role, content}>>,
 *   streamingContent: Ref<string>,
 *   isStreaming: Ref<boolean>,
 *   error: Ref<string|null>,
 *   sendMessage: (content: string) => Promise<void>,
 *   stopStreaming: () => void,
 *   clearMessages: () => void
 * }}
 */
function useStreamingChat({
  token,
  relayUrl = DEFAULT_RELAY_URL,
  provider = 'openai',
  model    = 'gpt-4o-mini',
  systemPrompt,
  extraParams = {},
} = {}) {
  const messages         = ref([]);
  const streamingContent = ref('');
  const isStreaming      = ref(false);
  const error            = ref(null);

  let abortController = null;

  function getToken() {
    return typeof token === 'object' && token !== null && 'value' in token ? token.value : token;
  }

  function buildBody(userMessages) {
    if (provider === 'anthropic') {
      const body = { model, max_tokens: 1024, stream: true, messages: userMessages, ...extraParams };
      if (systemPrompt) body.system = systemPrompt;
      return body;
    }
    const msgs = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...userMessages]
      : userMessages;
    return { model, messages: msgs, stream: true, ...extraParams };
  }

  function buildPath() {
    const path = PROVIDER_PATHS[provider] || 'chat/completions';
    return path.replace('{model}', encodeURIComponent(model));
  }

  function extractDelta(line) {
    if (!line.startsWith('data: ')) return '';
    const data = line.slice(6);
    if (data === '[DONE]') return null; // signal end-of-stream
    try {
      const parsed = JSON.parse(data);
      // OpenAI-style delta
      const oaiDelta = parsed?.choices?.[0]?.delta?.content;
      if (oaiDelta != null) return oaiDelta;
      // Anthropic-style delta
      if (parsed?.type === 'content_block_delta') return parsed?.delta?.text ?? '';
      return '';
    } catch {
      return '';
    }
  }

  async function sendMessage(content) {
    error.value = null;
    const t = getToken();
    if (!t) { error.value = 'Not registered'; return; }

    const userMsg = { role: 'user', content };
    messages.value = [...messages.value, userMsg];
    streamingContent.value = '';
    isStreaming.value = true;

    abortController = new AbortController();

    try {
      const res = await fetch(`${relayUrl}/relay/${provider}/${buildPath()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${t}`,
        },
        body: JSON.stringify(buildBody(messages.value)),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Provider error (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep incomplete last line
        for (const line of lines) {
          const delta = extractDelta(line.trim());
          if (delta === null) break; // [DONE]
          if (delta) streamingContent.value += delta;
        }
      }

      // Commit completed message
      if (streamingContent.value) {
        messages.value = [...messages.value, { role: 'assistant', content: streamingContent.value }];
      }
      streamingContent.value = '';
    } catch (err) {
      if (err.name === 'AbortError') {
        // User stopped — commit whatever we have
        if (streamingContent.value) {
          messages.value = [...messages.value, { role: 'assistant', content: streamingContent.value }];
        }
        streamingContent.value = '';
      } else {
        error.value = err.message;
        messages.value = messages.value.slice(0, -1);
        streamingContent.value = '';
      }
    } finally {
      isStreaming.value = false;
      abortController = null;
    }
  }

  function stopStreaming() {
    if (abortController) abortController.abort();
  }

  function clearMessages() {
    if (abortController) abortController.abort();
    messages.value = [];
    streamingContent.value = '';
    error.value = null;
  }

  // Abort any in-flight request when the component unmounts
  onUnmounted(() => {
    if (abortController) abortController.abort();
  });

  return {
    messages:         readonly(messages),
    streamingContent: readonly(streamingContent),
    isStreaming:      readonly(isStreaming),
    error:            readonly(error),
    sendMessage,
    stopStreaming,
    clearMessages,
  };
}

// ─── useRelayHealth ───────────────────────────────────────────────────────────

/**
 * Polls the relay /health endpoint and exposes liveness/readiness state.
 *
 * @param {object} opts
 * @param {string} [opts.relayUrl]         Relay base URL
 * @param {number} [opts.intervalMs=30000] Polling interval in milliseconds
 * @param {boolean}[opts.deep=false]       Include upstream provider readiness probe
 * @param {string} [opts.provider]         Provider to check when deep=true
 *
 * @returns {{
 *   isHealthy: Ref<boolean|null>,
 *   status: Ref<object|null>,
 *   isLoading: Ref<boolean>,
 *   error: Ref<string|null>,
 *   refetch: () => Promise<void>
 * }}
 */
function useRelayHealth({
  relayUrl   = DEFAULT_RELAY_URL,
  intervalMs = 30_000,
  deep       = false,
  provider,
} = {}) {
  const isHealthy = ref(null);
  const status    = ref(null);
  const isLoading = ref(false);
  const error     = ref(null);

  let timer = null;

  async function refetch() {
    isLoading.value = true;
    error.value     = null;
    try {
      let url = `${relayUrl}/health`;
      const params = [];
      if (deep) params.push('deep=1');
      if (provider) params.push(`provider=${encodeURIComponent(provider)}`);
      if (params.length) url += `?${params.join('&')}`;

      const res = await fetch(url);
      const body = await res.json().catch(() => ({}));
      status.value    = body;
      isHealthy.value = res.ok && body.status === 'ok';
    } catch (err) {
      error.value     = err.message;
      isHealthy.value = false;
    } finally {
      isLoading.value = false;
    }
  }

  onMounted(async () => {
    await refetch();
    if (intervalMs > 0) {
      timer = setInterval(refetch, intervalMs);
    }
  });

  onUnmounted(() => {
    if (timer) clearInterval(timer);
  });

  return { isHealthy: readonly(isHealthy), status: readonly(status), isLoading: readonly(isLoading), error: readonly(error), refetch };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  useByokRelay,
  useChat,
  useStreamingChat,
  useRelayHealth,
};

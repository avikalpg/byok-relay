/**
 * @byok-relay/expo
 *
 * React Native / Expo hooks and ByokRelayClient for byok-relay.
 * Drop-in BYOK AI in any React Native or Expo app — no server code required.
 *
 * Key differences from @byok-relay/react:
 *   - Storage: AsyncStorage (via @react-native-async-storage/async-storage)
 *     instead of localStorage. All storage operations are async.
 *   - SSE streaming: uses a fetch implementation with ReadableStream support.
 *     Expo SDK 52+ provides `expo/fetch`; older Expo SDKs and bare React Native
 *     apps should pass a compatible `fetch` implementation or polyfill.
 *   - No `window` global assumptions — safe in Hermes, Fabric, and New Arch.
 *
 * Usage:
 *   import {
 *     useByokRelay,
 *     useChat,
 *     useStreamingChat,
 *     useRelayHealth,
 *     ByokRelayClient,
 *     createAsyncStorage,
 *   } from '@byok-relay/expo';
 *
 * Peer deps: react >=16.8.0 (hooks), @react-native-async-storage/async-storage >=1.0.0 (optional)
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';
const TOKEN_STORAGE_PREFIX = 'byok_relay_token';

function _tokenStorageKeyForRelay(relayUrl) {
  return `${TOKEN_STORAGE_PREFIX}:${encodeURIComponent(relayUrl)}`;
}

/** Map of provider → chat path used when building relay URLs. */
const PROVIDER_PATHS = {
  openai:     'chat/completions',
  anthropic:  'messages',
  google:     'models/{model}:generateContent',
  groq:       'chat/completions',
  mistral:    'chat/completions',
  openrouter: 'chat/completions',
};

// ─── React hook shim ─────────────────────────────────────────────────────────

/**
 * Resolve React hooks from the 'react' package.
 * Returns { useState, useEffect, useCallback, useRef }.
 * Throws a clear error when react is not installed.
 */
function _resolveHooks() {
  try {
    // eslint-disable-next-line global-require
    const React = require('react');
    return {
      useState:     React.useState,
      useEffect:    React.useEffect,
      useCallback:  React.useCallback,
      useRef:       React.useRef,
    };
  } catch (_) {
    throw new Error(
      '@byok-relay/expo requires react as a peer dependency. ' +
      'Install it with: npm install react'
    );
  }
}

// ─── AsyncStorage shim ────────────────────────────────────────────────────────

/**
 * Try to require @react-native-async-storage/async-storage.
 * Returns null when not installed (falls back to in-memory storage).
 */
function _tryAsyncStorage() {
  try {
    // eslint-disable-next-line global-require
    return require('@react-native-async-storage/async-storage').default;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve the fetch implementation used by ByokRelayClient.
 *
 * Expo SDK 52+ provides `expo/fetch` with streaming response bodies. Older Expo
 * SDKs and bare React Native globals may not, so callers can pass `opts.fetch`
 * to the client/hooks.
 */
function _resolveFetch(fetchImpl) {
  if (fetchImpl) return fetchImpl;
  try {
    // eslint-disable-next-line global-require
    const expoFetch = require('expo/fetch');
    if (expoFetch && typeof expoFetch.fetch === 'function') return expoFetch.fetch.bind(globalThis);
  } catch (_) {
    // Fall back to the environment fetch below.
  }
  if (typeof fetch === 'function') return fetch.bind(globalThis);
  throw new Error(
    '@byok-relay/expo requires a fetch implementation. ' +
    'Use Expo with expo/fetch or pass { fetch } when constructing ByokRelayClient.'
  );
}

/**
 * Create an AsyncStorage-backed storage adapter for ByokRelayClient.
 *
 * Compatible with @react-native-async-storage/async-storage and any
 * object that implements { getItem, setItem, removeItem } returning Promises.
 *
 * @param {object} [asyncStorage]  AsyncStorage instance (default: auto-detect)
 * @returns {{ getItem, setItem, removeItem }}
 */
function createAsyncStorage(asyncStorage) {
  const AS = asyncStorage || _tryAsyncStorage();
  if (!AS) {
    // Warn and return in-memory fallback
    console.warn(
      '[byok-relay] @react-native-async-storage/async-storage not found. ' +
      'Relay token will not persist across app restarts. ' +
      'Install with: npx expo install @react-native-async-storage/async-storage'
    );
    const _mem = Object.create(null);
    return {
      getItem:    (key) => Promise.resolve(_mem[key] !== undefined ? _mem[key] : null),
      setItem:    (key, val) => { _mem[key] = val; return Promise.resolve(); },
      removeItem: (key) => { delete _mem[key]; return Promise.resolve(); },
    };
  }
  return {
    getItem:    (key) => AS.getItem(key),
    setItem:    (key, val) => AS.setItem(key, val),
    removeItem: (key) => AS.removeItem(key),
  };
}

// ─── In-memory storage (used in Node test environments) ──────────────────────

function _memStorage() {
  const _store = Object.create(null);
  return {
    getItem:    (key) => Promise.resolve(_store[key] !== undefined ? _store[key] : null),
    setItem:    (key, val) => { _store[key] = val; return Promise.resolve(); },
    removeItem: (key) => { delete _store[key]; return Promise.resolve(); },
  };
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Parse provider/model from a unified model id string.
 * "openai/gpt-4o" → { provider: 'openai', model: 'gpt-4o' }
 * "claude-opus-4-5"  → { provider: 'anthropic', model: 'claude-opus-4-5' }
 */
function _parseModelId(modelId) {
  if (!modelId) return { provider: 'openai', model: 'gpt-4o' };
  const slash = modelId.indexOf('/');
  if (slash > 0) {
    return { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
  }
  // Heuristic: bare model name
  if (/^claude/.test(modelId))   return { provider: 'anthropic', model: modelId };
  if (/^gemini/.test(modelId))   return { provider: 'google',    model: modelId };
  if (/^mistral/.test(modelId))  return { provider: 'mistral',   model: modelId };
  if (/^llama|mixtral/.test(modelId)) return { provider: 'groq', model: modelId };
  return { provider: 'openai', model: modelId };
}

/**
 * Build the full relay URL for a chat request.
 * Uses unified routing when POST /relay is available (v1.1+).
 */
function _buildRelayUrl(relayUrl, provider) {
  const base = relayUrl.replace(/\/$/, '');
  const path = PROVIDER_PATHS[provider] || 'chat/completions';
  return `${base}/relay/${provider}/${path}`;
}

/**
 * Build request headers for the relay.
 * Relay-Token header carries the user's session token.
 */
function _buildHeaders(token, contentType) {
  const h = { 'Content-Type': contentType || 'application/json' };
  if (token) h['Relay-Token'] = token;
  return h;
}

function _buildHealthUrl(relayUrl, deep = false, provider) {
  const base = relayUrl.replace(/\/$/, '');
  const params = new URLSearchParams();
  if (deep) params.set('deep', '1');
  if (provider) params.set('provider', provider);
  const query = params.toString();
  return `${base}/health${query ? `?${query}` : ''}`;
}

const OPTIMISTIC_MESSAGE_ID = Symbol('byokRelayOptimisticMessageId');

function _withoutOptimisticMessageIds(messages) {
  return messages.map((message) => {
    if (!message || typeof message !== 'object') return message;
    const clean = {};
    for (const key of Object.keys(message)) clean[key] = message[key];
    return clean;
  });
}

function _replaceOptimisticMessage(prev, optimisticId) {
  return prev.map((message) => {
    if (!message || message[OPTIMISTIC_MESSAGE_ID] !== optimisticId) return message;
    return _withoutOptimisticMessageIds([message])[0];
  });
}

function _removeOptimisticMessage(prev, optimisticId) {
  return prev.filter(message => !message || message[OPTIMISTIC_MESSAGE_ID] !== optimisticId);
}

// ─── SSE parser ──────────────────────────────────────────────────────────────

/**
 * Parse server-sent event chunks from a ReadableStream reader.
 * Yields { data } objects for each SSE data line.
 * Works with React Native's fetch ReadableStream implementation.
 *
 * @param {ReadableStreamDefaultReader} reader
 */
async function* _parseSSE(reader) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) {
          const data = trimmed.slice(5).trim();
          if (data && data !== '[DONE]') {
            yield { data };
          }
        }
      }
    }
    // Flush remaining buffer
    if (buffer.trim().startsWith('data:')) {
      const data = buffer.trim().slice(5).trim();
      if (data && data !== '[DONE]') yield { data };
    }
  } finally {
    try {
      if (typeof reader.cancel === 'function') await reader.cancel();
    } catch (_) { /* already closed */ }
    try {
      if (typeof reader.releaseLock === 'function') reader.releaseLock();
    } catch (_) { /* already released */ }
  }
}

/**
 * Extract the text delta from a streaming SSE chunk.
 * Handles both OpenAI and Anthropic streaming formats.
 */
function _extractDelta(parsed) {
  // OpenAI format: choices[0].delta.content
  if (parsed.choices && parsed.choices[0]) {
    return parsed.choices[0].delta?.content || '';
  }
  // Anthropic format: delta.text
  if (parsed.delta && parsed.delta.type === 'text_delta') {
    return parsed.delta.text || '';
  }
  return '';
}

// ─── ByokRelayClient ─────────────────────────────────────────────────────────

/**
 * Plain-JS client for byok-relay — works in React Native, Expo, and Node.js.
 *
 * By default uses AsyncStorage (via createAsyncStorage()) for token persistence.
 * Override with a custom storage adapter for Expo SecureStore or other backends.
 *
 * @example
 * // Basic usage
 * const client = new ByokRelayClient({ relayUrl: 'https://my-relay.example.com' });
 * await client.register('my-app');
 * await client.storeKey('openai', 'sk-...');
 * const reply = await client.chat('openai/gpt-4o', [{ role: 'user', content: 'hi' }]);
 *
 * @example
 * // With Expo SecureStore
 * import * as SecureStore from 'expo-secure-store';
 * const client = new ByokRelayClient({
 *   storage: {
 *     getItem:    (k) => SecureStore.getItemAsync(k),
 *     setItem:    (k, v) => SecureStore.setItemAsync(k, v),
 *     removeItem: (k) => SecureStore.deleteItemAsync(k),
 *   },
 * });
 */
class ByokRelayClient {
  /**
   * @param {object} opts
   * @param {string}  [opts.relayUrl]  Upstream relay URL (default: managed relay)
   * @param {string}  [opts.appId]     Application identifier for registration
   * @param {object}  [opts.storage]   Async storage adapter { getItem, setItem, removeItem }
   * @param {Function} [opts.fetch]    Fetch implementation; use expo/fetch for streaming in RN
   */
  constructor(opts = {}) {
    this._relayUrl = (opts.relayUrl || DEFAULT_RELAY_URL).replace(/\/$/, '');
    this._appId    = opts.appId || 'expo-app';
    this._storage  = opts.storage || createAsyncStorage();
    this._tokenStorageKey = _tokenStorageKeyForRelay(this._relayUrl);
    this._token    = null; // in-memory cache; AsyncStorage is the persistent store
    this._tokenPromise = null;
    this._authGeneration = 0;
    this._fetch    = _resolveFetch(opts.fetch);
  }

  // ── Token management ──

  _nextAuthGeneration() {
    this._authGeneration += 1;
    return this._authGeneration;
  }

  _isActiveAuthGeneration(generation) {
    return this._authGeneration === generation;
  }

  /** Current in-memory token, or null. */
  get token() { return this._token; }

  async _removeTokenIfCurrent(token) {
    const stored = await this._storage.getItem(this._tokenStorageKey);
    if (stored === token) await this._storage.removeItem(this._tokenStorageKey);
  }

  async _restoreToken() {
    if (this._token) return this._token;
    const generation = this._authGeneration;
    const stored = await this._storage.getItem(this._tokenStorageKey);
    if (!stored) return null;
    if (!this._isActiveAuthGeneration(generation)) return this._token;
    this._token = stored;
    return stored;
  }

  /** Restore a persisted token without registering a new one. */
  async restoreToken() { return this._restoreToken(); }

  async _clearAuthState() {
    this._nextAuthGeneration();
    this._token = null;
    this._tokenPromise = null;
    await this._storage.removeItem(this._tokenStorageKey);
  }

  /** Register a new user and persist the token. */
  async register(appId) {
    const generation = this._nextAuthGeneration();
    const id = appId || this._appId;
    const res = await this._fetch(`${this._relayUrl}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: id }),
    });
    if (!res.ok) throw new Error(`Registration failed: ${res.status}`);
    const { token } = await res.json();
    if (!this._isActiveAuthGeneration(generation)) return this._token;
    this._token = token;
    await this._storage.setItem(this._tokenStorageKey, token);
    if (!this._isActiveAuthGeneration(generation)) {
      if (this._token === token) this._token = null;
      await this._removeTokenIfCurrent(token);
      return this._token;
    }
    return token;
  }

  /** Load token from storage if not already in memory. */
  async ensureToken(appId) {
    if (this._token) return this._token;
    if (this._tokenPromise) return this._tokenPromise;
    let tokenPromise;
    tokenPromise = (async () => {
      const restored = await this._restoreToken();
      if (restored) return restored;
      if (!this._tokenPromise || this._tokenPromise !== tokenPromise) return this._token;
      return this.register(appId);
    })();
    this._tokenPromise = tokenPromise;
    try {
      return await tokenPromise;
    } finally {
      if (this._tokenPromise === tokenPromise) this._tokenPromise = null;
    }
  }

  /** Remove the token from memory and storage. */
  async logout() {
    await this._clearAuthState();
  }

  // ── Key management ──

  /** Store an API key for a provider (encrypted at rest on the relay). */
  async storeKey(provider, apiKey) {
    const token = await this.ensureToken();
    const res = await this._fetch(`${this._relayUrl}/keys/${provider}`, {
      method: 'POST',
      headers: _buildHeaders(token),
      body: JSON.stringify({ api_key: apiKey }),
    });
    if (!res.ok) throw new Error(`storeKey failed: ${res.status}`);
    return res.json();
  }

  /** List stored provider keys (returns key metadata, not the raw key values). */
  async listKeys() {
    const token = await this.ensureToken();
    const res = await this._fetch(`${this._relayUrl}/keys`, {
      headers: _buildHeaders(token),
    });
    if (!res.ok) throw new Error(`listKeys failed: ${res.status}`);
    return res.json();
  }

  /** Delete a stored provider key. */
  async deleteKey(provider) {
    const token = await this.ensureToken();
    const res = await this._fetch(`${this._relayUrl}/keys/${provider}`, {
      method: 'DELETE',
      headers: _buildHeaders(token),
    });
    if (!res.ok) throw new Error(`deleteKey failed: ${res.status}`);
    return res.json();
  }

  /** Atomically rotate a provider key (verify new key before replacing old). */
  async rotateKey(provider, newApiKey) {
    const token = await this.ensureToken();
    const res = await this._fetch(`${this._relayUrl}/keys/${provider}/rotate`, {
      method: 'POST',
      headers: _buildHeaders(token),
      body: JSON.stringify({ api_key: newApiKey }),
    });
    if (!res.ok) throw new Error(`rotateKey failed: ${res.status}`);
    return res.json();
  }

  // ── Relay ──

  /** Forward an arbitrary request to a provider via the relay. */
  async relayRequest(provider, path, body, method = 'POST') {
    const token = await this.ensureToken();
    const url = `${this._relayUrl}/relay/${provider}/${path}`;
    const res = await this._fetch(url, {
      method,
      headers: _buildHeaders(token),
      body: method !== 'GET' ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`relayRequest failed: ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  /**
   * Non-streaming chat completion.
   * @param {string} modelId  "provider/model" or bare model name
   * @param {Array}  messages  OpenAI-format messages array
   * @param {object} [extra]   Extra params (temperature, max_tokens, etc.)
   */
  async chat(modelId, messages, extra = {}) {
    const { provider, model } = _parseModelId(modelId);
    const token = await this.ensureToken();
    const url = _buildRelayUrl(this._relayUrl, provider);
    const body = { model, messages, ...extra };
    const res = await this._fetch(url, {
      method: 'POST',
      headers: _buildHeaders(token),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`chat failed: ${res.status}`);
    return res.json();
  }

  /**
   * Streaming chat completion — async generator of text chunks.
   *
   * @param {string}  modelId   "provider/model" or bare model name
   * @param {Array}   messages  OpenAI-format messages array
   * @param {object}  [opts]
   * @param {object}  [opts.extra]   Extra params for the provider API
   * @param {AbortSignal} [opts.signal]  AbortSignal for cancellation
   *
   * @yields {string} Text delta chunks
   *
   * @example
   * for await (const chunk of client.streamChat('openai/gpt-4o', messages)) {
   *   setContent(prev => prev + chunk);
   * }
   */
  async *streamChat(modelId, messages, opts = {}) {
    const { provider, model } = _parseModelId(modelId);
    const token = await this.ensureToken();
    const url = _buildRelayUrl(this._relayUrl, provider);
    const body = { model, messages, stream: true, ...(opts.extra || {}) };
    const res = await this._fetch(url, {
      method: 'POST',
      headers: _buildHeaders(token),
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`streamChat failed: ${res.status}`);
    if (!res.body) throw new Error('streamChat: response body is null (ReadableStream not supported)');
    const reader = res.body.getReader();
    for await (const { data } of _parseSSE(reader)) {
      try {
        const parsed = JSON.parse(data);
        const delta = _extractDelta(parsed);
        if (delta) yield delta;
      } catch (_) { /* skip unparseable chunks */ }
    }
  }

  // ── Health & stats ──

  /** Check relay liveness and optional upstream readiness. */
  async health(deep = false, provider) {
    const url = _buildHealthUrl(this._relayUrl, deep, provider);
    const res = await this._fetch(url);
    if (!res.ok) throw new Error(`health failed: ${res.status}`);
    return res.json();
  }

  /** Get relay usage statistics for the current user. */
  async stats(appId) {
    const token = await this.ensureToken();
    const path = appId ? `/stats/${appId}` : '/stats';
    const res = await this._fetch(`${this._relayUrl}${path}`, {
      headers: _buildHeaders(token),
    });
    if (!res.ok) throw new Error(`stats failed: ${res.status}`);
    return res.json();
  }

  /** List available models (when ALLOWED_MODELS is configured on the relay). */
  async getModels() {
    const res = await this._fetch(`${this._relayUrl}/models`);
    if (!res.ok) throw new Error(`getModels failed: ${res.status}`);
    return res.json();
  }

  /** Delete account and all stored keys (GDPR erasure). */
  async deleteAccount() {
    const token = await this.ensureToken();
    const res = await this._fetch(`${this._relayUrl}/users`, {
      method: 'DELETE',
      headers: _buildHeaders(token),
    });
    if (!res.ok) throw new Error(`deleteAccount failed: ${res.status}`);
    await this._clearAuthState();
    return res.json();
  }
}

// ─── React hooks ─────────────────────────────────────────────────────────────

/**
 * Core hook — token registration, key CRUD, and logout.
 *
 * Persists the relay token to AsyncStorage so it survives app restarts.
 *
 * @param {object} [opts]
 * @param {string}  [opts.relayUrl]   Relay URL (default: managed relay)
 * @param {string}  [opts.appId]      App identifier for registration
 * @param {object}  [opts.storage]    Async storage adapter (default: AsyncStorage)
 *
 * @returns {{
 *   token: string|null,
 *   loading: boolean,
 *   error: string|null,
 *   register: (appId?: string) => Promise<void>,
 *   storeKey: (provider: string, apiKey: string) => Promise<void>,
 *   listKeys: () => Promise<object[]>,
 *   deleteKey: (provider: string) => Promise<void>,
 *   rotateKey: (provider: string, newKey: string) => Promise<void>,
 *   logout: () => Promise<void>,
 *   client: ByokRelayClient,
 * }}
 */
function useByokRelay(opts = {}) {
  const { useState, useEffect, useCallback, useRef } = _resolveHooks();

  const clientRef = useRef(null);
  if (!clientRef.current) {
    clientRef.current = new ByokRelayClient({
      relayUrl: opts.relayUrl,
      appId:    opts.appId,
      storage:  opts.storage,
      fetch:    opts.fetch,
    });
  }
  const client = clientRef.current;

  const [token,   setToken]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  // On mount: restore token from AsyncStorage
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const stored = await client.restoreToken();
        if (!cancelled && stored && client.token === stored) setToken(stored);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const register = useCallback(async (appId) => {
    setLoading(true);
    setError(null);
    try {
      const t = await client.register(appId || opts.appId);
      setToken(client.token || t);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [client, opts.appId]);

  const storeKey = useCallback(async (provider, apiKey) => {
    setError(null);
    try {
      await client.storeKey(provider, apiKey);
    } catch (e) {
      setError(e.message);
      throw e;
    }
  }, [client]);

  const listKeys = useCallback(() => client.listKeys(), [client]);

  const deleteKey = useCallback(async (provider) => {
    setError(null);
    try {
      await client.deleteKey(provider);
    } catch (e) {
      setError(e.message);
      throw e;
    }
  }, [client]);

  const rotateKey = useCallback(async (provider, newKey) => {
    setError(null);
    try {
      await client.rotateKey(provider, newKey);
    } catch (e) {
      setError(e.message);
      throw e;
    }
  }, [client]);

  const logout = useCallback(async () => {
    await client.logout();
    setToken(null);
  }, [client]);

  return { token, loading, error, register, storeKey, listKeys, deleteKey, rotateKey, logout, client };
}

/**
 * Non-streaming chat hook.
 *
 * @param {object} opts
 * @param {string}  opts.relayUrl     Relay URL
 * @param {string}  opts.model        "provider/model" or bare model name
 * @param {string}  [opts.systemPrompt]  Optional system message
 * @param {object}  [opts.storage]    Async storage adapter
 * @param {object}  [opts.extraParams] Extra params passed to the provider API
 *
 * @returns {{
 *   messages: Array,
 *   loading: boolean,
 *   error: string|null,
 *   sendMessage: (content: string) => Promise<void>,
 *   clearMessages: () => void,
 * }}
 */
function useChat(opts = {}) {
  const { useState, useCallback, useRef } = _resolveHooks();

  const clientRef = useRef(null);
  if (!clientRef.current) {
    clientRef.current = new ByokRelayClient({
      relayUrl: opts.relayUrl,
      storage:  opts.storage,
      fetch:    opts.fetch,
    });
  }
  const client = clientRef.current;

  const [messages, setMessages] = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);
  const messagesRef = useRef([]);

  const sendMessage = useCallback(async (content) => {
    setError(null);
    const optimisticId = Symbol('pendingMessage');
    const userMsg = { role: 'user', content, [OPTIMISTIC_MESSAGE_ID]: optimisticId };
    const nextMessages = [...messagesRef.current, userMsg];
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    setLoading(true);

    const providerMessages = _withoutOptimisticMessageIds(nextMessages);
    const fullMessages = opts.systemPrompt
      ? [{ role: 'system', content: opts.systemPrompt }, ...providerMessages]
      : providerMessages;

    try {
      const data = await client.chat(opts.model || 'openai/gpt-4o', fullMessages, opts.extraParams || {});
      const reply = data.choices?.[0]?.message?.content
        || data.content?.[0]?.text
        || '';
      setMessages(prev => {
        const next = [..._replaceOptimisticMessage(prev, optimisticId), { role: 'assistant', content: reply }];
        messagesRef.current = next;
        return next;
      });
    } catch (e) {
      setMessages(prev => {
        const next = _removeOptimisticMessage(prev, optimisticId);
        messagesRef.current = next;
        return next;
      });
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [client, opts.model, opts.systemPrompt, opts.extraParams]);

  const clearMessages = useCallback(() => {
    messagesRef.current = [];
    setMessages([]);
  }, []);

  return { messages, loading, error, sendMessage, clearMessages };
}

/**
 * Streaming chat hook.
 *
 * Uses fetch + ReadableStream for SSE. Expo apps should use `expo/fetch` or
 * pass a streaming-capable fetch implementation; no EventSource polyfill required.
 *
 * @param {object} opts
 * @param {string}  opts.relayUrl     Relay URL
 * @param {string}  opts.model        "provider/model" or bare model name
 * @param {string}  [opts.systemPrompt]
 * @param {object}  [opts.storage]    Async storage adapter
 * @param {object}  [opts.extraParams]
 *
 * @returns {{
 *   messages: Array,
 *   streamingContent: string,
 *   loading: boolean,
 *   error: string|null,
 *   sendMessage: (content: string) => Promise<void>,
 *   stopStreaming: () => void,
 *   clearMessages: () => void,
 * }}
 */
function useStreamingChat(opts = {}) {
  const { useState, useCallback, useRef } = _resolveHooks();

  const clientRef = useRef(null);
  if (!clientRef.current) {
    clientRef.current = new ByokRelayClient({
      relayUrl: opts.relayUrl,
      storage:  opts.storage,
      fetch:    opts.fetch,
    });
  }
  const client = clientRef.current;

  const [messages,         setMessages]         = useState([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [loading,          setLoading]          = useState(false);
  const [error,            setError]            = useState(null);
  const abortRef = useRef(null);
  const messagesRef = useRef([]);
  const rollbackOnAbortRef = useRef(new Set());

  const abortActiveStream = useCallback((rollbackOptimistic = false) => {
    if (abortRef.current) {
      if (rollbackOptimistic && abortRef.current[OPTIMISTIC_MESSAGE_ID]) {
        rollbackOnAbortRef.current.add(abortRef.current[OPTIMISTIC_MESSAGE_ID]);
      }
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const stopStreaming = useCallback(() => {
    abortActiveStream(false);
  }, [abortActiveStream]);

  const sendMessage = useCallback(async (content) => {
    // Stop any in-progress stream
    abortActiveStream(true);
    setError(null);
    setStreamingContent('');

    const optimisticId = Symbol('pendingMessage');
    const userMsg = { role: 'user', content, [OPTIMISTIC_MESSAGE_ID]: optimisticId };
    const nextMessages = [...messagesRef.current, userMsg];
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    setLoading(true);

    const providerMessages = _withoutOptimisticMessageIds(nextMessages);
    const fullMessages = opts.systemPrompt
      ? [{ role: 'system', content: opts.systemPrompt }, ...providerMessages]
      : providerMessages;

    const controller = new AbortController();
    controller[OPTIMISTIC_MESSAGE_ID] = optimisticId;
    abortRef.current = controller;

    let accumulated = '';
    let aborted = false;
    try {
      for await (const chunk of client.streamChat(
        opts.model || 'openai/gpt-4o',
        fullMessages,
        { signal: controller.signal, extra: opts.extraParams || {} }
      )) {
        if (controller.signal.aborted) break;
        accumulated += chunk;
        setStreamingContent(accumulated);
      }
    } catch (e) {
      aborted = e.name === 'AbortError' || controller.signal.aborted;
      if (!aborted) {
        setMessages(prev => {
          const next = _removeOptimisticMessage(prev, optimisticId);
          messagesRef.current = next;
          return next;
        });
        setError(e.message);
      }
    } finally {
      aborted = aborted || controller.signal.aborted;
      if (accumulated) {
        const suffix = aborted ? ' [stopped]' : '';
        setMessages(prev => {
          const next = [..._replaceOptimisticMessage(prev, optimisticId), { role: 'assistant', content: accumulated + suffix }];
          messagesRef.current = next;
          return next;
        });
      } else if (aborted && rollbackOnAbortRef.current.has(optimisticId)) {
        setMessages(prev => {
          const next = _removeOptimisticMessage(prev, optimisticId);
          messagesRef.current = next;
          return next;
        });
      }
      rollbackOnAbortRef.current.delete(optimisticId);
      setStreamingContent('');
      if (abortRef.current === controller) abortRef.current = null;
      setLoading(false);
    }
  }, [client, opts.model, opts.systemPrompt, opts.extraParams, abortActiveStream]);

  const clearMessages = useCallback(() => {
    abortActiveStream(false);
    messagesRef.current = [];
    setMessages([]);
    setStreamingContent('');
  }, [abortActiveStream]);

  return { messages, streamingContent, loading, error, sendMessage, stopStreaming, clearMessages };
}

/**
 * Relay health polling hook.
 *
 * @param {object} [opts]
 * @param {string}  [opts.relayUrl]   Relay URL
 * @param {number}  [opts.intervalMs] Poll interval in ms (default: 30 000)
 * @param {Function} [opts.fetch]     Fetch implementation override
 *
 * relayUrl, intervalMs, and fetch are fixed at mount; later option changes do
 * not restart polling or change refetch/check, matching the other hooks. Fetch
 * resolution is deferred until the first health request.
 *
 * @returns {{
 *   status: 'ok'|'error'|'unknown',
 *   data: object|null,
 *   loading: boolean,
 *   refetch: () => Promise<void>,
 *   check: (deep?: boolean, provider?: string) => Promise<object>,
 * }}
 */
function useRelayHealth(opts = {}) {
  const { useState, useEffect, useCallback, useRef } = _resolveHooks();

  const relayUrlRef = useRef(opts.relayUrl || DEFAULT_RELAY_URL);
  const intervalRef = useRef(opts.intervalMs !== undefined ? opts.intervalMs : 30_000);
  const fetchOptRef = useRef(opts.fetch);
  const fetchRef = useRef(null);

  const getFetch = useCallback(() => {
    if (!fetchRef.current) fetchRef.current = _resolveFetch(fetchOptRef.current);
    return fetchRef.current;
  }, []);

  const [status,  setStatus]  = useState('unknown');
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await getFetch()(_buildHealthUrl(relayUrlRef.current));
      if (!res.ok) throw new Error(`health failed: ${res.status}`);
      const json = await res.json();
      setStatus(json.status === 'ok' ? 'ok' : 'error');
      setData(json);
    } catch (_) {
      setStatus('error');
    } finally {
      setLoading(false);
    }
  }, [getFetch]);

  const check = useCallback(async (deep = false, provider) => {
    const url = _buildHealthUrl(relayUrlRef.current, deep, provider);
    const res  = await getFetch()(url);
    if (!res.ok) throw new Error(`health failed: ${res.status}`);
    return res.json();
  }, [getFetch]);

  useEffect(() => {
    refetch();
    if (intervalRef.current > 0) {
      timerRef.current = setInterval(refetch, intervalRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, data, loading, refetch, check };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Hooks
  useByokRelay,
  useChat,
  useStreamingChat,
  useRelayHealth,
  // Client class
  ByokRelayClient,
  // Storage helpers
  createAsyncStorage,
};

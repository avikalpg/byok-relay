/**
 * @byok-relay/solid
 *
 * SolidJS reactive stores for byok-relay — drop-in BYOK AI in any SolidJS or SolidStart app.
 *
 * Usage:
 *   import {
 *     createByokRelayStore,
 *     createChatStore,
 *     createStreamingChatStore,
 *     createRelayHealthStore
 *   } from '@byok-relay/solid';
 *
 * No build step required. solid-js peer dep optional — stores work in plain JS too.
 * For SolidStart SSR: stores are browser-safe (localStorage guarded by `typeof window`).
 */

'use strict';

let solidCreateSignal = null;
let solidCreateStore = null;
try { ({ createSignal: solidCreateSignal } = require('solid-js')); } catch { /* optional peer dependency */ }
try { ({ createStore: solidCreateStore } = require('solid-js/store')); } catch { /* optional peer dependency */ }

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';

const PROVIDER_PATHS = {
  openai:     'chat/completions',
  anthropic:  'messages',
  groq:       'chat/completions',
  mistral:    'chat/completions',
  openrouter: 'chat/completions',
};

// ─── Signal shim ─────────────────────────────────────────────────────────────

/**
 * Create a minimal SolidJS-compatible signal.
 * When solid-js is available, uses native createSignal for reactivity.
 * Falls back to a plain getter/setter pair that still works in non-Solid contexts.
 *
 * Returns [getter, setter] — identical contract to SolidJS's `createSignal`.
 */
function createSignal(initial) {
  // Use native SolidJS signals when the optional peer dependency is installed.
  if (solidCreateSignal) return solidCreateSignal(initial);

  let value = initial;
  const getter = () => value;
  const setter = (next) => {
    value = typeof next === 'function' ? next(value) : next;
    return value;
  };
  return [getter, setter];
}

/**
 * Create a minimal SolidJS-compatible mutable store.
 * Returns [state proxy, setState] — mirrors SolidJS `createStore`.
 */
function createStore(initial) {
  if (solidCreateStore) return solidCreateStore(initial);

  // Minimal shim: plain object + setter that merges patches
  let state = { ...initial };
  const subscribers = new Set();

  const proxy = new Proxy(state, {
    get(target, key) { return target[key]; },
    set(target, key, val) { target[key] = val; return true; },
  });

  function setState(patch) {
    if (typeof patch === 'function') {
      patch = patch(state);
    }
    if (patch && typeof patch === 'object') {
      Object.assign(state, patch);
    }
    subscribers.forEach(fn => fn(state));
  }

  setState._subscribe = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };

  return [proxy, setState];
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

function* parseSSE(frame) {
  const lines = frame.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { yield null; continue; }
    try { yield JSON.parse(data); } catch { /* skip malformed */ }
  }
}

function createSSEParser() {
  let buffer = '';

  function* drainFrames(frames) {
    for (const frame of frames) yield* parseSSE(frame);
  }

  return {
    *push(chunk) {
      buffer += chunk;
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      yield* drainFrames(frames);
    },
    *flush() {
      const trailing = buffer;
      buffer = '';
      if (trailing.trim()) yield* parseSSE(trailing);
    },
  };
}

function extractDelta(event, provider) {
  if (!event) return '';
  if (provider === 'anthropic') {
    if (event.type === 'content_block_delta') return event.delta?.text || '';
    return '';
  }
  return event.choices?.[0]?.delta?.content || '';
}

// ─── createByokRelayStore ─────────────────────────────────────────────────────

/**
 * Core store — manages relay token registration and API key CRUD.
 *
 * @param {object} opts
 * @param {string} [opts.relayUrl]   Relay base URL (default: https://relay.byokrelay.com)
 * @param {string}  opts.appId       Your app identifier (used for token namespacing)
 * @param {object} [opts.storage]    Custom storage adapter { get, set, remove }
 *
 * @returns {{
 *   token: () => string|null,
 *   loading: () => boolean,
 *   error: () => string|null,
 *   providers: () => string[],
 *   register: () => Promise<string>,
 *   logout: () => void,
 *   storeKey: (provider: string, key: string) => Promise<void>,
 *   listKeys: () => Promise<string[]>,
 *   deleteKey: (provider: string) => Promise<void>,
 *   health: (opts?: {deep?: boolean, provider?: string}) => Promise<object>,
 * }}
 */
function createByokRelayStore(opts = {}) {
  const relayUrl = (opts.relayUrl || DEFAULT_RELAY_URL).replace(/\/$/, '');
  const appId    = opts.appId || 'byok-relay-app';
  const storeKey = `byok_token_${appId}`;

  const storage = opts.storage || {
    get:    (k) => storageGet(k),
    set:    (k, v) => storageSet(k, v),
    remove: (k) => storageRemove(k),
  };

  const [token,    setToken]    = createSignal(storage.get(storeKey) || null);
  const [loading,  setLoading]  = createSignal(false);
  const [error,    setError]    = createSignal(null);
  const [providers, setProviders] = createSignal([]);

  async function register() {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch(`${relayUrl}/users`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ app_id: appId }),
      });
      if (!res.ok) throw new Error(`Registration failed: ${res.status}`);
      const { token: t } = await res.json();
      storage.set(storeKey, t);
      setToken(t);
      return t;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    storage.remove(storeKey);
    setToken(null);
    setProviders([]);
  }

  async function _ensureToken() {
    const t = token();
    if (t) return t;
    return register();
  }

  async function storeProviderKey(provider, key) {
    setLoading(true);
    setError(null);
    try {
      const t = await _ensureToken();
      const res = await fetch(`${relayUrl}/keys/${provider}`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'x-relay-token': t,
        },
        body: JSON.stringify({ key }),
      });
      if (!res.ok) throw new Error(`Failed to store key: ${res.status}`);
      setProviders(prev => prev.includes(provider) ? prev : [...prev, provider]);
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }

  async function listKeys() {
    const t = await _ensureToken();
    const res = await fetch(`${relayUrl}/keys`, {
      headers: { 'x-relay-token': t },
    });
    if (!res.ok) throw new Error(`Failed to list keys: ${res.status}`);
    const { providers: list } = await res.json();
    setProviders(list || []);
    return list || [];
  }

  async function deleteKey(provider) {
    const t = await _ensureToken();
    const res = await fetch(`${relayUrl}/keys/${provider}`, {
      method:  'DELETE',
      headers: { 'x-relay-token': t },
    });
    if (!res.ok) throw new Error(`Failed to delete key: ${res.status}`);
    setProviders(prev => prev.filter(p => p !== provider));
  }

  async function health({ deep = false, provider } = {}) {
    const url = new URL(`${relayUrl}/health`);
    if (deep) url.searchParams.set('deep', '1');
    if (provider) url.searchParams.set('provider', provider);
    const res = await fetch(url.toString());
    return res.json();
  }

  return { token, loading, error, providers, register, logout, storeKey: storeProviderKey, listKeys, deleteKey, health };
}

// ─── createChatStore ──────────────────────────────────────────────────────────

/**
 * Stateful chat store — manages message list + non-streaming relay calls.
 *
 * @param {object} opts
 * @param {string} [opts.relayUrl]
 * @param {string}  opts.appId
 * @param {string}  opts.provider   openai | anthropic | groq | mistral | openrouter
 * @param {string}  opts.model
 * @param {string} [opts.systemPrompt]
 * @param {object} [opts.extraParams]  Extra body params forwarded to provider
 *
 * @returns {{
 *   messages: () => Array<{role:string, content:string}>,
 *   loading: () => boolean,
 *   error: () => string|null,
 *   sendMessage: (content: string, token: string) => Promise<string>,
 *   clearMessages: () => void,
 * }}
 */
function createChatStore(opts = {}) {
  const relayUrl    = (opts.relayUrl || DEFAULT_RELAY_URL).replace(/\/$/, '');
  const provider    = opts.provider || 'openai';
  const model       = opts.model || 'gpt-4o-mini';
  const systemPrompt = opts.systemPrompt || null;
  const extraParams  = opts.extraParams || {};

  const [messages, setMessages] = createSignal([]);
  const [loading,  setLoading]  = createSignal(false);
  const [error,    setError]    = createSignal(null);

  function clearMessages() {
    setMessages([]);
    setError(null);
  }

  async function sendMessage(content, relayToken) {
    if (!content?.trim()) throw new Error('Message content is required');
    if (!relayToken) throw new Error('Relay token is required');

    const userMsg = { role: 'user', content: content.trim() };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);
    setError(null);

    try {
      const history = messages();
      const msgs = systemPrompt
        ? [{ role: 'system', content: systemPrompt }, ...history]
        : [...history];

      let body;
      if (provider === 'anthropic') {
        const system = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n');
        const convMsgs = msgs.filter(m => m.role !== 'system');
        body = { model, messages: convMsgs, max_tokens: 1024, ...extraParams };
        if (system) body.system = system;
      } else {
        body = { model, messages: msgs, ...extraParams };
      }

      const res = await fetch(`${relayUrl}/relay/${provider}`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'x-relay-token': relayToken,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Relay error: ${res.status}`);

      const data = await res.json();
      let reply;
      if (provider === 'anthropic') {
        reply = data.content?.[0]?.text || '';
      } else {
        reply = data.choices?.[0]?.message?.content || '';
      }

      const assistantMsg = { role: 'assistant', content: reply };
      setMessages(prev => [...prev, assistantMsg]);
      return reply;
    } catch (err) {
      setError(err.message);
      setMessages(prev => prev.slice(0, -1)); // rollback user message
      throw err;
    } finally {
      setLoading(false);
    }
  }

  return { messages, loading, error, sendMessage, clearMessages };
}

// ─── createStreamingChatStore ─────────────────────────────────────────────────

/**
 * Streaming chat store — SSE-based streaming with live `streamingContent` signal.
 *
 * @param {object} opts
 * @param {string} [opts.relayUrl]
 * @param {string}  opts.appId
 * @param {string}  opts.provider
 * @param {string}  opts.model
 * @param {string} [opts.systemPrompt]
 * @param {object} [opts.extraParams]
 *
 * @returns {{
 *   messages: () => Array<{role:string, content:string}>,
 *   streamingContent: () => string,
 *   loading: () => boolean,
 *   error: () => string|null,
 *   sendMessage: (content: string, token: string) => Promise<void>,
 *   stopStreaming: () => void,
 *   clearMessages: () => void,
 * }}
 */
function createStreamingChatStore(opts = {}) {
  const relayUrl    = (opts.relayUrl || DEFAULT_RELAY_URL).replace(/\/$/, '');
  const provider    = opts.provider || 'openai';
  const model       = opts.model || 'gpt-4o-mini';
  const systemPrompt = opts.systemPrompt || null;
  const extraParams  = opts.extraParams || {};

  const [messages,         setMessages]         = createSignal([]);
  const [streamingContent, setStreamingContent] = createSignal('');
  const [loading,          setLoading]          = createSignal(false);
  const [error,            setError]            = createSignal(null);

  let abortController = null;

  function stopStreaming() {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    // Commit partial content if any
    const partial = streamingContent();
    if (partial) {
      setMessages(prev => [...prev, { role: 'assistant', content: partial }]);
      setStreamingContent('');
    }
    setLoading(false);
  }

  function clearMessages() {
    stopStreaming();
    setMessages([]);
    setError(null);
  }

  async function sendMessage(content, relayToken) {
    if (!content?.trim()) throw new Error('Message content is required');
    if (!relayToken) throw new Error('Relay token is required');

    // Cancel any in-flight stream
    if (abortController) abortController.abort();

    const userMsg = { role: 'user', content: content.trim() };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);
    setStreamingContent('');
    setError(null);

    const controller = new AbortController();
    abortController = controller;

    try {
      const history = messages();
      const msgs = systemPrompt
        ? [{ role: 'system', content: systemPrompt }, ...history]
        : [...history];

      let body;
      if (provider === 'anthropic') {
        const system = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n');
        const convMsgs = msgs.filter(m => m.role !== 'system');
        body = { model, messages: convMsgs, max_tokens: 1024, stream: true, ...extraParams };
        if (system) body.system = system;
      } else {
        body = { model, messages: msgs, stream: true, ...extraParams };
      }

      const res = await fetch(`${relayUrl}/relay/${provider}`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'x-relay-token': relayToken,
        },
        body:   JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`Relay error: ${res.status}`);

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      const sseParser = createSSEParser();
      let accumulated = '';

      function applyEvent(event) {
        if (abortController !== controller) return;
        const delta = extractDelta(event, provider);
        if (delta) {
          accumulated += delta;
          setStreamingContent(accumulated);
        }
      }

      while (true) {
        const { done, value } = await reader.read();
        if (abortController !== controller) return;
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        for (const event of sseParser.push(chunk)) applyEvent(event);
      }

      for (const event of sseParser.flush()) applyEvent(event);
      if (abortController !== controller) return;

      // Commit finished message
      setMessages(prev => [...prev, { role: 'assistant', content: accumulated }]);
      setStreamingContent('');
    } catch (err) {
      if (err.name === 'AbortError') return; // user-initiated stop
      if (abortController !== controller) return;
      setError(err.message);
      setMessages(prev => prev.slice(0, -1)); // rollback user message
      throw err;
    } finally {
      if (abortController === controller) {
        abortController = null;
        setLoading(false);
      }
    }
  }

  return {
    messages,
    streamingContent,
    loading,
    error,
    sendMessage,
    stopStreaming,
    clearMessages,
  };
}

// ─── createRelayHealthStore ───────────────────────────────────────────────────

/**
 * Health polling store — polls /health on an interval.
 *
 * @param {object} opts
 * @param {string} [opts.relayUrl]
 * @param {number} [opts.intervalMs]   Polling interval (default: 60_000)
 * @param {boolean} [opts.deep]        Use deep readiness probe
 * @param {string}  [opts.provider]    Provider for deep probe
 *
 * @returns {{
 *   status: () => 'ok'|'error'|'loading'|null,
 *   health: () => object|null,
 *   error: () => string|null,
 *   refetch: () => Promise<void>,
 *   destroy: () => void,
 * }}
 */
function createRelayHealthStore(opts = {}) {
  const relayUrl   = (opts.relayUrl || DEFAULT_RELAY_URL).replace(/\/$/, '');
  const intervalMs = opts.intervalMs ?? 60_000;
  const deep       = opts.deep       ?? false;
  const provider   = opts.provider   ?? undefined;

  const [status, setStatus] = createSignal(null);   // 'ok' | 'error' | 'loading' | null
  const [health, setHealth] = createSignal(null);
  const [error,  setError]  = createSignal(null);

  let timer = null;

  async function refetch() {
    setStatus('loading');
    setError(null);
    try {
      const url = new URL(`${relayUrl}/health`);
      if (deep) url.searchParams.set('deep', '1');
      if (provider) url.searchParams.set('provider', provider);
      const res  = await fetch(url.toString());
      const data = await res.json();
      setHealth(data);
      setStatus(res.ok ? 'ok' : 'error');
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }

  function destroy() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // Initial fetch
  refetch();

  if (intervalMs > 0) {
    timer = setInterval(refetch, intervalMs);
  }

  return { status, health, error, refetch, destroy };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  createByokRelayStore,
  createChatStore,
  createStreamingChatStore,
  createRelayHealthStore,
};

/**
 * @byok-relay/qwik
 *
 * Qwik City integration for byok-relay — BYOK AI in any Qwik City app.
 *
 * Three concerns:
 *
 *   1. Server-side helpers (createRelayLoader / createRelayAction)
 *      Thin wrappers around Qwik City's `routeLoader$` / `routeAction$` that
 *      proxy requests to the upstream byok-relay server. RELAY_URL comes from
 *      `import.meta.env.RELAY_URL` (Vite env, private — never in browser bundle).
 *
 *   2. Reactive client stores (createByokRelayStore, createChatStore,
 *      createStreamingChatStore, createRelayHealthStore)
 *      Plain-JS factory functions that return Qwik-compatible reactive objects.
 *      When `@builder.io/qwik` is installed, stores use `useStore()` for full
 *      Qwik reactivity; otherwise a plain-object shim works without Qwik.
 *
 *   3. ByokRelayClient plain-JS class
 *      Server-safe client for use inside `routeLoader$`, `routeAction$`,
 *      middleware, or any server-side Qwik code. localStorage-guarded for
 *      optional browser-side use.
 *
 * Runtime requirements:
 *   - fetch global (Node 18+, all modern browsers)
 *   - Qwik peer dep >=1.0.0 (optional — stores work without it via shim)
 *   - Qwik City peer dep >=1.0.0 (optional — loader/action helpers require it)
 */

'use strict';

/* ========================================================================== */
/* Constants                                                                   */
/* ========================================================================== */

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';

const PROVIDER_PATHS = {
  openai:     'chat/completions',
  anthropic:  'messages',
  google:     'models/{model}:generateContent',
  groq:       'chat/completions',
  mistral:    'chat/completions',
  openrouter: 'chat/completions',
};

/** Headers never forwarded between hops. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);

/* ========================================================================== */
/* Utilities                                                                   */
/* ========================================================================== */

function _isClient () {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function _safeGet (key) {
  if (!_isClient()) return null;
  try { return window.localStorage.getItem(key); } catch (_) { return null; }
}

function _safeSet (key, val) {
  if (!_isClient()) return;
  try { window.localStorage.setItem(key, val); } catch (_) {}
}

function _safeRemove (key) {
  if (!_isClient()) return;
  try { window.localStorage.removeItem(key); } catch (_) {}
}

function _filterHeaders (headers) {
  const out = {};
  const entries =
    typeof headers.entries === 'function'
      ? headers.entries()
      : Object.entries(headers);
  for (const [k, v] of entries) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

async function _resolveTrustedAppId (opts, context) {
  if (typeof opts.getTrustedAppId !== 'function') return '';
  const appId = await opts.getTrustedAppId(context);
  return appId == null ? '' : String(appId);
}

async function _assertAllowedApp (opts, context, fail) {
  if (!opts.allowedApps || opts.allowedApps.length === 0) return;
  const appId = await _resolveTrustedAppId(opts, context);
  if (!appId || !opts.allowedApps.includes(appId)) {
    throw fail(403, 'App not allowed');
  }
}

/* ========================================================================== */
/* Qwik store shim                                                             */
/* ========================================================================== */

/**
 * Create a minimal reactive store.
 *
 * When `@builder.io/qwik` provides `useStore`, wraps with it for full
 * Qwik fine-grained reactivity. Falls back to a plain-object proxy that
 * still works in plain-JS / testing contexts.
 */
function _createStore (initial) {
  // In a Qwik component context, useStore should be called by the component
  // itself. Here we return a plain reactive proxy compatible with both.
  // Callers that need Qwik reactivity should pass the result of useStore()
  // into createChatStore / createStreamingChatStore, or call useStore()
  // directly in their component.
  return Object.assign({}, initial);
}

/* ========================================================================== */
/* ByokRelayClient                                                             */
/* ========================================================================== */

/**
 * ByokRelayClient — framework-agnostic relay client.
 *
 * Works in:
 *   - Qwik City routeLoader$ / routeAction$ (server, Node 18+)
 *   - Qwik browser components (localStorage persistence)
 *   - Server-side middleware (in-memory fallback)
 *   - Plain-JS scripts / tests
 *
 * @param {object}  opts
 * @param {string}  [opts.relayUrl]   Upstream relay URL.
 * @param {string}  [opts.appId]      Your app identifier.
 * @param {object}  [opts.storage]    Custom { get, set, remove } adapter (e.g. Qwik City cookie session).
 */
class ByokRelayClient {
  constructor ({ relayUrl = DEFAULT_RELAY_URL, appId = 'qwik-app', storage } = {}) {
    this.relayUrl = relayUrl.replace(/\/$/, '');
    this.appId    = appId;

    if (storage) {
      this._storage = storage;
    } else if (_isClient()) {
      // Browser — use localStorage
      this._storage = {
        get    : (k)    => { try { return window.localStorage.getItem(k); }    catch (_) { return null; } },
        set    : (k, v) => { try { window.localStorage.setItem(k, v); }        catch (_) {} },
        remove : (k)    => { try { window.localStorage.removeItem(k); }        catch (_) {} },
      };
    } else {
      // Node / edge / SSR — in-memory
      const _mem = {};
      this._storage = {
        get    : (k)    => _mem[k] || null,
        set    : (k, v) => { _mem[k] = v; },
        remove : (k)    => { delete _mem[k]; },
      };
    }
  }

  _storeGet (key)      { return this._storage.get(key); }
  _storeSet (key, val) { this._storage.set(key, val); }
  _storeRemove (key)   { this._storage.remove(key); }

  /** Register a new relay token (called once; token shown only on registration). */
  async register () {
    const res = await fetch(`${this.relayUrl}/users`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ app_id: this.appId }),
    });
    if (!res.ok) throw new Error(`Register failed: ${res.status}`);
    const data = await res.json();
    this._storeSet('byok_relay_token', data.token);
    return data;
  }

  /** Return stored token, registering first if needed. */
  async ensureToken () {
    let token = this._storeGet('byok_relay_token');
    if (!token) {
      const data = await this.register();
      token = data.token;
    }
    return token;
  }

  /** Clear stored token (log out). */
  logout () { this._storeRemove('byok_relay_token'); }

  /** Store an API key for a provider. */
  async storeKey (provider, apiKey) {
    const token = await this.ensureToken();
    const res   = await fetch(`${this.relayUrl}/keys/${provider}`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body    : JSON.stringify({ key: apiKey }),
    });
    if (!res.ok) throw new Error(`storeKey failed: ${res.status}`);
    return res.json();
  }

  /** List stored provider keys. */
  async listKeys () {
    const token = await this.ensureToken();
    const res   = await fetch(`${this.relayUrl}/keys`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`listKeys failed: ${res.status}`);
    return res.json();
  }

  /** Delete a provider key. */
  async deleteKey (provider) {
    const token = await this.ensureToken();
    const res   = await fetch(`${this.relayUrl}/keys/${provider}`, {
      method  : 'DELETE',
      headers : { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`deleteKey failed: ${res.status}`);
    return res.json();
  }

  /** Rotate a provider key (atomic: validate → live-ping → replace). */
  async rotateKey (provider, newKey) {
    const token = await this.ensureToken();
    const res   = await fetch(`${this.relayUrl}/keys/${provider}/rotate`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body    : JSON.stringify({ key: newKey }),
    });
    if (!res.ok) throw new Error(`rotateKey failed: ${res.status}`);
    return res.json();
  }

  /**
   * Forward a raw request through the relay.
   *
   * @param {string} provider  Provider name (openai, anthropic, groq, …)
   * @param {string} path      API path (e.g. 'chat/completions')
   * @param {object} body      Request body (JSON-serialisable)
   * @param {object} [extra]   Extra headers
   */
  async relayRequest (provider, path, body, extra = {}) {
    const token = await this.ensureToken();
    return fetch(`${this.relayUrl}/relay/${provider}/${path}`, {
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/json',
        'Authorization' : `Bearer ${token}`,
        ...extra,
      },
      body: JSON.stringify(body),
    });
  }

  /**
   * Unified chat (non-streaming).
   *
   * @param {string}   model    'provider/model' or bare model name
   * @param {object[]} messages OpenAI-format messages array
   * @param {object}   [extra]  Extra body params (temperature, max_tokens, …)
   */
  async chat (model, messages, extra = {}) {
    const token = await this.ensureToken();
    const res   = await fetch(`${this.relayUrl}/relay`, {
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/json',
        'Authorization' : `Bearer ${token}`,
      },
      body: JSON.stringify({ model, messages, ...extra }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`chat failed (${res.status}): ${err}`);
    }
    return res.json();
  }

  /**
   * Streaming chat — async generator yielding text chunks.
   *
   * @param {string}   model     'provider/model' or bare model name
   * @param {object[]} messages  OpenAI-format messages array
   * @param {object}   [extra]   Extra body params
   * @param {AbortSignal} [signal]  Optional AbortSignal
   *
   * @yields {string} Text chunks as they arrive
   */
  async * streamChat (model, messages, extra = {}, signal) {
    const token = await this.ensureToken();
    const res   = await fetch(`${this.relayUrl}/relay`, {
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/json',
        'Authorization' : `Bearer ${token}`,
      },
      body   : JSON.stringify({ model, messages, stream: true, ...extra }),
      signal,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`streamChat failed (${res.status}): ${err}`);
    }
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buf     = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') return;
        try {
          const json  = JSON.parse(payload);
          const chunk =
            json.choices?.[0]?.delta?.content          || // OpenAI
            json.delta?.text                            || // Anthropic
            json.candidates?.[0]?.content?.parts?.[0]?.text || // Google
            '';
          if (chunk) yield chunk;
        } catch (_) {}
      }
    }
  }

  /** GET /health[?deep=1] */
  async health (deep = false) {
    const url = `${this.relayUrl}/health${deep ? '?deep=1' : ''}`;
    const res = await fetch(url);
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  }

  /** GET /health?deep=1&provider=<name> */
  async deepHealth (provider) {
    const url = `${this.relayUrl}/health?deep=1${provider ? `&provider=${provider}` : ''}`;
    const res = await fetch(url);
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  }

  /** GET /stats or GET /stats/:app_id */
  async stats (appId) {
    const token = await this.ensureToken();
    const path  = appId ? `/stats/${appId}` : '/stats';
    const res   = await fetch(`${this.relayUrl}${path}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`stats failed: ${res.status}`);
    return res.json();
  }

  /** GET /models */
  async getModels () {
    const res = await fetch(`${this.relayUrl}/models`);
    if (!res.ok) throw new Error(`getModels failed: ${res.status}`);
    return res.json();
  }

  /** DELETE /users — full GDPR erasure. */
  async deleteAccount () {
    const token = await this.ensureToken();
    const res   = await fetch(`${this.relayUrl}/users`, {
      method  : 'DELETE',
      headers : { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`deleteAccount failed: ${res.status}`);
    this.logout();
    return res.json();
  }
}

/* ========================================================================== */
/* Server-side helpers                                                         */
/* ========================================================================== */

/**
 * createRelayLoader — returns a Qwik City `routeLoader$`-compatible async
 * function that proxies GET/HEAD requests to the upstream relay.
 *
 * RELAY_URL is read from `process.env.RELAY_URL` (server-only).
 * It NEVER leaks into the browser bundle.
 *
 * Usage in a Qwik City route (e.g. src/routes/relay/[...path]/index.tsx):
 *
 *   import { createRelayLoader } from '@byok-relay/qwik';
 *   import { routeLoader$ } from '@builder.io/qwik-city';
 *
 *   export const useRelayData = routeLoader$(createRelayLoader());
 *
 * @param {object} [opts]
 * @param {string} [opts.relayUrl]        Override relay URL (default: process.env.RELAY_URL)
 * @param {string[]} [opts.allowedApps]   Optional trusted app_id allowlist
 * @param {Function} [opts.getTrustedAppId] Server-side resolver for the authenticated app_id
 */
function createRelayLoader (opts = {}) {
  const relayUrl = (opts.relayUrl || process.env.RELAY_URL || DEFAULT_RELAY_URL).replace(/\/$/, '');

  return async function relayLoader (requestEvent) {
    const { request, params, error } = requestEvent;
    const subPath = params['path'] || '';

    await _assertAllowedApp(opts, { request, params, requestEvent }, error);

    const upstreamUrl = `${relayUrl}/${subPath}`.replace(/\/+/g, '/').replace(':/', '://');
    const headers     = _filterHeaders(request.headers);

    const ctrl       = new AbortController();
    const timer      = setTimeout(() => ctrl.abort(), 30000);
    let   upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method  : request.method,
        headers,
        signal  : ctrl.signal,
      });
    } catch (err) {
      const status = err && err.name === 'AbortError' ? 504 : 502;
      throw error(status, status === 504 ? 'Upstream timeout' : 'Failed to reach relay');
    } finally {
      clearTimeout(timer);
    }

    const body = await upstream.text().catch(() => '');
    try {
      return JSON.parse(body);
    } catch (_) {
      return { raw: body, status: upstream.status };
    }
  };
}

/**
 * createRelayAction — returns a Qwik City `routeAction$`-compatible async
 * function that proxies POST/PUT/PATCH/DELETE requests to the upstream relay.
 *
 * Usage in a Qwik City route:
 *
 *   import { createRelayAction } from '@byok-relay/qwik';
 *   import { routeAction$, zod$, z } from '@builder.io/qwik-city';
 *
 *   export const useRelayAction = routeAction$(
 *     createRelayAction(),
 *     zod$({ path: z.string(), token: z.string(), body: z.any() })
 *   );
 *
 * @param {object} [opts]
 * @param {string}   [opts.relayUrl]      Override relay URL
 * @param {string[]} [opts.allowedApps]   Optional trusted app_id allowlist
 * @param {Function} [opts.getTrustedAppId] Server-side resolver for the authenticated app_id
 */
function createRelayAction (opts = {}) {
  const relayUrl = (opts.relayUrl || process.env.RELAY_URL || DEFAULT_RELAY_URL).replace(/\/$/, '');

  return async function relayAction (data, requestEvent) {
    const { request, error } = requestEvent;
    const subPath  = data.path || '';
    const token    = data.token || request.headers.get('authorization')?.replace(/^Bearer /i, '') || '';
    const bodyData = data.body;

    await _assertAllowedApp(opts, { request, data, requestEvent }, error);

    const upstreamUrl = `${relayUrl}/${subPath}`.replace(/\/+/g, '/').replace(':/', '://');
    const headers     = {
      ..._filterHeaders(request.headers),
      'Content-Type'  : 'application/json',
      'Authorization' : `Bearer ${token}`,
    };

    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let   upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method  : request.method !== 'GET' ? request.method : 'POST',
        headers,
        body    : JSON.stringify(bodyData),
        signal  : ctrl.signal,
      });
    } catch (err) {
      const status = err && err.name === 'AbortError' ? 504 : 502;
      return {
        success : false,
        status,
        error   : status === 504 ? 'Upstream timeout' : 'Failed to reach relay',
      };
    } finally {
      clearTimeout(timer);
    }

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      return { success: false, status: upstream.status, error: errText };
    }

    const text = await upstream.text().catch(() => '');
    try {
      return { success: true, data: JSON.parse(text) };
    } catch (_) {
      return { success: true, data: text };
    }
  };
}

/* ========================================================================== */
/* Client-side reactive stores                                                 */
/* ========================================================================== */

/**
 * createByokRelayStore — token registration, key management, and logout.
 *
 * Call this inside a Qwik `component$()` and pass the result of `useStore()`
 * for full reactivity, or use standalone for plain-JS contexts.
 *
 * Usage (inside component$):
 *   const store = useStore({ token: null, keys: [], loading: false, error: null });
 *   const relay = createByokRelayStore({ store, relayUrl: import.meta.env.PUBLIC_RELAY_URL });
 *   useVisibleTask$(async () => { await relay.init(); });
 *
 * @param {object} opts
 * @param {object} [opts.store]      Pre-created Qwik reactive store (from useStore())
 * @param {string} [opts.relayUrl]   Relay base URL
 * @param {string} [opts.appId]      App identifier
 * @param {object} [opts.storage]    Custom { get, set, remove } adapter
 */
function createByokRelayStore (opts = {}) {
  const client = new ByokRelayClient({
    relayUrl : opts.relayUrl,
    appId    : opts.appId,
    storage  : opts.storage,
  });

  const state = opts.store || _createStore({
    token   : null,
    keys    : [],
    loading : false,
    error   : null,
  });

  async function init () {
    const stored = client._storeGet('byok_relay_token');
    if (stored) state.token = stored;
  }

  async function register () {
    state.loading = true;
    state.error   = null;
    try {
      const data    = await client.register();
      state.token   = data.token;
      return data;
    } catch (err) {
      state.error = err.message;
      throw err;
    } finally {
      state.loading = false;
    }
  }

  async function storeKey (provider, apiKey) {
    state.loading = true;
    state.error   = null;
    try {
      const result = await client.storeKey(provider, apiKey);
      await refreshKeys();
      return result;
    } catch (err) {
      state.error = err.message;
      throw err;
    } finally {
      state.loading = false;
    }
  }

  async function refreshKeys () {
    try {
      const data  = await client.listKeys();
      state.keys  = data.keys || data || [];
    } catch (_) {}
  }

  async function deleteKey (provider) {
    state.loading = true;
    state.error   = null;
    try {
      const result = await client.deleteKey(provider);
      await refreshKeys();
      return result;
    } catch (err) {
      state.error = err.message;
      throw err;
    } finally {
      state.loading = false;
    }
  }

  async function rotateKey (provider, newKey) {
    state.loading = true;
    state.error   = null;
    try {
      const result = await client.rotateKey(provider, newKey);
      await refreshKeys();
      return result;
    } catch (err) {
      state.error = err.message;
      throw err;
    } finally {
      state.loading = false;
    }
  }

  function logout () {
    client.logout();
    state.token = null;
    state.keys  = [];
  }

  return {
    state,
    init,
    register,
    storeKey,
    refreshKeys,
    deleteKey,
    rotateKey,
    logout,
    get token () { return state.token; },
  };
}

/**
 * createChatStore — stateful non-streaming chat.
 *
 * Usage (inside component$):
 *   const chatState = useStore({ messages: [], loading: false, error: null });
 *   const chat = createChatStore({
 *     store   : chatState,
 *     model   : 'openai/gpt-4o-mini',
 *     relayUrl: import.meta.env.PUBLIC_RELAY_URL,
 *   });
 *
 * @param {object} opts
 * @param {object} [opts.store]        Pre-created Qwik reactive store
 * @param {string} opts.model          'provider/model' or bare model name
 * @param {string} [opts.relayUrl]     Relay URL
 * @param {string} [opts.appId]        App identifier
 * @param {string} [opts.systemPrompt] System prompt prepended to every call
 * @param {object} [opts.extraParams]  Extra body params (temperature, etc.)
 */
function createChatStore (opts = {}) {
  const client = new ByokRelayClient({
    relayUrl : opts.relayUrl,
    appId    : opts.appId,
  });

  const state = opts.store || _createStore({
    messages : [],
    loading  : false,
    error    : null,
  });

  async function sendMessage (userContent) {
    const userMsg  = { role: 'user', content: userContent };
    state.messages = [...state.messages, userMsg];
    state.loading  = true;
    state.error    = null;

    const msgs = opts.systemPrompt
      ? [{ role: 'system', content: opts.systemPrompt }, ...state.messages]
      : [...state.messages];

    try {
      const data    = await client.chat(opts.model, msgs, opts.extraParams || {});
      const content =
        data.choices?.[0]?.message?.content ||
        data.content?.[0]?.text             ||
        '';
      const assistantMsg  = { role: 'assistant', content };
      state.messages      = [...state.messages, assistantMsg];
      return content;
    } catch (err) {
      state.error    = err.message;
      // Optimistic rollback
      state.messages = state.messages.slice(0, -1);
      throw err;
    } finally {
      state.loading = false;
    }
  }

  function clearMessages () {
    state.messages = [];
    state.error    = null;
  }

  return { state, sendMessage, clearMessages };
}

/**
 * createStreamingChatStore — SSE streaming chat.
 *
 * Usage (inside component$):
 *   const streamState = useStore({
 *     messages: [], streamingContent: '', isStreaming: false, error: null
 *   });
 *   const chat = createStreamingChatStore({
 *     store   : streamState,
 *     model   : 'anthropic/claude-haiku-4-5',
 *     relayUrl: import.meta.env.PUBLIC_RELAY_URL,
 *   });
 *
 * @param {object} opts
 * @param {object} [opts.store]        Pre-created Qwik reactive store
 * @param {string} opts.model          'provider/model' or bare model name
 * @param {string} [opts.relayUrl]     Relay URL
 * @param {string} [opts.appId]        App identifier
 * @param {string} [opts.systemPrompt] System prompt
 * @param {object} [opts.extraParams]  Extra body params
 */
function createStreamingChatStore (opts = {}) {
  const client = new ByokRelayClient({
    relayUrl : opts.relayUrl,
    appId    : opts.appId,
  });

  const state = opts.store || _createStore({
    messages         : [],
    streamingContent : '',
    isStreaming      : false,
    error            : null,
  });

  let _abort = null;

  async function sendMessage (userContent) {
    if (state.isStreaming) return;

    const userMsg  = { role: 'user', content: userContent };
    state.messages = [...state.messages, userMsg];
    state.isStreaming      = true;
    state.streamingContent = '';
    state.error            = null;

    const msgs = opts.systemPrompt
      ? [{ role: 'system', content: opts.systemPrompt }, ...state.messages]
      : [...state.messages];

    _abort = new AbortController();
    let accumulated = '';

    try {
      for await (const chunk of client.streamChat(
        opts.model, msgs, opts.extraParams || {}, _abort.signal
      )) {
        accumulated            += chunk;
        state.streamingContent  = accumulated;
      }
      const assistantMsg  = { role: 'assistant', content: accumulated };
      state.messages      = [...state.messages, assistantMsg];
      state.streamingContent = '';
    } catch (err) {
      if (err.name === 'AbortError') {
        // Partial commit on manual stop
        if (accumulated) {
          state.messages = [
            ...state.messages,
            { role: 'assistant', content: accumulated + ' [stopped]' },
          ];
        } else {
          state.messages = state.messages.slice(0, -1);
        }
        state.streamingContent = '';
      } else {
        state.error    = err.message;
        state.messages = state.messages.slice(0, -1);
      }
    } finally {
      state.isStreaming = false;
      _abort = null;
    }
  }

  function stopStreaming () {
    if (_abort) _abort.abort();
  }

  function clearMessages () {
    state.messages         = [];
    state.streamingContent = '';
    state.error            = null;
  }

  return { state, sendMessage, stopStreaming, clearMessages };
}

/**
 * createRelayHealthStore — polls GET /health, exposes status reactively.
 *
 * @param {object} opts
 * @param {object} [opts.store]      Pre-created Qwik reactive store
 * @param {string} [opts.relayUrl]   Relay URL
 * @param {number} [opts.intervalMs] Poll interval (default 30 000 ms)
 */
function createRelayHealthStore (opts = {}) {
  const client = new ByokRelayClient({ relayUrl: opts.relayUrl });

  const state = opts.store || _createStore({
    status    : 'unknown',   // 'ok' | 'degraded' | 'unknown'
    lastCheck : null,
    details   : null,
    error     : null,
  });

  let _interval = null;

  async function check (deep = false) {
    try {
      const result  = await client.health(deep);
      state.status  = result.ok ? 'ok' : 'degraded';
      state.details = result.body;
      state.error   = null;
    } catch (err) {
      state.status = 'unknown';
      state.error  = err.message;
    }
    state.lastCheck = Date.now();
  }

  function startPolling (intervalMs) {
    const ms = intervalMs || opts.intervalMs || 30_000;
    check();
    _interval = setInterval(() => check(), ms);
  }

  function stopPolling () {
    if (_interval) {
      clearInterval(_interval);
      _interval = null;
    }
  }

  /** Call in useVisibleTask$ cleanup to stop polling on component unmount. */
  function destroy () { stopPolling(); }

  return { state, check, startPolling, stopPolling, destroy };
}

/* ========================================================================== */
/* Exports                                                                     */
/* ========================================================================== */

module.exports = {
  ByokRelayClient,
  createRelayLoader,
  createRelayAction,
  createByokRelayStore,
  createChatStore,
  createStreamingChatStore,
  createRelayHealthStore,
};

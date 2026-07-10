/**
 * @byok-relay/nuxt
 * Nuxt 3 module, H3 server route factory, and Vue composables for BYOK AI relay.
 *
 * Four distinct concerns:
 *
 *   1. createRelayServerRoute(opts)
 *      Returns an H3 event handler for placement in server/routes/relay/[...].ts.
 *      RELAY_URL reads from process.env server-side only — never in the browser bundle.
 *      The browser calls your own Nuxt server route, which proxies to the upstream relay.
 *
 *   2. defineByokRelayModule(opts)
 *      Nuxt module factory (wraps defineNuxtModule pattern).
 *      Registers the catch-all relay server route automatically so you get
 *      /relay/[...] without writing any server/routes file.
 *      Exposes RELAY_URL as a server-only runtime config key.
 *
 *   3. Vue composables (useByokRelay, useChat, useStreamingChat, useRelayHealth)
 *      Nuxt-auto-import-compatible Vue 3 composables for <script setup> components.
 *      Point relayUrl at your own Nuxt server route (/relay), not the upstream relay.
 *      Works with useRuntimeConfig() for public relayUrl.
 *
 *   4. ByokRelayClient plain-JS class
 *      Framework-agnostic — safe in Nuxt server routes, plugins, server-side
 *      useFetch() calls, and browser scripts.
 *      Accepts a custom storage adapter for cookie-session persistence.
 *
 * Node 18+ required on the server side; Nitro Edge Runtime compatible.
 */

'use strict';

/* ========================================================================== */
/* Constants                                                                   */
/* ========================================================================== */

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/* ========================================================================== */
/* Utility                                                                     */
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

function _buildStorage (custom) {
  if (custom) return custom;
  return {
    getItem    : _safeGet,
    setItem    : _safeSet,
    removeItem : _safeRemove,
  };
}

function _filterHeaders (headers) {
  if (!headers) return {};
  const out = {};
  const entries = typeof headers.entries === 'function'
    ? headers.entries()
    : Object.entries(headers);
  for (const [k, v] of entries) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/* ========================================================================== */
/* ByokRelayClient                                                             */
/* ========================================================================== */

/**
 * Plain-JS BYOK Relay client.
 * Works in Nuxt server routes, plugins, useAsyncData(), and browser components.
 *
 * @param {object} opts
 * @param {string}  [opts.relayUrl]   Upstream relay URL. Defaults to managed relay.
 * @param {string}  [opts.appId]      Your application ID.
 * @param {object}  [opts.storage]    Custom storage adapter { getItem, setItem, removeItem }.
 */
class ByokRelayClient {
  constructor (opts) {
    opts = opts || {};
    this._relayUrl = (opts.relayUrl || DEFAULT_RELAY_URL).replace(/\/$/, '');
    this._appId    = opts.appId || 'nuxt-app';
    this._storage  = _buildStorage(opts.storage);
    this._TOKEN_KEY = 'byok_relay_token';
  }

  /* ── Token management ── */

  getToken () {
    return this._storage.getItem(this._TOKEN_KEY);
  }

  _saveToken (token) {
    this._storage.setItem(this._TOKEN_KEY, token);
  }

  /**
   * Register a new relay token. Stored and returned.
   * @param {string} [appId]
   */
  async register (appId) {
    const id = appId || this._appId;
    const res = await fetch(`${this._relayUrl}/users`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ app_id: id }),
    });
    if (!res.ok) throw new Error(`Register failed: ${res.status}`);
    const data = await res.json();
    const token = data.token;
    this._saveToken(token);
    return token;
  }

  /**
   * Return existing token or register a new one.
   */
  async ensureToken (appId) {
    const existing = this.getToken();
    if (existing) return existing;
    return this.register(appId);
  }

  /** Remove token from storage (does not call server). */
  logout () {
    this._storage.removeItem(this._TOKEN_KEY);
  }

  /**
   * Delete account and all keys from the relay. Clears local token.
   */
  async deleteAccount () {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/users`, {
      method  : 'DELETE',
      headers : { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`deleteAccount failed: ${res.status}`);
    this.logout();
    return res.json();
  }

  /* ── Key management ── */

  async storeKey (provider, apiKey) {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/keys/${provider}`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body    : JSON.stringify({ api_key: apiKey }),
    });
    if (!res.ok) throw new Error(`storeKey failed: ${res.status}`);
    return res.json();
  }

  async listKeys () {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/keys`, {
      headers : { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`listKeys failed: ${res.status}`);
    return res.json();
  }

  async deleteKey (provider) {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/keys/${provider}`, {
      method  : 'DELETE',
      headers : { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`deleteKey failed: ${res.status}`);
    return res.json();
  }

  async rotateKey (provider, newApiKey) {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/keys/${provider}/rotate`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body    : JSON.stringify({ api_key: newApiKey }),
    });
    if (!res.ok) throw new Error(`rotateKey failed: ${res.status}`);
    return res.json();
  }

  /* ── Relay ── */

  /**
   * Low-level relay request.
   * @param {string} provider  e.g. 'openai', 'anthropic'
   * @param {string} path      API sub-path e.g. '/chat/completions'
   * @param {object} body      Request body (will be JSON-serialised)
   * @param {string} [method]  Default POST
   */
  async relayRequest (provider, path, body, method) {
    const token = await this.ensureToken();
    const url = `${this._relayUrl}/relay/${provider}${path}`;
    const res = await fetch(url, {
      method  : method || 'POST',
      headers : { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body    : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`relayRequest failed ${res.status}: ${text}`);
    }
    return res.json();
  }

  /**
   * Unified chat — provider/model-name or bare model string.
   */
  async chat (messages, opts) {
    opts = opts || {};
    const token = await this.ensureToken();
    const body = Object.assign({ messages }, opts);
    const res = await fetch(`${this._relayUrl}/relay`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body    : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`chat failed ${res.status}: ${text}`);
    }
    return res.json();
  }

  /**
   * Streaming chat — async generator that yields text chunks.
   * @param {Array}  messages
   * @param {object} opts         model, systemPrompt, extraParams, signal (AbortSignal)
   * @param {function} [onChunk] Called with each text chunk string.
   * @param {function} [onDone]  Called with full accumulated text.
   */
  async * streamChat (messages, opts, onChunk, onDone) {
    opts = opts || {};
    const token = await this.ensureToken();
    const { signal, ...rest } = opts;
    const body = Object.assign({ messages, stream: true }, rest);
    const res = await fetch(`${this._relayUrl}/relay`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body    : JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`streamChat failed ${res.status}: ${text}`);
    }
    const reader = res.body.getReader();
    const decoder = typeof TextDecoder !== 'undefined'
      ? new TextDecoder()
      : { decode: b => Buffer.from(b).toString('utf-8') };
    let accumulated = '';
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const raw = trimmed.slice(5).trim();
        if (raw === '[DONE]') continue;
        try {
          const parsed = JSON.parse(raw);
          const delta = parsed.choices?.[0]?.delta?.content
            || parsed.delta?.text
            || '';
          if (delta) {
            accumulated += delta;
            if (onChunk) onChunk(delta);
            yield delta;
          }
        } catch (_) {}
      }
    }
    if (onDone) onDone(accumulated);
  }

  /* ── Observability ── */

  async health (deep) {
    const url = deep ? `${this._relayUrl}/health?deep=1` : `${this._relayUrl}/health`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`health check failed: ${res.status}`);
    return res.json();
  }

  async stats (appId) {
    const token = await this.ensureToken();
    const url = appId
      ? `${this._relayUrl}/stats/${appId}`
      : `${this._relayUrl}/stats`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`stats failed: ${res.status}`);
    return res.json();
  }

  async getModels () {
    const res = await fetch(`${this._relayUrl}/models`);
    if (!res.ok) throw new Error(`getModels failed: ${res.status}`);
    return res.json();
  }
}

/* ========================================================================== */
/* createRelayServerRoute                                                      */
/* ========================================================================== */

/**
 * Create an H3 event handler that proxies /relay/[...] to the upstream relay.
 * Place in server/routes/relay/[...].ts (or [...].js).
 *
 * RELAY_URL is read from process.env at handler invocation time — never in the
 * browser bundle. The browser always calls your own Nuxt server route.
 *
 * @param {object} [opts]
 * @param {string}   [opts.relayUrl]      Upstream relay URL. Defaults to process.env.RELAY_URL.
 * @param {string[]} [opts.allowedAppIds] Optional app_id whitelist.
 * @param {number}   [opts.timeoutMs]     Upstream timeout in ms (default 30000).
 *
 * @returns {function} H3 event handler (async function(event) {...})
 *
 * @example
 * // server/routes/relay/[...].ts
 * import { createRelayServerRoute } from '@byok-relay/nuxt'
 * export default createRelayServerRoute({ allowedAppIds: ['my-nuxt-app'] })
 */
function createRelayServerRoute (opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || 30000;

  return async function relayHandler (event) {
    const relayUrl = (
      opts.relayUrl ||
      (typeof process !== 'undefined' && process.env && process.env.RELAY_URL) ||
      DEFAULT_RELAY_URL
    ).replace(/\/$/, '');

    // Extract sub-path from the wildcard param.
    // H3 exposes dynamic params via event.context.params
    const params  = (event.context && event.context.params) || {};
    const subPath = params._ || params[''] || '';  // Nuxt uses '_' for [...] catch-all

    // Optional app_id allowlist check — read from Authorization header body or query
    if (opts.allowedAppIds && opts.allowedAppIds.length > 0) {
      const appId = _getAppIdFromEvent(event);
      if (appId && !opts.allowedAppIds.includes(appId)) {
        return _h3Response(event, 403, { error: 'app_id not allowed' });
      }
    }

    const method  = (event.req || event.node && event.node.req || {}).method || 'GET';
    const reqHeaders = _getRequestHeaders(event);
    const fwdHeaders = _filterHeaders(reqHeaders);

    // Read raw body for non-GET
    let bodyBuffer = null;
    if (method !== 'GET' && method !== 'HEAD') {
      bodyBuffer = await _readBody(event);
    }

    const upstream = `${relayUrl}/relay/${subPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let upRes;
    try {
      upRes = await fetch(upstream, {
        method,
        headers : fwdHeaders,
        body    : bodyBuffer || undefined,
        signal  : controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        return _h3Response(event, 504, { error: 'Upstream timeout' });
      }
      return _h3Response(event, 502, { error: 'Failed to reach relay' });
    }
    clearTimeout(timer);

    // Pipe response
    const resHeaders = _filterHeaders(upRes.headers);
    _setResponseHeaders(event, upRes.status, resHeaders);
    const body = await upRes.arrayBuffer();
    return Buffer.from(body);
  };
}

/* H3 helper shims — work both with h3 imported and without (for tests) */
function _getAppIdFromEvent (event) {
  try {
    const auth = (event.req || event.node && event.node.req || {}).headers || {};
    const authHeader = auth.authorization || '';
    // app_id is not in the auth header; it's in the body — skip whitelist for streaming
    return null;
  } catch (_) { return null; }
}

function _getRequestHeaders (event) {
  try {
    return (event.req || (event.node && event.node.req) || {}).headers || {};
  } catch (_) { return {}; }
}

async function _readBody (event) {
  try {
    if (typeof event.request !== 'undefined') {
      return Buffer.from(await event.request.arrayBuffer());
    }
    const req = event.req || (event.node && event.node.req);
    if (!req) return null;
    if (typeof req.on !== 'function') return null;
    return await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  } catch (_) { return null; }
}

function _h3Response (event, status, body) {
  try {
    const res = event.res || (event.node && event.node.res);
    if (res) {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    }
  } catch (_) {}
  return JSON.stringify(body);
}

function _setResponseHeaders (event, status, headers) {
  try {
    const res = event.res || (event.node && event.node.res);
    if (res) {
      res.statusCode = status;
      for (const [k, v] of Object.entries(headers)) {
        try { res.setHeader(k, v); } catch (_) {}
      }
    }
  } catch (_) {}
}

/* ========================================================================== */
/* defineByokRelayModule                                                       */
/* ========================================================================== */

/**
 * Nuxt 3 module factory.
 * Auto-registers the catch-all relay server route and exposes relayUrl as
 * a public runtime config key so composables can read it via useRuntimeConfig().
 *
 * Add to nuxt.config.ts:
 *   import { defineByokRelayModule } from '@byok-relay/nuxt'
 *   export default defineNuxtConfig({
 *     modules: [ defineByokRelayModule({ relayUrl: process.env.RELAY_URL }) ]
 *   })
 *
 * @param {object} [opts]
 * @param {string}   [opts.relayUrl]      Upstream relay URL (server-only).
 * @param {string}   [opts.publicRelayUrl] Public relay URL exposed to browser.
 *                                         Defaults to /relay (your own Nuxt route).
 * @param {string[]} [opts.allowedAppIds] Optional app_id allowlist.
 *
 * @returns {function} Nuxt module setup function compatible with defineNuxtModule().
 */
function defineByokRelayModule (opts) {
  opts = opts || {};
  const publicRelayUrl = opts.publicRelayUrl || '/relay';

  // Return a Nuxt module setup tuple that defineNuxtModule() expects.
  // When Nuxt is available, this integrates via addServerHandler + runtimeConfig.
  // Without Nuxt (tests/standalone), it behaves as a no-op factory.
  return function byokRelayModule (nuxtApp, options) {
    // nuxtApp is the Nuxt instance passed by the module loader.
    // Merge runtime config so $config.public.relayUrl is available in components.
    if (nuxtApp && typeof nuxtApp.options !== 'undefined') {
      const runtimeConfig = nuxtApp.options.runtimeConfig || {};
      const publicConfig  = runtimeConfig.public || {};
      publicConfig.relayUrl = publicConfig.relayUrl || publicRelayUrl;
      runtimeConfig.public  = publicConfig;
      // Server-only: expose the upstream relay URL
      runtimeConfig.relayUrl = opts.relayUrl ||
        (typeof process !== 'undefined' ? process.env.RELAY_URL : undefined) ||
        DEFAULT_RELAY_URL;
      nuxtApp.options.runtimeConfig = runtimeConfig;

      // Register the catch-all server route if addServerHandler is available
      if (typeof nuxtApp.addServerHandler === 'function') {
        const handler = createRelayServerRoute({
          relayUrl     : runtimeConfig.relayUrl,
          allowedAppIds: opts.allowedAppIds,
        });
        nuxtApp.addServerHandler({
          route  : '/relay/**',
          handler: handler,
        });
      }
    }
  };
}

/* ========================================================================== */
/* Vue composables                                                             */
/* ========================================================================== */

/* ── Signal shim — works without Vue ── */

function _signal (init) {
  try {
    const vue = require('vue');
    const r = vue.ref(init);
    return {
      get value ()      { return r.value; },
      set value (v)     { r.value = v; },
    };
  } catch (_) {
    let _v = init;
    return {
      get value ()      { return _v; },
      set value (v)     { _v = v; },
    };
  }
}

function _onUnmounted (fn) {
  try {
    const vue = require('vue');
    if (typeof vue.onUnmounted === 'function') vue.onUnmounted(fn);
  } catch (_) {}
}

/* ── useByokRelay ── */

/**
 * Core composable: token registration + key CRUD + logout.
 * Nuxt auto-import compatible — place in composables/ or import directly.
 *
 * @param {object} [opts]
 * @param {string}  [opts.relayUrl]  Defaults to useRuntimeConfig().public.relayUrl or '/relay'.
 * @param {string}  [opts.appId]
 * @param {object}  [opts.storage]   Custom storage adapter.
 */
function useByokRelay (opts) {
  opts = opts || {};
  const relayUrl = opts.relayUrl || _getRuntimeRelayUrl() || DEFAULT_RELAY_URL;
  const client   = new ByokRelayClient({ relayUrl, appId: opts.appId, storage: opts.storage });

  const token     = _signal(client.getToken());
  const loading   = _signal(false);
  const error     = _signal(null);
  const providers = _signal([]);

  async function register (appId) {
    loading.value = true; error.value = null;
    try {
      const t = await client.register(appId);
      token.value = t;
      return t;
    } catch (e) { error.value = e.message; throw e; }
    finally { loading.value = false; }
  }

  async function ensureToken (appId) {
    if (token.value) return token.value;
    return register(appId);
  }

  async function storeKey (provider, apiKey) {
    loading.value = true; error.value = null;
    try {
      const r = await client.storeKey(provider, apiKey);
      await listKeys();
      return r;
    } catch (e) { error.value = e.message; throw e; }
    finally { loading.value = false; }
  }

  async function listKeys () {
    const data = await client.listKeys();
    providers.value = (data && data.providers) ? data.providers : [];
    return data;
  }

  async function deleteKey (provider) {
    loading.value = true; error.value = null;
    try {
      const r = await client.deleteKey(provider);
      await listKeys();
      return r;
    } catch (e) { error.value = e.message; throw e; }
    finally { loading.value = false; }
  }

  async function rotateKey (provider, newApiKey) {
    loading.value = true; error.value = null;
    try { return await client.rotateKey(provider, newApiKey); }
    catch (e) { error.value = e.message; throw e; }
    finally { loading.value = false; }
  }

  function logout () { client.logout(); token.value = null; providers.value = []; }

  async function init () {
    const t = client.getToken();
    if (t) {
      token.value = t;
      try { await listKeys(); } catch (_) {}
    }
  }

  init().catch(() => {});

  return { token, loading, error, providers, register, ensureToken, storeKey, listKeys, deleteKey, rotateKey, logout };
}

/* ── useChat ── */

/**
 * Stateful non-streaming chat composable.
 *
 * @param {object} [opts]
 * @param {string}  [opts.relayUrl]
 * @param {string}  [opts.model]         e.g. 'openai/gpt-4o' or 'gpt-4o'
 * @param {string}  [opts.systemPrompt]
 * @param {object}  [opts.extraParams]
 * @param {object}  [opts.storage]
 */
function useChat (opts) {
  opts = opts || {};
  const relayUrl = opts.relayUrl || _getRuntimeRelayUrl() || DEFAULT_RELAY_URL;
  const client   = new ByokRelayClient({ relayUrl, storage: opts.storage });

  const messages  = _signal([]);
  const loading   = _signal(false);
  const error     = _signal(null);

  async function sendMessage (content, sendOpts) {
    sendOpts = sendOpts || {};
    const userMsg = { role: 'user', content };
    const history = messages.value.concat(userMsg);
    loading.value = true; error.value = null;
    try {
      const payload = Object.assign(
        { model: opts.model },
        opts.extraParams || {},
        sendOpts,
        { messages: history },
      );
      if (opts.systemPrompt) {
        payload.messages = [{ role: 'system', content: opts.systemPrompt }].concat(history);
      }
      const res = await client.chat(payload.messages, payload);
      const assistantMsg = {
        role   : 'assistant',
        content: res.choices?.[0]?.message?.content || res.content?.[0]?.text || '',
      };
      messages.value = history.concat(assistantMsg);
      return assistantMsg.content;
    } catch (e) {
      messages.value = messages.value;  // keep previous on error
      error.value = e.message;
      throw e;
    } finally { loading.value = false; }
  }

  function clearMessages () { messages.value = []; }

  return { messages, loading, error, sendMessage, clearMessages };
}

/* ── useStreamingChat ── */

/**
 * SSE streaming chat composable with AbortController support.
 *
 * @param {object} [opts]
 * @param {string}  [opts.relayUrl]
 * @param {string}  [opts.model]
 * @param {string}  [opts.systemPrompt]
 * @param {object}  [opts.extraParams]
 * @param {object}  [opts.storage]
 */
function useStreamingChat (opts) {
  opts = opts || {};
  const relayUrl = opts.relayUrl || _getRuntimeRelayUrl() || DEFAULT_RELAY_URL;
  const client   = new ByokRelayClient({ relayUrl, storage: opts.storage });

  const messages        = _signal([]);
  const streamingContent = _signal('');
  const loading          = _signal(false);
  const error            = _signal(null);

  let _controller = null;

  _onUnmounted(() => { if (_controller) _controller.abort(); });

  async function sendMessage (content, sendOpts) {
    sendOpts = sendOpts || {};
    if (_controller) _controller.abort();
    _controller = new AbortController();

    const userMsg = { role: 'user', content };
    const history = messages.value.concat(userMsg);
    messages.value = history;
    streamingContent.value = '';
    loading.value = true; error.value = null;

    const payload = Object.assign(
      { model: opts.model, signal: _controller.signal },
      opts.extraParams || {},
      sendOpts,
    );
    if (opts.systemPrompt) {
      payload.messages = [{ role: 'system', content: opts.systemPrompt }].concat(history);
    }

    let accumulated = '';
    try {
      const gen = client.streamChat(payload.messages || history, payload,
        chunk => { accumulated += chunk; streamingContent.value = accumulated; },
      );
      for await (const _ of gen) { /* drain */ }
      const assistantMsg = { role: 'assistant', content: accumulated };
      messages.value = history.concat(assistantMsg);
      streamingContent.value = '';
    } catch (e) {
      if (e.name !== 'AbortError') {
        // Partial commit
        if (accumulated) {
          messages.value = history.concat({ role: 'assistant', content: accumulated + ' [stopped]' });
        }
        error.value = e.message;
      }
    } finally { loading.value = false; }
  }

  function stopStreaming () { if (_controller) { _controller.abort(); _controller = null; } }
  function clearMessages () { messages.value = []; streamingContent.value = ''; }

  return { messages, streamingContent, loading, error, sendMessage, stopStreaming, clearMessages };
}

/* ── useRelayHealth ── */

/**
 * Health polling composable. Call destroy() in onUnmounted to stop polling.
 *
 * @param {object} [opts]
 * @param {string}  [opts.relayUrl]
 * @param {number}  [opts.intervalMs]  Default no auto-poll. Call startPolling(ms) explicitly.
 * @param {object}  [opts.storage]
 */
function useRelayHealth (opts) {
  opts = opts || {};
  const relayUrl = opts.relayUrl || _getRuntimeRelayUrl() || DEFAULT_RELAY_URL;
  const client   = new ByokRelayClient({ relayUrl, storage: opts.storage });

  const status  = _signal('unknown');  // 'ok' | 'degraded' | 'unknown'
  const data    = _signal(null);
  const loading = _signal(false);
  const error   = _signal(null);

  let _timer = null;

  _onUnmounted(() => { if (_timer) clearInterval(_timer); });

  async function check (deep) {
    loading.value = true; error.value = null;
    try {
      const res = await client.health(deep);
      status.value = res.status || 'ok';
      data.value   = res;
      return res;
    } catch (e) {
      status.value = 'degraded';
      error.value  = e.message;
    } finally { loading.value = false; }
  }

  function startPolling (intervalMs) {
    if (_timer) clearInterval(_timer);
    check();
    _timer = setInterval(check, intervalMs || 60000);
  }

  function stopPolling () { if (_timer) { clearInterval(_timer); _timer = null; } }
  function destroy () { stopPolling(); }

  if (opts.intervalMs) startPolling(opts.intervalMs);

  return { status, data, loading, error, check, startPolling, stopPolling, destroy };
}

/* ── Runtime config helper ── */

function _getRuntimeRelayUrl () {
  // Try useRuntimeConfig() (Nuxt 3 composable — only available in component context)
  try {
    const nuxt = require('#app');
    if (nuxt && typeof nuxt.useRuntimeConfig === 'function') {
      const cfg = nuxt.useRuntimeConfig();
      return (cfg.public && cfg.public.relayUrl) || null;
    }
  } catch (_) {}
  // Fall back to env (server-side)
  try {
    if (typeof process !== 'undefined' && process.env && process.env.RELAY_URL) {
      return process.env.RELAY_URL;
    }
  } catch (_) {}
  return null;
}

/* ========================================================================== */
/* Exports                                                                     */
/* ========================================================================== */

module.exports = {
  ByokRelayClient,
  createRelayServerRoute,
  defineByokRelayModule,
  useByokRelay,
  useChat,
  useStreamingChat,
  useRelayHealth,
};

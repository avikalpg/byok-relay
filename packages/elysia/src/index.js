/**
 * @byok-relay/elysia
 * Elysia plugin and route factory for BYOK AI relay.
 * Works on Bun (native) and Node.js servers running Elysia 1.x.
 *
 * Three distinct concerns:
 *
 *   1. Elysia plugin (byokRelayPlugin)
 *      A composable Elysia plugin built with `new Elysia()` that registers a
 *      catch-all route under a configurable prefix. RELAY_URL comes from
 *      `process.env.RELAY_URL` (or `Bun.env.RELAY_URL`) so it never leaks
 *      into the browser bundle. Attach to your app with `.use(byokRelayPlugin(...))`.
 *
 *   2. Standalone route handler factory (createRelayRouteHandler)
 *      Returns an Elysia context handler function for manual route registration:
 *        app.all('/relay/*', createRelayRouteHandler({ ... }))
 *      Useful when you want full control over route grouping or guards.
 *
 *   3. ByokRelayClient plain-JS class
 *      Framework-agnostic client for use in Elysia lifecycle hooks, route
 *      handlers, and Bun scripts. In-memory storage on Bun/Node; localStorage
 *      when bundled for the browser; custom storage adapter supported.
 *
 * Runtime requirements:
 *   - Bun 1.0+ (preferred) OR Node.js 18+ with Elysia ≥ 1.0
 *   - native fetch (Bun built-in / Node 18+)
 */

'use strict';

/* ========================================================================== */
/* Constants                                                                   */
/* ========================================================================== */

const DEFAULT_RELAY_URL  = 'https://relay.byokrelay.com';
const DEFAULT_PATH_PREFIX = '/relay';

/** Headers that must not be forwarded upstream (hop-by-hop). */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

/* ========================================================================== */
/* Utility                                                                     */
/* ========================================================================== */

/** True only in a browser context. */
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

/** Strip hop-by-hop headers from a Headers / plain-object input. */
function _filterHeaders (headers) {
  const out = {};
  const entries = typeof headers.entries === 'function'
    ? [...headers.entries()]
    : Object.entries(headers);
  for (const [k, v] of entries) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Resolve relay URL: explicit option → env var → managed default. */
function _resolveRelayUrl (opt) {
  // Support both Bun.env and process.env
  const envUrl = (typeof Bun !== 'undefined' && Bun.env
    ? Bun.env.RELAY_URL
    : undefined) || (typeof process !== 'undefined' && process.env
    ? process.env.RELAY_URL
    : undefined);
  return opt || envUrl || DEFAULT_RELAY_URL;
}

/**
 * Build the upstream URL for a given sub-path and raw URL.
 * @param {string} relayUrl  – upstream relay base URL
 * @param {string} subPath   – path portion after the prefix
 * @param {string} rawUrl    – original request URL (for query-string forwarding)
 */
function _buildUpstreamUrl (relayUrl, subPath, rawUrl) {
  const qs = rawUrl && rawUrl.includes('?')
    ? '?' + rawUrl.split('?').slice(1).join('?')
    : '';
  return `${relayUrl.replace(/\/$/, '')}/${(subPath || '').replace(/^\//, '')}${qs}`;
}

/* ========================================================================== */
/* Core proxy helper                                                            */
/* ========================================================================== */

/**
 * Forward a request to the upstream relay and return a Fetch API `Response`.
 * Elysia handlers can return a native `Response` directly — the framework
 * pipes it to the client with all headers and status preserved.
 *
 * @param {object} opts
 * @param {string}          opts.relayUrl
 * @param {string}          opts.subPath
 * @param {string}          opts.rawUrl
 * @param {string}          opts.method
 * @param {object|Headers}  opts.headers
 * @param {Buffer|string|ReadableStream|null} opts.body
 * @param {number}          opts.timeoutMs
 * @returns {Promise<Response>}
 */
async function _proxy ({ relayUrl, subPath, rawUrl, method, headers, body, timeoutMs }) {
  const upstream    = _buildUpstreamUrl(relayUrl, subPath, rawUrl);
  const fwdHeaders  = _filterHeaders(headers);
  const controller  = new AbortController();
  const timer       = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstreamRes = await fetch(upstream, {
      method,
      headers:  fwdHeaders,
      body:     ['GET', 'HEAD'].includes(method.toUpperCase()) ? undefined : body,
      signal:   controller.signal,
      // Bun natively supports duplex streaming
      ...(typeof Bun !== 'undefined' ? {} : {}),
    });
    clearTimeout(timer);

    // Build forwarded headers (strip hop-by-hop from upstream response)
    const resHeaders = {};
    upstreamRes.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) resHeaders[k] = v;
    });

    // Return a native Response — Elysia will pipe it straight to the client.
    // This preserves SSE streaming and binary payloads.
    return new Response(upstreamRes.body, {
      status:  upstreamRes.status,
      headers: resHeaders,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return new Response(JSON.stringify({ error: 'Upstream relay timed out' }), {
        status:  504,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'Failed to reach upstream relay' }), {
      status:  502,
      headers: { 'content-type': 'application/json' },
    });
  }
}

/* ========================================================================== */
/* byokRelayPlugin — composable Elysia plugin                                  */
/* ========================================================================== */

/**
 * Create a composable Elysia plugin for the BYOK relay.
 *
 * @example
 * const { Elysia } = require('elysia');
 * const { byokRelayPlugin } = require('@byok-relay/elysia');
 *
 * const app = new Elysia()
 *   .use(byokRelayPlugin())
 *   .listen(3000);
 *
 * // With options:
 * const app = new Elysia()
 *   .use(byokRelayPlugin({
 *     relayUrl:      process.env.RELAY_URL,
 *     pathPrefix:    '/relay',          // default
 *     allowedAppIds: ['app-1', 'app-2'],
 *     timeoutMs:     30_000,            // default
 *   }))
 *   .listen(3000);
 *
 * @param {object} [opts]
 * @param {string}   [opts.relayUrl]       – upstream relay URL (default: env → managed)
 * @param {string}   [opts.pathPrefix]     – mount prefix (default: '/relay')
 * @param {string[]} [opts.allowedAppIds]  – optional app_id allowlist
 * @param {number}   [opts.timeoutMs]      – upstream fetch timeout ms (default: 30000)
 * @returns {Elysia} – a composable Elysia plugin instance
 */
function byokRelayPlugin (opts = {}) {
  const relayUrl    = _resolveRelayUrl(opts.relayUrl);
  const pathPrefix  = (opts.pathPrefix || DEFAULT_PATH_PREFIX).replace(/\/$/, '');
  const allowedApps = opts.allowedAppIds ? new Set(opts.allowedAppIds) : null;
  const timeoutMs   = opts.timeoutMs || 30_000;

  // Lazy-load Elysia to keep the peer dep optional at module load time
  let ElysiaClass;
  try {
    ElysiaClass = require('elysia').Elysia;
  } catch (_) {
    throw new Error(
      '@byok-relay/elysia: could not resolve the "elysia" peer dependency. ' +
      'Run `bun add elysia` or `npm install elysia`.'
    );
  }

  const plugin = new ElysiaClass({ name: '@byok-relay/elysia', seed: pathPrefix });

  // Catch-all: handles all HTTP methods on `<pathPrefix>/*`
  plugin.all(`${pathPrefix}/*`, async (ctx) => {
    const req = ctx.request;

    // Optional app_id allowlist (from header or query)
    const appId = req.headers.get('x-app-id') || (ctx.query && ctx.query.app_id);
    if (allowedApps && appId && !allowedApps.has(appId)) {
      return new Response(JSON.stringify({ error: 'app_id not allowed' }), {
        status:  403,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Elysia exposes the wildcard segment as ctx.params['*']
    const subPath = (ctx.params && ctx.params['*']) || '';

    // Read raw body as ArrayBuffer (works for JSON, binary, multipart)
    let body = null;
    try {
      if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
        body = await req.arrayBuffer();
        body = body.byteLength > 0 ? body : null;
      }
    } catch (_) { /* no body */ }

    return _proxy({
      relayUrl,
      subPath,
      rawUrl:   req.url,
      method:   req.method,
      headers:  req.headers,
      body,
      timeoutMs,
    });
  });

  return plugin;
}

/* ========================================================================== */
/* createRelayRouteHandler — standalone handler factory                       */
/* ========================================================================== */

/**
 * Returns an Elysia context handler for manual `app.all()` registration.
 *
 * @example
 * const { Elysia } = require('elysia');
 * const { createRelayRouteHandler } = require('@byok-relay/elysia');
 *
 * const handler = createRelayRouteHandler({ relayUrl: process.env.RELAY_URL });
 *
 * const app = new Elysia()
 *   .all('/relay/*', handler)
 *   .listen(3000);
 *
 * @param {object} [opts] – same options as `byokRelayPlugin`
 * @returns {Function} – Elysia route handler `(ctx) => Promise<Response>`
 */
function createRelayRouteHandler (opts = {}) {
  const relayUrl    = _resolveRelayUrl(opts.relayUrl);
  const allowedApps = opts.allowedAppIds ? new Set(opts.allowedAppIds) : null;
  const timeoutMs   = opts.timeoutMs || 30_000;

  return async function relayRouteHandler (ctx) {
    const req = ctx.request;

    const appId = req.headers.get('x-app-id') || (ctx.query && ctx.query.app_id);
    if (allowedApps && appId && !allowedApps.has(appId)) {
      return new Response(JSON.stringify({ error: 'app_id not allowed' }), {
        status:  403,
        headers: { 'content-type': 'application/json' },
      });
    }

    const subPath = (ctx.params && (ctx.params['*'] || ctx.params.path)) || '';

    let body = null;
    try {
      if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
        const ab = await req.arrayBuffer();
        body = ab.byteLength > 0 ? ab : null;
      }
    } catch (_) { /* no body */ }

    return _proxy({
      relayUrl,
      subPath,
      rawUrl:   req.url,
      method:   req.method,
      headers:  req.headers,
      body,
      timeoutMs,
    });
  };
}

/* ========================================================================== */
/* ByokRelayClient                                                             */
/* ========================================================================== */

/**
 * Plain-JS client for the byok-relay API.
 * Works in Elysia route handlers, lifecycle hooks, and Bun scripts.
 * Also works in browser bundles (localStorage default).
 *
 * @example
 * const { ByokRelayClient } = require('@byok-relay/elysia');
 * const client = new ByokRelayClient({ relayUrl: process.env.RELAY_URL });
 *
 * const { token } = await client.register({ appId: 'my-app' });
 * await client.storeKey('openai', process.env.OPENAI_API_KEY);
 * const reply = await client.chat({
 *   model: 'openai/gpt-4o',
 *   messages: [{ role: 'user', content: 'Hi' }],
 * });
 */
class ByokRelayClient {
  /**
   * @param {object}  [opts]
   * @param {string}  [opts.relayUrl]  – relay base URL (default: env → managed relay)
   * @param {string}  [opts.appId]    – your application identifier
   * @param {object}  [opts.storage]  – custom storage { getItem, setItem, removeItem }
   */
  constructor (opts = {}) {
    this._relayUrl = _resolveRelayUrl(opts.relayUrl);
    this._appId    = opts.appId || 'default';
    this._storage  = opts.storage || _defaultStorage();
    this._token    = this._storage.getItem('byok_relay_token') || null;
  }

  /* ---- Token management -------------------------------------------------- */

  async register (opts = {}) {
    const appId = opts.appId || this._appId;
    const res = await fetch(`${this._relayUrl}/users`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ app_id: appId }),
    });
    if (!res.ok) throw new Error(`register failed: ${res.status}`);
    const data = await res.json();
    this._token = data.token;
    this._storage.setItem('byok_relay_token', this._token);
    return data;
  }

  async ensureToken (opts = {}) {
    if (!this._token) await this.register(opts);
    return this._token;
  }

  logout () {
    this._token = null;
    this._storage.removeItem('byok_relay_token');
  }

  /* ---- Key management ---------------------------------------------------- */

  async storeKey (provider, apiKey) {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/keys/${provider}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify({ api_key: apiKey }),
    });
    if (!res.ok) throw new Error(`storeKey failed: ${res.status}`);
    return res.json();
  }

  async listKeys () {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/keys`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`listKeys failed: ${res.status}`);
    return res.json();
  }

  async deleteKey (provider) {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/keys/${provider}`, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`deleteKey failed: ${res.status}`);
    return res.json();
  }

  async rotateKey (provider, newApiKey) {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/keys/${provider}/rotate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify({ api_key: newApiKey }),
    });
    if (!res.ok) throw new Error(`rotateKey failed: ${res.status}`);
    return res.json();
  }

  /* ---- Relay requests ---------------------------------------------------- */

  async relayRequest (path, init = {}) {
    const token = await this.ensureToken();
    const url   = `${this._relayUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const headers = Object.assign({ 'Authorization': `Bearer ${token}` }, init.headers || {});
    return fetch(url, Object.assign({}, init, { headers }));
  }

  async chat (opts = {}) {
    const token  = await this.ensureToken();
    const { model, messages, systemPrompt, ...extra } = opts;
    const body = {
      model,
      messages: systemPrompt
        ? [{ role: 'system', content: systemPrompt }, ...messages]
        : messages,
      ...extra,
    };
    const res = await fetch(`${this._relayUrl}/relay`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`chat failed (${res.status}): ${err}`);
    }
    const data = await res.json();
    return (data.choices?.[0]?.message?.content) ?? (data.content?.[0]?.text) ?? data;
  }

  /** Streaming chat — async generator yielding text chunks. */
  async * streamChat (opts = {}) {
    const token  = await this.ensureToken();
    const { model, messages, systemPrompt, signal, ...extra } = opts;
    const body = {
      model,
      stream: true,
      messages: systemPrompt
        ? [{ role: 'system', content: systemPrompt }, ...messages]
        : messages,
      ...extra,
    };
    const res = await fetch(`${this._relayUrl}/relay`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const err = await res.text();
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
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') return;
        try {
          const chunk = JSON.parse(raw);
          const text  = chunk.choices?.[0]?.delta?.content
            ?? chunk.delta?.text
            ?? null;
          if (text) yield text;
        } catch (_) { /* malformed SSE line */ }
      }
    }
  }

  /* ---- Utility ----------------------------------------------------------- */

  async health (deep = false) {
    const res = await fetch(`${this._relayUrl}/health${deep ? '?deep=1' : ''}`);
    return res.json();
  }

  async stats (appId) {
    const token = await this.ensureToken();
    const path  = appId ? `/stats/${appId}` : '/stats';
    const res   = await fetch(`${this._relayUrl}${path}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`stats failed: ${res.status}`);
    return res.json();
  }

  async getModels () {
    const res = await fetch(`${this._relayUrl}/models`);
    if (!res.ok) throw new Error(`getModels failed: ${res.status}`);
    return res.json();
  }

  async deleteAccount () {
    const token = await this.ensureToken();
    const res   = await fetch(`${this._relayUrl}/users`, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`deleteAccount failed: ${res.status}`);
    this.logout();
    return res.json();
  }
}

/* ========================================================================== */
/* Default storage (in-memory on Bun/Node, localStorage in browser)           */
/* ========================================================================== */

function _defaultStorage () {
  if (_isClient()) {
    return {
      getItem    : (k) => _safeGet(k),
      setItem    : (k, v) => _safeSet(k, v),
      removeItem : (k) => _safeRemove(k),
    };
  }
  const _mem = new Map();
  return {
    getItem    : (k) => _mem.get(k) || null,
    setItem    : (k, v) => _mem.set(k, v),
    removeItem : (k) => _mem.delete(k),
  };
}

/* ========================================================================== */
/* Exports                                                                     */
/* ========================================================================== */

module.exports = {
  byokRelayPlugin,
  createRelayRouteHandler,
  ByokRelayClient,
};

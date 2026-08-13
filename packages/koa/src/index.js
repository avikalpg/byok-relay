/**
 * @byok-relay/koa
 * Koa middleware and router factory for BYOK AI relay.
 * Works on any Node.js server running Koa 2+ with async/await.
 *
 * Three distinct concerns:
 *
 *   1. Koa middleware (createByokRelayMiddleware)
 *      Standard `async (ctx, next)` middleware that transparently proxies
 *      requests under a configurable path prefix to the upstream relay.
 *      RELAY_URL comes from `process.env.RELAY_URL` so it stays server-only.
 *
 *   2. Koa Router factory (createRelayRouter)
 *      Returns a `@koa/router` Router pre-mounted at a catch-all route.
 *      Forwards all HTTP methods with original headers + body; strips
 *      hop-by-hop headers; optional app_id allowlist.
 *      Use with `app.use(createRelayRouter(opts).routes())`.
 *
 *   3. ByokRelayClient plain-JS class
 *      Framework-agnostic client for use in Koa route handlers,
 *      middleware, and scripts. localStorage default in browsers (if bundled);
 *      in-memory fallback in Node.js; custom storage adapter supported.
 *
 * Runtime requirements:
 *   - Node.js 18+ (native fetch) OR Node <18 with a fetch polyfill
 *   - Koa 2+ peer dep (optional — factory functions work without it)
 *   - @koa/router peer dep for createRelayRouter (optional)
 */

'use strict';

/* ========================================================================== */
/* Constants                                                                   */
/* ========================================================================== */

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';
const DEFAULT_RELAY_PATH_PREFIX = '/relay';

/** Headers that must not be forwarded upstream (hop-by-hop). */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

/* ========================================================================== */
/* Utility                                                                     */
/* ========================================================================== */

/** True only when running in a browser context (not Node.js). */
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

/** Strip hop-by-hop headers; return a plain object. */
function _filterHeaders (headers) {
  const out = {};
  const src = typeof headers.toJSON === 'function' ? headers.toJSON() : headers;
  for (const [k, v] of Object.entries(src)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Resolve the upstream relay URL (env → option → managed default). */
function _resolveRelayUrl (opt) {
  return opt || process.env.RELAY_URL || DEFAULT_RELAY_URL;
}

/** Read raw body from Koa ctx as a Buffer. */
async function _readBody (ctx) {
  // If koa-body / @koa/bodyparser already ran, use the parsed raw body
  if (ctx.request.rawBody) return Buffer.from(ctx.request.rawBody);
  if (ctx.req.body instanceof Buffer) return ctx.req.body;
  // Otherwise stream it ourselves
  return new Promise((resolve, reject) => {
    const chunks = [];
    ctx.req.on('data', c => chunks.push(c));
    ctx.req.on('end', () => resolve(Buffer.concat(chunks)));
    ctx.req.on('error', reject);
  });
}

/* ========================================================================== */
/* createByokRelayMiddleware                                                    */
/* ========================================================================== */

/**
 * Returns a Koa `async (ctx, next)` middleware.
 *
 * Options:
 *   relayUrl      – upstream relay base URL (default: process.env.RELAY_URL)
 *   pathPrefix    – prefix to intercept (default: '/relay')
 *   allowedAppIds – if set, only these app_id values pass through (403 otherwise)
 *   timeoutMs     – upstream fetch timeout in ms (default: 30000)
 *
 * Mount before your routes:
 *   app.use(createByokRelayMiddleware({ relayUrl: process.env.RELAY_URL }));
 */
function createByokRelayMiddleware (opts = {}) {
  const relayUrl    = _resolveRelayUrl(opts.relayUrl);
  const pathPrefix  = opts.pathPrefix || DEFAULT_RELAY_PATH_PREFIX;
  const allowedApps = opts.allowedAppIds ? new Set(opts.allowedAppIds) : null;
  const timeoutMs   = opts.timeoutMs || 30_000;

  return async function byokRelayMiddleware (ctx, next) {
    if (!ctx.path.startsWith(pathPrefix)) return next();

    // Optional app_id allowlist
    const appId = ctx.headers['x-app-id'] || ctx.query.app_id;
    if (allowedApps && appId && !allowedApps.has(appId)) {
      ctx.status = 403;
      ctx.body = { error: 'app_id not allowed' };
      return;
    }

    const subPath  = ctx.path.slice(pathPrefix.length) || '/';
    const qs       = ctx.querystring ? `?${ctx.querystring}` : '';
    const upstream = `${relayUrl.replace(/\/$/, '')}${subPath}${qs}`;

    const headers = _filterHeaders(ctx.headers);
    const body    = ['GET', 'HEAD', 'OPTIONS'].includes(ctx.method.toUpperCase())
      ? undefined
      : await _readBody(ctx);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(upstream, {
        method:  ctx.method,
        headers,
        body,
        signal:  controller.signal,
        duplex:  'half',
      });

      clearTimeout(timer);

      // Forward status + headers
      ctx.status = response.status;
      for (const [k, v] of response.headers.entries()) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) ctx.set(k, v);
      }

      // Stream or buffer body
      if (response.body) {
        ctx.body = response.body;
      } else {
        ctx.body = await response.arrayBuffer();
      }
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        ctx.status = 504;
        ctx.body = { error: 'upstream timeout' };
      } else {
        ctx.status = 502;
        ctx.body = { error: 'Failed to reach AI provider' };
      }
    }
  };
}

/* ========================================================================== */
/* createRelayRouter                                                            */
/* ========================================================================== */

/**
 * Returns a `@koa/router` Router with a catch-all route for all HTTP methods.
 *
 * Options: same as createByokRelayMiddleware.
 *
 * Usage:
 *   const relayRouter = createRelayRouter({ relayUrl: process.env.RELAY_URL });
 *   app.use(relayRouter.routes());
 *   app.use(relayRouter.allowedMethods());
 */
function createRelayRouter (opts = {}) {
  const relayUrl    = _resolveRelayUrl(opts.relayUrl);
  const pathPrefix  = (opts.pathPrefix || DEFAULT_RELAY_PATH_PREFIX).replace(/\/$/, '');
  const allowedApps = opts.allowedAppIds ? new Set(opts.allowedAppIds) : null;
  const timeoutMs   = opts.timeoutMs || 30_000;

  // Lazy-resolve @koa/router to keep it an optional peer dep
  let Router;
  try {
    Router = require('@koa/router');
  } catch (_) {
    try {
      Router = require('koa-router'); // legacy alias
    } catch (__) {
      throw new Error(
        '@byok-relay/koa: createRelayRouter requires @koa/router. ' +
        'Install it: npm install @koa/router'
      );
    }
  }

  const router = new Router();

  async function handler (ctx) {
    const appId = ctx.headers['x-app-id'] || ctx.query.app_id;
    if (allowedApps && appId && !allowedApps.has(appId)) {
      ctx.status = 403;
      ctx.body = { error: 'app_id not allowed' };
      return;
    }

    // ctx.params[0] contains the catch-all path segment from `(.*)`
    const subPath  = '/' + (ctx.params[0] || '').replace(/^\/+/, '');
    const qs       = ctx.querystring ? `?${ctx.querystring}` : '';
    const upstream = `${relayUrl}${subPath}${qs}`;

    const headers = _filterHeaders(ctx.headers);
    const body    = ['GET', 'HEAD', 'OPTIONS'].includes(ctx.method.toUpperCase())
      ? undefined
      : await _readBody(ctx);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(upstream, {
        method:  ctx.method,
        headers,
        body,
        signal:  controller.signal,
        duplex:  'half',
      });

      clearTimeout(timer);

      ctx.status = response.status;
      for (const [k, v] of response.headers.entries()) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) ctx.set(k, v);
      }
      ctx.body = response.body || await response.arrayBuffer();
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        ctx.status = 504;
        ctx.body = { error: 'upstream timeout' };
      } else {
        ctx.status = 502;
        ctx.body = { error: 'Failed to reach AI provider' };
      }
    }
  }

  // Register catch-all for all HTTP methods
  router.all(`${pathPrefix}/(.*)`, handler);
  router.all(pathPrefix, handler);

  return router;
}

/* ========================================================================== */
/* ByokRelayClient                                                             */
/* ========================================================================== */

/**
 * Framework-agnostic client for interacting with a byok-relay instance.
 *
 * Works in Node.js (in-memory storage) and browsers (localStorage).
 * Provide a custom `storage` adapter for session-based persistence.
 *
 * @example
 * const client = new ByokRelayClient({ relayUrl: 'https://relay.byokrelay.com' });
 * await client.register('my-app');
 * await client.storeKey('openai', 'sk-...');
 * const resp = await client.chat({ model: 'gpt-4o', messages: [...] });
 */
class ByokRelayClient {
  /**
   * @param {object} opts
   * @param {string}  [opts.relayUrl]  – relay base URL (default: process.env.RELAY_URL or managed relay)
   * @param {string}  [opts.appId]     – your app identifier
   * @param {object}  [opts.storage]   – custom storage: { get(key), set(key,val), remove(key) }
   */
  constructor (opts = {}) {
    this._relayUrl = _resolveRelayUrl(opts.relayUrl);
    this._appId    = opts.appId || 'koa-app';
    this._storage  = opts.storage || {
      get:    _safeGet,
      set:    _safeSet,
      remove: _safeRemove,
    };
    this._memStore = {}; // in-memory fallback for Node.js
  }

  /* ---------------------------------------------------------------------- */
  /* Internal storage helpers                                                 */
  /* ---------------------------------------------------------------------- */

  _get (key) {
    if (this._storage !== null && typeof this._storage.get === 'function') {
      const v = this._storage.get(key);
      if (v !== null && v !== undefined) return v;
    }
    return this._memStore[key] || null;
  }

  _set (key, val) {
    if (this._storage !== null && typeof this._storage.set === 'function') {
      this._storage.set(key, val);
    }
    this._memStore[key] = val;
  }

  _remove (key) {
    if (this._storage !== null && typeof this._storage.remove === 'function') {
      this._storage.remove(key);
    }
    delete this._memStore[key];
  }

  get _tokenKey () { return `byok_relay_token_${this._appId}`; }

  /* ---------------------------------------------------------------------- */
  /* Auth                                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Register and obtain a relay token. Persists token for future calls.
   * Returns the token (shown once — store it securely if needed externally).
   */
  async register (appId) {
    if (appId) this._appId = appId;
    const res  = await fetch(`${this._relayUrl}/users`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ app_id: this._appId }),
    });
    if (!res.ok) throw new Error(`register failed: ${res.status}`);
    const data = await res.json();
    this._set(this._tokenKey, data.token);
    return data.token;
  }

  /** Return the stored token; register automatically if none exists. */
  async ensureToken () {
    const existing = this._get(this._tokenKey);
    if (existing) return existing;
    return this.register(this._appId);
  }

  /** Clear the stored token locally (does not revoke on the server). */
  logout () {
    this._remove(this._tokenKey);
  }

  /* ---------------------------------------------------------------------- */
  /* Key management                                                           */
  /* ---------------------------------------------------------------------- */

  async storeKey (provider, apiKey) {
    const token = await this.ensureToken();
    const res   = await fetch(`${this._relayUrl}/keys/${provider}`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ api_key: apiKey }),
    });
    if (!res.ok) throw new Error(`storeKey failed: ${res.status}`);
    return res.json();
  }

  async listKeys () {
    const token = await this.ensureToken();
    const res   = await fetch(`${this._relayUrl}/keys`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`listKeys failed: ${res.status}`);
    return res.json();
  }

  async deleteKey (provider) {
    const token = await this.ensureToken();
    const res   = await fetch(`${this._relayUrl}/keys/${provider}`, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`deleteKey failed: ${res.status}`);
    return res.json();
  }

  async rotateKey (provider, newApiKey) {
    const token = await this.ensureToken();
    const res   = await fetch(`${this._relayUrl}/keys/${provider}/rotate`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ api_key: newApiKey }),
    });
    if (!res.ok) throw new Error(`rotateKey failed: ${res.status}`);
    return res.json();
  }

  /* ---------------------------------------------------------------------- */
  /* Relay                                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Forward a raw request to any AI provider endpoint via the relay.
   *
   * @param {string} providerPath – e.g. 'openai/chat/completions'
   * @param {object} body         – JSON body
   * @param {object} [extraHeaders]
   * @returns {Promise<Response>}
   */
  async relayRequest (providerPath, body, extraHeaders = {}) {
    const token = await this.ensureToken();
    return fetch(`${this._relayUrl}/relay/${providerPath}`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
  }

  /**
   * Send a chat completion request via unified model routing.
   *
   * @param {object} params
   * @param {string}   params.model    – provider/model or bare model name
   * @param {Array}    params.messages
   * @param {object}  [params.extraParams]
   * @returns {Promise<object>} parsed JSON response
   */
  async chat ({ model, messages, extraParams = {} }) {
    const token = await this.ensureToken();
    const res   = await fetch(`${this._relayUrl}/relay`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ model, messages, ...extraParams }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`chat failed (${res.status}): ${err}`);
    }
    return res.json();
  }

  /**
   * Streaming chat via SSE. Yields text chunks as an async generator.
   *
   * @param {object} params – same as chat() plus optional AbortSignal
   * @yields {string} text chunk
   */
  async * streamChat ({ model, messages, extraParams = {}, signal }) {
    const token = await this.ensureToken();
    const res   = await fetch(`${this._relayUrl}/relay`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body:   JSON.stringify({ model, messages, stream: true, ...extraParams }),
      signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`streamChat failed (${res.status}): ${err}`);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          const chunk  = parsed.choices?.[0]?.delta?.content
            ?? parsed.delta?.text
            ?? '';
          if (chunk) yield chunk;
        } catch (_) {}
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Observability                                                            */
  /* ---------------------------------------------------------------------- */

  async health (deep = false) {
    const url = `${this._relayUrl}/health${deep ? '?deep=1' : ''}`;
    const res = await fetch(url);
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

  /** Delete account and all associated keys (GDPR Art. 17). */
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
/* Exports                                                                     */
/* ========================================================================== */

module.exports = {
  createByokRelayMiddleware,
  createRelayRouter,
  ByokRelayClient,
};

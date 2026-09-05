/**
 * @byok-relay/hono
 * Hono middleware and route factory for BYOK AI relay.
 * Works on Cloudflare Workers, Deno Deploy, Bun, Node.js, and any Hono-
 * compatible edge runtime.
 *
 * Three distinct concerns:
 *
 *   1. Hono middleware (createByokRelayMiddleware)
 *      Hono `MiddlewareHandler` that transparently proxies requests under a
 *      configurable path prefix to the upstream relay. RELAY_URL comes from
 *      the Hono context env (c.env.RELAY_URL) so it stays server-side only.
 *
 *   2. Relay route factory (createRelayRoute)
 *      Returns a Hono `Handler` for a catch-all route (e.g. `/relay/*`).
 *      Forwards all HTTP methods with original headers + body; strips
 *      hop-by-hop headers; optional app_id allowlist.
 *
 *   3. ByokRelayClient plain-JS class
 *      Framework-agnostic client for use in Hono API endpoints, Workers
 *      scripts, or any edge environment. Falls back to in-memory storage
 *      (no localStorage on edge).
 *
 * Runtime requirements:
 *   - fetch global (all modern edge runtimes; Node 18+)
 *   - Hono peer dep >=3.0.0 (optional — factory functions work without it)
 */

'use strict';

/* ========================================================================== */
/* Constants                                                                   */
/* ========================================================================== */

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';
const DEFAULT_RELAY_PATH_PREFIX = '/relay';

/* ========================================================================== */
/* Utility                                                                     */
/* ========================================================================== */

/** True only when running in a browser context (not edge/Node). */
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

/** Headers that must never be forwarded between hops. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'content-length', // let fetch recompute
]);

function _filterHeaders (headers) {
  /** @param {Headers|Record<string,string>} headers */
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

/* ========================================================================== */
/* 1. Hono middleware factory                                                  */
/* ========================================================================== */

/**
 * Creates a Hono `MiddlewareHandler` that transparently proxies requests
 * whose path starts with `pathPrefix` to the upstream relay.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.relayUrl]       Upstream relay URL (default: read from
 *                                         c.env.RELAY_URL, then managed relay).
 * @param {string}  [opts.pathPrefix]     Mount point on this app (default: '/relay').
 * @param {string[]}[opts.allowedAppIds]  If set, reject requests whose relay token
 *                                         belongs to a different app_id (403).
 *
 * @returns {import('hono').MiddlewareHandler}
 *
 * @example
 * // Cloudflare Workers / Hono
 * import { Hono } from 'hono';
 * import { createByokRelayMiddleware } from '@byok-relay/hono';
 *
 * const app = new Hono();
 * app.use('/relay/*', createByokRelayMiddleware());
 * export default app;
 */
function createByokRelayMiddleware (opts = {}) {
  const {
    relayUrl: staticRelayUrl,
    pathPrefix = DEFAULT_RELAY_PATH_PREFIX,
    allowedAppIds,
  } = opts;

  return async function byokRelayMiddleware (c, next) {
    const url = new URL(c.req.url);

    // Only intercept paths that start with our prefix
    if (!url.pathname.startsWith(pathPrefix)) {
      return next();
    }

    // Resolve relay URL: opts > c.env > default
    const relayUrl =
      staticRelayUrl ||
      (c.env && c.env.RELAY_URL) ||
      DEFAULT_RELAY_URL;

    // Build sub-path by stripping the prefix
    const subPath = url.pathname.slice(pathPrefix.length) || '/';
    const upstreamUrl = relayUrl.replace(/\/$/, '') + subPath + (url.search || '');

    // Optional app_id allowlist: fail closed unless the request names an allowed app.
    if (allowedAppIds && allowedAppIds.length > 0) {
      const appId = c.req.header('x-app-id') || '';
      if (!appId || !allowedAppIds.includes(appId)) {
        return c.json({ error: 'app_id not allowed' }, 403);
      }
    }

    // Forward headers (strip hop-by-hop)
    const forwardHeaders = _filterHeaders(c.req.raw.headers);

    // Read body once (edge runtimes; body is a ReadableStream)
    let body;
    const method = c.req.method.toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      body = await c.req.raw.arrayBuffer();
    }

    let upstreamRes;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method,
        headers: forwardHeaders,
        body: body || undefined,
        redirect: 'follow',
      });
    } catch (err) {
      return c.json({ error: 'Failed to reach upstream relay', detail: String(err) }, 502);
    }

    // Forward response headers (strip hop-by-hop)
    const resHeaders = _filterHeaders(upstreamRes.headers);

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: resHeaders,
    });
  };
}

/* ========================================================================== */
/* 2. Relay route factory                                                      */
/* ========================================================================== */

/**
 * Creates a Hono `Handler` for a catch-all relay route.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.relayUrl]       Upstream relay URL.
 * @param {string[]}[opts.allowedAppIds]  If set, reject requests with unknown app_id.
 *
 * @returns {import('hono').Handler}
 *
 * @example
 * import { Hono } from 'hono';
 * import { createRelayRoute } from '@byok-relay/hono';
 *
 * const app = new Hono();
 * // Catch-all: /api/relay and everything under it
 * app.all('/api/relay/*', createRelayRoute({ relayUrl: process.env.RELAY_URL }));
 * app.all('/api/relay',   createRelayRoute({ relayUrl: process.env.RELAY_URL }));
 * export default app;
 */
function createRelayRoute (opts = {}) {
  const { relayUrl: staticRelayUrl, allowedAppIds } = opts;

  return async function relayRouteHandler (c) {
    const relayUrl =
      staticRelayUrl ||
      (c.env && c.env.RELAY_URL) ||
      DEFAULT_RELAY_URL;

    // Hono catch-all stores the wildcard part in c.req.param('*')
    const wildcard = c.req.param('*') || '';
    const url = new URL(c.req.url);
    const subPath = wildcard ? `/${wildcard}` : '/';
    const upstreamUrl = relayUrl.replace(/\/$/, '') + subPath + (url.search || '');

    if (allowedAppIds && allowedAppIds.length > 0) {
      const appId = c.req.header('x-app-id') || '';
      if (!appId || !allowedAppIds.includes(appId)) {
        return c.json({ error: 'app_id not allowed' }, 403);
      }
    }

    const forwardHeaders = _filterHeaders(c.req.raw.headers);

    let body;
    const method = c.req.method.toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      body = await c.req.raw.arrayBuffer();
    }

    let upstreamRes;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method,
        headers: forwardHeaders,
        body: body || undefined,
        redirect: 'follow',
      });
    } catch (err) {
      return c.json({ error: 'Failed to reach upstream relay', detail: String(err) }, 502);
    }

    const resHeaders = _filterHeaders(upstreamRes.headers);

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: resHeaders,
    });
  };
}

/* ========================================================================== */
/* 3. ByokRelayClient plain-JS class                                          */
/* ========================================================================== */

/**
 * Framework-agnostic BYOK relay client.
 * Works in Hono route handlers, Cloudflare Workers, Deno Deploy, Bun,
 * and browser scripts. Uses localStorage when available; falls back to an
 * in-memory store for edge/server runtimes.
 *
 * @example
 * // In a Hono API route (server-side)
 * import { ByokRelayClient } from '@byok-relay/hono';
 * const relay = new ByokRelayClient({ relayUrl: c.env.RELAY_URL });
 * const { token } = await relay.register('my-app');
 * await relay.storeKey('openai', 'sk-...');
 * const resp = await relay.chat('gpt-4o', [{ role: 'user', content: 'Hello' }]);
 *
 * @example
 * // In a browser script (no localStorage for Cloudflare Workers — use server-side)
 * const relay = new ByokRelayClient({ relayUrl: 'https://relay.byokrelay.com' });
 */
class ByokRelayClient {
  /**
   * @param {object}  opts
   * @param {string}  [opts.relayUrl]   Relay base URL.
   * @param {string}  [opts.appId]      Application identifier.
   * @param {object}  [opts.storage]    Custom storage adapter: { get, set, remove }.
   *                                    Defaults to localStorage (browser) or in-memory (edge).
   */
  constructor (opts = {}) {
    this._relayUrl = (opts.relayUrl || DEFAULT_RELAY_URL).replace(/\/$/, '');
    this._appId = opts.appId || 'default';
    this._storageKey = `byok_relay_token_${this._appId}`;

    if (opts.storage) {
      this._storage = opts.storage;
    } else if (_isClient()) {
      // Browser
      this._storage = {
        get: (k) => { try { return window.localStorage.getItem(k); } catch (_) { return null; } },
        set: (k, v) => { try { window.localStorage.setItem(k, v); } catch (_) {} },
        remove: (k) => { try { window.localStorage.removeItem(k); } catch (_) {} },
      };
    } else {
      // Edge / server — in-memory only (stateless Workers need to pass token explicitly)
      const _mem = {};
      this._storage = {
        get: (k) => _mem[k] || null,
        set: (k, v) => { _mem[k] = v; },
        remove: (k) => { delete _mem[k]; },
      };
    }

    this._token = this._storage.get(this._storageKey) || null;
  }

  /* ---------------------------------------------------------------------- */
  /* Token management                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Register a new user and get a relay token.
   * If a token is already stored, returns the cached token without re-registering.
   * Pass `force=true` to force a new registration.
   *
   * @param {string} [appId]   Override the appId used at construction time.
   * @param {boolean}[force]   Force a new registration even if a token exists.
   * @returns {Promise<{token:string,expires_at:string}>}
   */
  async register (appId, force = false) {
    if (!force && this._token) return { token: this._token };
    const res = await fetch(`${this._relayUrl}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId || this._appId }),
    });
    if (!res.ok) throw new Error(`Registration failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    this._token = data.token;
    if (this._token) this._storage.set(this._storageKey, this._token);
    return data;
  }

  /**
   * Ensure a token is available, registering if necessary.
   * @returns {Promise<string>} relay token
   */
  async ensureToken () {
    if (!this._token) await this.register();
    return this._token;
  }

  /** Clear stored token and log out. */
  logout () {
    this._token = null;
    this._storage.remove(this._storageKey);
  }

  /* ---------------------------------------------------------------------- */
  /* Key management                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Store an API key for a provider.
   * @param {string} provider  e.g. 'openai', 'anthropic'
   * @param {string} apiKey
   */
  async storeKey (provider, apiKey) {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/keys/${provider}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ api_key: apiKey }),
    });
    if (!res.ok) throw new Error(`storeKey failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** List stored providers. */
  async listKeys () {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/keys`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`listKeys failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /**
   * Delete an API key for a provider.
   * @param {string} provider
   */
  async deleteKey (provider) {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/keys/${provider}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`deleteKey failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /**
   * Rotate an API key for a provider (atomic: verify new → update stored).
   * @param {string} provider
   * @param {string} newApiKey
   */
  async rotateKey (provider, newApiKey) {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/keys/${provider}/rotate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ api_key: newApiKey }),
    });
    if (!res.ok) throw new Error(`rotateKey failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /* ---------------------------------------------------------------------- */
  /* Relay requests                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Send a raw relay request.
   * @param {string} provider   e.g. 'openai', 'anthropic'
   * @param {string} path       Provider API path, e.g. '/chat/completions'
   * @param {object} [body]     Request body
   * @param {string} [method]   HTTP method (default: 'POST')
   */
  async relayRequest (provider, path, body, method = 'POST') {
    const token = await this.ensureToken();
    const url = `${this._relayUrl}/relay/${provider}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`relayRequest failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /**
   * Unified chat — uses unified model routing endpoint (byok-relay ≥1.1.0).
   * @param {string} model    e.g. 'gpt-4o', 'anthropic/claude-3-5-sonnet'
   * @param {Array}  messages OpenAI-format messages array
   * @param {object} [extra]  Extra body params (temperature, max_tokens, etc.)
   */
  async chat (model, messages, extra = {}) {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/relay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ model, messages, ...extra }),
    });
    if (!res.ok) throw new Error(`chat failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /**
   * Streaming chat via SSE. Returns an async generator yielding text chunks.
   * Works in edge runtimes that support ReadableStream.
   *
   * @param {string}   model     e.g. 'gpt-4o', 'anthropic/claude-3-5-sonnet'
   * @param {Array}    messages
   * @param {object}   [extra]
   * @param {AbortSignal} [signal]  Optional AbortSignal to cancel the stream
   *
   * @example
   * for await (const chunk of relay.streamChat('gpt-4o', messages)) {
   *   process.stdout.write(chunk);
   * }
   */
  async * streamChat (model, messages, extra = {}, signal) {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/relay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ model, messages, stream: true, ...extra }),
      signal,
    });
    if (!res.ok) throw new Error(`streamChat failed: ${res.status} ${await res.text()}`);

    // Parse SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

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
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch (_) {}
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Utility endpoints                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Health check.
   * @param {boolean} [deep]  If true, runs an upstream provider ping.
   */
  async health (deep = false) {
    const url = `${this._relayUrl}/health${deep ? '?deep=1' : ''}`;
    const res = await fetch(url);
    return res.json();
  }

  /**
   * Usage stats for the current token.
   * @param {string} [appId]
   */
  async stats (appId) {
    const token = await this.ensureToken();
    const url = appId
      ? `${this._relayUrl}/stats/${appId}`
      : `${this._relayUrl}/stats`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`stats failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** Get list of models from unified routing endpoint. */
  async getModels () {
    const res = await fetch(`${this._relayUrl}/models`);
    if (!res.ok) throw new Error(`getModels failed: ${res.status}`);
    return res.json();
  }

  /** Delete account and all associated keys (GDPR erasure). */
  async deleteAccount () {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/users`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`deleteAccount failed: ${res.status} ${await res.text()}`);
    this.logout();
    return res.json();
  }
}

/* ========================================================================== */
/* Exports                                                                     */
/* ========================================================================== */

module.exports = {
  createByokRelayMiddleware,
  createRelayRoute,
  ByokRelayClient,
};

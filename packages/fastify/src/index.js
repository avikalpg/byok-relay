/**
 * @byok-relay/fastify
 * Fastify plugin and route factory for BYOK AI relay.
 * Works on any Node.js server running Fastify 4+.
 *
 * Three distinct concerns:
 *
 *   1. Fastify plugin (byokRelayPlugin)
 *      A standard Fastify plugin that registers a catch-all route under a
 *      configurable prefix and decorates the Fastify instance with a
 *      `byokRelayClient` helper. RELAY_URL comes from `process.env.RELAY_URL`
 *      so it never leaks into the browser bundle.
 *
 *   2. Standalone route handler (createRelayRouteHandler)
 *      Returns a Fastify route handler function for manual registration via
 *      `fastify.all('/relay/*', createRelayRouteHandler(...))`. Useful when
 *      you want full control over the route definition.
 *
 *   3. ByokRelayClient plain-JS class
 *      Framework-agnostic client for use in Fastify route handlers, hooks,
 *      and scripts. In-memory storage on Node.js; localStorage in browsers
 *      (when bundled); custom storage adapter supported.
 *
 * Runtime requirements:
 *   - Node.js 18+ (native fetch) OR Node <18 with a fetch polyfill
 *   - Fastify 4+ peer dep (optional — handler factory works without it)
 */

'use strict';

/* ========================================================================== */
/* Constants                                                                   */
/* ========================================================================== */

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';
const DEFAULT_PATH_PREFIX = '/relay';

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
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Resolve the upstream relay URL (env → option → managed default). */
function _resolveRelayUrl (opt) {
  return opt || process.env.RELAY_URL || DEFAULT_RELAY_URL;
}

/* ========================================================================== */
/* Core proxy handler (shared by plugin + standalone factory)                 */
/* ========================================================================== */

/**
 * Build the upstream URL from a Fastify request.
 * Fastify wildcard routes expose the path as `request.params['*']`.
 * The subPath derived here is relative to the relay base URL.
 */
function _buildUpstreamUrl (relayUrl, subPath, rawUrl) {
  const qs = rawUrl && rawUrl.includes('?') ? '?' + rawUrl.split('?').slice(1).join('?') : '';
  return `${relayUrl.replace(/\/$/, '')}/${subPath.replace(/^\//, '')}${qs}`;
}

/**
 * Core proxy logic — shared between the Fastify plugin route handler and the
 * standalone route handler factory. Takes a normalised `subPath` + raw request
 * context and pipes the upstream response back to the client.
 *
 * @param {object} opts
 * @param {string}  opts.relayUrl
 * @param {string}  opts.subPath   – path segment to forward (no leading slash required)
 * @param {string}  opts.rawUrl    – full request URL (for query-string forwarding)
 * @param {string}  opts.method
 * @param {object}  opts.headers
 * @param {Buffer|string|null} opts.body
 * @param {number}  opts.timeoutMs
 * @param {object}  opts.reply     – Fastify reply object
 */
async function _proxy ({ relayUrl, subPath, rawUrl, method, headers, body, timeoutMs, reply }) {
  const upstream   = _buildUpstreamUrl(relayUrl, subPath, rawUrl);
  const fwdHeaders = _filterHeaders(headers);
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstreamRes = await fetch(upstream, {
      method,
      headers:  fwdHeaders,
      body:     ['GET', 'HEAD'].includes(method) ? undefined : body,
      signal:   controller.signal,
    });

    clearTimeout(timer);

    // Forward response headers (skip hop-by-hop)
    for (const [k, v] of upstreamRes.headers.entries()) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) reply.header(k, v);
    }

    reply.code(upstreamRes.status);

    // Pipe the response body — Fastify accepts a ReadableStream or Buffer
    if (upstreamRes.body) {
      reply.send(upstreamRes.body);
    } else {
      reply.send('');
    }
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return reply.code(504).send({ error: 'Upstream relay timed out' });
    }
    return reply.code(502).send({ error: 'Failed to reach upstream relay' });
  }
}

/* ========================================================================== */
/* byokRelayPlugin — Fastify plugin                                            */
/* ========================================================================== */

/**
 * Fastify plugin for BYOK relay.
 *
 * Register with:
 *   const { byokRelayPlugin } = require('@byok-relay/fastify');
 *   await fastify.register(byokRelayPlugin, {
 *     relayUrl: process.env.RELAY_URL,   // default: managed relay
 *     pathPrefix: '/relay',               // default
 *     allowedAppIds: ['app-1', 'app-2'], // optional allowlist
 *     timeoutMs: 30000,                   // default
 *   });
 *
 * After registration the Fastify instance is decorated with:
 *   fastify.byokRelayClient  — a ByokRelayClient instance (server-side, in-memory storage)
 *
 * The plugin registers `fastify.all('/relay/*', ...)` inside an encapsulated
 * scope so it does not bleed into parent scope. If you want the decoration to
 * be available on the parent instance, wrap with `fastify-plugin`:
 *   const fp = require('fastify-plugin');
 *   module.exports = fp(byokRelayPlugin);
 */
async function byokRelayPlugin (fastify, opts) {
  const relayUrl    = _resolveRelayUrl(opts.relayUrl);
  const pathPrefix  = (opts.pathPrefix || DEFAULT_PATH_PREFIX).replace(/\/$/, '');
  const allowedApps = opts.allowedAppIds ? new Set(opts.allowedAppIds) : null;
  const timeoutMs   = opts.timeoutMs || 30_000;

  // Decorate the fastify instance with a server-side ByokRelayClient
  if (!fastify.byokRelayClient) {
    fastify.decorate('byokRelayClient', new ByokRelayClient({ relayUrl }));
  }

  // Add a content-type parser for the relay prefix so raw bodies pass through
  // We catch all content types and store the raw buffer.
  fastify.addContentTypeParser(
    /^.*$/,
    { parseAs: 'buffer', bodyLimit: 52_428_800 /* 50 MB */ },
    (req, body, done) => done(null, body)
  );

  // Catch-all route: `${pathPrefix}/*`
  fastify.all(`${pathPrefix}/*`, {
    config: { rawBody: true },
  }, async (request, reply) => {
    // Optional app_id allowlist
    const appId = request.headers['x-app-id'] || (request.query && request.query.app_id);
    if (allowedApps && appId && !allowedApps.has(appId)) {
      return reply.code(403).send({ error: 'app_id not allowed' });
    }

    // Fastify wildcard parameter is `*`
    const subPath = request.params['*'] || '';

    // Derive raw body — Fastify stores parsed body on `request.body`
    let body = null;
    if (request.body !== undefined && request.body !== null) {
      body = Buffer.isBuffer(request.body)
        ? request.body
        : typeof request.body === 'string'
          ? request.body
          : JSON.stringify(request.body);
    }

    await _proxy({
      relayUrl,
      subPath,
      rawUrl: request.raw.url,
      method: request.method,
      headers: request.headers,
      body,
      timeoutMs,
      reply,
    });
  });
}

// Expose plugin metadata (Fastify 4 convention)
byokRelayPlugin[Symbol.for('skip-override')] = false; // scoped by default
byokRelayPlugin.fastify = '4.x - 5.x';

/* ========================================================================== */
/* createRelayRouteHandler — standalone handler factory                       */
/* ========================================================================== */

/**
 * Returns a Fastify route handler that proxies all traffic to the upstream relay.
 * Use when you want full control over route definition:
 *
 *   const handler = createRelayRouteHandler({ relayUrl: process.env.RELAY_URL });
 *   fastify.all('/relay/*', handler);
 *
 * Options: same as byokRelayPlugin.
 */
function createRelayRouteHandler (opts = {}) {
  const relayUrl    = _resolveRelayUrl(opts.relayUrl);
  const allowedApps = opts.allowedAppIds ? new Set(opts.allowedAppIds) : null;
  const timeoutMs   = opts.timeoutMs || 30_000;

  return async function relayRouteHandler (request, reply) {
    const appId = request.headers['x-app-id'] || (request.query && request.query.app_id);
    if (allowedApps && appId && !allowedApps.has(appId)) {
      return reply.code(403).send({ error: 'app_id not allowed' });
    }

    const subPath = request.params['*'] || request.params.path || '';

    let body = null;
    if (request.body !== undefined && request.body !== null) {
      body = Buffer.isBuffer(request.body)
        ? request.body
        : typeof request.body === 'string'
          ? request.body
          : JSON.stringify(request.body);
    }

    await _proxy({
      relayUrl,
      subPath,
      rawUrl: request.raw.url,
      method: request.method,
      headers: request.headers,
      body,
      timeoutMs,
      reply,
    });
  };
}

/* ========================================================================== */
/* ByokRelayClient                                                             */
/* ========================================================================== */

/**
 * Plain-JS client for the byok-relay API.
 * Works in Fastify route handlers, hooks, plugins, and (when bundled) browsers.
 *
 * @example
 * const client = new ByokRelayClient({ relayUrl: process.env.RELAY_URL });
 * const { token } = await client.register({ appId: 'my-app' });
 * await client.storeKey('openai', process.env.OPENAI_API_KEY);
 * const reply = await client.chat({
 *   model: 'openai/gpt-4o',
 *   messages: [{ role: 'user', content: 'Hi' }]
 * });
 */
class ByokRelayClient {
  /**
   * @param {object} opts
   * @param {string} [opts.relayUrl]  – relay base URL (default: process.env.RELAY_URL → managed relay)
   * @param {string} [opts.appId]    – your application identifier
   * @param {object} [opts.storage]  – custom storage adapter { getItem, setItem, removeItem }
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
    if (!res.ok) throw new Error(`Register failed: ${res.status}`);
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
    const url = `${this._relayUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const headers = Object.assign({ 'Authorization': `Bearer ${token}` }, init.headers || {});
    const res = await fetch(url, Object.assign({}, init, { headers }));
    return res;
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

  async deleteAccount () {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/users`, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`deleteAccount failed: ${res.status}`);
    this.logout();
    return res.json();
  }
}

/* ========================================================================== */
/* Default storage (in-memory on Node, localStorage in browser)               */
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

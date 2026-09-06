/**
 * @byok-relay/express
 * Express middleware and router factory for BYOK AI relay.
 * Works on any Node.js server running Express 4+ or Express 5+.
 *
 * Three distinct concerns:
 *
 *   1. Express middleware (createByokRelayMiddleware)
 *      Standard `(req, res, next)` middleware that transparently proxies
 *      requests under a configurable path prefix to the upstream relay.
 *      RELAY_URL comes from `process.env.RELAY_URL` so it stays server-only.
 *
 *   2. Express Router factory (createRelayRouter)
 *      Returns an `express.Router()` pre-mounted at a catch-all route.
 *      Forwards all HTTP methods with original headers + body; strips
 *      hop-by-hop headers; optional app_id allowlist.
 *      Use with `app.use('/relay', createRelayRouter(...))`.
 *
 *   3. ByokRelayClient plain-JS class
 *      Framework-agnostic client for use in Express route handlers,
 *      middleware, and scripts. localStorage default in browsers (if bundled);
 *      in-memory fallback in Node.js; custom storage adapter supported.
 *
 * Runtime requirements:
 *   - Node.js 18+ (native fetch) OR Node <18 with a fetch polyfill
 *   - Express 4+ or 5+ peer dep (optional — factory functions work without it)
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

// Node's fetch transparently decodes response bodies, so these transport
// headers can no longer describe the bytes sent to the downstream client.
const STALE_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length']);

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

/** Strip hop-by-hop and stale transport headers; return a plain object. */
function _filterHeaders (headers, { reconstructBody = false } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (
      !HOP_BY_HOP.has(name) &&
      name !== 'host' &&
      !(reconstructBody && name === 'content-length')
    ) out[k] = v;
  }
  return out;
}

/** Resolve the upstream relay URL (option → env → managed default). */
function _resolveRelayUrl (opt) {
  const envUrl = typeof process !== 'undefined' && process.env
    ? process.env.RELAY_URL
    : undefined;
  return opt || envUrl || DEFAULT_RELAY_URL;
}

function _matchesPathPrefix (path, prefix) {
  return prefix === '/'
    ? path.startsWith('/')
    : path === prefix || path.startsWith(`${prefix}/`);
}

function _requestBody (req) {
  if (req.body !== undefined) {
    return {
      body: Buffer.isBuffer(req.body)
        ? req.body
        : typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body),
      reconstructBody: true,
    };
  }
  return {
    body: typeof req.pipe === 'function' ? req : undefined,
    reconstructBody: false,
  };
}

function _waitForDrainOrClose (res) {
  if (res.destroyed || res.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.removeListener('drain', done);
      res.removeListener('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

async function _relayResponse (fetchOpts, res, controller, timer) {
  let reader;
  let downstreamClosed = false;
  const onClose = () => {
    if (!res.writableEnded) {
      downstreamClosed = true;
      controller.abort();
    }
  };
  res.once('close', onClose);

  try {
    const upstreamRes = await fetch(fetchOpts.upstream, fetchOpts.init);
    clearTimeout(timer);

    res.status(upstreamRes.status);
    for (const [k, v] of upstreamRes.headers.entries()) {
      const name = k.toLowerCase();
      if (!HOP_BY_HOP.has(name) && !STALE_RESPONSE_HEADERS.has(name)) {
        res.setHeader(k, v);
      }
    }

    if (!upstreamRes.body) {
      res.end();
      return;
    }

    reader = upstreamRes.body.getReader();
    while (!downstreamClosed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await _waitForDrainOrClose(res);
    }
    if (!downstreamClosed) res.end();
  } catch (err) {
    // The downstream client has already disconnected. Do not turn that abort
    // into a timeout response or attempt to write a second response.
    if (downstreamClosed) return;
    if (!res.headersSent) {
      if (err.name === 'AbortError') {
        return res.status(504).json({ error: 'Upstream relay timed out' });
      }
      return res.status(502).json({ error: 'Failed to reach upstream relay' });
    }
    if (!res.writableEnded) res.end();
  } finally {
    clearTimeout(timer);
    res.removeListener('close', onClose);
    if (downstreamClosed && reader) {
      try { await reader.cancel(); } catch (_) {}
    }
  }
}

/* ========================================================================== */
/* createByokRelayMiddleware                                                    */
/* ========================================================================== */

/**
 * Returns an Express `(req, res, next)` middleware.
 *
 * Options:
 *   relayUrl      – upstream relay base URL (default: process.env.RELAY_URL)
 *   pathPrefix    – prefix to intercept (default: '/relay')
 *   allowedAppIds – if set, every request needs an allowed app_id (403 otherwise)
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

  return async function byokRelayMiddleware (req, res, next) {
    if (!_matchesPathPrefix(req.path, pathPrefix)) return next();

    // Optional app_id allowlist
    const appId = req.headers['x-app-id'] || req.query.app_id;
    if (allowedApps && !allowedApps.has(appId)) {
      return res.status(403).json({ error: 'app_id not allowed' });
    }

    const subPath  = req.path.slice(pathPrefix.length) || '/';
    const upstream = `${relayUrl.replace(/\/$/, '')}${subPath}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`;

    const { body, reconstructBody } = _requestBody(req);
    const headers = _filterHeaders(req.headers, { reconstructBody });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const sentBody = ['GET', 'HEAD'].includes(req.method) ? undefined : body;
    return _relayResponse({
      upstream,
      init: {
        method:  req.method,
        headers,
        body:    sentBody,
        signal:  controller.signal,
        ...(sentBody === req ? { duplex: 'half' } : {}),
      },
    }, res, controller, timer);
  };
}

/* ========================================================================== */
/* createRelayRouter                                                            */
/* ========================================================================== */

/**
 * Returns an Express Router that proxies all traffic to the upstream relay.
 *
 * Usage:
 *   const { Router } = require('express');
 *   app.use('/relay', createRelayRouter({ relayUrl: process.env.RELAY_URL }));
 *
 * Options: same as createByokRelayMiddleware.
 *
 * Note: The returned Router is a plain function and does NOT require Express
 * to be installed — it only calls `Router()` when actually wiring routes,
 * which happens lazily on first `app.use()` call.
 */
function createRelayRouter (opts = {}) {
  const relayUrl    = _resolveRelayUrl(opts.relayUrl);
  const allowedApps = opts.allowedAppIds ? new Set(opts.allowedAppIds) : null;
  const timeoutMs   = opts.timeoutMs || 30_000;

  // Lazy-resolve Express Router so the factory works without Express installed
  let _router = null;

  function _getRouter () {
    if (_router) return _router;
    try {
      const express = require('express');
      _router = express.Router();
    } catch (_) {
      // Minimal stand-in if Express isn't installed
      const r = (req, res, next) => r.handle(req, res, next);
      r.handlers = [];
      r.all = (_path, handler) => { r.handlers.push(handler); return r; };
      r.handle = (req, res, next) => r.handlers.reduce(
        (chain, handler) => chain.then(() => handler(req, res, next)),
        Promise.resolve(),
      );
      _router = r;
    }
    _router.all(/.*/, _handler);
    return _router;
  }

  async function _handler (req, res, next) {
    // Optional app_id allowlist
    const appId = req.headers['x-app-id'] || (req.query && req.query.app_id);
    if (allowedApps && !allowedApps.has(appId)) {
      return res.status(403).json({ error: 'app_id not allowed' });
    }

    // req.path here is relative to the mount point (e.g. '/chat/completions')
    const subPath  = req.path || '/';
    const qs       = req.url && req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
    const upstream = `${relayUrl.replace(/\/$/, '')}${subPath}${qs}`;

    const { body, reconstructBody } = _requestBody(req);
    const headers = _filterHeaders(req.headers, { reconstructBody });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const sentBody = ['GET', 'HEAD'].includes(req.method) ? undefined : body;
    return _relayResponse({
      upstream,
      init: {
        method:  req.method,
        headers,
        body:    sentBody,
        signal:  controller.signal,
        ...(sentBody === req ? { duplex: 'half' } : {}),
      },
    }, res, controller, timer);
  }

  // Return a proxy that wires the router lazily on first call
  return new Proxy(function lazyRouter () {}, {
    get (_, prop) {
      const r = _getRouter();
      const val = r[prop];
      return typeof val === 'function' ? val.bind(r) : val;
    },
    apply (_, thisArg, args) {
      return _getRouter()(...args);
    },
  });
}

/* ========================================================================== */
/* ByokRelayClient                                                             */
/* ========================================================================== */

/**
 * Plain-JS client for the byok-relay API.
 * Works in Express route handlers, middleware, scripts, and (when bundled) browsers.
 *
 * @example
 * const client = new ByokRelayClient({ relayUrl: process.env.RELAY_URL, appId: 'my-app' });
 * const { token } = await client.register();
 * await client.storeKey('openai', process.env.OPENAI_API_KEY);
 * const reply = await client.chat({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'Hi' }] });
 */
class ByokRelayClient {
  /**
   * @param {object} opts
   * @param {string} [opts.relayUrl]  – relay base URL (default: process.env.RELAY_URL → managed relay)
   * @param {string} [opts.appId]    – your application identifier
   * @param {object} [opts.storage]  – custom storage adapter { getItem, setItem, removeItem }
   * @param {string} [opts.storageKey] – token storage key (default: relay URL + app ID namespace)
   */
  constructor (opts = {}) {
    this._relayUrl = _resolveRelayUrl(opts.relayUrl);
    this._appId    = opts.appId || 'default';
    this._storage  = opts.storage || _defaultStorage();
    this._storageKey = opts.storageKey || `byok_relay_token:${encodeURIComponent(this._relayUrl)}:${encodeURIComponent(this._appId)}`;
    this._token    = this._storage.getItem(this._storageKey) || null;
  }

  _headers (headers = {}) {
    return Object.assign({}, headers, { 'x-app-id': this._appId });
  }

  /* ---- Token management -------------------------------------------------- */

  async register (opts = {}) {
    if (opts.appId && opts.appId !== this._appId) {
      throw new Error('register appId must match the client appId');
    }
    const res = await fetch(`${this._relayUrl}/users`, {
      method:  'POST',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body:    JSON.stringify({ app_id: this._appId }),
    });
    if (!res.ok) throw new Error(`Register failed: ${res.status}`);
    const data = await res.json();
    this._token = data.token;
    this._storage.setItem(this._storageKey, this._token);
    return data;
  }

  async ensureToken (opts = {}) {
    if (!this._token) {
      this._registrationPromise ||= this.register(opts)
        .finally(() => { this._registrationPromise = null; });
      await this._registrationPromise;
    }
    return this._token;
  }

  logout () {
    this._token = null;
    this._storage.removeItem(this._storageKey);
  }

  /* ---- Key management ---------------------------------------------------- */

  async storeKey (provider, apiKey) {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/keys/${provider}`, {
      method:  'POST',
      headers: this._headers({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }),
      body:    JSON.stringify({ api_key: apiKey }),
    });
    if (!res.ok) throw new Error(`storeKey failed: ${res.status}`);
    return res.json();
  }

  async listKeys () {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/keys`, {
      headers: this._headers({ 'Authorization': `Bearer ${token}` }),
    });
    if (!res.ok) throw new Error(`listKeys failed: ${res.status}`);
    return res.json();
  }

  async deleteKey (provider) {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/keys/${provider}`, {
      method:  'DELETE',
      headers: this._headers({ 'Authorization': `Bearer ${token}` }),
    });
    if (!res.ok) throw new Error(`deleteKey failed: ${res.status}`);
    return res.json();
  }

  async rotateKey (provider, newApiKey) {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/keys/${provider}/rotate`, {
      method:  'POST',
      headers: this._headers({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }),
      body:    JSON.stringify({ api_key: newApiKey }),
    });
    if (!res.ok) throw new Error(`rotateKey failed: ${res.status}`);
    return res.json();
  }

  /* ---- Relay requests ---------------------------------------------------- */

  async relayRequest (path, init = {}) {
    const token = await this.ensureToken();
    const url = `${this._relayUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const headers = this._headers(Object.assign({ 'Authorization': `Bearer ${token}` }, init.headers || {}));
    const res = await fetch(url, Object.assign({}, init, { headers }));
    return res;
  }

  async chat (opts = {}) {
    const token  = await this.ensureToken();
    const { model, messages, systemPrompt, ...extra } = opts;
    const body = { model, messages: systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages, ...extra };
    const res = await fetch(`${this._relayUrl}/relay`, {
      method:  'POST',
      headers: this._headers({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }),
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
      headers: this._headers({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }),
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

    try {
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
    } finally {
      try { await reader.cancel(); } catch (_) {}
      reader.releaseLock();
    }
  }

  /* ---- Utility ----------------------------------------------------------- */

  async health (deep = false) {
    const url = `${this._relayUrl}/health${deep ? '?deep=1' : ''}`;
    const res = await fetch(url, { headers: this._headers() });
    return res.json();
  }

  async stats (appId) {
    const token = await this.ensureToken();
    const path  = appId ? `/stats/${appId}` : '/stats';
    const res   = await fetch(`${this._relayUrl}${path}`, {
      headers: this._headers({ 'Authorization': `Bearer ${token}` }),
    });
    if (!res.ok) throw new Error(`stats failed: ${res.status}`);
    return res.json();
  }

  async getModels () {
    const res = await fetch(`${this._relayUrl}/models`, { headers: this._headers() });
    if (!res.ok) throw new Error(`getModels failed: ${res.status}`);
    return res.json();
  }

  async deleteAccount () {
    const token = await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/users`, {
      method:  'DELETE',
      headers: this._headers({ 'Authorization': `Bearer ${token}` }),
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
  // In-memory fallback for Node.js / server-side use
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
  createByokRelayMiddleware,
  createRelayRouter,
  ByokRelayClient,
};

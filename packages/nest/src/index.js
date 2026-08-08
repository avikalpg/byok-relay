/**
 * @byok-relay/nest
 * NestJS module, middleware, and injectable service for BYOK AI relay.
 * Works with NestJS 8+, 9+, 10+, and 11+ on Node.js 18+.
 *
 * Three distinct concerns:
 *
 *   1. ByokRelayModule (dynamic NestJS module)
 *      Use `ByokRelayModule.forRoot(config)` or `ByokRelayModule.forRootAsync(config)`
 *      in your AppModule imports. Registers ByokRelayService as a provider and
 *      exports it for injection across the app. RELAY_URL stays in process.env.
 *
 *   2. ByokRelayMiddleware (NestJS NestMiddleware)
 *      Standard NestJS middleware with a `use(req, res, next)` method.
 *      Apply via `consumer.apply(ByokRelayMiddleware).forRoutes('/relay')`.
 *      Transparently proxies matching requests to the upstream relay.
 *
 *   3. ByokRelayService (injectable service)
 *      Wraps ByokRelayClient with NestJS DI. Inject via constructor:
 *        constructor(private readonly relay: ByokRelayService) {}
 *      Provides all client methods: register, storeKey, chat, streamChat, etc.
 *
 *   4. ByokRelayClient (plain-JS class)
 *      Framework-agnostic client for use in guards, interceptors, scripts, and
 *      tests. In-memory storage on Node.js; custom storage adapter supported.
 *
 * Runtime requirements:
 *   - Node.js 18+ (native fetch)
 *   - NestJS 8+ peer dep (optional — middleware and client work without it)
 *
 * Plain-JS usage (no TypeScript required):
 *   const { ByokRelayModule, ByokRelayService, ByokRelayMiddleware, ByokRelayClient }
 *     = require('@byok-relay/nest');
 */

'use strict';

/* ========================================================================== */
/* Constants                                                                   */
/* ========================================================================== */

const DEFAULT_RELAY_URL  = 'https://relay.byokrelay.com';
const DEFAULT_PATH_PREFIX = '/relay';
const BYOK_RELAY_CONFIG  = 'BYOK_RELAY_CONFIG';

/** Headers that must not be forwarded upstream (hop-by-hop). */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
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

function _filterHeaders (headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function _resolveRelayUrl (opt) {
  return opt || process.env.RELAY_URL || DEFAULT_RELAY_URL;
}

function _defaultStorage () {
  if (_isClient()) {
    return {
      getItem:    (k) => _safeGet(k),
      setItem:    (k, v) => _safeSet(k, v),
      removeItem: (k) => _safeRemove(k),
    };
  }
  const mem = new Map();
  return {
    getItem:    (k) => mem.get(k) || null,
    setItem:    (k, v) => mem.set(k, v),
    removeItem: (k) => mem.delete(k),
  };
}

/* ========================================================================== */
/* Core proxy logic (shared by middleware + controller helper)                */
/* ========================================================================== */

/**
 * Build upstream URL from subPath + query string.
 * subPath is the path segment after the relay prefix.
 */
function _buildUpstreamUrl (relayUrl, subPath, rawUrl) {
  const qs = rawUrl && rawUrl.includes('?')
    ? '?' + rawUrl.split('?').slice(1).join('?')
    : '';
  return `${relayUrl.replace(/\/$/, '')}/${subPath.replace(/^\//, '')}${qs}`;
}

/**
 * Core proxy handler for Node.js IncomingMessage / ServerResponse.
 * Used by ByokRelayMiddleware and by createRelayHandler().
 */
async function _proxyNode ({ relayUrl, subPath, req, res, timeoutMs }) {
  const rawUrl     = req.url || '';
  const upstream   = _buildUpstreamUrl(relayUrl, subPath, rawUrl);
  const fwdHeaders = _filterHeaders(req.headers);
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);

  // Collect request body
  const body = await new Promise((resolve, reject) => {
    if (['GET', 'HEAD'].includes(req.method)) return resolve(undefined);
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  try {
    const upstreamRes = await fetch(upstream, {
      method:  req.method,
      headers: fwdHeaders,
      body:    body && body.length ? body : undefined,
      signal:  controller.signal,
    });

    clearTimeout(timer);

    // Forward status + headers
    const outHeaders = {};
    for (const [k, v] of upstreamRes.headers.entries()) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v;
    }
    res.writeHead(upstreamRes.status, outHeaders);

    // Pipe body
    if (upstreamRes.body) {
      const reader  = upstreamRes.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); break; }
          res.write(value);
        }
      };
      await pump();
    } else {
      res.end();
    }
  } catch (err) {
    clearTimeout(timer);
    if (!res.headersSent) {
      if (err.name === 'AbortError') {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upstream relay timed out' }));
      } else {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to reach upstream relay' }));
      }
    } else {
      res.end();
    }
  }
}

/* ========================================================================== */
/* ByokRelayMiddleware — NestJS NestMiddleware                                 */
/* ========================================================================== */

/**
 * NestJS middleware that transparently proxies requests to the upstream relay.
 *
 * Apply in your AppModule (or any module implementing NestModule):
 *
 *   class AppModule {
 *     configure(consumer) {
 *       consumer
 *         .apply(ByokRelayMiddleware)
 *         .forRoutes('/relay');
 *     }
 *   }
 *
 * Configure via environment:
 *   RELAY_URL=https://your-relay.example.com
 *
 * Or inject config explicitly (when used outside ByokRelayModule):
 *   ByokRelayMiddleware.configure({
 *     relayUrl:      process.env.RELAY_URL,
 *     pathPrefix:    '/relay',
 *     allowedAppIds: ['app-1', 'app-2'],
 *     timeoutMs:     30_000,
 *   });
 */
class ByokRelayMiddleware {
  constructor (config) {
    // NestJS injects BYOK_RELAY_CONFIG when registered via ByokRelayModule.
    // Falls back to static config or environment defaults when used standalone.
    const cfg          = config || ByokRelayMiddleware._staticConfig || {};
    this._relayUrl     = _resolveRelayUrl(cfg.relayUrl);
    this._pathPrefix   = (cfg.pathPrefix || DEFAULT_PATH_PREFIX).replace(/\/$/, '');
    this._allowedApps  = cfg.allowedAppIds ? new Set(cfg.allowedAppIds) : null;
    this._timeoutMs    = cfg.timeoutMs || 30_000;
  }

  /**
   * Configure ByokRelayMiddleware when used without ByokRelayModule DI.
   * Call once at bootstrap, before middleware registration.
   */
  static configure (opts = {}) {
    ByokRelayMiddleware._staticConfig = opts;
  }

  /**
   * NestJS NestMiddleware interface.
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse}  res
   * @param {Function}                       next
   */
  async use (req, res, next) {
    const url = req.url || '';

    // Only intercept paths under our prefix; call next() for everything else
    if (!url.startsWith(this._pathPrefix)) {
      return next();
    }

    // Optional app_id allowlist
    const appId = (req.headers && req.headers['x-app-id']) ||
      (url.includes('app_id=') ? new URL(url, 'http://localhost').searchParams.get('app_id') : null);
    if (this._allowedApps && appId && !this._allowedApps.has(appId)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'app_id not allowed' }));
    }

    // Derive sub-path (strip pathPrefix)
    const subPath = url.slice(this._pathPrefix.length) || '/';

    await _proxyNode({
      relayUrl:  this._relayUrl,
      subPath,
      req,
      res,
      timeoutMs: this._timeoutMs,
    });
  }
}

ByokRelayMiddleware._staticConfig = null;

// Apply NestJS @Injectable() programmatically if @nestjs/common is present.
// This makes ByokRelayMiddleware injectable into the NestJS DI container.
try {
  const { Injectable, Inject, Optional } = require('@nestjs/common');
  Injectable()(ByokRelayMiddleware);

  // Re-define constructor metadata so NestJS knows to inject BYOK_RELAY_CONFIG
  const originalUse = ByokRelayMiddleware.prototype.use;
  ByokRelayMiddleware.prototype.use = originalUse; // preserve

  // Mark constructor parameter as optional injection token
  Inject(BYOK_RELAY_CONFIG)(ByokRelayMiddleware.prototype, undefined, 0);
  Optional()(ByokRelayMiddleware.prototype, undefined, 0);
} catch (_) {
  // @nestjs/common not installed — ByokRelayMiddleware still works standalone
}

/* ========================================================================== */
/* ByokRelayService — injectable NestJS service                               */
/* ========================================================================== */

/**
 * Injectable NestJS service wrapping ByokRelayClient.
 * Provided automatically by ByokRelayModule.forRoot().
 *
 * Inject in any NestJS provider:
 *   class MyService {
 *     constructor(relay) { this.relay = relay; }
 *   }
 *   // NestJS resolves ByokRelayService automatically via DI
 *
 * Or use directly (without DI):
 *   const svc = new ByokRelayService({ relayUrl: process.env.RELAY_URL });
 */
class ByokRelayService {
  constructor (config) {
    const cfg      = config || {};
    this._client   = new ByokRelayClient({
      relayUrl: _resolveRelayUrl(cfg.relayUrl),
      appId:    cfg.appId,
      storage:  cfg.storage,
    });
  }

  // Expose all ByokRelayClient methods as service methods

  register    (opts)           { return this._client.register(opts); }
  ensureToken (opts)           { return this._client.ensureToken(opts); }
  logout      ()               { return this._client.logout(); }
  storeKey    (provider, key)  { return this._client.storeKey(provider, key); }
  listKeys    ()               { return this._client.listKeys(); }
  deleteKey   (provider)       { return this._client.deleteKey(provider); }
  rotateKey   (provider, key)  { return this._client.rotateKey(provider, key); }
  relayRequest(path, init)     { return this._client.relayRequest(path, init); }
  chat        (opts)           { return this._client.chat(opts); }
  streamChat  (opts)           { return this._client.streamChat(opts); }
  health      (deep)           { return this._client.health(deep); }
  stats       (appId)          { return this._client.stats(appId); }
  getModels   ()               { return this._client.getModels(); }
  deleteAccount()              { return this._client.deleteAccount(); }

  /** Direct access to underlying client (for advanced usage). */
  get client () { return this._client; }
}

// Apply @Injectable() if NestJS is available
try {
  const { Injectable, Inject } = require('@nestjs/common');
  Injectable()(ByokRelayService);
  Inject(BYOK_RELAY_CONFIG)(ByokRelayService.prototype, undefined, 0);
} catch (_) { /* NestJS not installed — works standalone */ }

/* ========================================================================== */
/* ByokRelayModule — NestJS dynamic module                                    */
/* ========================================================================== */

/**
 * NestJS dynamic module for byok-relay.
 *
 * Quick start:
 *
 *   // app.module.js
 *   const { Module }          = require('@nestjs/common');
 *   const { ByokRelayModule } = require('@byok-relay/nest');
 *
 *   class AppModule {}
 *   Module({
 *     imports: [
 *       ByokRelayModule.forRoot({
 *         relayUrl:   process.env.RELAY_URL,  // default: managed relay
 *         pathPrefix: '/relay',               // default
 *         timeoutMs:  30_000,                 // default
 *       }),
 *     ],
 *   })(AppModule);
 *   module.exports = { AppModule };
 *
 * Async configuration (e.g. ConfigModule):
 *
 *   ByokRelayModule.forRootAsync({
 *     useFactory: (configService) => ({
 *       relayUrl: configService.get('RELAY_URL'),
 *     }),
 *     inject: [ConfigService],
 *   })
 */
class ByokRelayModule {
  /**
   * Synchronous module configuration.
   * @param {object} config
   * @param {string}   [config.relayUrl]      – upstream relay URL
   * @param {string}   [config.pathPrefix]    – path prefix to intercept (default: '/relay')
   * @param {string[]} [config.allowedAppIds] – optional app_id allowlist
   * @param {number}   [config.timeoutMs]     – upstream fetch timeout (default: 30 000 ms)
   * @param {string}   [config.appId]         – app identifier for ByokRelayService
   * @returns {object} NestJS DynamicModule
   */
  static forRoot (config = {}) {
    return {
      module:    ByokRelayModule,
      global:    config.global || false,
      providers: [
        { provide: BYOK_RELAY_CONFIG, useValue: config },
        ByokRelayService,
        ByokRelayMiddleware,
      ],
      exports: [ByokRelayService, ByokRelayMiddleware, BYOK_RELAY_CONFIG],
    };
  }

  /**
   * Asynchronous module configuration — supports useFactory / useClass / useExisting.
   * @param {object} asyncOptions
   * @param {Function}   [asyncOptions.useFactory]  – factory returning config
   * @param {any[]}      [asyncOptions.inject]       – providers to inject into factory
   * @param {Function}   [asyncOptions.useClass]     – class implementing ByokRelayConfigFactory
   * @param {boolean}    [asyncOptions.global]       – make module global
   * @param {any[]}      [asyncOptions.imports]      – modules to import
   * @returns {object} NestJS DynamicModule
   */
  static forRootAsync (asyncOptions = {}) {
    const configProvider = asyncOptions.useFactory
      ? {
          provide:    BYOK_RELAY_CONFIG,
          useFactory: asyncOptions.useFactory,
          inject:     asyncOptions.inject || [],
        }
      : asyncOptions.useClass
        ? {
            provide:  BYOK_RELAY_CONFIG,
            useClass: asyncOptions.useClass,
          }
        : {
            provide:    BYOK_RELAY_CONFIG,
            useExisting: asyncOptions.useExisting,
          };

    return {
      module:    ByokRelayModule,
      global:    asyncOptions.global || false,
      imports:   asyncOptions.imports || [],
      providers: [
        configProvider,
        ByokRelayService,
        ByokRelayMiddleware,
      ],
      exports: [ByokRelayService, ByokRelayMiddleware, BYOK_RELAY_CONFIG],
    };
  }
}

// Apply @Module({}) if NestJS is available
try {
  const { Module } = require('@nestjs/common');
  Module({})(ByokRelayModule);
} catch (_) { /* NestJS not installed */ }

/* ========================================================================== */
/* createRelayHandler — standalone request handler factory                    */
/* ========================================================================== */

/**
 * Returns a plain Node.js `(req, res)` handler that proxies all traffic
 * to the upstream relay. Useful for NestJS custom servers, raw http.Server,
 * or testing without a full NestJS app.
 *
 * @example
 *   const handler = createRelayHandler({ relayUrl: process.env.RELAY_URL });
 *   // In a NestJS custom provider:
 *   app.use('/relay', (req, res) => handler(req, res));
 */
function createRelayHandler (opts = {}) {
  const relayUrl    = _resolveRelayUrl(opts.relayUrl);
  const pathPrefix  = (opts.pathPrefix || DEFAULT_PATH_PREFIX).replace(/\/$/, '');
  const allowedApps = opts.allowedAppIds ? new Set(opts.allowedAppIds) : null;
  const timeoutMs   = opts.timeoutMs || 30_000;

  return async function relayHandler (req, res) {
    const url = req.url || '';

    const appId = (req.headers && req.headers['x-app-id']) || null;
    if (allowedApps && appId && !allowedApps.has(appId)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'app_id not allowed' }));
    }

    // Strip the pathPrefix to derive the upstream sub-path
    const subPath = url.startsWith(pathPrefix)
      ? url.slice(pathPrefix.length) || '/'
      : url;

    await _proxyNode({ relayUrl, subPath, req, res, timeoutMs });
  };
}

/* ========================================================================== */
/* ByokRelayClient                                                             */
/* ========================================================================== */

/**
 * Plain-JS client for the byok-relay API.
 * Works in NestJS services, guards, interceptors, and scripts.
 *
 * @example
 *   const client = new ByokRelayClient({ relayUrl: process.env.RELAY_URL });
 *   const { token } = await client.register({ appId: 'my-app' });
 *   await client.storeKey('openai', process.env.OPENAI_API_KEY);
 *   const reply = await client.chat({
 *     model: 'openai/gpt-4o',
 *     messages: [{ role: 'user', content: 'Hello' }],
 *   });
 */
class ByokRelayClient {
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
/* Exports                                                                     */
/* ========================================================================== */

module.exports = {
  /** Dynamic NestJS module — use forRoot() or forRootAsync() in imports[]. */
  ByokRelayModule,
  /** NestJS middleware — apply via consumer.apply(ByokRelayMiddleware).forRoutes(). */
  ByokRelayMiddleware,
  /** Injectable NestJS service — provided by ByokRelayModule. */
  ByokRelayService,
  /** Plain-JS client — works in any Node.js context. */
  ByokRelayClient,
  /** Standalone handler factory — returns a Node.js (req, res) handler. */
  createRelayHandler,
  /** DI token for the relay config object. */
  BYOK_RELAY_CONFIG,
};

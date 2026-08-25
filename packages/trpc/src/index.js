/**
 * @byok-relay/trpc
 * tRPC v11 router adapter, context factory, and middleware for BYOK AI relay.
 * Works with tRPC v11 + any adapter: Next.js App Router, Express, Fastify, Fetch.
 *
 * Four distinct concerns:
 *
 *   1. createByokRelayContext (context factory)
 *      Pass to `createCallerFactory` or `createTRPCContext`.
 *      Reads `RELAY_URL` from `process.env` server-only — never exposed to browser.
 *        const createContext = createByokRelayContext({ relayUrl: process.env.RELAY_URL });
 *
 *   2. createByokRelayRouter (tRPC router factory)
 *      Returns a tRPC router with pre-built procedures for all relay operations:
 *        relay.health, relay.register, relay.storeKey, relay.listKeys,
 *        relay.deleteKey, relay.rotateKey, relay.chat, relay.stats, relay.models.
 *      Accepts any `t` instance (initTRPC output) so you can merge with your own router.
 *        const relayRouter = createByokRelayRouter(t);
 *        const appRouter = t.router({ relay: relayRouter, ...yourRoutes });
 *
 *   3. createRelayProcedure (middleware factory)
 *      Injects a per-request ByokRelayClient into tRPC context.
 *      Use when you want fine-grained control over procedures without the full router.
 *        const authedProcedure = createRelayProcedure(t.procedure, { relayUrl });
 *
 *   4. ByokRelayClient (plain-JS class)
 *      Framework-agnostic. Use in tRPC procedures, scripts, and tests.
 *      In-memory storage on Node.js; localStorage in browser; custom adapter supported.
 *
 * Runtime requirements:
 *   - Node.js 18+ (native fetch)
 *   - @trpc/server v11 peer dep (optional — client works without it)
 *
 * Plain-JS usage (no TypeScript required):
 *   const { createByokRelayRouter, createByokRelayContext, ByokRelayClient }
 *     = require('@byok-relay/trpc');
 */

'use strict';

/* ========================================================================== */
/* Constants                                                                   */
/* ========================================================================== */

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';
const REQUEST_TIMEOUT_MS = 30_000;

/** Headers that must not be forwarded upstream (hop-by-hop). */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

/* ========================================================================== */
/* Storage helpers                                                             */
/* ========================================================================== */

function _isClient() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function _safeGet(key) {
  if (!_isClient()) return null;
  try { return window.localStorage.getItem(key); } catch (_) { return null; }
}

function _safeSet(key, val) {
  if (!_isClient()) return;
  try { window.localStorage.setItem(key, val); } catch (_) {}
}

function _safeRemove(key) {
  if (!_isClient()) return;
  try { window.localStorage.removeItem(key); } catch (_) {}
}

/**
 * Resolve either a storage adapter or a request/context-aware storage factory.
 * Server adapters should use a factory to select storage for the authenticated
 * request instead of sharing a process-wide token store.
 */
function _resolveStorage(storage, requestOrContext) {
  return typeof storage === 'function' ? storage(requestOrContext) : storage;
}

/* ========================================================================== */
/* ByokRelayClient — plain-JS class, no framework dependency                  */
/* ========================================================================== */

class ByokRelayClient {
  /**
   * @param {object} opts
   * @param {string}  [opts.relayUrl]  Upstream relay base URL. Defaults to managed relay.
   * @param {string}  [opts.appId]     Optional app_id sent on registration.
   * @param {object}  [opts.storage]   Custom storage: { get(k), set(k,v), remove(k) }
   */
  constructor(opts = {}) {
    this._relayUrl = (opts.relayUrl || DEFAULT_RELAY_URL).replace(/\/$/, '');
    this._appId    = opts.appId || 'byok-relay-trpc-client';
    this._storage  = opts.storage || {
      get:    (k) => _safeGet(k),
      set:    (k, v) => _safeSet(k, v),
      remove: (k) => _safeRemove(k),
    };
    // In-memory fallback for Node.js
    this._mem = {};
  }

  _store(key, val) {
    this._mem[key] = val;
    this._storage.set(key, val);
  }

  _load(key) {
    if (this._mem[key] !== undefined) return this._mem[key];
    const v = this._storage.get(key);
    if (v) this._mem[key] = v;
    return v || null;
  }

  _drop(key) {
    delete this._mem[key];
    this._storage.remove(key);
  }

  /* ---------------------------------------------------------------------- */
  /* Auth                                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Register and get a relay token. Idempotent — returns cached token if present.
   * @returns {Promise<string>} relay token
   */
  async ensureToken() {
    const cached = this._load('byok_relay_token');
    if (cached) return cached;
    return this.register();
  }

  /**
   * Register a new user and return the relay token (shown once).
   * @param {string} [appId] Override app_id for this registration.
   * @returns {Promise<string>} relay token
   */
  async register(appId) {
    const res = await this._fetch('/users', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ app_id: appId || this._appId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Register failed: ${data.error || res.status}`);
    this._store('byok_relay_token', data.token);
    return data.token;
  }

  /** Remove stored token (local logout — does not delete server-side account). */
  logout() {
    this._drop('byok_relay_token');
  }

  /* ---------------------------------------------------------------------- */
  /* Key management                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Store an API key for a provider.
   * @param {string} provider e.g. 'openai', 'anthropic'
   * @param {string} apiKey
   */
  async storeKey(provider, apiKey) {
    const token = await this.ensureToken();
    const res = await this._fetch(`/keys/${provider}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify({ api_key: apiKey }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`storeKey failed: ${data.error || res.status}`);
    return data;
  }

  /** List stored provider keys (names only, not values). */
  async listKeys() {
    const token = await this.ensureToken();
    const res = await this._fetch('/keys', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`listKeys failed: ${data.error || res.status}`);
    return data.keys || [];
  }

  /** Delete a stored provider key. */
  async deleteKey(provider) {
    const token = await this.ensureToken();
    const res = await this._fetch(`/keys/${provider}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`deleteKey failed: ${data.error || res.status}`);
    return data;
  }

  /** Rotate a provider key — validates new key before replacing old one. */
  async rotateKey(provider, newApiKey) {
    const token = await this.ensureToken();
    const res = await this._fetch(`/keys/${provider}/rotate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify({ api_key: newApiKey }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`rotateKey failed: ${data.error || res.status}`);
    return data;
  }

  /* ---------------------------------------------------------------------- */
  /* Relay request                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Forward a raw request to an AI provider via the relay.
   * @param {string} provider  e.g. 'openai', 'anthropic'
   * @param {string} path      Provider sub-path e.g. 'v1/chat/completions'
   * @param {object} body      JSON body
   * @param {object} [headers] Extra headers
   */
  async relayRequest(provider, path, body, headers = {}) {
    const token = await this.ensureToken();
    const url = `${this._relayUrl}/relay/${provider}/${path}`;
    const res = await this._fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...headers,
      },
      body: JSON.stringify(body),
    }, true /* absolute */);
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Relay request failed (${res.status}): ${txt}`);
    }
    return res.json();
  }

  /**
   * Unified chat — uses model routing (provider/model or bare model name).
   * @param {object} opts
   * @param {string}   opts.model    e.g. 'openai/gpt-4o' or 'claude-opus-4-5'
   * @param {Array}    opts.messages OpenAI-format messages array
   * @param {object}   [opts.extra]  Extra body fields (temperature, max_tokens, …)
   * @returns {Promise<string>} assistant reply text
   */
  async chat({ model, messages, extra = {} }) {
    const token = await this.ensureToken();
    const res = await this._fetch('/relay', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify({ model, messages, ...extra }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`chat failed (${res.status}): ${txt}`);
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content
        ?? data?.content?.[0]?.text
        ?? JSON.stringify(data);
  }

  /**
   * Streaming chat via SSE — async generator yields text chunks.
   * @param {object} opts
   * @param {string}   opts.model
   * @param {Array}    opts.messages
   * @param {object}   [opts.extra]
   * @param {AbortSignal} [opts.signal]
   * @yields {string} text chunk
   */
  async * streamChat({ model, messages, extra = {}, signal } = {}) {
    const token = await this.ensureToken();
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (signal) signal.addEventListener('abort', () => controller.abort());

    let res;
    try {
      res = await fetch(`${this._relayUrl}/relay`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body:    JSON.stringify({ model, messages, stream: true, ...extra }),
        signal:  controller.signal,
      });
    } finally {
      clearTimeout(tid);
    }

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`streamChat failed (${res.status}): ${txt}`);
    }

    const reader = res.body.getReader();
    const dec    = new TextDecoder();
    let buf      = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const parsed = JSON.parse(payload);
          const chunk  = parsed?.choices?.[0]?.delta?.content
                      ?? parsed?.delta?.text;
          if (chunk) yield chunk;
        } catch (_) {}
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Utility endpoints                                                        */
  /* ---------------------------------------------------------------------- */

  /** Health check. Pass deep=true to ping upstream providers. */
  async health(deep = false) {
    const url = deep ? '/health?deep=1' : '/health';
    const res = await this._fetch(url);
    return res.json();
  }

  /** Per-user / per-app usage stats. */
  async stats(appId) {
    const token = await this.ensureToken();
    const url = appId ? `/stats/${appId}` : '/stats';
    const res = await this._fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`stats failed (${res.status}): ${txt}`);
    }
    return res.json();
  }

  /** List available models (respects ALLOWED_MODELS). */
  async getModels() {
    const res = await this._fetch('/models');
    return res.json();
  }

  /** Delete account and all associated keys (GDPR erasure). */
  async deleteAccount() {
    const token = await this.ensureToken();
    const res = await this._fetch('/users', {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`deleteAccount failed (${res.status}): ${txt}`);
    }
    this.logout();
    return res.json();
  }

  /* ---------------------------------------------------------------------- */
  /* Internal fetch                                                           */
  /* ---------------------------------------------------------------------- */

  async _fetch(pathOrUrl, init = {}, absolute = false) {
    const url = absolute ? pathOrUrl : `${this._relayUrl}${pathOrUrl}`;
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { signal: controller.signal, ...init });
    } finally {
      clearTimeout(tid);
    }
  }
}

/* ========================================================================== */
/* createByokRelayContext — tRPC context factory                               */
/* ========================================================================== */

/**
 * Create a tRPC context factory that injects a ByokRelayClient into every request.
 * Use with `createCallerFactory` or as your root `createTRPCContext`.
 *
 * @param {object} [opts]
 * @param {string} [opts.relayUrl]  Upstream relay URL. Defaults to process.env.RELAY_URL or managed relay.
 * @param {string} [opts.appId]     Optional app_id for client registration.
 * @param {object|Function} [opts.storage] Custom storage adapter, or a factory
 *   receiving the request and returning an adapter for its authenticated session.
 * @returns {(req: Request) => object} tRPC context factory
 *
 * @example
 * // trpc/context.js
 * const { createByokRelayContext } = require('@byok-relay/trpc');
 * const createContext = createByokRelayContext({ relayUrl: process.env.RELAY_URL });
 * module.exports = { createContext };
 */
function createByokRelayContext(opts = {}) {
  const relayUrl = opts.relayUrl || process.env.RELAY_URL || DEFAULT_RELAY_URL;
  const appId    = opts.appId || 'byok-relay-trpc';
  return function createContext(req) {
    const storage = _resolveStorage(opts.storage, req);
    const client = new ByokRelayClient({ relayUrl, appId, storage });
    return { relay: client, relayUrl };
  };
}

/* ========================================================================== */
/* createByokRelayRouter — pre-built tRPC router with relay procedures        */
/* ========================================================================== */

/**
 * Create a tRPC router pre-wired with all BYOK relay procedures.
 * Merge into your app router under any namespace.
 *
 * Requires a `t` instance from `initTRPC.context<{ relay: ByokRelayClient }>().create()`.
 * Falls back to a minimal shim if @trpc/server is not installed.
 *
 * @param {object} t  initTRPC result ({ router, procedure })
 * @param {object} [opts]
 * @param {string} [opts.relayUrl]  Override relay URL for this router.
 * @returns tRPC router
 *
 * @example
 * // trpc/router.js
 * const { initTRPC } = require('@trpc/server');
 * const { createByokRelayRouter, createByokRelayContext } = require('@byok-relay/trpc');
 * const t = initTRPC.context().create();
 * const relayRouter = createByokRelayRouter(t);
 * const appRouter = t.router({ relay: relayRouter });
 */
function createByokRelayRouter(t, opts = {}) {
  if (!t || typeof t.router !== 'function' || typeof t.procedure !== 'object') {
    throw new Error(
      '@byok-relay/trpc: createByokRelayRouter requires a valid `t` from initTRPC.create(). ' +
      'Install @trpc/server v11+ and call initTRPC.context().create().'
    );
  }

  const { router, procedure } = t;

  // Helper: get relay client from context or create ad-hoc from opts
  function getClient(ctx) {
    if (ctx && ctx.relay) return ctx.relay;
    return new ByokRelayClient({
      relayUrl: opts.relayUrl || process.env.RELAY_URL || DEFAULT_RELAY_URL,
      appId:    opts.appId,
      storage:  _resolveStorage(opts.storage, ctx),
    });
  }

  return router({
    /** Liveness + optional deep readiness check. */
    health: procedure
      .input((input) => {
        const i = input || {};
        return { deep: Boolean(i.deep), provider: i.provider || undefined };
      })
      .query(async ({ input, ctx }) => {
        const client = getClient(ctx);
        const url = input.deep
          ? `/health?deep=1${input.provider ? `&provider=${encodeURIComponent(input.provider)}` : ''}`
          : '/health';
        const res = await client._fetch(url);
        return res.json();
      }),

    /** Register a new user and return a relay token (shown once). */
    register: procedure
      .input((input) => {
        const i = input || {};
        return { appId: i.appId || undefined };
      })
      .mutation(async ({ input, ctx }) => {
        const client = getClient(ctx);
        const token = await client.register(input.appId);
        return { token };
      }),

    /** Store a provider API key (encrypted at rest). */
    storeKey: procedure
      .input((input) => {
        if (!input || typeof input.provider !== 'string' || typeof input.apiKey !== 'string') {
          throw new Error('storeKey requires { provider: string, apiKey: string }');
        }
        return { provider: input.provider, apiKey: input.apiKey };
      })
      .mutation(async ({ input, ctx }) => {
        const client = getClient(ctx);
        return client.storeKey(input.provider, input.apiKey);
      }),

    /** List stored provider keys (names only). */
    listKeys: procedure
      .query(async ({ ctx }) => {
        const client = getClient(ctx);
        return client.listKeys();
      }),

    /** Delete a stored provider key. */
    deleteKey: procedure
      .input((input) => {
        if (!input || typeof input.provider !== 'string') {
          throw new Error('deleteKey requires { provider: string }');
        }
        return { provider: input.provider };
      })
      .mutation(async ({ input, ctx }) => {
        const client = getClient(ctx);
        return client.deleteKey(input.provider);
      }),

    /** Rotate a provider key — validates new key before replacing old one. */
    rotateKey: procedure
      .input((input) => {
        if (!input || typeof input.provider !== 'string' || typeof input.newApiKey !== 'string') {
          throw new Error('rotateKey requires { provider: string, newApiKey: string }');
        }
        return { provider: input.provider, newApiKey: input.newApiKey };
      })
      .mutation(async ({ input, ctx }) => {
        const client = getClient(ctx);
        return client.rotateKey(input.provider, input.newApiKey);
      }),

    /** Unified chat — server-side relay call, result returned to client. */
    chat: procedure
      .input((input) => {
        if (!input || typeof input.model !== 'string' || !Array.isArray(input.messages)) {
          throw new Error('chat requires { model: string, messages: Array }');
        }
        return { model: input.model, messages: input.messages, extra: input.extra || {} };
      })
      .mutation(async ({ input, ctx }) => {
        const client = getClient(ctx);
        const reply = await client.chat({
          model:    input.model,
          messages: input.messages,
          extra:    input.extra,
        });
        return { reply };
      }),

    /** Per-user or per-app usage stats. */
    stats: procedure
      .input((input) => {
        const i = input || {};
        return { appId: i.appId || undefined };
      })
      .query(async ({ input, ctx }) => {
        const client = getClient(ctx);
        return client.stats(input.appId);
      }),

    /** List available models (respects ALLOWED_MODELS on the relay). */
    models: procedure
      .query(async ({ ctx }) => {
        const client = getClient(ctx);
        return client.getModels();
      }),
  });
}

/* ========================================================================== */
/* createRelayProcedure — inject ByokRelayClient as tRPC middleware            */
/* ========================================================================== */

/**
 * Returns an enhanced tRPC procedure that injects a ByokRelayClient into `ctx`.
 * Use when you want to add relay capability to individual procedures without
 * adopting the full pre-built router.
 *
 * @param {object} baseProcedure  A tRPC procedure (t.procedure)
 * @param {object} [opts]
 * @param {string} [opts.relayUrl] Upstream relay URL.
 * @param {string} [opts.appId]
 * @param {object|Function} [opts.storage] Custom storage adapter, or a factory
 *   receiving tRPC context and returning a session-scoped adapter.
 * @returns enhanced tRPC procedure with `ctx.relay: ByokRelayClient`
 *
 * @example
 * const relayProcedure = createRelayProcedure(t.procedure, { relayUrl: process.env.RELAY_URL });
 * const router = t.router({
 *   askAI: relayProcedure
 *     .input(z.object({ question: z.string() }))
 *     .mutation(async ({ input, ctx }) => {
 *       return ctx.relay.chat({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: input.question }] });
 *     }),
 * });
 */
function createRelayProcedure(baseProcedure, opts = {}) {
  if (!baseProcedure || typeof baseProcedure.use !== 'function') {
    throw new Error(
      '@byok-relay/trpc: createRelayProcedure requires a tRPC procedure (t.procedure). ' +
      'Install @trpc/server v11+ and pass t.procedure.'
    );
  }

  const relayUrl = opts.relayUrl || process.env.RELAY_URL || DEFAULT_RELAY_URL;
  const appId    = opts.appId;

  return baseProcedure.use(({ ctx, next }) => {
    if (ctx && ctx.relay) return next({ ctx });
    const storage = _resolveStorage(opts.storage, ctx);
    const relay = new ByokRelayClient({ relayUrl, appId, storage });
    return next({ ctx: { ...ctx, relay } });
  });
}

/* ========================================================================== */
/* createByokRelayFetchHandler — fetch-based HTTP handler for tRPC             */
/* ========================================================================== */

/**
 * Create a fetch-compatible tRPC handler pre-configured with byok-relay context.
 * Use with Next.js App Router, Cloudflare Workers, Deno Deploy, or any Fetch-based runtime.
 *
 * Requires `@trpc/server/adapters/fetch` — lazy-resolved at call time.
 *
 * @param {object} opts
 * @param {object}  opts.router      tRPC app router
 * @param {string}  [opts.endpoint]  tRPC endpoint prefix (default '/api/trpc')
 * @param {string}  [opts.relayUrl]  Upstream relay URL
 * @param {string}  [opts.appId]     Optional app_id
 * @param {object|Function} [opts.storage] Custom storage adapter, or a factory
 *   receiving the request and returning a session-scoped adapter.
 * @param {Function} [opts.createContext] Additional context factories to merge
 * @returns {(request: Request) => Promise<Response>}
 *
 * @example
 * // app/api/trpc/[trpc]/route.js  (Next.js App Router)
 * const { createByokRelayFetchHandler } = require('@byok-relay/trpc');
 * const { appRouter } = require('../../../../trpc/router');
 * const handler = createByokRelayFetchHandler({ router: appRouter });
 * module.exports = { GET: handler, POST: handler };
 */
function createByokRelayFetchHandler(opts = {}) {
  const relayUrl = opts.relayUrl || process.env.RELAY_URL || DEFAULT_RELAY_URL;
  const appId    = opts.appId;

  return async function handler(request) {
    let fetchAdapter;
    try {
      fetchAdapter = require('@trpc/server/adapters/fetch');
    } catch (_) {
      throw new Error(
        '@byok-relay/trpc: createByokRelayFetchHandler requires @trpc/server. ' +
        'Run: npm install @trpc/server'
      );
    }

    const baseCtx = (opts.createContext ? await opts.createContext(request) : {}) || {};
    const relay   = baseCtx.relay || new ByokRelayClient({
      relayUrl,
      appId,
      storage: _resolveStorage(opts.storage, request),
    });

    return fetchAdapter.fetchRequestHandler({
      endpoint:      opts.endpoint || '/api/trpc',
      req:           request,
      router:        opts.router,
      createContext: () => ({ ...baseCtx, relay }),
    });
  };
}

/* ========================================================================== */
/* Exports                                                                     */
/* ========================================================================== */

module.exports = {
  ByokRelayClient,
  createByokRelayContext,
  createByokRelayRouter,
  createRelayProcedure,
  createByokRelayFetchHandler,
};

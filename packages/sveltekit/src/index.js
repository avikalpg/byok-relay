/**
 * @byok-relay/sveltekit
 * SvelteKit handle hook factory and +server.js route handlers for BYOK AI relay.
 * Compatible with all SvelteKit adapters (adapter-node, adapter-vercel, adapter-cloudflare).
 *
 * Three distinct concerns:
 *
 *   1. Handle hook (createByokRelayHandle)
 *      SvelteKit hooks.server.js handle function factory.
 *      Intercepts requests under a configurable path prefix and proxies them
 *      to the upstream relay. RELAY_URL stays in process.env (server-only).
 *
 *      // hooks.server.js
 *      import { createByokRelayHandle } from '@byok-relay/sveltekit';
 *      export const handle = createByokRelayHandle();
 *
 *   2. Route handler factory (createRelayRouteHandlers)
 *      Returns { GET, POST, PUT, PATCH, DELETE, OPTIONS } for use in
 *      src/routes/relay/[...path]/+server.js.
 *      Uses event.params.path from SvelteKit's catch-all route parameter.
 *
 *      // src/routes/relay/[...path]/+server.js
 *      import { createRelayRouteHandlers } from '@byok-relay/sveltekit';
 *      export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = createRelayRouteHandlers();
 *
 *   3. ByokRelayClient plain-JS class
 *      Framework-agnostic client for use in +server.js load/action functions,
 *      hooks.server.js, and Svelte component <script> blocks (browser).
 *      localStorage default in browser; in-memory on server; custom storage
 *      adapter for cookie-based persistence in server load functions.
 *
 * Runtime requirements:
 *   - Node.js 18+ OR edge runtime with native fetch (Cloudflare Workers, Deno Deploy)
 *   - @sveltejs/kit peer dep (optional — exports work without it)
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

/** True only when running in a browser context. */
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

/** Strip hop-by-hop headers from a Headers object; return a plain object. */
function _filterHeaders (headers) {
  const out = {};
  if (headers && typeof headers.entries === 'function') {
    for (const [k, v] of headers.entries()) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
    }
  } else if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
    }
  }
  return out;
}

/** Resolve the upstream relay URL (option → env → managed default). */
function _resolveRelayUrl (opt) {
  // process.env is available in Node.js (adapter-node) and most edge runtimes
  const envUrl = (typeof process !== 'undefined' && process.env && process.env.RELAY_URL)
    ? process.env.RELAY_URL
    : null;
  return opt || envUrl || DEFAULT_RELAY_URL;
}

/**
 * Proxy a standard Web Request to the upstream relay and return a Response.
 * Used by both createByokRelayHandle and createRelayRouteHandlers.
 */
async function _proxyToRelay (upstreamUrl, request, timeoutMs, allowedApps) {
  // Optional app_id allowlist check
  const appId = request.headers.get('x-app-id');
  if (allowedApps && appId && !allowedApps.has(appId)) {
    return new Response(JSON.stringify({ error: 'app_id not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const filteredHeaders = _filterHeaders(request.headers);
  const method = request.method.toUpperCase();
  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(method);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = hasBody ? await request.arrayBuffer() : undefined;

    const response = await fetch(upstreamUrl, {
      method,
      headers: filteredHeaders,
      body: hasBody ? body : undefined,
      signal: controller.signal,
      // duplex: 'half' required in Node 18+ when body is a stream
      ...(hasBody ? { duplex: 'half' } : {}),
    });

    clearTimeout(timer);

    // Forward status and headers; stream the body
    const responseHeaders = {};
    for (const [k, v] of response.headers.entries()) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) responseHeaders[k] = v;
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return new Response(JSON.stringify({ error: 'upstream timeout' }), {
        status: 504,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'Failed to reach AI provider' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/* ========================================================================== */
/* createByokRelayHandle                                                        */
/* ========================================================================== */

/**
 * Returns a SvelteKit `handle` hook function for use in hooks.server.js.
 *
 * Intercepts all requests whose pathname starts with `pathPrefix` and proxies
 * them to the upstream relay. All other requests pass through to SvelteKit's
 * resolver unchanged.
 *
 * RELAY_URL is read from `process.env.RELAY_URL` at request time so it stays
 * server-only and is never bundled into the client.
 *
 * Options:
 *   relayUrl      – upstream relay base URL (default: process.env.RELAY_URL)
 *   pathPrefix    – URL prefix to intercept (default: '/relay')
 *   allowedAppIds – optional string[]; if set, only these app_id header values pass (403 otherwise)
 *   timeoutMs     – upstream fetch timeout in ms (default: 30000)
 *
 * @example
 * // src/hooks.server.js
 * import { createByokRelayHandle } from '@byok-relay/sveltekit';
 * export const handle = createByokRelayHandle();
 *
 * @example  Chaining with sequence() from @sveltejs/kit/hooks
 * import { sequence } from '@sveltejs/kit/hooks';
 * import { createByokRelayHandle } from '@byok-relay/sveltekit';
 * export const handle = sequence(createByokRelayHandle(), authHandle);
 */
function createByokRelayHandle (opts = {}) {
  const relayUrl    = _resolveRelayUrl(opts.relayUrl);
  const pathPrefix  = opts.pathPrefix || DEFAULT_RELAY_PATH_PREFIX;
  const allowedApps = opts.allowedAppIds ? new Set(opts.allowedAppIds) : null;
  const timeoutMs   = opts.timeoutMs || 30_000;

  return async function byokRelayHandle ({ event, resolve }) {
    const { pathname, search } = event.url;

    if (!pathname.startsWith(pathPrefix)) {
      return resolve(event);
    }

    const subPath  = pathname.slice(pathPrefix.length) || '/';
    const upstream = `${relayUrl.replace(/\/$/, '')}${subPath}${search}`;

    return _proxyToRelay(upstream, event.request, timeoutMs, allowedApps);
  };
}

/* ========================================================================== */
/* createRelayRouteHandlers                                                     */
/* ========================================================================== */

/**
 * Returns { GET, POST, PUT, PATCH, DELETE, OPTIONS } SvelteKit RequestHandlers
 * for use in a catch-all +server.js route.
 *
 * Create the file at: src/routes/relay/[...path]/+server.js
 *
 * Options: same as createByokRelayHandle.
 *
 * @example
 * // src/routes/relay/[...path]/+server.js
 * import { createRelayRouteHandlers } from '@byok-relay/sveltekit';
 * export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = createRelayRouteHandlers();
 *
 * @example  With app_id allowlist
 * export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = createRelayRouteHandlers({
 *   allowedAppIds: ['my-app', 'my-other-app'],
 * });
 */
function createRelayRouteHandlers (opts = {}) {
  const relayUrl    = _resolveRelayUrl(opts.relayUrl);
  const pathPrefix  = (opts.pathPrefix || DEFAULT_RELAY_PATH_PREFIX).replace(/\/$/, '');
  const allowedApps = opts.allowedAppIds ? new Set(opts.allowedAppIds) : null;
  const timeoutMs   = opts.timeoutMs || 30_000;

  async function handler (event) {
    // event.params.path is the [...path] catch-all from [...]path]/+server.js
    // It may be undefined if the file is at relay/+server.js (no catch-all)
    const subPath  = event.params.path ? `/${event.params.path}` : '/';
    const search   = event.url.search || '';
    const upstream = `${relayUrl.replace(/\/$/, '')}${subPath}${search}`;

    return _proxyToRelay(upstream, event.request, timeoutMs, allowedApps);
  }

  return {
    GET:     handler,
    POST:    handler,
    PUT:     handler,
    PATCH:   handler,
    DELETE:  handler,
    OPTIONS: handler,
  };
}

/* ========================================================================== */
/* ByokRelayClient                                                             */
/* ========================================================================== */

/**
 * Framework-agnostic client for interacting with a byok-relay instance.
 *
 * Storage precedence:
 *   - Browser: localStorage by default
 *   - Server (Node.js / edge): in-memory fallback
 *   - Provide a custom `storage` adapter for cookie-session persistence
 *     in SvelteKit +page.server.js load / form action functions.
 *
 * @example  Browser (Svelte component <script>)
 * import { ByokRelayClient } from '@byok-relay/sveltekit';
 * const client = new ByokRelayClient({ relayUrl: '/relay' });
 * await client.register('my-app');
 * await client.storeKey('openai', 'sk-...');
 *
 * @example  Server load function with cookie storage adapter
 * import { ByokRelayClient } from '@byok-relay/sveltekit';
 * export async function load({ cookies }) {
 *   const client = new ByokRelayClient({
 *     relayUrl: process.env.RELAY_URL,
 *     storage: {
 *       get: (key) => cookies.get(key) ?? null,
 *       set: (key, val) => cookies.set(key, val, { path: '/', httpOnly: true }),
 *       remove: (key) => cookies.delete(key, { path: '/' }),
 *     },
 *   });
 *   // ...
 * }
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
    this._appId    = opts.appId || 'sveltekit-app';
    this._storage  = opts.storage || {
      get:    _safeGet,
      set:    _safeSet,
      remove: _safeRemove,
    };
    this._memStore = {}; // in-memory fallback for Node.js / edge runtimes
  }

  /* ---------------------------------------------------------------------- */
  /* Internal storage helpers                                                 */
  /* ---------------------------------------------------------------------- */

  _get (key) {
    if (this._storage && typeof this._storage.get === 'function') {
      const v = this._storage.get(key);
      if (v !== null && v !== undefined) return v;
    }
    return this._memStore[key] || null;
  }

  _set (key, val) {
    if (this._storage && typeof this._storage.set === 'function') {
      this._storage.set(key, val);
    }
    this._memStore[key] = val;
  }

  _remove (key) {
    if (this._storage && typeof this._storage.remove === 'function') {
      this._storage.remove(key);
    }
    delete this._memStore[key];
  }

  get _tokenKey () { return `byok_relay_token_${this._appId}`; }

  /* ---------------------------------------------------------------------- */
  /* Auth                                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Register and obtain a relay token. Persists token via configured storage.
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

  /** Return the stored token; auto-register if none exists. */
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
   * Unified model routing chat completion.
   *
   * @param {object} params
   * @param {string}  params.model    – 'provider/model' or bare model name
   * @param {Array}   params.messages
   * @param {object} [params.extraParams]
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
   * Works in Node.js (adapter-node), Cloudflare Workers, and browsers.
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
  createByokRelayHandle,
  createRelayRouteHandlers,
  ByokRelayClient,
};

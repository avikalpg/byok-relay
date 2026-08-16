/**
 * @byok-relay/astro
 * Astro integration for BYOK AI relay.
 *
 * Three distinct concerns:
 *
 *   1. Server-side middleware (defineMiddleware / onRequest)
 *      Proxies /api/relay/* requests to the upstream relay, keeping RELAY_URL
 *      private in env vars and never exposed to the client.
 *
 *   2. API route factory (createRelayApiRoute)
 *      Returns an Astro API route handler (`APIRoute`) that proxies relay calls
 *      server-to-server so the real relay URL never ships to the browser.
 *
 *   3. Client-side ByokRelayClient class
 *      Plain-JS class (no framework hooks) for use in Astro <script> blocks,
 *      View Transitions, and hybrid-rendered pages.
 *
 * Server-side helpers use the Node `fetch` global (Astro requires Node 18+).
 * Client-side ByokRelayClient uses browser fetch.
 */

'use strict';

/* ========================================================================== */
/* Constants                                                                   */
/* ========================================================================== */

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';
const DEFAULT_RELAY_PATH_PREFIX = '/api/relay';
const DEFAULT_PROXY_TIMEOUT_MS = 30_000;

/* ========================================================================== */
/* Utility — SSR-safe storage                                                  */
/* ========================================================================== */

function _isClient () {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  } catch (_) {
    return false;
  }
}

function _timeoutSignal (timeoutMs) {
  if (!timeoutMs || typeof AbortController === 'undefined') {
    return { signal: undefined, cancel: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

function _isTimeoutError (err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
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

/* ========================================================================== */
/* 1. Astro middleware factory                                                 */
/* ========================================================================== */

/**
 * Creates an Astro middleware (onRequest handler) that transparently proxies
 * requests whose URL starts with `pathPrefix` to the upstream relay.
 *
 * Usage in `src/middleware.ts`:
 *
 *   import { sequence } from 'astro:middleware';
 *   import { createByokRelayMiddleware } from '@byok-relay/astro';
 *
 *   export const onRequest = sequence(
 *     createByokRelayMiddleware({
 *       relayUrl: import.meta.env.RELAY_URL,     // server-only env var
 *       pathPrefix: '/api/relay',
 *     }),
 *   );
 *
 * @param {object} opts
 * @param {string} opts.relayUrl         Upstream relay base URL (server-only env var).
 * @param {string} [opts.pathPrefix]     URL prefix to intercept. Default: '/api/relay'.
 * @param {string[]} [opts.allowedApps]  Optional client-controlled app_id filter.
 * @returns Astro `onRequest` middleware function.
 */
function createByokRelayMiddleware (opts = {}) {
  const relayUrl = (opts.relayUrl || DEFAULT_RELAY_URL).replace(/\/$/, '');
  const pathPrefix = opts.pathPrefix || DEFAULT_RELAY_PATH_PREFIX;
  const allowedApps = Array.isArray(opts.allowedApps) ? new Set(opts.allowedApps) : null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS;

  return async function byokRelayMiddleware (context, next) {
    const { request } = context;
    const url = new URL(request.url);

    if (!url.pathname.startsWith(pathPrefix)) {
      return next();
    }

    // Strip the path prefix to get the relay sub-path
    const subPath = url.pathname.slice(pathPrefix.length) || '/';
    const upstreamUrl = relayUrl + subPath + url.search;

    // Optional coarse app_id filter. app_id comes from the client, so this is
    // not authentication or authorization; upstream relay tokens carry the real
    // user/account authorization.
    if (allowedApps) {
      const appId = request.headers.get('x-app-id') || url.searchParams.get('app_id');
      if (!appId || !allowedApps.has(appId)) {
        return new Response(JSON.stringify({ error: 'Forbidden app_id' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Forward headers, minus hop-by-hop
    const forwardHeaders = new Headers();
    const hopByHop = new Set([
      'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
      'te', 'trailers', 'transfer-encoding', 'upgrade', 'host',
    ]);
    for (const [k, v] of request.headers.entries()) {
      if (!hopByHop.has(k.toLowerCase())) {
        forwardHeaders.set(k, v);
      }
    }

    const timeout = _timeoutSignal(timeoutMs);
    const init = {
      method: request.method,
      headers: forwardHeaders,
      redirect: 'follow',
      signal: timeout.signal,
    };
    if (!['GET', 'HEAD'].includes(request.method)) {
      init.body = request.body;
      init.duplex = 'half'; // required for Node fetch with streaming body
    }

    try {
      const upstreamResp = await fetch(upstreamUrl, init);
      timeout.cancel();

      // Stream response body back to client
      const respHeaders = new Headers();
      for (const [k, v] of upstreamResp.headers.entries()) {
        if (!hopByHop.has(k.toLowerCase())) {
          respHeaders.set(k, v);
        }
      }
      return new Response(upstreamResp.body, {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      timeout.cancel();
      const timedOut = _isTimeoutError(err);
      return new Response(JSON.stringify({ error: timedOut ? 'Relay proxy timeout' : 'Relay proxy error', details: err.message }), {
        status: timedOut ? 504 : 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  };
}

/* ========================================================================== */
/* 2. Astro API route factory                                                  */
/* ========================================================================== */

/**
 * Creates an Astro API route handler that proxies all relay calls server-side.
 *
 * Usage in `src/pages/api/relay/[...path].ts`:
 *
 *   import { createRelayApiRoute } from '@byok-relay/astro';
 *   export const { GET, POST, DELETE, PUT, PATCH, OPTIONS } = createRelayApiRoute({
 *     relayUrl: import.meta.env.RELAY_URL,
 *   });
 *   export const prerender = false;
 *
 * All HTTP methods are forwarded. The client never sees the real RELAY_URL.
 *
 * @param {object} opts
 * @param {string} opts.relayUrl         Upstream relay URL (server-side env var).
 * @param {string[]} [opts.allowedApps]  Optional client-controlled app_id filter.
 * @returns Object with GET, POST, PUT, PATCH, DELETE, OPTIONS Astro APIRoute handlers.
 */
function createRelayApiRoute (opts = {}) {
  const relayUrl = (opts.relayUrl || DEFAULT_RELAY_URL).replace(/\/$/, '');
  const allowedApps = Array.isArray(opts.allowedApps) ? new Set(opts.allowedApps) : null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS;

  async function handler ({ request, params }) {
    // Reconstruct sub-path from catch-all param
    const subPath = params.path ? '/' + params.path : '/';
    const reqUrl = new URL(request.url);
    const upstreamUrl = relayUrl + subPath + reqUrl.search;

    // Optional coarse app_id filter. app_id comes from the client, so this is
    // not authentication or authorization; upstream relay tokens carry the real
    // user/account authorization.
    if (allowedApps) {
      const appId = request.headers.get('x-app-id') || reqUrl.searchParams.get('app_id');
      if (!appId || !allowedApps.has(appId)) {
        return new Response(JSON.stringify({ error: 'Forbidden app_id' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const hopByHop = new Set([
      'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
      'te', 'trailers', 'transfer-encoding', 'upgrade', 'host',
    ]);

    const forwardHeaders = new Headers();
    for (const [k, v] of request.headers.entries()) {
      if (!hopByHop.has(k.toLowerCase())) {
        forwardHeaders.set(k, v);
      }
    }

    const timeout = _timeoutSignal(timeoutMs);
    const init = {
      method: request.method,
      headers: forwardHeaders,
      redirect: 'follow',
      signal: timeout.signal,
    };
    if (!['GET', 'HEAD'].includes(request.method)) {
      init.body = request.body;
      init.duplex = 'half';
    }

    try {
      const upstream = await fetch(upstreamUrl, init);
      timeout.cancel();
      const respHeaders = new Headers();
      for (const [k, v] of upstream.headers.entries()) {
        if (!hopByHop.has(k.toLowerCase())) {
          respHeaders.set(k, v);
        }
      }
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      timeout.cancel();
      const timedOut = _isTimeoutError(err);
      return new Response(JSON.stringify({ error: timedOut ? 'Relay proxy timeout' : 'Relay proxy error', details: err.message }), {
        status: timedOut ? 504 : 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return { GET: handler, POST: handler, PUT: handler, PATCH: handler, DELETE: handler, OPTIONS: handler };
}

/* ========================================================================== */
/* 3. Client-side ByokRelayClient class                                       */
/* ========================================================================== */

/**
 * Plain-JS client for use in Astro <script> blocks, View Transitions,
 * or any environment without a framework hook system.
 *
 * Works with both:
 *   - Direct relay URL:  new ByokRelayClient({ relayUrl: 'https://relay.byokrelay.com', appId: 'my-app' })
 *   - Server proxy URL:  new ByokRelayClient({ relayUrl: '/api/relay', appId: 'my-app' })
 *
 * Example in an Astro page:
 *
 *   <script>
 *     import { ByokRelayClient } from '@byok-relay/astro/client';
 *
 *     const relay = new ByokRelayClient({ relayUrl: '/api/relay', appId: 'my-app' });
 *     await relay.ensureToken();
 *     await relay.storeKey('openai', userApiKey);
 *     const reply = await relay.chat({ provider: 'openai', model: 'gpt-4o', messages });
 *   </script>
 */
class ByokRelayClient {
  /**
   * @param {object} opts
   * @param {string} opts.relayUrl   Relay base URL. Can be a server proxy path like '/api/relay'.
   * @param {string} opts.appId     Application identifier.
   * @param {string} [opts.storageKey]  localStorage key for the relay token. Default: 'byok_relay_token'.
   */
  constructor (opts = {}) {
    this._relayUrl = (opts.relayUrl || DEFAULT_RELAY_URL).replace(/\/$/, '');
    this._appId = opts.appId || 'astro-app';
    this._storageKey = opts.storageKey || 'byok_relay_token';
    this._token = _safeGet(this._storageKey) || null;
    this._registering = null;
  }

  /* ---------------------------------------------------------------------- */
  /* Token management                                                         */
  /* ---------------------------------------------------------------------- */

  /** Current relay token or null. */
  get token () { return this._token; }

  /**
   * Register and store a relay token.
   * @returns {Promise<string>} The new relay token.
   */
  async register () {
    const resp = await fetch(`${this._relayUrl}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this._appId }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Registration failed: ${resp.status}`);
    }
    const data = await resp.json();
    this._token = data.token;
    _safeSet(this._storageKey, this._token);
    return this._token;
  }

  /**
   * Return existing token or register a new one.
   * @returns {Promise<string>}
   */
  async ensureToken () {
    if (this._token) return this._token;
    if (!this._registering) {
      this._registering = this.register().finally(() => {
        this._registering = null;
      });
    }
    return this._registering;
  }

  /**
   * Clear the stored token (logout).
   */
  logout () {
    this._token = null;
    _safeRemove(this._storageKey);
  }

  /* ---------------------------------------------------------------------- */
  /* Key management                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Store a provider API key for the current user.
   * @param {string} provider  Provider name (e.g. 'openai', 'anthropic').
   * @param {string} apiKey    The user's API key.
   */
  async storeKey (provider, apiKey) {
    await this.ensureToken();
    const resp = await fetch(`${this._relayUrl}/keys/${provider}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._token}`,
      },
      body: JSON.stringify({ key: apiKey }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `storeKey failed: ${resp.status}`);
    }
    return resp.json();
  }

  /**
   * List all stored provider keys (returns names only, not values).
   * @returns {Promise<string[]>} Provider names.
   */
  async listKeys () {
    await this.ensureToken();
    const resp = await fetch(`${this._relayUrl}/keys`, {
      headers: { Authorization: `Bearer ${this._token}` },
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `listKeys failed: ${resp.status}`);
    }
    const data = await resp.json();
    return data.providers || [];
  }

  /**
   * Delete a stored provider key.
   * @param {string} provider
   */
  async deleteKey (provider) {
    await this.ensureToken();
    const resp = await fetch(`${this._relayUrl}/keys/${provider}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this._token}` },
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `deleteKey failed: ${resp.status}`);
    }
    return resp.json();
  }

  /**
   * Rotate a stored provider key (validate new key with provider before swapping).
   * @param {string} provider
   * @param {string} newApiKey
   */
  async rotateKey (provider, newApiKey) {
    await this.ensureToken();
    const resp = await fetch(`${this._relayUrl}/keys/${provider}/rotate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._token}`,
      },
      body: JSON.stringify({ key: newApiKey }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `rotateKey failed: ${resp.status}`);
    }
    return resp.json();
  }

  /* ---------------------------------------------------------------------- */
  /* Relay — chat                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Send a non-streaming chat request.
   *
   * @param {object} opts
   * @param {string} opts.provider      Provider name (e.g. 'openai', 'anthropic', 'groq').
   * @param {string} opts.model         Model name.
   * @param {Array}  opts.messages      Chat messages array.
   * @param {string} [opts.systemPrompt]
   * @param {object} [opts.extraParams] Extra body params forwarded to the provider.
   * @returns {Promise<string>} The assistant's reply text.
   */
  async chat (opts = {}) {
    await this.ensureToken();
    const { provider, model, messages = [], systemPrompt, extraParams = {} } = opts;

    const msgs = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;

    const body = { model, messages: msgs, ...extraParams };

    const endpoint = provider
      ? `${this._relayUrl}/relay/${provider}/chat/completions`
      : `${this._relayUrl}/relay`;

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._token}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `chat failed: ${resp.status}`);
    }
    const data = await resp.json();
    if (provider === 'anthropic') {
      return data.content?.[0]?.text || '';
    }
    return data.choices?.[0]?.message?.content || '';
  }

  /**
   * Send a streaming chat request. Calls `onChunk(text)` for each SSE delta.
   *
   * @param {object} opts
   * @param {string}   opts.provider
   * @param {string}   opts.model
   * @param {Array}    opts.messages
   * @param {string}   [opts.systemPrompt]
   * @param {Function} opts.onChunk      Called with each text delta string.
   * @param {Function} [opts.onDone]     Called with full accumulated text when stream ends.
   * @param {object}   [opts.extraParams]
   * @returns {Promise<string>} Full accumulated response text.
   */
  async streamChat (opts = {}) {
    await this.ensureToken();
    const { provider, model, messages = [], systemPrompt, onChunk, onDone, extraParams = {} } = opts;

    const msgs = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;

    const endpoint = provider
      ? `${this._relayUrl}/relay/${provider}/chat/completions`
      : `${this._relayUrl}/relay`;

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._token}`,
      },
      body: JSON.stringify({ model, messages: msgs, stream: true, ...extraParams }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `streamChat failed: ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          let delta = '';
          if (parsed.choices) {
            delta = parsed.choices[0]?.delta?.content || '';
          } else if (parsed.type === 'content_block_delta') {
            delta = parsed.delta?.text || '';
          }
          if (delta) {
            accumulated += delta;
            if (typeof onChunk === 'function') onChunk(delta);
          }
        } catch (_) { /* incomplete JSON frame — skip */ }
      }
    }

    if (typeof onDone === 'function') onDone(accumulated);
    return accumulated;
  }

  /* ---------------------------------------------------------------------- */
  /* Health & stats                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Check relay health.
   * @param {boolean} [deep] If true, also pings the upstream AI provider.
   */
  async health (deep = false) {
    const url = `${this._relayUrl}/health${deep ? '?deep=1' : ''}`;
    const resp = await fetch(url);
    return resp.json();
  }

  /**
   * Get usage stats for the current token.
   * @param {string} [appId] Operator app_id for aggregate stats (requires APP_SECRET).
   */
  async stats (appId) {
    await this.ensureToken();
    const url = appId
      ? `${this._relayUrl}/stats/${appId}`
      : `${this._relayUrl}/stats`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${this._token}` },
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `stats failed: ${resp.status}`);
    }
    return resp.json();
  }

  /**
   * List available models.
   */
  async getModels () {
    const resp = await fetch(`${this._relayUrl}/models`);
    return resp.json();
  }

  /**
   * Delete the current user account and all stored keys.
   */
  async deleteAccount () {
    await this.ensureToken();
    const resp = await fetch(`${this._relayUrl}/users`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this._token}` },
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `deleteAccount failed: ${resp.status}`);
    }
    this.logout();
    return resp.json();
  }
}

/* ========================================================================== */
/* Exports                                                                     */
/* ========================================================================== */

module.exports = {
  createByokRelayMiddleware,
  createRelayApiRoute,
  ByokRelayClient,
  DEFAULT_RELAY_URL,
  DEFAULT_RELAY_PATH_PREFIX,
};

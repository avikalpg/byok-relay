/**
 * @byok-relay/next
 * Next.js App Router integration for BYOK AI relay.
 *
 * Four distinct concerns:
 *
 *   1. Route Handler factory (createRelayRouteHandler)
 *      Returns { GET, POST, PUT, PATCH, DELETE, OPTIONS } for placement in
 *      app/api/relay/[...path]/route.js|ts. RELAY_URL lives in process.env —
 *      it never ships to the browser bundle. The browser only calls your own
 *      Next.js API route, which proxies server-to-server to the relay.
 *
 *   2. Middleware factory (createRelayMiddleware)
 *      Returns a Next.js `middleware` export function for middleware.js|ts.
 *      Intercepts requests whose pathname matches a configurable prefix
 *      (default /relay) and proxies them upstream. Works on Edge Runtime.
 *
 *   3. React hooks (useByokRelay, useChat, useStreamingChat, useRelayHealth)
 *      Client-side hooks for 'use client' App Router components and Pages
 *      Router components. Point relayUrl at your own API route, not the
 *      upstream relay URL — keep RELAY_URL server-only.
 *
 *   4. ByokRelayClient plain-JS class
 *      Framework-agnostic client safe in Server Components, Server Actions,
 *      API route handlers, and browser scripts. Accepts a custom storage
 *      adapter for server-side session stores.
 *
 * Peer dependency: react >=17 (optional — hooks are no-ops without it).
 * Node 18+ recommended for server-side fetch; Edge Runtime also supported.
 */

'use strict';

/* ========================================================================== */
/* Constants                                                                   */
/* ========================================================================== */

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';

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

/** Hop-by-hop headers that must not be forwarded between server ↔ relay. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'content-length', // let fetch set correct value
]);

function _filterHeaders (headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Convert Next.js Request headers (or plain object) to a plain object. */
function _headersToObject (headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') {
    const out = {};
    for (const [k, v] of headers.entries()) out[k] = v;
    return out;
  }
  return Object.assign({}, headers);
}

/* ========================================================================== */
/* 1. Route Handler factory                                                    */
/* ========================================================================== */

/**
 * Creates Next.js App Router Route Handler exports for the catch-all file:
 *   app/api/relay/[...path]/route.js
 *
 * Usage:
 *
 *   // app/api/relay/[...path]/route.js
 *   import { createRelayRouteHandler } from '@byok-relay/next';
 *   export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } =
 *     createRelayRouteHandler({ relayUrl: process.env.RELAY_URL });
 *
 * The catch-all segment `[...path]` maps to the relay sub-path.
 * e.g. POST /api/relay/relay/anthropic/... → relay POST /relay/anthropic/...
 *
 * @param {object}   opts
 * @param {string}   opts.relayUrl      Upstream relay base URL.
 * @param {string[]} [opts.allowedApps] Optional app_id allowlist (403 otherwise).
 * @param {number}   [opts.timeoutMs]   Upstream fetch timeout (default 30 000 ms).
 * @returns {{ GET, POST, PUT, PATCH, DELETE, OPTIONS }}
 */
function createRelayRouteHandler ({
  relayUrl = process.env.RELAY_URL || DEFAULT_RELAY_URL,
  allowedApps,
  timeoutMs = 30_000,
} = {}) {
  /**
   * Core proxy handler.
   * @param {Request} request  Incoming Next.js Request (Web API).
   * @param {{ params: { path?: string[] } }} context  Route context.
   */
  async function _handler (request, context) {
    // Build upstream sub-path from catch-all segment
    const segments = (context && context.params && context.params.path) || [];
    const subPath = segments.length ? '/' + segments.join('/') : '';
    const upstreamUrl = relayUrl.replace(/\/$/, '') + subPath;

    // Optional app_id gate
    if (allowedApps && allowedApps.length) {
      const appId =
        request.headers.get('x-app-id') ||
        new URL(request.url).searchParams.get('app_id');
      if (!appId || !allowedApps.includes(appId)) {
        return new Response(
          JSON.stringify({ error: 'app_id not allowed' }),
          { status: 403, headers: { 'content-type': 'application/json' } }
        );
      }
    }

    // Forward request headers (strip hop-by-hop)
    const inHeaders = _filterHeaders(_headersToObject(request.headers));

    // Read body (undefined for GET/HEAD/OPTIONS)
    let body = undefined;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) {
      try {
        body = await request.arrayBuffer();
        // Pass through as-is (preserves multipart, binary, JSON)
      } catch (_) {
        body = undefined;
      }
    }

    // Timeout via AbortController
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const upstreamResp = await fetch(upstreamUrl, {
        method: request.method,
        headers: inHeaders,
        body: body instanceof ArrayBuffer && body.byteLength > 0 ? body : undefined,
        signal: ac.signal,
        // Disable compression so binary streams pass through cleanly
        ...(typeof EdgeRuntime === 'undefined' ? { compress: false } : {}),
      });

      // Forward response headers (strip hop-by-hop)
      const respHeaders = _filterHeaders(_headersToObject(upstreamResp.headers));

      return new Response(upstreamResp.body, {
        status: upstreamResp.status,
        headers: respHeaders,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return new Response(
          JSON.stringify({ error: 'upstream timeout' }),
          { status: 504, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({ error: 'failed to reach relay' }),
        { status: 502, headers: { 'content-type': 'application/json' } }
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // OPTIONS handler for CORS pre-flight
  async function OPTIONS () {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': '*',
        'access-control-max-age': '86400',
      },
    });
  }

  return {
    GET: _handler,
    POST: _handler,
    PUT: _handler,
    PATCH: _handler,
    DELETE: _handler,
    OPTIONS,
  };
}

/* ========================================================================== */
/* 2. Middleware factory                                                        */
/* ========================================================================== */

/**
 * Creates a Next.js middleware function that proxies a path prefix upstream.
 *
 * Usage in middleware.js (project root):
 *
 *   import { createRelayMiddleware } from '@byok-relay/next';
 *   export const middleware = createRelayMiddleware({
 *     relayUrl: process.env.RELAY_URL,
 *     pathPrefix: '/relay',
 *   });
 *   export const config = { matcher: ['/relay/:path*'] };
 *
 * On Edge Runtime, RELAY_URL must be available as a public env var
 * (NEXT_PUBLIC_*) OR injected via the config option — process.env is
 * available on Edge in Next.js ≥13.4 for env vars referenced in code.
 *
 * @param {object}   opts
 * @param {string}   opts.relayUrl      Upstream relay base URL.
 * @param {string}   [opts.pathPrefix]  URL prefix to intercept (default /relay).
 * @param {string[]} [opts.allowedApps] Optional app_id allowlist.
 * @param {number}   [opts.timeoutMs]   Timeout ms (default 30 000).
 * @returns {Function} Next.js middleware function.
 */
function createRelayMiddleware ({
  relayUrl = process.env.RELAY_URL || DEFAULT_RELAY_URL,
  pathPrefix = '/relay',
  allowedApps,
  timeoutMs = 30_000,
} = {}) {
  const prefix = pathPrefix.replace(/\/$/, '');

  return async function relayMiddleware (request) {
    const url = new URL(request.url);

    // Only intercept requests under pathPrefix
    if (!url.pathname.startsWith(prefix)) {
      // Pass through (Next.js will handle normally)
      // Return undefined to continue
      return;
    }

    // Optional app_id gate
    if (allowedApps && allowedApps.length) {
      const appId =
        request.headers.get('x-app-id') ||
        url.searchParams.get('app_id');
      if (!appId || !allowedApps.includes(appId)) {
        return new Response(
          JSON.stringify({ error: 'app_id not allowed' }),
          { status: 403, headers: { 'content-type': 'application/json' } }
        );
      }
    }

    // Build upstream URL: strip the prefix and append the rest
    const subPath = url.pathname.slice(prefix.length) || '/';
    const upstreamUrl = relayUrl.replace(/\/$/, '') + subPath +
      (url.search ? url.search : '');

    const inHeaders = _filterHeaders(_headersToObject(request.headers));

    let body = undefined;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) {
      try { body = await request.arrayBuffer(); } catch (_) {}
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const upstreamResp = await fetch(upstreamUrl, {
        method: request.method,
        headers: inHeaders,
        body: body instanceof ArrayBuffer && body.byteLength > 0 ? body : undefined,
        signal: ac.signal,
      });

      const respHeaders = _filterHeaders(_headersToObject(upstreamResp.headers));
      return new Response(upstreamResp.body, {
        status: upstreamResp.status,
        headers: respHeaders,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return new Response(
          JSON.stringify({ error: 'upstream timeout' }),
          { status: 504, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({ error: 'failed to reach relay' }),
        { status: 502, headers: { 'content-type': 'application/json' } }
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

/* ========================================================================== */
/* 3. React hooks (for 'use client' components)                                */
/* ========================================================================== */

/**
 * Resolve React hooks — same shim pattern used across the package family.
 * Works with React 17/18, Next.js 13+ (App + Pages Router).
 */
function _hookShim () {
  return {
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial ?? null }),
    useCallback: (fn) => fn,
  };
}

function _hasActiveReactDispatcher (react) {
  const clientInternals = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  if (clientInternals && clientInternals.H) return true;

  const secretInternals = react.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  const dispatcher = secretInternals && secretInternals.ReactCurrentDispatcher;
  return Boolean(dispatcher && dispatcher.current);
}

function _getHooks () {
  try {
    const r = require('react');
    if (r && r.useState && r.useEffect && r.useRef && r.useCallback && _hasActiveReactDispatcher(r)) return r;
  } catch (_) {}
  // No-op shims for environments without an active React render dispatcher (tests, edge)
  return _hookShim();
}

/**
 * useByokRelay — register/manage a relay token + API keys.
 *
 * Point `relayUrl` at your own Next.js API route, not the upstream relay:
 *
 *   // Client component
 *   'use client';
 *   import { useByokRelay } from '@byok-relay/next';
 *   const { token, registerUser, storeKey, listKeys, deleteKey, logout } =
 *     useByokRelay({ relayUrl: '/api/relay', appId: 'my-app' });
 *
 * @param {object}  opts
 * @param {string}  opts.relayUrl  Your Next.js API route prefix (e.g. /api/relay).
 * @param {string}  [opts.appId]   Application identifier.
 * @returns {{ token, loading, error, registerUser, storeKey, listKeys, deleteKey, rotateKey, logout }}
 */
function useByokRelay ({ relayUrl = '/api/relay', appId = 'next-app' } = {}) {
  const React = _getHooks();
  const [token, setToken] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);

  const TOKEN_KEY = `byok_token_${appId}`;
  const base = relayUrl.replace(/\/$/, '');

  React.useEffect(() => {
    const stored = _safeGet(TOKEN_KEY);
    if (stored) setToken(stored);
  }, []);

  const registerUser = React.useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const resp = await fetch(`${base}/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: appId }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'registration failed');
      _safeSet(TOKEN_KEY, data.token);
      setToken(data.token);
      return data.token;
    } catch (e) { setError(e.message); throw e; }
    finally { setLoading(false); }
  }, [base, appId]);

  const storeKey = React.useCallback(async (provider, apiKey) => {
    if (!token) throw new Error('not registered');
    const resp = await fetch(`${base}/keys/${provider}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ api_key: apiKey }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'store key failed');
    return data;
  }, [base, token]);

  const listKeys = React.useCallback(async () => {
    if (!token) return [];
    const resp = await fetch(`${base}/keys`, {
      headers: { 'authorization': `Bearer ${token}` },
    });
    const data = await resp.json();
    return data.providers || data.keys || [];
  }, [base, token]);

  const deleteKey = React.useCallback(async (provider) => {
    if (!token) throw new Error('not registered');
    const resp = await fetch(`${base}/keys/${provider}`, {
      method: 'DELETE',
      headers: { 'authorization': `Bearer ${token}` },
    });
    return resp.json();
  }, [base, token]);

  const rotateKey = React.useCallback(async (provider, newKey) => {
    if (!token) throw new Error('not registered');
    const resp = await fetch(`${base}/keys/${provider}/rotate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ api_key: newKey }),
    });
    return resp.json();
  }, [base, token]);

  const logout = React.useCallback(() => {
    _safeRemove(TOKEN_KEY);
    setToken(null);
  }, []);

  return { token, loading, error, registerUser, storeKey, listKeys, deleteKey, rotateKey, logout };
}

/**
 * useChat — stateful non-streaming chat hook.
 *
 * @param {object}  opts
 * @param {string}  opts.relayUrl   Your Next.js API route prefix.
 * @param {string}  opts.token      Relay token (from useByokRelay).
 * @param {string}  [opts.model]    e.g. 'openai/gpt-4o' or 'anthropic/claude-3-5-sonnet-20241022'.
 * @param {string}  [opts.systemPrompt]
 * @param {object}  [opts.extraParams]  Additional body params forwarded to provider.
 * @returns {{ messages, sendMessage, clearMessages, loading, error }}
 */
function useChat ({
  relayUrl = '/api/relay',
  token,
  model = 'openai/gpt-4o',
  systemPrompt,
  extraParams = {},
} = {}) {
  const React = _getHooks();
  const [messages, setMessages] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);

  const base = relayUrl.replace(/\/$/, '');

  const sendMessage = React.useCallback(async (content) => {
    const userMsg = { role: 'user', content };
    const history = [...messages, userMsg];
    setMessages(history);
    setLoading(true); setError(null);

    const allMessages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...history]
      : history;

    try {
      const resp = await fetch(`${base}/relay`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ model, messages: allMessages, ...extraParams }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'relay request failed');
      const assistantContent =
        data.choices?.[0]?.message?.content ||
        data.content?.[0]?.text ||
        '';
      const updated = [...history, { role: 'assistant', content: assistantContent }];
      setMessages(updated);
      return assistantContent;
    } catch (e) {
      setMessages(history.slice(0, -1)); // rollback optimistic user message
      setError(e.message);
      throw e;
    } finally { setLoading(false); }
  }, [base, token, model, messages, systemPrompt, extraParams]);

  const clearMessages = React.useCallback(() => setMessages([]), []);

  return { messages, sendMessage, clearMessages, loading, error };
}

/**
 * useStreamingChat — SSE streaming chat hook.
 *
 * @param {object}  opts
 * @param {string}  opts.relayUrl      Your Next.js API route prefix.
 * @param {string}  opts.token         Relay token.
 * @param {string}  [opts.model]       Model string.
 * @param {string}  [opts.systemPrompt]
 * @param {object}  [opts.extraParams]
 * @returns {{ messages, streamingContent, sendMessage, stopStreaming, clearMessages, loading, error }}
 */
function useStreamingChat ({
  relayUrl = '/api/relay',
  token,
  model = 'openai/gpt-4o',
  systemPrompt,
  extraParams = {},
} = {}) {
  const React = _getHooks();
  const [messages, setMessages] = React.useState([]);
  const [streamingContent, setStreamingContent] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const abortRef = React.useRef(null);

  const base = relayUrl.replace(/\/$/, '');

  const stopStreaming = React.useCallback(() => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
  }, []);

  const sendMessage = React.useCallback(async (content) => {
    stopStreaming();
    const userMsg = { role: 'user', content };
    const history = [...messages, userMsg];
    setMessages(history);
    setStreamingContent('');
    setLoading(true); setError(null);

    const allMessages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...history]
      : history;

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const resp = await fetch(`${base}/relay`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ model, messages: allMessages, stream: true, ...extraParams }),
        signal: ac.signal,
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;
          try {
            const parsed = JSON.parse(raw);
            const delta =
              parsed.choices?.[0]?.delta?.content ||
              parsed.delta?.text || '';
            if (delta) {
              accumulated += delta;
              setStreamingContent(accumulated);
            }
          } catch (_) {}
        }
      }

      const finalMessages = [
        ...history,
        { role: 'assistant', content: accumulated },
      ];
      setMessages(finalMessages);
      setStreamingContent('');
      return accumulated;
    } catch (e) {
      if (e.name !== 'AbortError') {
        setMessages(messages); // revert
        setError(e.message);
        throw e;
      }
      // Committed partial content on abort
      if (streamingContent) {
        setMessages([...history, { role: 'assistant', content: streamingContent }]);
      } else {
        setMessages(messages);
      }
      setStreamingContent('');
    } finally {
      setLoading(false);
      if (abortRef.current === ac) abortRef.current = null;
    }
  }, [base, token, model, messages, systemPrompt, extraParams, streamingContent, stopStreaming]);

  const clearMessages = React.useCallback(() => {
    stopStreaming();
    setMessages([]);
    setStreamingContent('');
  }, [stopStreaming]);

  return { messages, streamingContent, sendMessage, stopStreaming, clearMessages, loading, error };
}

/**
 * useRelayHealth — polls the relay health endpoint.
 *
 * @param {object}  opts
 * @param {string}  opts.relayUrl    Your Next.js API route prefix.
 * @param {number}  [opts.intervalMs] Poll interval (default 60 000 ms; 0 = no auto-poll).
 * @returns {{ status, latencyMs, warnings, loading, error, refetch, check }}
 */
function useRelayHealth ({ relayUrl = '/api/relay', intervalMs = 60_000 } = {}) {
  const React = _getHooks();
  const [status, setStatus] = React.useState(null);
  const [latencyMs, setLatencyMs] = React.useState(null);
  const [warnings, setWarnings] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const intervalRef = React.useRef(null);

  const base = relayUrl.replace(/\/$/, '');

  const check = React.useCallback(async (deep = false) => {
    setLoading(true); setError(null);
    const t0 = Date.now();
    try {
      const url = `${base}/health${deep ? '?deep=1' : ''}`;
      const resp = await fetch(url);
      const ms = Date.now() - t0;
      const data = await resp.json().catch(() => ({}));
      setStatus(data.status || (resp.ok ? 'ok' : 'error'));
      setLatencyMs(ms);
      setWarnings(data.warnings || []);
      return { status: data.status, latencyMs: ms, warnings: data.warnings || [] };
    } catch (e) {
      setError(e.message);
      setStatus('error');
    } finally { setLoading(false); }
  }, [base]);

  const refetch = React.useCallback(() => check(false), [check]);

  React.useEffect(() => {
    refetch();
    if (intervalMs > 0) {
      intervalRef.current = setInterval(refetch, intervalMs);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refetch, intervalMs]);

  return { status, latencyMs, warnings, loading, error, refetch, check };
}

/* ========================================================================== */
/* 4. ByokRelayClient plain-JS class                                           */
/* ========================================================================== */

/**
 * ByokRelayClient — framework-agnostic client for BYOK relay.
 *
 * Safe in Server Components, Server Actions, API route handlers, middleware,
 * and browser scripts. Use a custom `storage` adapter when running on the
 * server (e.g. a cookies object, a session store).
 *
 * Usage in a Server Action:
 *
 *   'use server';
 *   import { ByokRelayClient } from '@byok-relay/next';
 *   const client = new ByokRelayClient({
 *     relayUrl: process.env.RELAY_URL,  // direct relay, server-only
 *     storage: cookieStorage,           // custom adapter
 *   });
 *
 * Usage in a browser script:
 *
 *   import { ByokRelayClient } from '@byok-relay/next';
 *   const client = new ByokRelayClient({ relayUrl: '/api/relay' });
 *   const token = await client.ensureToken('my-app');
 *
 * @param {object}  opts
 * @param {string}  opts.relayUrl  Relay base URL (or Next.js API route prefix).
 * @param {object}  [opts.storage] Custom storage adapter: { getItem, setItem, removeItem }.
 */
class ByokRelayClient {
  constructor ({ relayUrl = DEFAULT_RELAY_URL, storage } = {}) {
    this._base = relayUrl.replace(/\/$/, '');
    this._storage = storage || {
      getItem: (k) => _safeGet(k),
      setItem: (k, v) => _safeSet(k, v),
      removeItem: (k) => _safeRemove(k),
    };
    this._token = null;
  }

  _tokenKey (appId) { return `byok_token_${appId}`; }

  /** Register a new user and return their relay token. Stores it in storage. */
  async register (appId = 'next-client') {
    const resp = await fetch(`${this._base}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'registration failed');
    this._storage.setItem(this._tokenKey(appId), data.token);
    this._token = data.token;
    return data.token;
  }

  /** Get stored token or register a new one. */
  async ensureToken (appId = 'next-client') {
    if (this._token) return this._token;
    const stored = this._storage.getItem(this._tokenKey(appId));
    if (stored) { this._token = stored; return stored; }
    return this.register(appId);
  }

  /** Revoke the current token and remove from storage. */
  logout (appId = 'next-client') {
    this._storage.removeItem(this._tokenKey(appId));
    this._token = null;
  }

  /** Store an API key for a provider. */
  async storeKey (provider, apiKey) {
    if (!this._token) throw new Error('call ensureToken() first');
    const resp = await fetch(`${this._base}/keys/${provider}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this._token}`,
      },
      body: JSON.stringify({ api_key: apiKey }),
    });
    return resp.json();
  }

  /** List stored provider keys. */
  async listKeys () {
    if (!this._token) return [];
    const resp = await fetch(`${this._base}/keys`, {
      headers: { 'authorization': `Bearer ${this._token}` },
    });
    const data = await resp.json();
    return data.providers || data.keys || [];
  }

  /** Delete a provider key. */
  async deleteKey (provider) {
    if (!this._token) throw new Error('call ensureToken() first');
    const resp = await fetch(`${this._base}/keys/${provider}`, {
      method: 'DELETE',
      headers: { 'authorization': `Bearer ${this._token}` },
    });
    return resp.json();
  }

  /** Atomic key rotation: validate new key → replace old. */
  async rotateKey (provider, newApiKey) {
    if (!this._token) throw new Error('call ensureToken() first');
    const resp = await fetch(`${this._base}/keys/${provider}/rotate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this._token}`,
      },
      body: JSON.stringify({ api_key: newApiKey }),
    });
    return resp.json();
  }

  /** Low-level relay request. Returns a fetch Response. */
  async relayRequest (method, path, body, extraHeaders = {}) {
    if (!this._token) throw new Error('call ensureToken() first');
    return fetch(`${this._base}${path}`, {
      method: method.toUpperCase(),
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this._token}`,
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * Unified chat (non-streaming).
   * Accepts model in 'provider/model' format (e.g. 'openai/gpt-4o').
   */
  async chat ({ model = 'openai/gpt-4o', messages, systemPrompt, ...rest }) {
    const allMessages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;
    const resp = await this.relayRequest('POST', '/relay', {
      model, messages: allMessages, ...rest,
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'chat failed');
    return data.choices?.[0]?.message?.content || data.content?.[0]?.text || '';
  }

  /**
   * Streaming chat — async generator yielding text deltas.
   *
   *   for await (const delta of client.streamChat({ model, messages })) {
   *     process.stdout.write(delta);
   *   }
   */
  async * streamChat ({ model = 'openai/gpt-4o', messages, systemPrompt, signal, ...rest }) {
    const allMessages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;

    if (!this._token) throw new Error('call ensureToken() first');
    const resp = await fetch(`${this._base}/relay`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this._token}`,
      },
      body: JSON.stringify({ model, messages: allMessages, stream: true, ...rest }),
      signal,
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') return;
          try {
            const parsed = JSON.parse(raw);
            const delta =
              parsed.choices?.[0]?.delta?.content ||
              parsed.delta?.text || '';
            if (delta) yield delta;
          } catch (_) {}
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** GET /health — liveness check. */
  async health (deep = false) {
    const resp = await fetch(`${this._base}/health${deep ? '?deep=1' : ''}`);
    return resp.json();
  }

  /** GET /stats — per-user or operator aggregate. */
  async stats (appId) {
    if (!this._token) throw new Error('call ensureToken() first');
    const path = appId ? `/stats/${appId}` : '/stats';
    const resp = await fetch(`${this._base}${path}`, {
      headers: { 'authorization': `Bearer ${this._token}` },
    });
    return resp.json();
  }

  /** GET /models — available model list (when ALLOWED_MODELS configured). */
  async getModels () {
    const resp = await fetch(`${this._base}/models`);
    return resp.json();
  }

  /** DELETE /users — full account erasure (GDPR Art. 17). */
  async deleteAccount () {
    if (!this._token) throw new Error('call ensureToken() first');
    const resp = await fetch(`${this._base}/users`, {
      method: 'DELETE',
      headers: { 'authorization': `Bearer ${this._token}` },
    });
    this._token = null;
    return resp.json();
  }
}

/* ========================================================================== */
/* Exports                                                                     */
/* ========================================================================== */

module.exports = {
  // Route handler factory
  createRelayRouteHandler,
  // Middleware factory
  createRelayMiddleware,
  // React hooks ('use client' components)
  useByokRelay,
  useChat,
  useStreamingChat,
  useRelayHealth,
  // Plain-JS client (server + browser)
  ByokRelayClient,
};

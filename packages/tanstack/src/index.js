/**
 * @byok-relay/tanstack
 * TanStack Start API route factory, server function adapter, and React hooks for BYOK AI relay.
 *
 * Four distinct concerns:
 *
 *   1. createByokRelayAPIRoute(opts)
 *      Returns an HTTP method handler map for use with TanStack Start's
 *      createAPIFileRoute('/api/relay/$')({ GET, POST, ... }) pattern.
 *      RELAY_URL reads from process.env on the server — never in the browser bundle.
 *      The browser calls your own /api/relay route, which proxies to the upstream relay.
 *
 *   2. createRelayServerFnHandler(opts)
 *      Returns an async function body for use inside TanStack Start's
 *      createServerFn().handler(fn) pattern.
 *      Use when you want typed relay calls from client components via server functions.
 *
 *   3. React hooks (useByokRelay, useChat, useStreamingChat, useRelayHealth)
 *      TanStack Start compatible React hooks for <script>-setup components.
 *      Point relayUrl at your own /api/relay route, not the upstream relay.
 *      Works with TanStack Router's loaderDeps and route context.
 *
 *   4. ByokRelayClient plain-JS class
 *      Framework-agnostic — safe in server functions, loaders, middleware,
 *      and browser scripts. Accepts a custom storage adapter.
 *
 * Node 18+ required on the server side; Vinxi Edge Runtime compatible.
 */

'use strict';

/* ========================================================================== */
/* Constants                                                                   */
/* ========================================================================== */

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
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

function _buildStorage (custom) {
  if (custom) return custom;
  return {
    getItem    : _safeGet,
    setItem    : _safeSet,
    removeItem : _safeRemove,
  };
}

function _filterHeaders (headers) {
  if (!headers) return {};
  const out = {};
  const entries = typeof headers.entries === 'function'
    ? headers.entries()
    : Object.entries(headers);
  for (const [k, v] of entries) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function _resolveRelayUrl (opts = {}) {
  // Server-side: prefer process.env.RELAY_URL; fall back to opts.relayUrl
  if (typeof process !== 'undefined' && process.env && process.env.RELAY_URL) {
    return process.env.RELAY_URL.replace(/\/$/, '');
  }
  return (opts.relayUrl || DEFAULT_RELAY_URL).replace(/\/$/, '');
}

/* ========================================================================== */
/* 1. createByokRelayAPIRoute                                                  */
/* ========================================================================== */

/**
 * Factory for TanStack Start API file route handlers.
 *
 * Usage in app/routes/api/relay.$.ts (or app/routes/api/relay.$.js):
 *
 *   import { createAPIFileRoute } from '@tanstack/start/api';
 *   import { createByokRelayAPIRoute } from '@byok-relay/tanstack';
 *
 *   export const APIRoute = createAPIFileRoute('/api/relay/$')({
 *     ...createByokRelayAPIRoute(),
 *   });
 *
 * Options:
 *   relayUrl      {string}   Upstream relay URL. Defaults to process.env.RELAY_URL.
 *   allowedAppIds {string[]} Optional app_id allowlist.
 *   timeoutMs     {number}   Abort timeout in ms (default 30_000).
 */
function createByokRelayAPIRoute (opts = {}) {
  const timeoutMs    = opts.timeoutMs    ?? 30_000;
  const allowedApps  = opts.allowedAppIds ? new Set(opts.allowedAppIds) : null;

  async function handle ({ request, params }) {
    const relayUrl = _resolveRelayUrl(opts);

    // TanStack Start wildcard param is `params['$']` (or `params['*']` depending on file name)
    const wildcard  = params['$'] || params['*'] || params.path || '';
    const upstream  = `${relayUrl}/${wildcard}`;

    // Optional app_id check via x-app-id header
    if (allowedApps) {
      const appId = request.headers.get('x-app-id') || '';
      if (!allowedApps.has(appId)) {
        return new Response(JSON.stringify({ error: 'App not allowed' }), {
          status  : 403,
          headers : { 'content-type': 'application/json' },
        });
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Forward filtered headers
      const inHeaders = _filterHeaders(request.headers);
      const outHeaders = new Headers(inHeaders);

      // Forward body for methods that have one
      const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase());
      const body    = hasBody ? request.body : undefined;

      const upstream_res = await fetch(upstream, {
        method  : request.method,
        headers : outHeaders,
        body,
        signal  : controller.signal,
        duplex  : 'half',  // required for streaming request bodies in Node 18+
      }).catch(err => {
        if (err.name === 'AbortError') {
          return new Response(JSON.stringify({ error: 'Gateway timeout' }), {
            status  : 504,
            headers : { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: 'Failed to reach relay' }), {
          status  : 502,
          headers : { 'content-type': 'application/json' },
        });
      });

      // Pipe through response with filtered headers
      const resHeaders = new Headers(_filterHeaders(upstream_res.headers));
      return new Response(upstream_res.body, {
        status  : upstream_res.status,
        headers : resHeaders,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // Return all HTTP methods — TanStack Start createAPIFileRoute accepts a method map
  return {
    GET    : handle,
    POST   : handle,
    PUT    : handle,
    PATCH  : handle,
    DELETE : handle,
    OPTIONS: handle,
    HEAD   : handle,
  };
}

/* ========================================================================== */
/* 2. createRelayServerFnHandler                                               */
/* ========================================================================== */

/**
 * Returns an async handler body for TanStack Start's createServerFn().handler().
 *
 * Usage:
 *   import { createServerFn } from '@tanstack/react-start/server';
 *   import { createRelayServerFnHandler } from '@byok-relay/tanstack';
 *
 *   export const relayFn = createServerFn({ method: 'POST' })
 *     .validator(z.object({ path: z.string(), token: z.string(), body: z.any().optional() }))
 *     .handler(createRelayServerFnHandler());
 *
 * The handler receives { data: { path, token, body } } from TanStack Start's
 * validated input and returns the upstream relay JSON response.
 *
 * Options:
 *   relayUrl  {string} Upstream relay URL. Defaults to process.env.RELAY_URL.
 *   timeoutMs {number} Abort timeout in ms (default 30_000).
 */
function createRelayServerFnHandler (opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return async function handler (ctx) {
    const relayUrl = _resolveRelayUrl(opts);
    // ctx.data is the validated input from .validator()
    const { path, token, method = 'POST', body, contentType } = ctx.data || ctx;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers = { 'content-type': contentType || 'application/json' };
    if (token) headers['x-relay-token'] = token;

    try {
      const upstream_res = await fetch(`${relayUrl}/${path.replace(/^\//, '')}`, {
        method  : method.toUpperCase(),
        headers,
        body    : body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        signal  : controller.signal,
      });

      const ct = upstream_res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        return upstream_res.json();
      }
      return { _text: await upstream_res.text(), _status: upstream_res.status };
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Relay request timed out');
      throw new Error('Failed to reach relay');
    } finally {
      clearTimeout(timer);
    }
  };
}

/* ========================================================================== */
/* 3. React Hooks                                                              */
/* ========================================================================== */

/**
 * Resolve React hooks. Compatible with React 18+.
 * Works without React installed (plain JS shim for testing).
 */
function _getReact () {
  try {
    return require('react');
  } catch (_) {
    // Minimal shim for environments without React
    const _state = new Map();
    let _id = 0;
    return {
      useState  : (init) => {
        const id  = _id++;
        if (!_state.has(id)) _state.set(id, typeof init === 'function' ? init() : init);
        return [_state.get(id), (v) => _state.set(id, v)];
      },
      useRef    : (init) => ({ current: init }),
      useEffect : () => {},
      useCallback: (fn) => fn,
    };
  }
}

/**
 * useByokRelay — token registration, key CRUD, and logout.
 *
 * @param {object} opts
 * @param {string} opts.relayUrl    Local proxy route URL, e.g. '/api/relay' (default).
 * @param {string} [opts.appId]    Optional app_id header for operator filtering.
 * @param {object} [opts.storage]  Custom storage adapter (getItem/setItem/removeItem).
 */
function useByokRelay (opts = {}) {
  const React    = _getReact();
  const relayUrl = (opts.relayUrl || '/api/relay').replace(/\/$/, '');
  const storage  = _buildStorage(opts.storage);

  const [token,   setToken]   = React.useState(() => storage.getItem('byok_relay_token'));
  const [keys,    setKeys]    = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error,   setError]   = React.useState(null);

  function _headers (extra = {}) {
    const h = { 'content-type': 'application/json', ...extra };
    if (opts.appId) h['x-app-id'] = opts.appId;
    if (token) h['x-relay-token'] = token;
    return h;
  }

  const register = React.useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res  = await fetch(`${relayUrl}/users`, {
        method : 'POST',
        headers: _headers(),
        body   : JSON.stringify({ app_id: opts.appId || 'tanstack-app' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');
      storage.setItem('byok_relay_token', data.token);
      setToken(data.token);
      return data.token;
    } catch (e) { setError(e.message); throw e; } finally { setLoading(false); }
  }, [relayUrl, opts.appId, token]);

  const ensureToken = React.useCallback(async () => {
    if (token) return token;
    return register();
  }, [token, register]);

  const storeKey = React.useCallback(async (provider, apiKey) => {
    const t = await ensureToken();
    setLoading(true); setError(null);
    try {
      const res  = await fetch(`${relayUrl}/keys/${provider}`, {
        method : 'POST',
        headers: { ...(_headers()), 'x-relay-token': t },
        body   : JSON.stringify({ api_key: apiKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to store key');
      await listKeys();
      return data;
    } catch (e) { setError(e.message); throw e; } finally { setLoading(false); }
  }, [relayUrl, ensureToken]);

  const listKeys = React.useCallback(async () => {
    if (!token) return [];
    try {
      const res  = await fetch(`${relayUrl}/keys`, { headers: _headers() });
      const data = await res.json();
      const list = data.keys || [];
      setKeys(list);
      return list;
    } catch (_) { return []; }
  }, [relayUrl, token]);

  const deleteKey = React.useCallback(async (provider) => {
    setLoading(true); setError(null);
    try {
      const res  = await fetch(`${relayUrl}/keys/${provider}`, {
        method : 'DELETE',
        headers: _headers(),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed to delete key'); }
      await listKeys();
    } catch (e) { setError(e.message); throw e; } finally { setLoading(false); }
  }, [relayUrl, token, listKeys]);

  const rotateKey = React.useCallback(async (provider, newApiKey) => {
    setLoading(true); setError(null);
    try {
      const res  = await fetch(`${relayUrl}/keys/${provider}/rotate`, {
        method : 'POST',
        headers: _headers(),
        body   : JSON.stringify({ api_key: newApiKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to rotate key');
      return data;
    } catch (e) { setError(e.message); throw e; } finally { setLoading(false); }
  }, [relayUrl, token]);

  const logout = React.useCallback(() => {
    storage.removeItem('byok_relay_token');
    setToken(null);
    setKeys([]);
  }, []);

  React.useEffect(() => {
    if (token) listKeys();
  }, [token]);

  return { token, keys, loading, error, register, ensureToken, storeKey, listKeys, deleteKey, rotateKey, logout };
}

/**
 * useChat — stateful non-streaming chat.
 *
 * @param {object} opts
 * @param {string} opts.relayUrl     Local proxy route URL (default '/api/relay').
 * @param {string} opts.model        Model string, e.g. 'openai/gpt-4o-mini'.
 * @param {string} [opts.token]      Relay token (or use ensureToken from useByokRelay).
 * @param {string} [opts.systemPrompt]
 * @param {object} [opts.extraParams] Extra params forwarded to the provider.
 */
function useChat (opts = {}) {
  const React       = _getReact();
  const relayUrl    = (opts.relayUrl || '/api/relay').replace(/\/$/, '');
  const model       = opts.model || 'openai/gpt-4o-mini';

  const [messages,  setMessages]  = React.useState([]);
  const [loading,   setLoading]   = React.useState(false);
  const [error,     setError]     = React.useState(null);

  const sendMessage = React.useCallback(async (content, tokenOverride) => {
    const token = tokenOverride || opts.token;
    const userMsg = { role: 'user', content };
    const next    = [...messages, userMsg];
    setMessages(next); setLoading(true); setError(null);

    try {
      const body = {
        model,
        messages: opts.systemPrompt
          ? [{ role: 'system', content: opts.systemPrompt }, ...next]
          : next,
        ...(opts.extraParams || {}),
      };
      const res  = await fetch(`${relayUrl}/relay`, {
        method : 'POST',
        headers: {
          'content-type' : 'application/json',
          'x-relay-token': token || '',
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Chat failed');
      const reply = data.choices?.[0]?.message || data.content?.[0] || { role: 'assistant', content: '' };
      const assistantMsg = { role: 'assistant', content: reply.content || reply.text || '' };
      setMessages(prev => [...prev, assistantMsg]);
      return assistantMsg;
    } catch (e) {
      setMessages(messages); // rollback
      setError(e.message);
      throw e;
    } finally {
      setLoading(false);
    }
  }, [relayUrl, model, messages, opts.token, opts.systemPrompt, opts.extraParams]);

  const clearMessages = React.useCallback(() => setMessages([]), []);

  return { messages, loading, error, sendMessage, clearMessages };
}

/**
 * useStreamingChat — SSE streaming chat with AbortController cancellation.
 *
 * @param {object} opts
 * @param {string} opts.relayUrl   Local proxy route URL (default '/api/relay').
 * @param {string} opts.model      Model string.
 * @param {string} [opts.token]    Relay token.
 * @param {string} [opts.systemPrompt]
 * @param {object} [opts.extraParams]
 */
function useStreamingChat (opts = {}) {
  const React        = _getReact();
  const relayUrl     = (opts.relayUrl || '/api/relay').replace(/\/$/, '');
  const model        = opts.model || 'openai/gpt-4o-mini';

  const [messages,         setMessages]         = React.useState([]);
  const [streamingContent, setStreamingContent] = React.useState('');
  const [isStreaming,      setIsStreaming]       = React.useState(false);
  const [error,            setError]             = React.useState(null);
  const abortRef = React.useRef(null);

  const sendMessage = React.useCallback(async (content, tokenOverride) => {
    const token   = tokenOverride || opts.token;
    const userMsg = { role: 'user', content };
    const next    = [...messages, userMsg];
    setMessages(next);
    setStreamingContent('');
    setIsStreaming(true);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const body = {
        model,
        messages: opts.systemPrompt
          ? [{ role: 'system', content: opts.systemPrompt }, ...next]
          : next,
        stream: true,
        ...(opts.extraParams || {}),
      };
      const res = await fetch(`${relayUrl}/relay`, {
        method : 'POST',
        headers: {
          'content-type' : 'application/json',
          'x-relay-token': token || '',
        },
        body  : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Stream failed (${res.status})`);
      }

      const reader  = res.body.getReader();
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
          if (raw === '[DONE]') break;
          try {
            const parsed = JSON.parse(raw);
            const delta  = parsed.choices?.[0]?.delta?.content
              ?? parsed.delta?.text
              ?? '';
            if (delta) {
              accumulated += delta;
              setStreamingContent(accumulated);
            }
          } catch (_) { /* non-JSON SSE line */ }
        }
      }

      const assistantMsg = { role: 'assistant', content: accumulated };
      setMessages(prev => [...prev, assistantMsg]);
      setStreamingContent('');
      return assistantMsg;
    } catch (e) {
      if (e.name === 'AbortError') {
        // Partial commit on stop
        if (streamingContent) {
          setMessages(prev => [...prev, { role: 'assistant', content: streamingContent + ' [stopped]' }]);
          setStreamingContent('');
        }
      } else {
        setMessages(messages);
        setError(e.message);
        throw e;
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [relayUrl, model, messages, opts.token, opts.systemPrompt, opts.extraParams, streamingContent]);

  const stopStreaming = React.useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  const clearMessages = React.useCallback(() => {
    setMessages([]);
    setStreamingContent('');
  }, []);

  return { messages, streamingContent, isStreaming, error, sendMessage, stopStreaming, clearMessages };
}

/**
 * useRelayHealth — polls /health and provides a readiness check.
 *
 * @param {object} opts
 * @param {string}  opts.relayUrl    Local proxy route URL (default '/api/relay').
 * @param {number}  [opts.intervalMs] Auto-poll interval ms (default: no auto-poll).
 */
function useRelayHealth (opts = {}) {
  const React    = _getReact();
  const relayUrl = (opts.relayUrl || '/api/relay').replace(/\/$/, '');

  const [status,  setStatus]  = React.useState('unknown'); // 'ok' | 'degraded' | 'unknown'
  const [details, setDetails] = React.useState(null);
  const timerRef = React.useRef(null);

  const check = React.useCallback(async (deep = false) => {
    try {
      const url = deep ? `${relayUrl}/health?deep=1` : `${relayUrl}/health`;
      const res  = await fetch(url);
      const data = await res.json().catch(() => ({}));
      setStatus(res.ok ? 'ok' : 'degraded');
      setDetails(data);
      return data;
    } catch (_) {
      setStatus('degraded');
      setDetails(null);
    }
  }, [relayUrl]);

  const startPolling = React.useCallback((intervalMs = opts.intervalMs || 30_000) => {
    check();
    timerRef.current = setInterval(() => check(), intervalMs);
  }, [check, opts.intervalMs]);

  const stopPolling = React.useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  React.useEffect(() => {
    check();
    if (opts.intervalMs) {
      timerRef.current = setInterval(() => check(), opts.intervalMs);
      return () => stopPolling();
    }
  }, []);

  return { status, details, check, startPolling, stopPolling };
}

/* ========================================================================== */
/* 4. ByokRelayClient                                                          */
/* ========================================================================== */

/**
 * ByokRelayClient — plain JS class for use in TanStack Start server functions,
 * loaders, middleware, and browser scripts.
 *
 * @param {object} opts
 * @param {string} opts.relayUrl   Relay URL (server: process.env.RELAY_URL; browser: '/api/relay').
 * @param {string} [opts.appId]    Optional app_id.
 * @param {object} [opts.storage]  Custom storage adapter.
 */
class ByokRelayClient {
  constructor (opts = {}) {
    this._relayUrl = _resolveRelayUrl(opts);
    this._appId    = opts.appId || null;
    this._storage  = _buildStorage(opts.storage);
    this._token    = this._storage.getItem('byok_relay_token');
  }

  _headers (extra = {}) {
    const h = { 'content-type': 'application/json', ...extra };
    if (this._appId) h['x-app-id'] = this._appId;
    if (this._token) h['x-relay-token'] = this._token;
    return h;
  }

  async register () {
    const res  = await fetch(`${this._relayUrl}/users`, {
      method : 'POST',
      headers: this._headers(),
      body   : JSON.stringify({ app_id: this._appId || 'tanstack-app' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    this._token = data.token;
    this._storage.setItem('byok_relay_token', data.token);
    return data;
  }

  async ensureToken () {
    if (this._token) return this._token;
    const data = await this.register();
    return data.token;
  }

  logout () {
    this._token = null;
    this._storage.removeItem('byok_relay_token');
  }

  async storeKey (provider, apiKey) {
    await this.ensureToken();
    const res  = await fetch(`${this._relayUrl}/keys/${provider}`, {
      method : 'POST',
      headers: this._headers(),
      body   : JSON.stringify({ api_key: apiKey }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to store key');
    return data;
  }

  async listKeys () {
    const res  = await fetch(`${this._relayUrl}/keys`, { headers: this._headers() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to list keys');
    return data.keys || [];
  }

  async deleteKey (provider) {
    const res  = await fetch(`${this._relayUrl}/keys/${provider}`, {
      method : 'DELETE',
      headers: this._headers(),
    });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed to delete key'); }
    return true;
  }

  async rotateKey (provider, newApiKey) {
    const res  = await fetch(`${this._relayUrl}/keys/${provider}/rotate`, {
      method : 'POST',
      headers: this._headers(),
      body   : JSON.stringify({ api_key: newApiKey }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to rotate key');
    return data;
  }

  async relayRequest (path, options = {}) {
    await this.ensureToken();
    const res = await fetch(`${this._relayUrl}/${path.replace(/^\//, '')}`, {
      method : options.method || 'POST',
      headers: this._headers(options.headers || {}),
      body   : options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
      signal : options.signal,
    });
    return res;
  }

  async chat (options = {}) {
    const { model, messages, systemPrompt, extraParams, signal } = options;
    const fullMessages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...(messages || [])]
      : (messages || []);
    const res  = await this.relayRequest('/relay', {
      body  : { model, messages: fullMessages, ...(extraParams || {}) },
      signal,
    });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error || `Chat failed (${res.status})`); }
    return res.json();
  }

  async * streamChat (options = {}) {
    const { model, messages, systemPrompt, extraParams, signal } = options;
    const fullMessages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...(messages || [])]
      : (messages || []);
    const res = await this.relayRequest('/relay', {
      body  : { model, messages: fullMessages, stream: true, ...(extraParams || {}) },
      signal,
    });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error || `Stream failed (${res.status})`); }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
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
          const delta  = parsed.choices?.[0]?.delta?.content ?? parsed.delta?.text ?? '';
          if (delta) { accumulated += delta; yield delta; }
        } catch (_) {}
      }
    }
  }

  async health (deep = false) {
    const url = deep ? `${this._relayUrl}/health?deep=1` : `${this._relayUrl}/health`;
    const res  = await fetch(url);
    return res.json();
  }

  async stats (appId) {
    const path = appId ? `/stats/${appId}` : '/stats';
    const res  = await fetch(`${this._relayUrl}${path}`, { headers: this._headers() });
    return res.json();
  }

  async getModels () {
    const res = await fetch(`${this._relayUrl}/models`);
    return res.json();
  }

  async deleteAccount () {
    const res = await fetch(`${this._relayUrl}/users`, {
      method : 'DELETE',
      headers: this._headers(),
    });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed to delete account'); }
    this.logout();
    return true;
  }
}

/* ========================================================================== */
/* Exports                                                                     */
/* ========================================================================== */

module.exports = {
  createByokRelayAPIRoute,
  createRelayServerFnHandler,
  useByokRelay,
  useChat,
  useStreamingChat,
  useRelayHealth,
  ByokRelayClient,
};

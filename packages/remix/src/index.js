/**
 * @byok-relay/remix
 * Remix v2 / React Router v7 integration for BYOK AI relay.
 *
 * Four distinct concerns:
 *
 *   1. Server-side loader factory (createRelayLoader)
 *      Returns a Remix `LoaderFunction` that proxies GET requests to the
 *      upstream relay. RELAY_URL is read server-side only; never ships to the
 *      browser bundle.
 *
 *   2. Server-side action factory (createRelayAction)
 *      Returns a Remix `ActionFunction` that handles POST/PUT/PATCH/DELETE
 *      relay calls server-to-server.
 *
 *   3. React hooks (useByokRelay, useChat, useStreamingChat, useRelayHealth)
 *      Client-side React hooks identical in API to @byok-relay/react, but
 *      designed for use with Remix's client-side hydration model. Use the
 *      same-origin relay route (for example `/api/relay`).
 *
 *   4. ByokRelayClient plain-JS class
 *      Framework-agnostic client, safe in both Remix loaders (server) and
 *      Remix <script> blocks (browser). No Node-only APIs.
 *
 * Peer dependency: react >=17 (optional — hooks are no-ops without it).
 * Node 18+ required for server-side loader/action fetch.
 */

'use strict';

/* ========================================================================== */
/* Constants                                                                   */
/* ========================================================================== */

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';
const DEFAULT_PROXY_TIMEOUT_MS = 30_000;
const REGISTRATION_IN_FLIGHT = new Map();

/* ========================================================================== */
/* Utility                                                                     */
/* ========================================================================== */

function _isClient () {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  } catch (_) {
    return false;
  }
}

function _timeoutSignal (timeoutMs) {
  if (!timeoutMs || typeof AbortSignal === 'undefined') return undefined;
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

function _isTimeoutError (err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

function _proxyErrorResponse (err) {
  const timedOut = _isTimeoutError(err);
  return new Response(JSON.stringify({ error: timedOut ? 'relay timeout' : 'relay unreachable' }), {
    status: timedOut ? 504 : 502,
    headers: { 'Content-Type': 'application/json' },
  });
}

function _responseHeaders (headers) {
  const responseHeaders = {};
  headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase())) responseHeaders[k] = v;
  });
  return responseHeaders;
}

function _forceReactShim () {
  return typeof process !== 'undefined' && process.env?.BYOK_RELAY_FORCE_REACT_SHIM === '1';
}

function _getRegistrationEntry (storageKey, relayUrl, appId) {
  let entry = REGISTRATION_IN_FLIGHT.get(storageKey);
  if (!entry) {
    const controller = new AbortController();
    entry = {
      controller,
      consumers: 0,
      settled: false,
      abortTimer: null,
    };
    entry.promise = fetch(`${relayUrl}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(appId ? { 'x-app-id': appId } : {}) },
      body: JSON.stringify({ app_id: appId || 'remix-app' }),
      signal: controller.signal,
    })
      .then(r => r.json())
      .finally(() => {
        entry.settled = true;
        if (entry.abortTimer) clearTimeout(entry.abortTimer);
        REGISTRATION_IN_FLIGHT.delete(storageKey);
      });
    REGISTRATION_IN_FLIGHT.set(storageKey, entry);
  }
  if (entry.abortTimer) {
    clearTimeout(entry.abortTimer);
    entry.abortTimer = null;
  }
  entry.consumers++;
  return entry;
}

function _releaseRegistrationEntry (storageKey, entry) {
  entry.consumers = Math.max(0, entry.consumers - 1);
  if (entry.consumers === 0 && !entry.settled) {
    entry.abortTimer = setTimeout(() => {
      if (entry.consumers === 0 && !entry.settled) {
        entry.controller.abort();
        REGISTRATION_IN_FLIGHT.delete(storageKey);
      }
    }, 0);
  }
}

function _sseLines (buffer, chunk) {
  const text = buffer + chunk;
  const lines = text.split('\n');
  return { lines, buffer: lines.pop() ?? '' };
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

/** Strip hop-by-hop headers before forwarding between server ↔ relay. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'content-length', // let fetch set it
  'host', // belongs to the app origin, not the relay origin
  'content-encoding', // fetch already decoded the upstream body
]);

function _filterHeaders (headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/* ========================================================================== */
/* 1. Server-side loader factory                                               */
/* ========================================================================== */

/**
 * Creates a Remix `LoaderFunction` that proxies GET requests to the relay.
 *
 * Usage in app/routes/api.relay.$.tsx (catch-all route):
 *
 *   import { createRelayLoader } from '@byok-relay/remix';
 *
 *   export const loader = createRelayLoader({
 *     relayUrl: process.env.RELAY_URL,   // server-only; never in browser bundle
 *   });
 *
 * The catch-all segment (`$`) maps to the relay sub-path.
 * e.g. GET /api/relay/health → relay GET /health
 *      GET /api/relay/models → relay GET /models
 *
 * @param {object} opts
 * @param {string}   opts.relayUrl       Upstream relay base URL.
 * @param {string[]} [opts.allowedApps]  Optional app_id allowlist.
 * @returns Remix LoaderFunction
 */
function createRelayLoader ({ relayUrl = DEFAULT_RELAY_URL, allowedApps, timeoutMs = DEFAULT_PROXY_TIMEOUT_MS } = {}) {
  return async function relayLoader ({ request, params }) {
    const subPath = params['*'] || '';
    const url = new URL(request.url);

    // app_id allowlist check
    if (allowedApps && allowedApps.length > 0) {
      const appId = url.searchParams.get('app_id') ||
        request.headers.get('x-app-id') || '';
      if (!allowedApps.includes(appId)) {
        return new Response(JSON.stringify({ error: 'app_id not allowed' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const targetUrl = `${relayUrl.replace(/\/$/, '')}/${subPath}${url.search}`;
    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        method: 'GET',
        headers: _filterHeaders(Object.fromEntries(request.headers.entries())),
        signal: _timeoutSignal(timeoutMs),
      });
    } catch (e) {
      return _proxyErrorResponse(e);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: _responseHeaders(upstream.headers),
    });
  };
}

/* ========================================================================== */
/* 2. Server-side action factory                                               */
/* ========================================================================== */

/**
 * Creates a Remix `ActionFunction` that proxies mutation requests to the relay.
 *
 * Usage in app/routes/api.relay.$.tsx (same catch-all route):
 *
 *   import { createRelayAction } from '@byok-relay/remix';
 *
 *   export const action = createRelayAction({
 *     relayUrl: process.env.RELAY_URL,
 *   });
 *
 * Supports POST, PUT, PATCH, DELETE.  The relay sub-path comes from the
 * catch-all param; the HTTP method is forwarded as-is.
 *
 * @param {object} opts
 * @param {string}   opts.relayUrl       Upstream relay base URL.
 * @param {string[]} [opts.allowedApps]  Optional app_id allowlist.
 * @returns Remix ActionFunction
 */
function createRelayAction ({ relayUrl = DEFAULT_RELAY_URL, allowedApps, timeoutMs = DEFAULT_PROXY_TIMEOUT_MS } = {}) {
  return async function relayAction ({ request, params }) {
    const subPath = params['*'] || '';
    const url = new URL(request.url);

    // app_id allowlist check
    if (allowedApps && allowedApps.length > 0) {
      const appId = url.searchParams.get('app_id') ||
        request.headers.get('x-app-id') || '';
      if (!allowedApps.includes(appId)) {
        return new Response(JSON.stringify({ error: 'app_id not allowed' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const targetUrl = `${relayUrl.replace(/\/$/, '')}/${subPath}${url.search}`;
    const bodyBuffer = await request.arrayBuffer();

    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        method: request.method,
        headers: _filterHeaders(Object.fromEntries(request.headers.entries())),
        body: bodyBuffer.byteLength > 0 ? bodyBuffer : undefined,
        signal: _timeoutSignal(timeoutMs),
      });
    } catch (e) {
      return _proxyErrorResponse(e);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: _responseHeaders(upstream.headers),
    });
  };
}

/* ========================================================================== */
/* 3. React hooks (client-side)                                               */
/* ========================================================================== */

/** Resolve React hooks — works with React 17/18/19 or a plain shim. */
function _resolveReactHooks () {
  if (!_forceReactShim()) {
    try {
      // eslint-disable-next-line global-require
      const r = require('react');
      if (r && r.useState) return r;
    } catch (_) {}
  }
  // Minimal shim for testing / non-React environments
  let _state = {};
  let _effects = [];
  return {
    useState: (init) => {
      const key = Math.random().toString(36).slice(2);
      _state[key] = typeof init === 'function' ? init() : init;
      const setter = (v) => { _state[key] = typeof v === 'function' ? v(_state[key]) : v; };
      return [_state[key], setter];
    },
    useEffect: (fn, _deps) => { _effects.push(fn); },
    useRef: (init) => ({ current: init }),
    useCallback: (fn) => fn,
  };
}

/* ------------------------------------------------------------------ */
/* useByokRelay                                                         */
/* ------------------------------------------------------------------ */

/**
 * Core hook — token registration, key CRUD, logout.
 *
 * @param {object} opts
 * @param {string} opts.relayUrl   Same-origin relay URL (for example `/api/relay`).
 * @param {string} [opts.appId]    Optional app identifier.
 * @returns {{ token, loading, error, storeKey, listKeys, deleteKey, rotateKey, logout }}
 */
function useByokRelay ({ relayUrl = DEFAULT_RELAY_URL, appId = '' } = {}) {
  const React = _resolveReactHooks();
  const { useState, useEffect, useCallback } = React;

  const normalizedRelayUrl = relayUrl.replace(/\/$/, '');
  const STORAGE_KEY = `byok_token_${normalizedRelayUrl}_${appId}`;
  const [token, setToken] = useState(() => _safeGet(STORAGE_KEY));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const _headers = useCallback(() => {
    const h = { 'Content-Type': 'application/json' };
    if (token) h['x-relay-token'] = token;
    if (appId) h['x-app-id'] = appId;
    return h;
  }, [token, appId]);

  // Auto-register if no token
  useEffect(() => {
    if (token) return;
    let cancelled = false;
    const entry = _getRegistrationEntry(STORAGE_KEY, normalizedRelayUrl, appId);
    setLoading(true);
    entry.promise
      .then(d => {
        if (cancelled) return;
        if (d.token) {
          _safeSet(STORAGE_KEY, d.token);
          setToken(d.token);
        } else {
          setError(d.error || 'Registration failed');
        }
      })
      .catch(e => {
        if (!cancelled && e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      _releaseRegistrationEntry(STORAGE_KEY, entry);
    };
  }, [normalizedRelayUrl, appId, STORAGE_KEY, token]);

  const storeKey = useCallback(async (provider, apiKey) => {
    if (!token) throw new Error('Not registered');
    const r = await fetch(`${normalizedRelayUrl}/keys/${provider}`, {
      method: 'POST',
      headers: _headers(),
      body: JSON.stringify({ key: apiKey }),
    });
    return r.json();
  }, [normalizedRelayUrl, token, _headers]);

  const listKeys = useCallback(async () => {
    if (!token) throw new Error('Not registered');
    const r = await fetch(`${normalizedRelayUrl}/keys`, { headers: _headers() });
    return r.json();
  }, [normalizedRelayUrl, token, _headers]);

  const deleteKey = useCallback(async (provider) => {
    if (!token) throw new Error('Not registered');
    const r = await fetch(`${normalizedRelayUrl}/keys/${provider}`, {
      method: 'DELETE',
      headers: _headers(),
    });
    return r.json();
  }, [normalizedRelayUrl, token, _headers]);

  const rotateKey = useCallback(async (provider, newApiKey) => {
    if (!token) throw new Error('Not registered');
    const r = await fetch(`${normalizedRelayUrl}/keys/${provider}/rotate`, {
      method: 'POST',
      headers: _headers(),
      body: JSON.stringify({ key: newApiKey }),
    });
    return r.json();
  }, [normalizedRelayUrl, token, _headers]);

  const logout = useCallback(() => {
    _safeRemove(STORAGE_KEY);
    setToken(null);
  }, [STORAGE_KEY]);

  return { token, loading, error, storeKey, listKeys, deleteKey, rotateKey, logout };
}

/* ------------------------------------------------------------------ */
/* useChat                                                              */
/* ------------------------------------------------------------------ */

/**
 * Non-streaming chat hook.
 *
 * @param {object} opts
 * @param {string} opts.relayUrl
 * @param {string} opts.token           Relay token from useByokRelay.
 * @param {string} [opts.provider]      openai | anthropic | groq | mistral | openrouter
 * @param {string} [opts.model]         Model name.
 * @param {string} [opts.systemPrompt]
 * @param {object} [opts.extraParams]
 * @returns {{ messages, send, clear, loading, error }}
 */
function useChat ({
  relayUrl = DEFAULT_RELAY_URL,
  token,
  provider = 'openai',
  model = 'gpt-4o-mini',
  systemPrompt,
  extraParams = {},
} = {}) {
  const { useState, useCallback } = _resolveReactHooks();
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const send = useCallback(async (userMessage) => {
    if (!token) { setError('No relay token'); return; }
    const newMessages = [...messages, { role: 'user', content: userMessage }];
    setMessages(newMessages);
    setLoading(true);
    setError(null);

    const body = {
      model,
      messages: systemPrompt
        ? [{ role: 'system', content: systemPrompt }, ...newMessages]
        : newMessages,
      ...extraParams,
    };

    try {
      const r = await fetch(`${relayUrl}/relay/${provider}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-relay-token': token },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const reply = data.choices?.[0]?.message?.content ||
                    data.content?.[0]?.text || '';
      setMessages(m => [...m, { role: 'assistant', content: reply }]);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [relayUrl, token, provider, model, systemPrompt, extraParams, messages]);

  const clear = useCallback(() => setMessages([]), []);

  return { messages, send, clear, loading, error };
}

/* ------------------------------------------------------------------ */
/* useStreamingChat                                                     */
/* ------------------------------------------------------------------ */

/**
 * Streaming chat hook (SSE).
 *
 * @param {object} opts — same shape as useChat
 * @returns {{ messages, streamingContent, send, stopStreaming, clear, loading, error }}
 */
function useStreamingChat ({
  relayUrl = DEFAULT_RELAY_URL,
  token,
  provider = 'openai',
  model = 'gpt-4o-mini',
  systemPrompt,
  extraParams = {},
} = {}) {
  const { useState, useRef, useCallback } = _resolveReactHooks();
  const [messages, setMessages] = useState([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const stopStreaming = useCallback(() => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
  }, []);

  const send = useCallback(async (userMessage) => {
    if (!token) { setError('No relay token'); return; }
    const newMessages = [...messages, { role: 'user', content: userMessage }];
    setMessages(newMessages);
    setLoading(true);
    setError(null);
    setStreamingContent('');

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let accumulated = '';

    const body = {
      model,
      messages: systemPrompt
        ? [{ role: 'system', content: systemPrompt }, ...newMessages]
        : newMessages,
      stream: true,
      ...extraParams,
    };

    try {
      const r = await fetch(`${relayUrl}/relay/${provider}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-relay-token': token },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!r.ok) {
        const errData = await r.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${r.status}`);
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const parsedChunk = _sseLines(buffer, chunk);
        buffer = parsedChunk.buffer;
        for (const line of parsedChunk.lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') {
            streamDone = true;
            break;
          }
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed.choices?.[0]?.delta?.content || '';
            if (delta) {
              accumulated += delta;
              setStreamingContent(accumulated);
            }
          } catch (_) {}
        }
        if (streamDone) break;
      }

      setMessages(m => [...m, { role: 'assistant', content: accumulated }]);
      setStreamingContent('');
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
      else if (accumulated) {
        // partial commit on abort
        setMessages(m => [...m, { role: 'assistant', content: accumulated }]);
        setStreamingContent('');
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [relayUrl, token, provider, model, systemPrompt, extraParams, messages]);

  const clear = useCallback(() => {
    stopStreaming();
    setMessages([]);
    setStreamingContent('');
  }, [stopStreaming]);

  return { messages, streamingContent, send, stopStreaming, clear, loading, error };
}

/* ------------------------------------------------------------------ */
/* useRelayHealth                                                       */
/* ------------------------------------------------------------------ */

/**
 * Polls GET /health on the relay.
 *
 * @param {object} opts
 * @param {string} opts.relayUrl
 * @param {number} [opts.intervalMs]  Polling interval. Default 30 000. 0 = no poll.
 * @returns {{ status, checks, warnings, uptime, loading, error, refetch, check }}
 */
function useRelayHealth ({ relayUrl = DEFAULT_RELAY_URL, intervalMs = 30_000 } = {}) {
  const { useState, useEffect, useCallback, useRef } = _resolveReactHooks();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  const fetchHealth = useCallback(async (deep = false) => {
    setLoading(true);
    setError(null);
    try {
      const url = deep ? `${relayUrl}/health?deep=1` : `${relayUrl}/health`;
      const r = await fetch(url);
      const d = await r.json();
      setData(d);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [relayUrl]);

  useEffect(() => {
    fetchHealth();
    if (intervalMs > 0) {
      timerRef.current = setInterval(() => fetchHealth(), intervalMs);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchHealth, intervalMs]);

  const refetch = useCallback(() => fetchHealth(), [fetchHealth]);
  const check = useCallback((deep = false) => fetchHealth(deep), [fetchHealth]);

  return {
    status: data?.status,
    checks: data?.checks,
    warnings: data?.warnings,
    uptime: data?.uptime,
    loading,
    error,
    refetch,
    check,
  };
}

/* ========================================================================== */
/* 4. ByokRelayClient (plain JS, framework-agnostic)                          */
/* ========================================================================== */

/**
 * Plain-JS client — safe in Remix loaders (server) and browser.
 *
 * In loaders/actions: use server-side RELAY_URL (private env var).
 * In browser scripts: use public relay URL (from window.ENV or loader data).
 */
class ByokRelayClient {
  /**
   * @param {object} opts
   * @param {string}  opts.relayUrl  Relay base URL.
   * @param {string}  [opts.appId]   Application identifier.
   * @param {object}  [opts.storage] Custom storage adapter { get, set, remove }.
   */
  constructor ({ relayUrl = DEFAULT_RELAY_URL, appId = '', storage } = {}) {
    this.relayUrl = relayUrl.replace(/\/$/, '');
    this.appId = appId;
    this._storageKey = `byok_token_${this.relayUrl}_${appId}`;
    this._storage = storage || {
      get: (k) => _safeGet(k),
      set: (k, v) => _safeSet(k, v),
      remove: (k) => _safeRemove(k),
    };
    this.token = this._storage.get(this._storageKey) || null;
  }

  _headers (extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (this.token) h['x-relay-token'] = this.token;
    if (this.appId) h['x-app-id'] = this.appId;
    return h;
  }

  /** Register a new user and persist the token. Returns { token, expires_at }. */
  async register (appId) {
    const r = await fetch(`${this.relayUrl}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId || this.appId || 'remix-app' }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Registration failed');
    this.token = d.token;
    this._storage.set(this._storageKey, this.token);
    return d;
  }

  /** Register if no token is stored yet. */
  async ensureToken () {
    if (this.token) return this.token;
    const d = await this.register();
    return d.token;
  }

  /** Remove stored token (client-side logout). */
  logout () {
    this.token = null;
    this._storage.remove(this._storageKey);
  }

  /** Store a provider API key. */
  async storeKey (provider, apiKey) {
    const r = await fetch(`${this.relayUrl}/keys/${provider}`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ key: apiKey }),
    });
    return r.json();
  }

  /** List stored provider keys. */
  async listKeys () {
    const r = await fetch(`${this.relayUrl}/keys`, { headers: this._headers() });
    return r.json();
  }

  /** Delete a stored provider key. */
  async deleteKey (provider) {
    const r = await fetch(`${this.relayUrl}/keys/${provider}`, {
      method: 'DELETE',
      headers: this._headers(),
    });
    return r.json();
  }

  /** Rotate a provider key (atomic: verify new key before replacing). */
  async rotateKey (provider, newApiKey) {
    const r = await fetch(`${this.relayUrl}/keys/${provider}/rotate`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ key: newApiKey }),
    });
    return r.json();
  }

  /**
   * Send a non-streaming chat request.
   * @param {object} opts
   * @param {string}   opts.provider   openai | anthropic | groq | mistral | openrouter
   * @param {string}   opts.model
   * @param {object[]} opts.messages   OpenAI-format messages array.
   * @param {object}   [opts.extra]    Extra body params.
   */
  async chat ({ provider = 'openai', model = 'gpt-4o-mini', messages = [], extra = {} } = {}) {
    const r = await fetch(`${this.relayUrl}/relay/${provider}/chat/completions`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ model, messages, ...extra }),
    });
    return r.json();
  }

  /**
   * Streaming chat — calls onChunk(delta) for each text token, onDone(full) when complete.
   * @param {object}   opts
   * @param {string}   opts.provider
   * @param {string}   opts.model
   * @param {object[]} opts.messages
   * @param {function} opts.onChunk    Called with each text delta.
   * @param {function} [opts.onDone]   Called with accumulated text when stream ends.
   * @param {object}   [opts.extra]
   * @param {AbortSignal} [opts.signal]
   */
  async streamChat ({
    provider = 'openai',
    model = 'gpt-4o-mini',
    messages = [],
    onChunk,
    onDone,
    extra = {},
    signal,
  } = {}) {
    const r = await fetch(`${this.relayUrl}/relay/${provider}/chat/completions`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ model, messages, stream: true, ...extra }),
      signal,
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    let buffer = '';
    let streamDone = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const parsedChunk = _sseLines(buffer, chunk);
        buffer = parsedChunk.buffer;
        for (const line of parsedChunk.lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') {
            streamDone = true;
            break;
          }
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed.choices?.[0]?.delta?.content || '';
            if (delta) { accumulated += delta; if (onChunk) onChunk(delta, accumulated); }
          } catch (_) {}
        }
        if (streamDone) break;
      }
    } finally {
      reader.releaseLock();
    }

    if (onDone) onDone(accumulated);
    return accumulated;
  }

  /** GET /health[?deep=1] */
  async health (deep = false) {
    const url = deep ? `${this.relayUrl}/health?deep=1` : `${this.relayUrl}/health`;
    const r = await fetch(url);
    return r.json();
  }

  /** GET /stats[/:appId] */
  async stats (appId) {
    const path = appId ? `/stats/${appId}` : '/stats';
    const r = await fetch(`${this.relayUrl}${path}`, { headers: this._headers() });
    return r.json();
  }

  /** GET /models */
  async getModels () {
    const r = await fetch(`${this.relayUrl}/models`, { headers: this._headers() });
    return r.json();
  }

  /** DELETE /users — remove account + all keys (GDPR). */
  async deleteAccount () {
    const r = await fetch(`${this.relayUrl}/users`, {
      method: 'DELETE',
      headers: this._headers(),
    });
    if (r.ok) this.logout();
    return r.json().catch(() => ({ ok: r.ok, status: r.status }));
  }
}

/* ========================================================================== */
/* Exports                                                                     */
/* ========================================================================== */

module.exports = {
  // Server
  createRelayLoader,
  createRelayAction,
  // React hooks (client)
  useByokRelay,
  useChat,
  useStreamingChat,
  useRelayHealth,
  // Plain JS
  ByokRelayClient,
};

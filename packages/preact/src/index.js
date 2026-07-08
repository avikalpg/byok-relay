/**
 * @byok-relay/preact
 * Preact hooks for BYOK AI — works in Astro component islands, Vite apps, and any Preact project.
 *
 * Hooks are resolved at runtime:
 *   1. preact/hooks  (preferred — native Preact)
 *   2. react         (fallback — if preact is not installed but react is)
 *   3. inline shim   (test / non-browser environments)
 */

'use strict';

/* -------------------------------------------------------------------------- */
/* Hook resolution                                                             */
/* -------------------------------------------------------------------------- */

let _useState, _useEffect, _useCallback, _useRef;

function _resolveHooks () {
  if (_useState) return;
  // Try preact/hooks first
  try {
    const ph = require('preact/hooks');
    _useState = ph.useState;
    _useEffect = ph.useEffect;
    _useCallback = ph.useCallback;
    _useRef = ph.useRef;
    return;
  } catch (_) { /* not installed */ }
  // Fall back to react
  try {
    const r = require('react');
    _useState = r.useState;
    _useEffect = r.useEffect;
    _useCallback = r.useCallback;
    _useRef = r.useRef;
    return;
  } catch (_) { /* not installed */ }
  // Inline shim for test / non-DOM environments
  _useState = (init) => {
    const val = typeof init === 'function' ? init() : init;
    const setter = (next) => {
      // no-op shim; state management happens externally in tests
      setter._current = typeof next === 'function' ? next(val) : next;
    };
    setter._current = val;
    return [val, setter];
  };
  _useEffect = (fn) => { fn(); };
  _useCallback = (fn) => fn;
  _useRef = (init) => ({ current: init });
}

function useState (init) { _resolveHooks(); return _useState(init); }
function useEffect (fn, deps) { _resolveHooks(); return _useEffect(fn, deps); }
function useCallback (fn, deps) { _resolveHooks(); return _useCallback(fn, deps); }
function useRef (init) { _resolveHooks(); return _useRef(init); }

/* -------------------------------------------------------------------------- */
/* SSR-safe storage helpers                                                    */
/* -------------------------------------------------------------------------- */

function _isClient () {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function _safeGet (key) {
  if (!_isClient()) return null;
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

function _safeSet (key, val) {
  if (!_isClient()) return;
  try { localStorage.setItem(key, val); } catch (_) {}
}

function _safeRemove (key) {
  if (!_isClient()) return;
  try { localStorage.removeItem(key); } catch (_) {}
}

/* -------------------------------------------------------------------------- */
/* SSE helpers                                                                 */
/* -------------------------------------------------------------------------- */

function _parseSSEData (line) {
  if (!line.startsWith('data:')) return null;
  const raw = line.slice(5).trim();
  if (raw === '[DONE]') return { done: true };
  try { return { data: JSON.parse(raw) }; } catch (_) { return null; }
}

async function _streamSSE (url, body, headers, signal, onChunk, onDone, onError) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    if (err.name === 'AbortError') return;
    onError(err.message || 'Fetch error');
    return;
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error || j.message || msg; } catch (_) {}
    onError(msg);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    let chunk;
    try { chunk = await reader.read(); } catch (_) { break; }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const parsed = _parseSSEData(line.trim());
      if (!parsed) continue;
      if (parsed.done) { onDone(); return; }
      const delta =
        parsed.data?.choices?.[0]?.delta?.content ||
        parsed.data?.delta?.text ||
        '';
      if (delta) onChunk(delta);
    }
  }
  onDone();
}

/* -------------------------------------------------------------------------- */
/* Provider → auth header mapping                                              */
/* -------------------------------------------------------------------------- */

const _PROVIDERS = {
  openai: { header: 'x-openai-key', relayPath: 'openai/chat/completions' },
  anthropic: { header: 'x-anthropic-key', relayPath: 'anthropic/messages' },
  groq: { header: 'x-groq-key', relayPath: 'openai/chat/completions' },
  mistral: { header: 'x-mistral-key', relayPath: 'openai/chat/completions' },
  openrouter: { header: 'x-openrouter-key', relayPath: 'openai/chat/completions' },
};

/* -------------------------------------------------------------------------- */
/* useByokRelay                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Core relay hook — token registration, key management, logout.
 *
 * @param {object} opts
 * @param {string} opts.relayUrl   - Base URL of the byok-relay server (e.g. "https://relay.byokrelay.com")
 * @param {string} opts.appId      - Your application ID (sent at registration)
 * @param {string} [opts.storageKey] - localStorage key prefix (default: "byok_relay")
 */
function useByokRelay ({ relayUrl, appId, storageKey = 'byok_relay' } = {}) {
  const tokenKey = `${storageKey}_token`;

  const [token, setToken] = useState(() => _safeGet(tokenKey) || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  /** Retrieve an existing token from localStorage or register a new user. */
  const getToken = useCallback(async () => {
    const stored = _safeGet(tokenKey);
    if (stored) { setToken(stored); return stored; }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${relayUrl}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const t = data.token;
      _safeSet(tokenKey, t);
      setToken(t);
      return t;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [relayUrl, appId, tokenKey]);

  /** Store (or update) a provider API key in the relay. */
  const storeKey = useCallback(async (provider, apiKey) => {
    const t = token || await getToken();
    if (!t) return { ok: false, error: 'No relay token' };
    const res = await fetch(`${relayUrl}/keys/${provider}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${t}` },
      body: JSON.stringify({ key: apiKey }),
    });
    const data = await res.json();
    return { ok: res.ok, ...data };
  }, [relayUrl, token, getToken]);

  /** Delete a stored provider key. */
  const deleteKey = useCallback(async (provider) => {
    const t = token || await getToken();
    if (!t) return { ok: false, error: 'No relay token' };
    const res = await fetch(`${relayUrl}/keys/${provider}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${t}` },
    });
    return { ok: res.ok };
  }, [relayUrl, token, getToken]);

  /** List all stored provider keys (returns key names, not values). */
  const listKeys = useCallback(async () => {
    const t = token || await getToken();
    if (!t) return [];
    const res = await fetch(`${relayUrl}/keys`, {
      headers: { 'Authorization': `Bearer ${t}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.keys || [];
  }, [relayUrl, token, getToken]);

  /** Remove the relay token from localStorage (logout). */
  const logout = useCallback(() => {
    _safeRemove(tokenKey);
    setToken(null);
  }, [tokenKey]);

  return { token, loading, error, getToken, storeKey, deleteKey, listKeys, logout };
}

/* -------------------------------------------------------------------------- */
/* useChat                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Stateful non-streaming chat hook.
 *
 * @param {object} opts
 * @param {string} opts.relayUrl     - byok-relay base URL
 * @param {string} opts.appId        - app ID
 * @param {string} [opts.provider]   - "openai" | "anthropic" | "groq" | "mistral" | "openrouter" (default: "openai")
 * @param {string} [opts.model]      - model name (default: "gpt-4o-mini")
 * @param {string} [opts.systemPrompt]
 * @param {object} [opts.extraParams] - extra body params forwarded to provider
 */
function useChat ({
  relayUrl,
  appId,
  provider = 'openai',
  model = 'gpt-4o-mini',
  systemPrompt,
  extraParams = {},
} = {}) {
  const { token, getToken } = useByokRelay({ relayUrl, appId });
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const sendMessage = useCallback(async (content) => {
    const userMsg = { role: 'user', content };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);
    setError(null);
    const t = token || await getToken();
    if (!t) { setError('No relay token'); setLoading(false); return; }

    const history = [...messages, userMsg];
    const body = {
      model,
      messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...history] : history,
      ...extraParams,
    };

    const provInfo = _PROVIDERS[provider] || _PROVIDERS.openai;
    try {
      const res = await fetch(`${relayUrl}/relay/${provInfo.relayPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${t}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const reply =
        data.choices?.[0]?.message?.content ||
        data.content?.[0]?.text ||
        '';
      setMessages(prev => [...prev, { role: 'assistant', content: reply }]);
    } catch (err) {
      setError(err.message);
      setMessages(prev => prev.slice(0, -1)); // roll back user message on error
    } finally {
      setLoading(false);
    }
  }, [relayUrl, provider, model, systemPrompt, extraParams, messages, token, getToken]);

  const clearMessages = useCallback(() => setMessages([]), []);

  return { messages, loading, error, sendMessage, clearMessages };
}

/* -------------------------------------------------------------------------- */
/* useStreamingChat                                                            */
/* -------------------------------------------------------------------------- */

/**
 * SSE streaming chat hook. Compatible with Preact signals and standard state.
 *
 * @param {object} opts  - same as useChat
 */
function useStreamingChat ({
  relayUrl,
  appId,
  provider = 'openai',
  model = 'gpt-4o-mini',
  systemPrompt,
  extraParams = {},
} = {}) {
  const { token, getToken } = useByokRelay({ relayUrl, appId });
  const [messages, setMessages] = useState([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const sendMessage = useCallback(async (content) => {
    const userMsg = { role: 'user', content };
    setMessages(prev => [...prev, userMsg]);
    setStreamingContent('');
    setIsStreaming(true);
    setError(null);

    const t = token || await getToken();
    if (!t) { setError('No relay token'); setIsStreaming(false); return; }

    const controller = new AbortController();
    abortRef.current = controller;

    const history = [...messages, userMsg];
    const body = {
      model,
      messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...history] : history,
      stream: true,
      ...extraParams,
    };

    const provInfo = _PROVIDERS[provider] || _PROVIDERS.openai;
    let accumulated = '';

    await _streamSSE(
      `${relayUrl}/relay/${provInfo.relayPath}`,
      body,
      { 'Content-Type': 'application/json', 'Authorization': `Bearer ${t}` },
      controller.signal,
      (chunk) => {
        accumulated += chunk;
        setStreamingContent(accumulated);
      },
      () => {
        setMessages(prev => [...prev, { role: 'assistant', content: accumulated }]);
        setStreamingContent('');
        setIsStreaming(false);
      },
      (err) => {
        setError(err);
        setMessages(prev => prev.slice(0, -1));
        setIsStreaming(false);
      },
    );
  }, [relayUrl, provider, model, systemPrompt, extraParams, messages, token, getToken]);

  const stopStreaming = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    setIsStreaming(false);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setStreamingContent('');
  }, []);

  return { messages, streamingContent, isStreaming, error, sendMessage, stopStreaming, clearMessages };
}

/* -------------------------------------------------------------------------- */
/* useRelayHealth                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Polls the relay /health endpoint at a configurable interval.
 *
 * @param {object} opts
 * @param {string} opts.relayUrl           - byok-relay base URL
 * @param {number} [opts.intervalMs=30000] - polling interval in ms (0 = one-shot)
 * @param {boolean} [opts.deep=false]      - use ?deep=1 readiness probe
 */
function useRelayHealth ({ relayUrl, intervalMs = 30000, deep = false } = {}) {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const check = useCallback(async (deepOverride) => {
    setLoading(true);
    setError(null);
    try {
      const url = `${relayUrl}/health${(deepOverride ?? deep) ? '?deep=1' : ''}`;
      const res = await fetch(url);
      const data = await res.json();
      setHealth({ ...data, ok: res.ok, statusCode: res.status });
      return data;
    } catch (err) {
      setError(err.message);
      setHealth(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [relayUrl, deep]);

  useEffect(() => {
    check();
    if (!intervalMs) return;
    const id = setInterval(check, intervalMs);
    return () => clearInterval(id);
  }, [check, intervalMs]);

  return { health, loading, error, check };
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                     */
/* -------------------------------------------------------------------------- */

module.exports = { useByokRelay, useChat, useStreamingChat, useRelayHealth };

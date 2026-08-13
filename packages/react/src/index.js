/**
 * @byok-relay/react
 *
 * React hooks for byok-relay — drop-in BYOK AI in any React app.
 *
 * Usage:
 *   import { useByokRelay, useChat, useStreamingChat } from '@byok-relay/react';
 *
 * No build step required. Peer dep: react >=17.
 */

'use strict';

const { useState, useCallback, useRef, useEffect } = require('react');

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';

// Provider → path mapping for standard relay requests
const PROVIDER_PATHS = {
  openai: 'chat/completions',
  anthropic: 'messages',
  groq: 'chat/completions',
  mistral: 'chat/completions',
  openrouter: 'chat/completions',
};

const registrationFlights = new Map();
const logoutGenerations = new Map();
const tokenSubscribers = new Map();

// ─── Storage helpers ──────────────────────────────────────────────────────────

function storageGet(key) {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; }
  catch { return null; }
}

function storageSet(key, value) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); }
  catch { /* ignore */ }
}

function storageRemove(key) {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(key); }
  catch { /* ignore */ }
}

function legacyTokenStorageKey(relayUrl, appId) {
  return `byok_relay_token_${encodeURIComponent(String(relayUrl))}_${encodeURIComponent(String(appId))}`;
}

function tokenStorageKey(relayUrl, appId) {
  return `byok_relay_token_v2_${encodeURIComponent(JSON.stringify([String(relayUrl), String(appId)]))}`;
}

function tokenScopeKey(relayUrl, appId) {
  return JSON.stringify([String(relayUrl), String(appId)]);
}

function readStoredToken(tokenKey, legacyTokenKey) {
  const existing = storageGet(tokenKey);
  if (existing) return existing;

  if (legacyTokenKey && legacyTokenKey !== tokenKey) {
    const legacy = storageGet(legacyTokenKey);
    if (legacy) {
      storageSet(tokenKey, legacy);
      return legacy;
    }
  }

  return null;
}

function removeStoredToken(tokenKey, legacyTokenKey) {
  storageRemove(tokenKey);
  if (legacyTokenKey && legacyTokenKey !== tokenKey) storageRemove(legacyTokenKey);
}

function tokenGeneration(scopeKey) {
  return logoutGenerations.get(scopeKey) || 0;
}

function createAbortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function subscribeTokenScope(scopeKey, listener) {
  if (!tokenSubscribers.has(scopeKey)) tokenSubscribers.set(scopeKey, new Set());
  const listeners = tokenSubscribers.get(scopeKey);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) tokenSubscribers.delete(scopeKey);
  };
}

function bumpTokenGeneration(scopeKey) {
  const next = tokenGeneration(scopeKey) + 1;
  logoutGenerations.set(scopeKey, next);
  const listeners = tokenSubscribers.get(scopeKey);
  if (listeners) {
    for (const listener of listeners) listener(next);
  }
  return next;
}

async function registerRelayToken({ relayUrl, appId, tokenKey, legacyTokenKey, scopeKey, generation }) {
  const startGeneration = generation ?? tokenGeneration(scopeKey);
  const existing = readStoredToken(tokenKey, legacyTokenKey);
  if (existing) return existing;

  const flightKey = JSON.stringify([scopeKey, startGeneration]);
  if (!registrationFlights.has(flightKey)) {
    const flight = (async () => {
      const stored = readStoredToken(tokenKey, legacyTokenKey);
      if (stored) return stored;

      const res = await fetch(`${relayUrl}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Registration failed (${res.status})`);
      }
      const { token: t } = await res.json();
      if (tokenGeneration(scopeKey) !== startGeneration) {
        throw createAbortError('Registration cancelled by logout');
      }
      storageSet(tokenKey, t);
      return t;
    })().finally(() => {
      if (registrationFlights.get(flightKey) === flight) registrationFlights.delete(flightKey);
    });

    registrationFlights.set(flightKey, flight);
  }

  return registrationFlights.get(flightKey);
}

// ─── useByokRelay ─────────────────────────────────────────────────────────────

/**
 * Core hook — manages relay token + key storage.
 *
 * @param {object} opts
 * @param {string} [opts.relayUrl]   Relay base URL (default: https://relay.byokrelay.com)
 * @param {string} opts.appId        Your app identifier (used for key namespacing)
 *
 * @returns {{ token, isRegistered, register, storeKey, deleteKey, listProviders, error }}
 */
function useByokRelay({ relayUrl = DEFAULT_RELAY_URL, appId } = {}) {
  const tokenKey = tokenStorageKey(relayUrl, appId);
  const legacyTokenKey = legacyTokenStorageKey(relayUrl, appId);
  const scopeKey = tokenScopeKey(relayUrl, appId);

  const readToken = useCallback(() => readStoredToken(tokenKey, legacyTokenKey), [tokenKey, legacyTokenKey]);
  const [tokenState, setTokenState] = useState(() => ({
    scopeKey,
    tokenKey,
    generation: tokenGeneration(scopeKey),
    token: readToken(),
  }));
  const [error, setError] = useState(null);

  const token = tokenState.scopeKey === scopeKey && tokenState.tokenKey === tokenKey ? tokenState.token : readToken();
  const tokenStateGeneration = tokenState.scopeKey === scopeKey ? tokenState.generation : tokenGeneration(scopeKey);
  const isRegistered = Boolean(token);

  useEffect(() => {
    setTokenState({ scopeKey, tokenKey, generation: tokenGeneration(scopeKey), token: readToken() });
    setError(null);
  }, [scopeKey, tokenKey, readToken]);

  useEffect(() => subscribeTokenScope(scopeKey, (generation) => {
    setTokenState({ scopeKey, tokenKey, generation, token: null });
  }), [scopeKey, tokenKey]);

  /** Register a new relay token (or load an existing one from localStorage). */
  const register = useCallback(async () => {
    setError(null);
    const generation = tokenGeneration(scopeKey);
    try {
      const t = await registerRelayToken({ relayUrl, appId, tokenKey, legacyTokenKey, scopeKey, generation });
      if (tokenGeneration(scopeKey) !== generation) throw createAbortError('Registration cancelled by logout');
      setTokenState({ scopeKey, tokenKey, generation, token: t });
      return t;
    } catch (e) {
      if (e?.name !== 'AbortError') setError(e.message);
      throw e;
    }
  }, [relayUrl, appId, tokenKey, legacyTokenKey, scopeKey]);

  /** Get the current token, auto-registering if needed. */
  const getToken = useCallback(async () => {
    const generation = tokenGeneration(scopeKey);
    const stored = readToken();
    if (stored) {
      if (stored !== token || tokenStateGeneration !== generation) {
        setTokenState({ scopeKey, tokenKey, generation, token: stored });
      }
      return stored;
    }
    if (tokenStateGeneration !== generation) {
      if (token !== null) setTokenState({ scopeKey, tokenKey, generation, token: null });
      return register();
    }
    return token || register();
  }, [token, tokenKey, scopeKey, tokenStateGeneration, readToken, register]);

  /**
   * Store an API key for a provider.
   * @param {string} provider   e.g. 'openai', 'anthropic'
   * @param {string} apiKey     The user's API key
   */
  const storeKey = useCallback(async (provider, apiKey) => {
    setError(null);
    const t = await getToken();
    const res = await fetch(`${relayUrl}/keys/${provider}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relay-token': t },
      body: JSON.stringify({ key: apiKey }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body.error || `Failed to store key (${res.status})`;
      setError(msg);
      throw new Error(msg);
    }
    return res.json();
  }, [relayUrl, getToken]);

  /**
   * Delete a stored API key for a provider.
   * @param {string} provider
   */
  const deleteKey = useCallback(async (provider) => {
    setError(null);
    const t = await getToken();
    const res = await fetch(`${relayUrl}/keys/${provider}`, {
      method: 'DELETE',
      headers: { 'x-relay-token': t },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body.error || `Failed to delete key (${res.status})`;
      setError(msg);
      throw new Error(msg);
    }
  }, [relayUrl, getToken]);

  /** List providers the user has stored keys for. */
  const listProviders = useCallback(async () => {
    setError(null);
    const t = await getToken();
    const res = await fetch(`${relayUrl}/keys`, {
      headers: { 'x-relay-token': t },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body.error || `Failed to list providers (${res.status})`;
      setError(msg);
      throw new Error(msg);
    }
    return res.json();
  }, [relayUrl, getToken]);

  /** Clear token from localStorage (logout). */
  const logout = useCallback(() => {
    removeStoredToken(tokenKey, legacyTokenKey);
    const generation = bumpTokenGeneration(scopeKey);
    setTokenState({ scopeKey, tokenKey, generation, token: null });
  }, [tokenKey, legacyTokenKey, scopeKey]);

  return { token, isRegistered, register, storeKey, deleteKey, listProviders, logout, error };
}

// ─── useChat ──────────────────────────────────────────────────────────────────

/**
 * Chat hook — stateful message list, send/receive, error handling.
 *
 * @param {object} opts
 * @param {string} [opts.relayUrl]   Relay base URL
 * @param {string} opts.appId        App identifier
 * @param {string} [opts.provider]   AI provider ('openai' | 'anthropic' | 'groq' | …)
 * @param {string} [opts.model]      Model name (e.g. 'gpt-4o', 'claude-3-5-sonnet-20241022')
 * @param {string} [opts.systemPrompt]  System message prepended to every request
 * @param {object} [opts.extraParams]   Extra body params forwarded to the provider
 *
 * @returns {{ messages, sendMessage, isLoading, error, clearMessages }}
 */
function useChat({
  relayUrl = DEFAULT_RELAY_URL,
  appId,
  provider = 'openai',
  model = 'gpt-4o',
  systemPrompt,
  extraParams = {},
} = {}) {
  const { getToken, error: relayError } = _useByokRelayInternal({ relayUrl, appId });
  const [messages, setMessages] = useState([]);
  const messagesRef = useRef([]);
  const turnInFlightRef = useRef(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const setMessagesAndRef = useCallback((next) => {
    const value = typeof next === 'function' ? next(messagesRef.current) : next;
    messagesRef.current = value;
    setMessages(value);
    return value;
  }, []);

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const sendMessage = useCallback(async (content) => {
    setError(null);
    if (turnInFlightRef.current) {
      const msg = 'A chat turn is already in progress';
      setError(msg);
      throw new Error(msg);
    }

    turnInFlightRef.current = true;
    const userMsg = { role: 'user', content };
    const nextMessages = setMessagesAndRef(prev => [...prev, userMsg]);
    setIsLoading(true);

    try {
      const t = await getToken();
      const path = PROVIDER_PATHS[provider] || 'chat/completions';
      const resolvedPath = path.replace('{model}', model);

      let body;
      if (provider === 'anthropic') {
        body = {
          model,
          max_tokens: 1024,
          messages: nextMessages,
          ...(systemPrompt ? { system: systemPrompt } : {}),
          ...extraParams,
        };
      } else {
        body = {
          model,
          messages: [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            ...nextMessages,
          ],
          ...extraParams,
        };
      }

      const res = await fetch(`${relayUrl}/relay/${provider}/${resolvedPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-relay-token': t },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `Request failed (${res.status})`);
      }

      const data = await res.json();
      const assistantContent = _extractContent(data, provider);
      const assistantMsg = { role: 'assistant', content: assistantContent };
      setMessagesAndRef(prev => [...prev, assistantMsg]);
      return assistantContent;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      turnInFlightRef.current = false;
      setIsLoading(false);
    }
  }, [relayUrl, appId, provider, model, systemPrompt, extraParams, getToken, setMessagesAndRef]);

  return {
    messages,
    sendMessage,
    isLoading,
    error: error || relayError,
    clearMessages: () => setMessagesAndRef([]),
  };
}

// ─── useStreamingChat ─────────────────────────────────────────────────────────

/**
 * Streaming chat hook — streams assistant response token by token via SSE.
 *
 * @param {object} opts   Same as useChat
 * @returns {{ messages, sendMessage, streamingContent, isStreaming, error, clearMessages }}
 */
function useStreamingChat({
  relayUrl = DEFAULT_RELAY_URL,
  appId,
  provider = 'openai',
  model = 'gpt-4o',
  systemPrompt,
  extraParams = {},
} = {}) {
  const { getToken, error: relayError } = _useByokRelayInternal({ relayUrl, appId });
  const [messages, setMessages] = useState([]);
  const messagesRef = useRef([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const setMessagesAndRef = useCallback((next) => {
    const value = typeof next === 'function' ? next(messagesRef.current) : next;
    messagesRef.current = value;
    setMessages(value);
    return value;
  }, []);

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Clean up any in-flight stream on unmount
  useEffect(() => {
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, []);

  const sendMessage = useCallback(async (content) => {
    setError(null);
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const userMsg = { role: 'user', content };
    const nextMessages = setMessagesAndRef(prev => [...prev, userMsg]);
    setIsStreaming(true);
    setStreamingContent('');

    try {
      const t = await getToken();
      const path = PROVIDER_PATHS[provider] || 'chat/completions';
      const resolvedPath = path.replace('{model}', model);

      let body;
      if (provider === 'anthropic') {
        body = {
          model,
          max_tokens: 1024,
          stream: true,
          messages: nextMessages,
          ...(systemPrompt ? { system: systemPrompt } : {}),
          ...extraParams,
        };
      } else {
        body = {
          model,
          stream: true,
          messages: [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            ...nextMessages,
          ],
          ...extraParams,
        };
      }

      const res = await fetch(`${relayUrl}/relay/${provider}/${resolvedPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-relay-token': t },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `Request failed (${res.status})`);
      }

      let full = '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      const handleSseLine = (line) => {
        if (!line.startsWith('data: ')) return false;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') return true;
        try {
          const delta = _extractStreamDelta(JSON.parse(raw), provider);
          if (delta) {
            full += delta;
            setStreamingContent(full);
          }
        } catch { /* skip malformed chunks */ }
        return false;
      };

      while (!finished) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (handleSseLine(line)) {
            finished = true;
            break;
          }
        }
      }

      if (!finished && buffer.trim()) handleSseLine(buffer);

      const assistantMsg = { role: 'assistant', content: full };
      setMessagesAndRef(prev => [...prev, assistantMsg]);
      setStreamingContent('');
      return full;
    } catch (e) {
      if (e.name !== 'AbortError') {
        setError(e.message);
        throw e;
      }
    } finally {
      setIsStreaming(false);
    }
  }, [relayUrl, appId, provider, model, systemPrompt, extraParams, getToken, setMessagesAndRef]);

  const stopStreaming = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  return {
    messages,
    sendMessage,
    streamingContent,
    isStreaming,
    stopStreaming,
    error: error || relayError,
    clearMessages: () => { setMessagesAndRef([]); setStreamingContent(''); },
  };
}

// ─── useRelayHealth ───────────────────────────────────────────────────────────

/**
 * Health-check hook — polls the relay's /health endpoint.
 *
 * @param {object} opts
 * @param {string} [opts.relayUrl]
 * @param {boolean} [opts.deep]  Run deep (upstream provider ping) check
 * @param {number} [opts.intervalMs] Poll interval in milliseconds (default: 30000, 0 disables polling)
 *
 * @returns {{ status, data, isLoading, refetch }}
 */
function useRelayHealth({ relayUrl = DEFAULT_RELAY_URL, deep = false, intervalMs = 30000 } = {}) {
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [status, setStatus] = useState(null); // 'ok' | 'error' | null
  const requestIdRef = useRef(0);
  const activeControllerRef = useRef(null);

  const refetch = useCallback(async (options = {}) => {
    const externalSignal = options && options.signal;
    const timeoutMs = options && options.timeoutMs;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (activeControllerRef.current) activeControllerRef.current.abort();

    const controller = new AbortController();
    activeControllerRef.current = controller;
    let timeoutId = null;
    let timedOut = false;

    const abortFromExternalSignal = () => controller.abort();
    if (externalSignal?.aborted) {
      controller.abort();
    } else if (externalSignal?.addEventListener) {
      externalSignal.addEventListener('abort', abortFromExternalSignal, { once: true });
    }

    if (timeoutMs && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }

    setIsLoading(true);
    try {
      const url = deep ? `${relayUrl}/health?deep=1` : `${relayUrl}/health`;
      const res = await fetch(url, { signal: controller.signal });
      const body = await res.json();
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      setData(body);
      setStatus(res.ok ? 'ok' : 'error');
    } catch (e) {
      if (e?.name === 'AbortError' && !timedOut) return;
      if (requestId === requestIdRef.current) {
        setStatus('error');
        setData(null);
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (externalSignal?.removeEventListener) {
        externalSignal.removeEventListener('abort', abortFromExternalSignal);
      }
      if (activeControllerRef.current === controller) activeControllerRef.current = null;
      if (requestId === requestIdRef.current && (!controller.signal.aborted || timedOut)) {
        setIsLoading(false);
      }
    }
  }, [relayUrl, deep]);

  useEffect(() => {
    let timeoutId = null;
    let disposed = false;
    let pollController = null;

    const poll = async () => {
      pollController = new AbortController();
      const pollTimeoutMs = intervalMs && intervalMs > 0 ? intervalMs : 30000;
      try {
        await refetch({ signal: pollController.signal, timeoutMs: pollTimeoutMs });
      } finally {
        pollController = null;
        if (!disposed && intervalMs && intervalMs > 0) {
          timeoutId = setTimeout(poll, intervalMs);
        }
      }
    };

    poll();

    return () => {
      disposed = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (pollController) pollController.abort();
    };
  }, [refetch, intervalMs]);

  return { status, data, isLoading, refetch };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Internal version of useByokRelay that exposes getToken(). */
function _useByokRelayInternal({ relayUrl, appId }) {
  const tokenKey = tokenStorageKey(relayUrl, appId);
  const legacyTokenKey = legacyTokenStorageKey(relayUrl, appId);
  const scopeKey = tokenScopeKey(relayUrl, appId);
  const readToken = useCallback(() => readStoredToken(tokenKey, legacyTokenKey), [tokenKey, legacyTokenKey]);
  const [tokenState, setTokenState] = useState(() => ({
    scopeKey,
    tokenKey,
    generation: tokenGeneration(scopeKey),
    token: readToken(),
  }));
  const [error, setError] = useState(null);
  const token = tokenState.scopeKey === scopeKey && tokenState.tokenKey === tokenKey ? tokenState.token : readToken();
  const tokenStateGeneration = tokenState.scopeKey === scopeKey ? tokenState.generation : tokenGeneration(scopeKey);

  useEffect(() => {
    setTokenState({ scopeKey, tokenKey, generation: tokenGeneration(scopeKey), token: readToken() });
    setError(null);
  }, [scopeKey, tokenKey, readToken]);

  useEffect(() => subscribeTokenScope(scopeKey, (generation) => {
    setTokenState({ scopeKey, tokenKey, generation, token: null });
  }), [scopeKey, tokenKey]);

  const register = useCallback(async () => {
    const generation = tokenGeneration(scopeKey);
    try {
      const t = await registerRelayToken({ relayUrl, appId, tokenKey, legacyTokenKey, scopeKey, generation });
      if (tokenGeneration(scopeKey) !== generation) throw createAbortError('Registration cancelled by logout');
      setTokenState({ scopeKey, tokenKey, generation, token: t });
      return t;
    } catch (e) {
      if (e?.name !== 'AbortError') setError(e.message);
      throw e;
    }
  }, [relayUrl, appId, tokenKey, legacyTokenKey, scopeKey]);

  const getToken = useCallback(async () => {
    const generation = tokenGeneration(scopeKey);
    const stored = readToken();
    if (stored) {
      if (stored !== token || tokenStateGeneration !== generation) {
        setTokenState({ scopeKey, tokenKey, generation, token: stored });
      }
      return stored;
    }
    if (tokenStateGeneration !== generation) {
      if (token !== null) setTokenState({ scopeKey, tokenKey, generation, token: null });
      return register();
    }
    return token || register();
  }, [token, tokenKey, scopeKey, tokenStateGeneration, readToken, register]);

  return { token, getToken, error };
}

function _extractContent(data, provider) {
  if (provider === 'anthropic') {
    return data.content?.[0]?.text ?? '';
  }
  return data.choices?.[0]?.message?.content ?? '';
}

function _extractStreamDelta(parsed, provider) {
  if (provider === 'anthropic') {
    return parsed.delta?.text ?? parsed.delta?.value ?? '';
  }
  return parsed.choices?.[0]?.delta?.content ?? '';
}

// ─── Exports ──────────────────────────────────────────────────────────────────

const exported = {
  useByokRelay,
  useChat,
  useStreamingChat,
  useRelayHealth,
};

if (process.env.NODE_ENV === 'test') {
  exported.__testing = {
    tokenStorageKey,
    legacyTokenStorageKey,
    tokenScopeKey,
    readStoredToken,
    removeStoredToken,
    tokenGeneration,
  };
}

module.exports = exported;

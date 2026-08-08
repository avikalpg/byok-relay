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
  google: 'models/{model}:generateContent',
  groq: 'chat/completions',
  mistral: 'chat/completions',
  openrouter: 'chat/completions',
};

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
  const tokenKey = `byok_relay_token_${appId}`;

  const [token, setToken] = useState(() => storageGet(tokenKey));
  const [error, setError] = useState(null);

  const isRegistered = Boolean(token);

  /** Register a new relay token (or load an existing one from localStorage). */
  const register = useCallback(async () => {
    setError(null);
    try {
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
      storageSet(tokenKey, t);
      setToken(t);
      return t;
    } catch (e) {
      setError(e.message);
      throw e;
    }
  }, [relayUrl, appId, tokenKey]);

  /** Get the current token, auto-registering if needed. */
  const getToken = useCallback(async () => {
    return token || register();
  }, [token, register]);

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
    storageRemove(tokenKey);
    setToken(null);
  }, [tokenKey]);

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
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const sendMessage = useCallback(async (content) => {
    setError(null);
    const userMsg = { role: 'user', content };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
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
      setMessages(prev => [...prev, assistantMsg]);
      return assistantContent;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, [relayUrl, appId, provider, model, systemPrompt, extraParams, messages, getToken]);

  return {
    messages,
    sendMessage,
    isLoading,
    error: error || relayError,
    clearMessages: () => setMessages([]),
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
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

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
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
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
            const delta = _extractStreamDelta(JSON.parse(raw), provider);
            if (delta) {
              full += delta;
              setStreamingContent(full);
            }
          } catch { /* skip malformed chunks */ }
        }
      }

      const assistantMsg = { role: 'assistant', content: full };
      setMessages(prev => [...prev, assistantMsg]);
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
  }, [relayUrl, appId, provider, model, systemPrompt, extraParams, messages, getToken]);

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
    clearMessages: () => { setMessages([]); setStreamingContent(''); },
  };
}

// ─── useRelayHealth ───────────────────────────────────────────────────────────

/**
 * Health-check hook — polls the relay's /health endpoint.
 *
 * @param {object} opts
 * @param {string} [opts.relayUrl]
 * @param {boolean} [opts.deep]  Run deep (upstream provider ping) check
 *
 * @returns {{ status, data, isLoading, refetch }}
 */
function useRelayHealth({ relayUrl = DEFAULT_RELAY_URL, deep = false } = {}) {
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [status, setStatus] = useState(null); // 'ok' | 'error' | null

  const refetch = useCallback(async () => {
    setIsLoading(true);
    try {
      const url = deep ? `${relayUrl}/health?deep=1` : `${relayUrl}/health`;
      const res = await fetch(url);
      const body = await res.json();
      setData(body);
      setStatus(res.ok ? 'ok' : 'error');
    } catch {
      setStatus('error');
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, [relayUrl, deep]);

  useEffect(() => { refetch(); }, [refetch]);

  return { status, data, isLoading, refetch };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Internal version of useByokRelay that exposes getToken(). */
function _useByokRelayInternal({ relayUrl, appId }) {
  const tokenKey = `byok_relay_token_${appId}`;
  const [token, setToken] = useState(() => storageGet(tokenKey));
  const [error, setError] = useState(null);

  const register = useCallback(async () => {
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
    storageSet(tokenKey, t);
    setToken(t);
    return t;
  }, [relayUrl, appId, tokenKey]);

  const getToken = useCallback(async () => token || register(), [token, register]);

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

module.exports = {
  useByokRelay,
  useChat,
  useStreamingChat,
  useRelayHealth,
};

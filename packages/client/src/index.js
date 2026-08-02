/**
 * @byok-relay/client
 *
 * Framework-agnostic client for byok-relay.
 * Works in browsers (localStorage default), Node.js (in-memory default),
 * and any environment that supplies a custom storage adapter.
 *
 * @example Browser (Vite / CRA)
 *   import { createClient } from '@byok-relay/client'
 *   const relay = createClient({ relayUrl: import.meta.env.VITE_RELAY_URL })
 *
 * @example Node.js / test
 *   const { createClient } = require('@byok-relay/client')
 *   const relay = createClient({ relayUrl: process.env.RELAY_URL })
 */

'use strict'

const TOKEN_KEY = 'byok_relay_token'

// ── Storage helpers ──────────────────────────────────────────────────────────

/**
 * Create an in-memory storage adapter (fallback for non-browser environments).
 * @returns {{ getItem(k:string):string|null, setItem(k:string,v:string):void, removeItem(k:string):void }}
 */
function createMemoryStorage() {
  const store = Object.create(null)
  return {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = value },
    removeItem: (key) => { delete store[key] },
  }
}

/**
 * Return the best available default storage for the current environment.
 * Prefers globalThis.localStorage (browsers + JSDOM), falls back to in-memory.
 */
function defaultStorage() {
  if (
    typeof globalThis !== 'undefined' &&
    globalThis.localStorage &&
    typeof globalThis.localStorage.getItem === 'function'
  ) {
    return globalThis.localStorage
  }
  return createMemoryStorage()
}

// ── Client factory ───────────────────────────────────────────────────────────

/**
 * Create a byok-relay client.
 *
 * @param {object} [opts]
 * @param {string} [opts.relayUrl='http://localhost:3000']  Base URL of the relay server.
 * @param {string} [opts.appId='app']  Identifier sent when auto-registering.
 * @param {object} [opts.storage]  Custom storage adapter implementing getItem/setItem/removeItem.
 *   Pass null to disable token persistence (token lives only for the current factory instance).
 * @returns {RelayClient}
 */
function createClient({
  relayUrl = 'http://localhost:3000',
  appId = 'app',
  storage,
} = {}) {
  // storage=null → disable persistence (no localStorage, no memory across instances)
  const _storage = storage === null ? createMemoryStorage() : (storage || defaultStorage())
  // Normalise base URL: strip trailing slash
  const base = relayUrl.replace(/\/+$/, '')

  // ── Token management ────────────────────────────────────────────────────────

  function getToken() {
    return _storage.getItem(TOKEN_KEY)
  }

  function saveToken(token) {
    _storage.setItem(TOKEN_KEY, token)
  }

  function clearToken() {
    _storage.removeItem(TOKEN_KEY)
  }

  // ── User registration ────────────────────────────────────────────────────────

  /**
   * Register a new user with the relay (or reuse an existing persisted token).
   * @param {string} [id] - app_id override (defaults to the factory-level appId)
   * @returns {Promise<string>} relay token
   */
  async function ensureToken(id) {
    const existing = getToken()
    if (existing) return existing

    const res = await fetch(`${base}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: id || appId }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `Registration failed: ${res.status}`)
    }
    const { token } = await res.json()
    saveToken(token)
    return token
  }

  // ── API key management ───────────────────────────────────────────────────────

  /**
   * Store the user's API key on the relay (encrypted at rest, never returned).
   * @param {string} provider  e.g. "openai" | "anthropic" | "google" | "groq" | "elevenlabs"
   * @param {string} apiKey    The raw API key supplied by the user
   * @returns {Promise<object>} server response
   */
  async function storeKey(provider, apiKey) {
    const token = await ensureToken()
    const res = await fetch(`${base}/keys/${encodeURIComponent(provider)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-token': token,
      },
      body: JSON.stringify({ key: apiKey }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `Failed to store key: ${res.status}`)
    }
    return res.json()
  }

  /**
   * List which providers have a stored key (key values are never returned).
   * Returns an empty array if there is no token yet.
   * @returns {Promise<string[]>} provider names
   */
  async function listKeys() {
    const token = getToken()
    if (!token) return []
    const res = await fetch(`${base}/keys`, {
      headers: { 'x-relay-token': token },
    })
    if (!res.ok) return []
    const data = await res.json().catch(() => ({}))
    return Array.isArray(data.providers) ? data.providers : []
  }

  /**
   * Delete a stored key for the given provider.
   * @param {string} provider
   * @returns {Promise<void>}
   */
  async function deleteKey(provider) {
    const token = getToken()
    if (!token) return
    await fetch(`${base}/keys/${encodeURIComponent(provider)}`, {
      method: 'DELETE',
      headers: { 'x-relay-token': token },
    })
  }

  /**
   * Delete the relay account (GDPR Art. 17 erasure).
   * Removes the user row, all stored keys, and clears the local token.
   * @returns {Promise<void>}
   */
  async function deleteAccount() {
    const token = getToken()
    if (!token) return
    const res = await fetch(`${base}/users`, {
      method: 'DELETE',
      headers: { 'x-relay-token': token },
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `Delete account failed: ${res.status}`)
    }
    clearToken()
  }

  // ── Relay request ────────────────────────────────────────────────────────────

  /**
   * Forward a request through the relay (non-streaming or streaming).
   *
   * For streaming, pass onChunk and consume the returned full text.
   * For non-streaming, omit onChunk and await the parsed JSON response.
   *
   * @param {object} opts
   * @param {string} opts.provider           e.g. "openai" | "anthropic" | "google"
   * @param {string} opts.path               Provider-relative path, e.g. "/v1/chat/completions"
   * @param {object} opts.body               Request body (JSON-serialisable)
   * @param {object} [opts.headers]          Extra provider headers (e.g. anthropic-version)
   * @param {function(string):void} [opts.onChunk]  SSE text-delta handler; enables streaming mode
   * @returns {Promise<object|string>}       Parsed JSON (non-streaming) or full text (streaming)
   */
  async function relayRequest({ provider, path, body, headers: extraHeaders = {}, onChunk }) {
    const token = await ensureToken()
    const url = `${base}/relay/${encodeURIComponent(provider)}${path}`

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-token': token,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `Relay request failed: ${res.status}`)
    }

    // Non-streaming: return parsed JSON
    if (!onChunk) return res.json()

    // Streaming: parse SSE and invoke onChunk
    return _consumeSSE(res, onChunk)
  }

  // ── High-level streaming chat ─────────────────────────────────────────────

  /**
   * Stream a chat completion through byok-relay.
   *
   * Supports Anthropic Messages API and OpenAI Chat Completions API.
   * Calls onChunk(text) for each streamed token; resolves with the full text.
   *
   * @param {object} opts
   * @param {"anthropic"|"openai"} opts.provider
   * @param {string} opts.model
   * @param {Array<{role:string, content:string}>} opts.messages
   * @param {function(string):void} [opts.onChunk]  Called with each text delta
   * @param {number} [opts.maxTokens=1024]           Max tokens (Anthropic only)
   * @returns {Promise<string>} Full response text
   */
  async function streamChat({ provider, model, messages, onChunk, maxTokens = 1024 }) {
    if (provider === 'anthropic') {
      return relayRequest({
        provider: 'anthropic',
        path: '/v1/messages',
        headers: { 'anthropic-version': '2023-06-01' },
        body: { model, max_tokens: maxTokens, stream: true, messages },
        onChunk,
      })
    }

    if (provider === 'openai') {
      return relayRequest({
        provider: 'openai',
        path: '/v1/chat/completions',
        body: { model, stream: true, messages },
        onChunk,
      })
    }

    throw new Error(`streamChat: unsupported provider "${provider}". Use relayRequest() for others.`)
  }

  // ── Unified model routing (v1.1+) ────────────────────────────────────────

  /**
   * Stream a chat completion using unified model routing.
   * Requires byok-relay v1.1+ (POST /relay with model field).
   *
   * @param {object} opts
   * @param {string} opts.model   e.g. "anthropic/claude-haiku-4-5" or "gpt-4o"
   * @param {Array<{role:string,content:string}>} opts.messages
   * @param {function(string):void} [opts.onChunk]
   * @param {number} [opts.maxTokens=1024]
   * @returns {Promise<string>} Full response text
   */
  async function chat({ model, messages, onChunk, maxTokens = 1024 }) {
    const token = await ensureToken()
    const res = await fetch(`${base}/relay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-token': token,
      },
      body: JSON.stringify({ model, messages, stream: !!onChunk, max_tokens: maxTokens }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `Chat request failed: ${res.status}`)
    }

    if (!onChunk) return res.json()
    return _consumeSSE(res, onChunk)
  }

  // ── SSE parser ───────────────────────────────────────────────────────────

  async function _consumeSSE(res, onChunk) {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let fullText = ''
    let buffer = ''

    function processSSELine(line) {
      if (!line.startsWith('data:')) return
      const data = line.slice(5).trim()
      if (data === '[DONE]') return

      try {
        const json = JSON.parse(data)

        // Anthropic SSE
        if (json.type === 'content_block_delta' && json.delta?.text) {
          fullText += json.delta.text
          onChunk?.(json.delta.text)
        }

        // OpenAI SSE
        const delta = json.choices?.[0]?.delta?.content
        if (delta) {
          fullText += delta
          onChunk?.(delta)
        }
      } catch {
        // skip malformed SSE frames
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() // keep incomplete line

      for (const line of lines) processSSELine(line)
    }

    buffer += decoder.decode()
    for (const line of buffer.split('\n')) processSSELine(line)

    return fullText
  }

  // ── Stats & health ───────────────────────────────────────────────────────

  /**
   * Get relay stats for the current user's token.
   * Requires byok-relay v1.2+ (GET /stats).
   * @returns {Promise<object>}
   */
  async function getStats() {
    const token = getToken()
    if (!token) throw new Error('Not authenticated')
    const res = await fetch(`${base}/stats`, {
      headers: { 'x-relay-token': token },
    })
    if (!res.ok) throw new Error(`Stats request failed: ${res.status}`)
    return res.json()
  }

  /**
   * Ping the relay health endpoint.
   * @returns {Promise<object>}
   */
  async function health() {
    const res = await fetch(`${base}/health`)
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`)
    return res.json()
  }

  /**
   * Get the list of supported models from the relay (v1.1+).
   * @returns {Promise<object[]>}
   */
  async function getModels() {
    const res = await fetch(`${base}/models`)
    if (!res.ok) throw new Error(`Models request failed: ${res.status}`)
    return res.json()
  }

  return {
    // Token management
    getToken,
    clearToken,
    ensureToken,
    // Key management
    storeKey,
    listKeys,
    deleteKey,
    deleteAccount,
    // Low-level
    relayRequest,
    // High-level chat
    streamChat,
    chat,
    // Info
    getStats,
    health,
    getModels,
  }
}

module.exports = { createClient, createMemoryStorage }

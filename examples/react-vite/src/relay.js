/**
 * relay.js — byok-relay client for React apps
 *
 * Handles: user registration, API key storage, streaming relay requests.
 * Token is persisted in localStorage under "byok_relay_token".
 */

const RELAY_URL = import.meta.env.VITE_RELAY_URL || 'http://localhost:3000'
const TOKEN_KEY = 'byok_relay_token'

// ── Token management ────────────────────────────────────────────────────────

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

function saveToken(token) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

// ── User registration ────────────────────────────────────────────────────────

/**
 * Register a new user with the relay (or reuse existing token).
 * @param {string} appId - Your app identifier (e.g. "my-ai-app")
 * @returns {Promise<string>} relay token
 */
export async function ensureToken(appId = 'react-vite-example') {
  const existing = getToken()
  if (existing) return existing

  const res = await fetch(`${RELAY_URL}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId }),
  })
  if (!res.ok) throw new Error(`Registration failed: ${res.status}`)
  const { token } = await res.json()
  saveToken(token)
  return token
}

// ── API key management ───────────────────────────────────────────────────────

/**
 * Store the user's API key on the relay (encrypted at rest).
 * @param {string} provider - "anthropic" | "openai" | "google" | "groq" | etc.
 * @param {string} apiKey - The raw API key from the user
 */
export async function storeKey(provider, apiKey) {
  const token = await ensureToken()
  const res = await fetch(`${RELAY_URL}/keys/${provider}`, {
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
 * List which providers have stored keys (values are never returned).
 */
export async function listKeys() {
  const token = getToken()
  if (!token) return []
  const res = await fetch(`${RELAY_URL}/keys`, {
    headers: { 'x-relay-token': token },
  })
  if (!res.ok) return []
  return res.json()
}

/**
 * Delete a stored key.
 */
export async function deleteKey(provider) {
  const token = getToken()
  if (!token) return
  await fetch(`${RELAY_URL}/keys/${provider}`, {
    method: 'DELETE',
    headers: { 'x-relay-token': token },
  })
}

// ── Streaming relay ──────────────────────────────────────────────────────────

/**
 * Stream a chat completion through byok-relay.
 *
 * Supports Anthropic Messages API and OpenAI Chat Completions API.
 * Calls onChunk(text) for each streamed token, returns full response text.
 *
 * @param {Object} opts
 * @param {"anthropic"|"openai"} opts.provider
 * @param {string} opts.model
 * @param {Array<{role: string, content: string}>} opts.messages
 * @param {function(string): void} opts.onChunk - called with each text delta
 * @returns {Promise<string>} full response text
 */
export async function streamChat({ provider, model, messages, onChunk }) {
  const token = await ensureToken()

  let url, headers, body

  if (provider === 'anthropic') {
    url = `${RELAY_URL}/relay/anthropic/v1/messages`
    headers = {
      'Content-Type': 'application/json',
      'x-relay-token': token,
      'anthropic-version': '2023-06-01',
    }
    body = JSON.stringify({
      model,
      max_tokens: 1024,
      stream: true,
      messages,
    })
  } else if (provider === 'openai') {
    url = `${RELAY_URL}/relay/openai/v1/chat/completions`
    headers = {
      'Content-Type': 'application/json',
      'x-relay-token': token,
    }
    body = JSON.stringify({
      model,
      stream: true,
      messages,
    })
  } else {
    throw new Error(`Unsupported provider: ${provider}`)
  }

  const res = await fetch(url, { method: 'POST', headers, body })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Relay request failed: ${res.status}`)
  }

  // Parse SSE stream
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let fullText = ''
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') continue

      try {
        const json = JSON.parse(data)

        // Anthropic SSE format
        if (json.type === 'content_block_delta' && json.delta?.text) {
          fullText += json.delta.text
          onChunk?.(json.delta.text)
        }

        // OpenAI SSE format
        const delta = json.choices?.[0]?.delta?.content
        if (delta) {
          fullText += delta
          onChunk?.(delta)
        }
      } catch {
        // skip malformed SSE lines
      }
    }
  }

  return fullText
}

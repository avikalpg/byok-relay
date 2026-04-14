/**
 * Provider-specific request forwarding.
 *
 * Built-in providers: anthropic, openai, google, groq
 *
 * Generic OpenAI-compatible passthrough:
 *   Any provider registered as `openai-compatible:<base-url>` will be forwarded
 *   using Bearer token auth to the given base URL. This covers:
 *   OpenRouter, LiteLLM, Groq, Mistral, Ollama, etc.
 *
 * Adding a new built-in provider: add an entry to PROVIDERS below.
 * Adding a custom OpenAI-compatible endpoint: no code change needed —
 *   the user stores their key under a name like `openrouter` and passes
 *   the base URL as a header `x-relay-base-url`.
 */
const fetch = require('node-fetch');

const PROVIDERS = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    buildHeaders: (apiKey, extraHeaders = {}) => ({
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': extraHeaders['anthropic-version'] || '2023-06-01',
      ...Object.fromEntries(
        Object.entries(extraHeaders).filter(([k]) =>
          k.startsWith('anthropic-') && k !== 'anthropic-version'
        )
      ),
    }),
  },

  openai: {
    baseUrl: 'https://api.openai.com',
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }),
  },

  google: {
    // Gemini API — key is passed as query param; ?alt=sse required for SSE streaming
    baseUrl: 'https://generativelanguage.googleapis.com',
    buildHeaders: () => ({ 'Content-Type': 'application/json' }),
    buildUrl: (baseUrl, path, apiKey) => {
      // Add alt=sse for streaming endpoints, plus the API key
      const isStreaming = path.includes('stream');
      const params = new URLSearchParams({ key: apiKey });
      if (isStreaming) params.set('alt', 'sse');
      const sep = path.includes('?') ? '&' : '?';
      return `${baseUrl}${path}${sep}${params.toString()}`;
    },
  },

  groq: {
    baseUrl: 'https://api.groq.com',
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }),
  },

  openrouter: {
    baseUrl: 'https://openrouter.ai',
    buildHeaders: (apiKey, extraHeaders = {}) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      // OpenRouter requires HTTP-Referer and optionally X-Title
      'HTTP-Referer': extraHeaders['http-referer'] || extraHeaders['x-relay-referer'] || 'https://github.com/avikalpg/byok-relay',
      ...(extraHeaders['x-title'] ? { 'X-Title': extraHeaders['x-title'] } : {}),
    }),
  },

  mistral: {
    baseUrl: 'https://api.mistral.ai',
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }),
  },

  /**
   * Generic OpenAI-compatible passthrough.
   * Client must pass `x-relay-base-url` header with the target base URL.
   * Key name in storage can be anything (e.g. "my-ollama", "company-llm").
   */
  'openai-compatible': {
    baseUrl: null, // determined per-request from x-relay-base-url header
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }),
  },
};

/**
 * Forward a request to the AI provider.
 * Returns a node-fetch Response (streaming-capable).
 *
 * @param {string} provider - Provider name from PROVIDERS
 * @param {string} path - URL path to forward (e.g. /v1/messages)
 * @param {string} method - HTTP method
 * @param {object} body - Request body
 * @param {string} apiKey - Decrypted API key
 * @param {object} extraHeaders - Additional headers from the original request
 */
async function forwardRequest(provider, path, method, body, apiKey, extraHeaders = {}) {
  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  let baseUrl = config.baseUrl;

  // For openai-compatible, the base URL comes from the request header
  if (provider === 'openai-compatible') {
    baseUrl = extraHeaders['x-relay-base-url'];
    if (!baseUrl) {
      throw new Error('x-relay-base-url header required for openai-compatible provider');
    }
    // Strip trailing slash
    baseUrl = baseUrl.replace(/\/$/, '');
  }

  const headers = config.buildHeaders(apiKey, extraHeaders);

  // Some providers (Google) put the key in the URL
  const url = config.buildUrl
    ? config.buildUrl(baseUrl, path, apiKey)
    : `${baseUrl}${path}`;

  const response = await fetch(url, {
    method,
    headers,
    body: method !== 'GET' ? JSON.stringify(body) : undefined,
  });

  return response;
}

const SUPPORTED_PROVIDERS = Object.keys(PROVIDERS);

module.exports = { forwardRequest, SUPPORTED_PROVIDERS };

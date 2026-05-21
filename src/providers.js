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

// ── SSRF protection ──────────────────────────────────────────────────────────
// Blocked IP ranges: RFC-1918 private, loopback, link-local, and cloud IMDS
// endpoints. Used to validate the `x-relay-base-url` header for the
// `openai-compatible` provider.

/**
 * CIDR block descriptor as a pair [baseInt, prefixBits].
 * All comparisons are done on 32-bit unsigned integers (IPv4 only).
 */
const BLOCKED_CIDRS = [
  '127.0.0.0/8',       // loopback
  '10.0.0.0/8',        // RFC-1918 class A
  '172.16.0.0/12',     // RFC-1918 class B
  '192.168.0.0/16',    // RFC-1918 class C
  '169.254.0.0/16',    // link-local / AWS IMDS (169.254.169.254)
  '100.64.0.0/10',     // Shared address space (RFC 6598)
  '0.0.0.0/8',         // "This" network
  '192.0.2.0/24',      // TEST-NET-1 (RFC 5737)
  '198.51.100.0/24',   // TEST-NET-2
  '203.0.113.0/24',    // TEST-NET-3
  '240.0.0.0/4',       // Reserved
  '255.255.255.255/32',// Broadcast
  '100.100.100.200/32',// Alibaba Cloud IMDS
].map(cidr => {
  const [ip, bits] = cidr.split('/');
  const prefixBits = parseInt(bits, 10);
  const parts = ip.split('.').map(Number);
  const baseInt = (parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3]) >>> 0;
  const mask = prefixBits === 0 ? 0 : (0xFFFFFFFF << (32 - prefixBits)) >>> 0;
  return { baseInt, mask };
});

/** Convert a dotted-decimal IPv4 string to a 32-bit unsigned integer. */
function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some(n => isNaN(n) || n < 0 || n > 255)) return null;
  return (nums[0] << 24 | nums[1] << 16 | nums[2] << 8 | nums[3]) >>> 0;
}

/** Return true if ipStr falls inside any blocked CIDR range. */
function isBlockedIp(ipStr) {
  const ipInt = ipToInt(ipStr);
  if (ipInt === null) return false; // non-IPv4 strings can't be matched
  // Use `>>> 0` to coerce the bitwise-AND result back to an unsigned 32-bit
  // integer before comparing, because JS `&` returns a signed 32-bit value.
  return BLOCKED_CIDRS.some(({ baseInt, mask }) => ((ipInt & mask) >>> 0) === baseInt);
}

/**
 * Validate that a client-supplied base URL is safe to use as an upstream
 * target.  Throws with a descriptive message on any policy violation.
 *
 * Rules enforced:
 *  1. Must be a valid URL.
 *  2. Must use HTTPS.
 *  3. Hostname must not be a raw IP address that falls in a blocked range.
 *  4. Normalized to `url.origin` only — any path, credentials, or query
 *     string supplied by the client is stripped before the URL is used.
 */
function validateAndNormaliseBaseUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('x-relay-base-url must be a valid URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('x-relay-base-url must use HTTPS');
  }

  const hostname = parsed.hostname;

  // Block raw IPv4 addresses in private / link-local ranges
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new Error('x-relay-base-url must not target a private or reserved IP address');
    }
  }

  // Block localhost by name
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('x-relay-base-url must not target localhost');
  }

  // Return only the origin (scheme + host + port) — strip any path the
  // client may have embedded to prevent path-injection attacks.
  return parsed.origin;
}

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

  // For openai-compatible, the base URL comes from the request header.
  // Validate and normalise it to prevent SSRF attacks.
  if (provider === 'openai-compatible') {
    const rawBaseUrl = extraHeaders['x-relay-base-url'];
    if (!rawBaseUrl) {
      throw new Error('x-relay-base-url header required for openai-compatible provider');
    }
    // validateAndNormaliseBaseUrl throws on any policy violation and returns
    // url.origin (scheme + host + port), stripping any path the client embedded.
    baseUrl = validateAndNormaliseBaseUrl(rawBaseUrl);
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

module.exports = { forwardRequest, SUPPORTED_PROVIDERS, validateAndNormaliseBaseUrl };

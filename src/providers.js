/**
 * Provider-specific request forwarding.
 *
 * Built-in providers: anthropic, openai, google, groq, elevenlabs, huggingface, deepgram
 *
 * Generic OpenAI-compatible passthrough:
 *   Any provider registered as `openai-compatible:<base-url>` will be forwarded
 *   using Bearer token auth to the given base URL. This covers:
 *   OpenRouter, LiteLLM, Groq, Mistral, Ollama, etc.
 *
 * Adding a new built-in provider: add an entry to PROVIDERS below.
 *   - allowedPaths: array of permitted path prefixes (string match). Required.
 *   - binaryResponse: true if provider may return non-JSON binary responses
 *     (audio, images). The relay will stream binary responses to the client
 *     without calling .json().
 *   - rawBody: true if the provider may receive raw binary request bodies
 *     (e.g. audio file uploads). The relay will pass the raw buffer through
 *     instead of JSON-serialising req.body.
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

// ── IPv6 blocked ranges ──────────────────────────────────────────────────────
// Covers loopback (::1), link-local (fe80::/10), unique-local (fc00::/7),
// and IPv4-mapped addresses (::ffff:x.x.x.x /96) which can resolve to
// private IPv4 ranges including IMDS at ::ffff:169.254.169.254.

const BLOCKED_IPV6 = [
  { prefix: 0x00000000000000000000000000000001n,
    mask:   0xffffffffffffffffffffffffffffffffn },  // ::1  loopback
  { prefix: 0xfe800000000000000000000000000000n,
    mask:   0xffc00000000000000000000000000000n },  // fe80::/10  link-local
  { prefix: 0xfc000000000000000000000000000000n,
    mask:   0xfe000000000000000000000000000000n },  // fc00::/7   unique-local
  { prefix: 0x00000000000000000000ffff00000000n,
    mask:   0xffffffffffffffffffffffff00000000n },  // ::ffff:0:0/96  IPv4-mapped
];

/**
 * Parse a colon-separated IPv6 address string (without surrounding brackets)
 * into a 128-bit BigInt.  Returns null on any parse error.
 */
function ipv6ToBigInt(addr) {
  try {
    let expandedAddr = addr;

    // Handle mixed IPv4 tail (e.g. ::ffff:192.168.1.1)
    if (addr.includes('.')) {
      const lastColon = addr.lastIndexOf(':');
      const ipv4Parts = addr.slice(lastColon + 1).split('.').map(Number);
      if (ipv4Parts.length !== 4 || ipv4Parts.some(n => isNaN(n) || n < 0 || n > 255)) return null;
      const hex = ipv4Parts.map(n => n.toString(16).padStart(2, '0')).join('');
      expandedAddr = addr.slice(0, lastColon + 1) + hex.slice(0, 4) + ':' + hex.slice(4);
    }

    // Expand '::' shorthand
    let parts;
    if (expandedAddr.includes('::')) {
      const [left, right] = expandedAddr.split('::');
      const leftParts  = left  ? left.split(':')  : [];
      const rightParts = right ? right.split(':') : [];
      const missing    = 8 - leftParts.length - rightParts.length;
      if (missing < 0) return null;
      parts = [...leftParts, ...Array(missing).fill('0'), ...rightParts];
    } else {
      parts = expandedAddr.split(':');
    }

    if (parts.length !== 8) return null;
    return parts.reduce((acc, p) => {
      if (acc === null) return null;
      const v = parseInt(p || '0', 16);
      if (isNaN(v) || v < 0 || v > 0xffff) return null;
      return (acc << 16n) | BigInt(v);
    }, 0n);
  } catch {
    return null;
  }
}

/** Return true if an IPv6 address string (without brackets) is in a blocked range. */
function isBlockedIpv6(addr) {
  const addrInt = ipv6ToBigInt(addr);
  if (addrInt === null) return false;
  return BLOCKED_IPV6.some(({ prefix, mask }) => (addrInt & mask) === prefix);
}

/**
 * Structured error thrown for client-supplied URL policy violations.
 * Caught in index.js and returned as HTTP 400 — the client's input is
 * at fault, not a server-side relay failure (which would be 502).
 */
class RelayUrlValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RelayUrlValidationError';
    this.code = 'INVALID_RELAY_BASE_URL';
  }
}

/**
 * Validate that a client-supplied base URL is safe to use as an upstream
 * target.  Throws RelayUrlValidationError on any policy violation.
 *
 * Rules enforced:
 *  1. Must be a valid URL.
 *  2. Must use HTTPS.
 *  3. IPv4 hostname must not fall in a private/reserved CIDR range.
 *  4. IPv6 hostname must not fall in a blocked range (::1, fe80::/10,
 *     fc00::/7, ::ffff:0:0/96).
 *  5. 'localhost' (and *.localhost) is blocked by name.
 *  6. Normalised to url.origin — path/credentials/query stripped to
 *     prevent path-injection.
 */
function validateAndNormaliseBaseUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RelayUrlValidationError('x-relay-base-url must be a valid URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new RelayUrlValidationError('x-relay-base-url must use HTTPS');
  }

  const hostname = parsed.hostname;

  // Block raw IPv4 addresses in private / link-local / reserved ranges
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new RelayUrlValidationError(
        'x-relay-base-url must not target a private or reserved IP address',
      );
    }
  }

  // Block IPv6 literals.  WHATWG URL preserves brackets in hostname
  // (e.g. new URL('https://[::1]').hostname === '[::1]'), so strip them
  // before passing to the parser.
  const ipv6Bare = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (ipv6Bare.includes(':')) {
    if (isBlockedIpv6(ipv6Bare)) {
      throw new RelayUrlValidationError(
        'x-relay-base-url must not target a private or reserved IP address',
      );
    }
  }

  // Block localhost by name.
  // Strip trailing dot first: 'localhost.' parses as-is in Node but still
  // resolves to 127.0.0.1 on most systems, so normalise before comparing.
  const hostForNameCheck = hostname.replace(/\.$/, '');
  if (hostForNameCheck === 'localhost' || hostForNameCheck.endsWith('.localhost')) {
    throw new RelayUrlValidationError('x-relay-base-url must not target localhost');
  }

  // Return only the origin (scheme + host + port) — strip any path the
  // client may have embedded to prevent path-injection attacks.
  return parsed.origin;
}

const PROVIDERS = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    allowedPaths: ['/v1/messages', '/v1/complete'],
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
    allowedPaths: ['/v1/chat/completions', '/v1/completions', '/v1/embeddings', '/v1/responses'],
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }),
  },

  google: {
    // Gemini API — key is passed as query param; ?alt=sse required for SSE streaming
    baseUrl: 'https://generativelanguage.googleapis.com',
    allowedPaths: ['/v1beta/models/', '/v1/models/'],
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
    allowedPaths: ['/openai/v1/chat/completions', '/openai/v1/completions', '/openai/v1/embeddings'],
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }),
  },

  openrouter: {
    baseUrl: 'https://openrouter.ai',
    allowedPaths: ['/api/v1/chat/completions', '/api/v1/completions', '/api/v1/embeddings'],
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
    allowedPaths: ['/v1/chat/completions', '/v1/completions', '/v1/embeddings', '/v1/fim/completions'],
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }),
  },

  /**
   * ElevenLabs — text-to-speech, speech-to-speech, sound generation.
   * API key: xi-api-key header.
   * TTS responses are binary audio (mp3/pcm/ulaw). STT requests may send raw audio.
   * Docs: https://elevenlabs.io/docs/api-reference
   */
  elevenlabs: {
    baseUrl: 'https://api.elevenlabs.io',
    allowedPaths: [
      '/v1/text-to-speech/',
      '/v1/speech-to-speech/',
      '/v1/sound-generation',
      '/v1/audio-isolation',
      '/v1/voice-generation',
      '/v1/voices',
    ],
    binaryResponse: true,  // TTS returns audio/mpeg or audio/pcm
    buildHeaders: (apiKey, extraHeaders = {}) => ({
      'xi-api-key': apiKey,
      // Content-Type is forwarded from the caller; default to JSON for TTS
      'Content-Type': extraHeaders['content-type'] || 'application/json',
    }),
  },

  /**
   * HuggingFace Inference API — NLP, image, audio, multimodal models.
   * API key: Bearer token.
   * Response varies: JSON for NLP/classification, binary for image/audio generation.
   * Docs: https://huggingface.co/docs/api-inference/index
   */
  huggingface: {
    baseUrl: 'https://api-inference.huggingface.co',
    allowedPaths: ['/models/'],
    binaryResponse: true,  // image/audio models return binary; relay detects Content-Type
    buildHeaders: (apiKey, extraHeaders = {}) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': extraHeaders['content-type'] || 'application/json',
    }),
  },

  /**
   * Deepgram — speech-to-text (transcription) and text-to-speech.
   * API key: Token scheme (not Bearer).
   * /v1/listen accepts audio binary body; /v1/speak returns audio binary.
   * Docs: https://developers.deepgram.com/reference
   */
  deepgram: {
    baseUrl: 'https://api.deepgram.com',
    allowedPaths: [
      '/v1/listen',
      '/v1/speak',
      '/v1/read',
    ],
    binaryResponse: true,  // /v1/speak returns audio/mpeg
    rawBody: true,         // /v1/listen may receive raw audio binary upload
    buildHeaders: (apiKey, extraHeaders = {}) => ({
      'Authorization': `Token ${apiKey}`,
      'Content-Type': extraHeaders['content-type'] || 'application/json',
    }),
  },

  /**
   * Generic OpenAI-compatible passthrough.
   * Client must pass `x-relay-base-url` header with the target base URL.
   * Key name in storage can be anything (e.g. "my-ollama", "company-llm").
   */
  'openai-compatible': {
    baseUrl: null, // determined per-request from x-relay-base-url header
    allowedPaths: [
      '/v1/chat/completions', '/v1/completions', '/v1/embeddings',
      '/api/v1/chat/completions', '/api/v1/completions', '/api/v1/embeddings',
      '/openai/v1/chat/completions', '/openai/v1/completions',
    ],
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }),
  },
};

/**
 * Return true if `path` starts with any allowed prefix for `provider`.
 * Applies path.posix.normalize() to neutralise dot-segment traversal before
 * matching (e.g. '/v1/messages/../files' normalises to '/v1/files' which is
 * then correctly blocked).
 *
 * Providers without an allowedPaths array pass all paths.
 *
 * @param {string} provider
 * @param {string} path
 * @returns {boolean}
 */
function isPathAllowed(provider, path) {
  const config = PROVIDERS[provider];
  if (!config || !config.allowedPaths) return true; // no allowlist → allow all
  const { posix } = require('path');
  const normalised = posix.normalize(path);
  return config.allowedPaths.some(prefix => normalised.startsWith(prefix));
}

/**
 * Forward a request to the AI provider.
 * Returns a node-fetch Response (streaming-capable).
 *
 * @param {string} provider - Provider name from PROVIDERS
 * @param {string} path - URL path to forward (e.g. /v1/messages)
 * @param {string} method - HTTP method
 * @param {object|Buffer|null} body - Parsed JSON body, raw Buffer, or null
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
      throw new RelayUrlValidationError('x-relay-base-url header is required for openai-compatible provider');
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

  // Determine the request body to forward.
  // - If body is already a Buffer (raw binary, e.g. audio upload), pass through.
  // - If there is no body or method is GET, send nothing.
  // - Otherwise JSON-serialise the parsed body object.
  let fetchBody;
  if (method === 'GET' || body === null || body === undefined) {
    fetchBody = undefined;
  } else if (Buffer.isBuffer(body)) {
    fetchBody = body; // raw binary pass-through (e.g. Deepgram STT audio)
  } else {
    fetchBody = JSON.stringify(body);
  }

  const response = await fetch(url, {
    method,
    headers,
    body: fetchBody,
  });

  return response;
}

/**
 * Return provider config metadata flags used by the relay handler.
 *
 * @param {string} provider
 * @returns {{ binaryResponse: boolean, rawBody: boolean }}
 */
function getProviderMeta(provider) {
  const config = PROVIDERS[provider] || {};
  return {
    binaryResponse: config.binaryResponse === true,
    rawBody: config.rawBody === true,
  };
}

const SUPPORTED_PROVIDERS = Object.keys(PROVIDERS);

module.exports = { forwardRequest, getProviderMeta, isPathAllowed, SUPPORTED_PROVIDERS, validateAndNormaliseBaseUrl };

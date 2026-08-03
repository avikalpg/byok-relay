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
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const fetch = require('node-fetch');
const nodePath = require('path');

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

function stripIpv6Brackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isBlockedAddress(address, family) {
  if (family === 4) return isBlockedIp(address);
  if (family === 6) return isBlockedIpv6(address);
  return false;
}

function createPinnedHttpsAgent({ address, family }) {
  return new https.Agent({
    lookup(_hostname, options, callback) {
      if (options?.all) {
        callback(null, [{ address, family }]);
        return;
      }
      callback(null, address, family);
    },
  });
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
 *  3. Must not include embedded credentials.
 *  4. IPv4 hostname must not fall in a private/reserved CIDR range.
 *  5. IPv6 hostname must not fall in a blocked range (::1, fe80::/10,
 *     fc00::/7, ::ffff:0:0/96).
 *  6. 'localhost' (and *.localhost) is blocked by name.
 *  7. Hostnames must resolve only to public IP ranges.
 *  8. Normalised to url.origin — path/query stripped to prevent path-injection.
 */
async function validateAndNormaliseBaseUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RelayUrlValidationError('x-relay-base-url must be a valid URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new RelayUrlValidationError('x-relay-base-url must use HTTPS');
  }

  if (parsed.username || parsed.password) {
    throw new RelayUrlValidationError('x-relay-base-url must not include embedded credentials');
  }

  const hostname = parsed.hostname;
  const ipv6Bare = stripIpv6Brackets(hostname);
  let approvedAddress;

  // Block raw IP addresses in private / link-local / reserved ranges.
  const literalFamily = net.isIP(ipv6Bare);
  if (literalFamily !== 0) {
    if (isBlockedAddress(ipv6Bare, literalFamily)) {
      throw new RelayUrlValidationError(
        'x-relay-base-url must not target a private or reserved IP address',
      );
    }
    approvedAddress = { address: ipv6Bare, family: literalFamily };
  }

  // Block IPv6 literals.  WHATWG URL preserves brackets in hostname
  // (e.g. new URL('https://[::1]').hostname === '[::1]'), so strip them
  // before passing to the parser. The literalFamily branch above handles both
  // IPv4 and IPv6 literals.

  // Block localhost by name.
  // Strip trailing dot first: 'localhost.' parses as-is in Node but still
  // resolves to 127.0.0.1 on most systems, so normalise before comparing.
  const hostForNameCheck = hostname.replace(/\.$/, '');
  if (hostForNameCheck === 'localhost' || hostForNameCheck.endsWith('.localhost')) {
    throw new RelayUrlValidationError('x-relay-base-url must not target localhost');
  }

  // Hostname SSRF protection: reject DNS names that resolve to private,
  // loopback, link-local, reserved, or IMDS ranges. IP literals were already
  // checked above, so only perform resolver work for real hostnames.
  if (literalFamily === 0) {
    let addresses;
    try {
      addresses = await dns.lookup(hostForNameCheck, { all: true });
    } catch {
      throw new RelayUrlValidationError('x-relay-base-url hostname could not be resolved safely');
    }

    if (!addresses.length) {
      throw new RelayUrlValidationError('x-relay-base-url hostname could not be resolved safely');
    }

    for (const { address, family } of addresses) {
      if (isBlockedAddress(address, family)) {
        throw new RelayUrlValidationError(
          'x-relay-base-url must not resolve to a private or reserved IP address',
        );
      }
    }

    // Pin the actual request to one address that passed validation so a later
    // DNS answer cannot rebind the approved hostname to a private target.
    approvedAddress = addresses[0];
  }

  // Return only the origin (scheme + host + port) and a pinned agent — strip
  // any path the client may have embedded to prevent path-injection attacks.
  return {
    origin: parsed.origin,
    agent: createPinnedHttpsAgent(approvedAddress),
  };
}

function getE2eBaseUrlOverride(extraHeaders) {
  if (process.env.NODE_ENV !== 'test') return null;

  const overrideBaseUrl = process.env.E2E_OPENAI_COMPATIBLE_BASE_URL;
  const overrideToken = process.env.E2E_OPENAI_COMPATIBLE_BASE_URL_TOKEN;
  if (!overrideBaseUrl || !overrideToken) return null;

  return extraHeaders['x-relay-e2e-base-url-token'] === overrideToken
    ? overrideBaseUrl
    : null;
}

// ── Path traversal allowlist ────────────────────────────────────────────────
// Each provider defines the path prefixes that are permitted to be forwarded.
// Any path not matching an allowed prefix is rejected with 403.
// This prevents a stolen relay token from being used to access non-inference
// endpoints (fine-tuning, file uploads, billing, model deletion, etc.).
//
// Rules:
// - Paths are matched as prefixes (startsWith), case-sensitive.
// - A trailing '*' is symbolic only — matching is always prefix-based.
// - For 'openai-compatible', a broad inference set covers the common case;
//   callers that need more paths should use named providers.

/**
 * Check whether a request path is allowed for the given provider.
 * Returns true if allowed, false if it should be blocked.
 *
 * @param {string} provider - Provider name from PROVIDERS
 * @param {string} path - Forward path starting with '/'
 */
function safeDecodePath(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function normalizeProviderPath(path) {
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
  const decodedPath = safeDecodePath(withLeadingSlash);
  const normalizedPath = nodePath.posix.normalize(decodedPath);
  return normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
}

function isPathAllowed(provider, path) {
  const config = PROVIDERS[provider];
  if (!config) return false;

  // If provider defines no allowedPaths, default to deny
  const allowed = config.allowedPaths;
  if (!allowed || allowed.length === 0) return false;

  // Normalize the path to collapse dot-segments before prefix matching.
  // This prevents traversal payloads like '/v1/chat/completions/../files'
  // from bypassing the allowlist by starting with an allowed prefix.
  const normalizedPath = normalizeProviderPath(path);

  return allowed.some(prefix => {
    const normalizedPrefix = normalizeProviderPath(prefix);
    return normalizedPath === normalizedPrefix || normalizedPath.startsWith(normalizedPrefix + '/') || normalizedPath.startsWith(normalizedPrefix + '?');
  });
}

const PROVIDERS = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    // Allowed inference paths for Anthropic
    allowedPaths: [
      '/v1/messages',
      '/v1/complete',
    ],
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
    // Allowed inference paths for OpenAI
    allowedPaths: [
      '/v1/chat/completions',
      '/v1/completions',
      '/v1/embeddings',
      '/v1/responses',
    ],
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }),
  },

  google: {
    // Gemini API — key is passed as query param; ?alt=sse required for SSE streaming
    baseUrl: 'https://generativelanguage.googleapis.com',
    // Allowed inference paths for Google Gemini
    // Paths are like /v1beta/models/{model}:generateContent
    allowedPaths: [
      '/v1beta/models',
      '/v1/models',
    ],
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
    // Allowed inference paths for Groq
    allowedPaths: [
      '/openai/v1/chat/completions',
      '/openai/v1/completions',
      '/openai/v1/embeddings',
    ],
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }),
  },

  openrouter: {
    baseUrl: 'https://openrouter.ai',
    // Allowed inference paths for OpenRouter
    allowedPaths: [
      '/api/v1/chat/completions',
      '/api/v1/completions',
      '/api/v1/embeddings',
    ],
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
    // Allowed inference paths for Mistral
    allowedPaths: [
      '/v1/chat/completions',
      '/v1/completions',
      '/v1/embeddings',
      '/v1/fim/completions',
    ],
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
      '/v1/text-to-speech',
      '/v1/speech-to-speech',
      '/v1/sound-generation',
      '/v1/audio-isolation',
      '/v1/voice-generation',
      '/v1/voices',
    ],
    binaryResponse: true,
    buildHeaders: (apiKey, extraHeaders = {}) => ({
      'xi-api-key': apiKey,
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
    allowedPaths: ['/models'],
    binaryResponse: true,
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
    binaryResponse: true,
    rawBody: true,
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
    // Allowed inference paths for generic OpenAI-compatible endpoints
    // Covers the most common inference APIs; non-inference paths are blocked.
    allowedPaths: [
      '/v1/chat/completions',
      '/v1/completions',
      '/v1/embeddings',
      '/v1/messages',
      '/v1/responses',
      '/api/v1/chat/completions',
      '/api/v1/completions',
      '/api/v1/embeddings',
      '/openai/v1/chat/completions',
      '/openai/v1/completions',
      '/openai/v1/embeddings',
    ],
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
/**
 * Strip CRLF and null bytes from a header value to prevent header injection.
 * Returns the sanitised string.
 */
function sanitiseHeaderValue(value) {
  if (typeof value !== 'string') return value;
  // Remove CR (\r), LF (\n), and null (\0) — the classic header injection chars.
  return value.replace(/[\r\n\0]/g, '');
}

/**
 * Return a copy of extraHeaders with all values sanitised against CRLF injection.
 */
function sanitiseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = sanitiseHeaderValue(v);
  }
  return out;
}

async function forwardRequest(provider, path, method, body, apiKey, extraHeaders = {}, options = {}) {
  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  let baseUrl = config.baseUrl;
  const fetchOptions = {};
  const e2eBaseUrl = getE2eBaseUrlOverride(extraHeaders);

  // Sanitise all passthrough header values before they touch any downstream call.
  // Prevents CRLF injection: a \r\n in a header value can inject arbitrary
  // headers into the outbound request to the AI provider.
  const safeExtraHeaders = sanitiseHeaders(extraHeaders);

  // For openai-compatible, the base URL comes from the request header.
  // Validate and normalise it to prevent SSRF attacks.
  if (provider === 'openai-compatible') {
    const rawBaseUrl = safeExtraHeaders['x-relay-base-url'];
    if (!rawBaseUrl) {
      throw new RelayUrlValidationError('x-relay-base-url header is required for openai-compatible provider');
    }
    // validateAndNormaliseBaseUrl throws on any policy violation and returns
    // url.origin (scheme + host + port), stripping any path the client embedded,
    // plus a custom agent pinned to the DNS result that passed validation.
    const validatedBaseUrl = await validateAndNormaliseBaseUrl(rawBaseUrl);
    baseUrl = validatedBaseUrl.origin;
    fetchOptions.agent = validatedBaseUrl.agent;
    fetchOptions.redirect = 'manual';

    // E2E tests need a loopback HTTPS mock provider, but production requests
    // must reject hostnames such as localtest.me that resolve to loopback. Keep
    // the public header validation path intact, then swap in the mock base URL
    // only when the test runner supplies a one-off process-local token.
    if (e2eBaseUrl) {
      baseUrl = e2eBaseUrl;
      delete fetchOptions.agent;
    }
  } else if (e2eBaseUrl) {
    // E2E tests may route built-in providers to the local mock server so
    // allowlist smoke tests never contact real vendor APIs.
    baseUrl = e2eBaseUrl;
  }

  const headers = config.buildHeaders(apiKey, safeExtraHeaders);

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
    fetchBody = body;
  } else {
    fetchBody = JSON.stringify(body);
  }

  // Hard 30-second timeout on every upstream provider request. Combine it with
  // any caller-supplied abort signal so hung providers and disconnected clients
  // both tear down the upstream fetch promptly.
  const controller = new AbortController();
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : 30_000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener('abort', abortFromCaller, { once: true });
    }
  }

  let response;
  try {
    response = await fetch(url, {
      ...fetchOptions,
      method,
      headers,
      body: fetchBody,
      signal: controller.signal,
    });
  } finally {
    // Always clear the timeout — whether the fetch succeeded, threw, or aborted.
    clearTimeout(timeoutId);
    if (!response && options.signal) {
      options.signal.removeEventListener('abort', abortFromCaller);
    }
  }

  if (options.signal && response.body) {
    const cleanupAbortListener = () => {
      options.signal.removeEventListener('abort', abortFromCaller);
    };
    response.body.once('close', cleanupAbortListener);
    response.body.once('end', cleanupAbortListener);
    response.body.once('error', cleanupAbortListener);
  } else if (options.signal) {
    options.signal.removeEventListener('abort', abortFromCaller);
  }

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

// ── Per-provider API key format validation ──────────────────────────────────────────
//
// Each entry has:
//   test(key)  → true if the key looks valid
//   hint       → human-readable error shown when the test fails

const PROVIDER_KEY_VALIDATORS = {
  openai: {
    // OpenAI keys start with `sk-` but NOT `sk-ant-` (Anthropic prefix).
    // Accept both legacy `sk-<20+>` and newer `sk-proj-` / `sk-svcacct-` formats.
    test: (k) => k.startsWith('sk-') && !k.startsWith('sk-ant-'),
    hint: 'OpenAI API keys start with sk- (e.g. sk-proj-... or sk-...); make sure you are not pasting an Anthropic key',
  },
  anthropic: {
    test: (k) => k.startsWith('sk-ant-'),
    hint: 'Anthropic API keys start with sk-ant-',
  },
  google: {
    // API keys are AIza followed by 35 alphanumeric chars (39 total).
    // Service-account JSON and OAuth tokens are much longer; accept those too.
    test: (k) => /^AIza[\w-]{35}$/.test(k) || k.length > 50,
    hint: 'Google API keys start with AIza and are 39 characters long',
  },
  groq: {
    test: (k) => k.startsWith('gsk_'),
    hint: 'Groq API keys start with gsk_',
  },
  openrouter: {
    test: (k) => k.startsWith('sk-or-'),
    hint: 'OpenRouter API keys start with sk-or-',
  },
  mistral: {
    // Mistral uses random alphanumeric strings with no enforced prefix.
    // Validate only that it’s at least 32 characters to catch obvious mistakes.
    test: (k) => k.length >= 32,
    hint: 'Mistral API keys are at least 32 characters long',
  },
  // openai-compatible: any string passes; provider is user-defined.
};

/**
 * Validate that a plaintext API key looks correct for the given provider.
 *
 * @param {string} provider  - Provider name from SUPPORTED_PROVIDERS
 * @param {string} key       - Trimmed plaintext API key
 * @returns {{ valid: boolean, hint: string | null }}
 *   `valid: true` + `hint: null`  → format looks correct
 *   `valid: false` + `hint: '…'` → format looks wrong; hint explains expected format
 */
function validateProviderKeyFormat(provider, key) {
  const validator = PROVIDER_KEY_VALIDATORS[provider];
  if (!validator) {
    // No specific validator for this provider — accept any non-empty key.
    return { valid: true, hint: null };
  }
  if (validator.test(key)) {
    return { valid: true, hint: null };
  }
  return { valid: false, hint: validator.hint };
}

// ── Per-provider lightweight key verification (live ping) ────────────────────
//
// Used by POST /keys/:provider/rotate to confirm the new key is accepted
// before replacing the old one.  Each ping is a lightweight read-only
// request that does not trigger any charges.
//
// Returns { ok: boolean, status: number, message?: string }

const PROVIDER_VERIFY = {
  openai: {
    url: 'https://api.openai.com/v1/models',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/models',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  },
  google: {
    url: (key) => `https://generativelanguage.googleapis.com/v1/models?key=${key}`,
    headers: () => ({}),
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/models',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/models',
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': 'https://github.com/avikalpg/byok-relay',
    }),
  },
  mistral: {
    url: 'https://api.mistral.ai/v1/models',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
};

/**
 * Verify a provider API key by making a lightweight read-only request.
 *
 * @param {string} provider   - Provider name from SUPPORTED_PROVIDERS
 * @param {string} apiKey     - Plaintext API key to test
 * @returns {Promise<{ ok: boolean, status: number, message?: string }>}
 *   `ok: true`  → key accepted by provider
 *   `ok: false` → key rejected; `status` and `message` carry the provider response
 */
async function verifyProviderKey(provider, apiKey) {
  const config = PROVIDER_VERIFY[provider];
  if (!config) {
    // No verification endpoint for this provider (e.g. openai-compatible).
    // Skip live ping and trust the format check.
    return { ok: true, status: 0, message: 'verification skipped (provider has no ping endpoint)' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10 s
  try {
    const url = typeof config.url === 'function' ? config.url(apiKey) : config.url;
    const headers = config.headers(apiKey);
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) return { ok: true, status: res.status };
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, message: body.slice(0, 200) };
  } catch (err) {
    clearTimeout(timeout);
    const message = err.name === 'AbortError' ? 'verification timed out' : err.message;
    return { ok: false, status: 0, message };
  }
}

/**
 * pingProvider — unauthenticated GET to a provider's models listing.
 * Used by GET /health?deep=1 to verify network reachability.
 *
 * We deliberately do NOT require an API key here — the purpose is connectivity
 * verification, not auth. A 401/403 means the network path works; a timeout
 * or 5xx means the provider is degraded.
 *
 * Returns { ok: boolean, statusCode: number }.
 * Throws on network error / timeout (AbortError).
 */
async function pingProvider(providerName) {
  const PING_PATHS = {
    openai: '/v1/models',
    anthropic: '/v1/models',
    google: '/v1beta/models',
    cohere: '/v2/models',
    mistral: '/v1/models',
    groq: '/openai/v1/models',
    together: '/v1/models',
    xai: '/v1/models',
    deepseek: '/v1/models',
    perplexity: '/models',
    openrouter: '/api/v1/models',
  };

  const config = PROVIDERS[providerName];
  if (!config) throw new Error(`Unknown provider: ${providerName}`);
  if (providerName === 'openai-compatible') {
    const err = new Error('openai-compatible deep health probes require a validated relay base URL');
    err.code = 'PING_UNSUPPORTED_PROVIDER';
    throw err;
  }

  const path = PING_PATHS[providerName] || '/v1/models';
  const baseUrl = config.baseUrl || 'https://api.openai.com';
  const url = `${baseUrl}${path}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    // 401/403 = auth required but network works = reachable
    // 200/206 = public endpoint, fully reachable
    // 5xx = provider degraded
    const ok = response.status < 500;
    return { ok, statusCode: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  forwardRequest,
  getProviderMeta,
  SUPPORTED_PROVIDERS,
  validateAndNormaliseBaseUrl,
  validateProviderKeyFormat,
  verifyProviderKey,
  pingProvider,
  isPathAllowed,
  normalizeProviderPath,
};

/**
 * Unified model routing for POST /relay.
 *
 * Resolves a `model` field (e.g. "anthropic/claude-3-5-haiku" or "gpt-4o")
 * to the correct { provider, path, modelName } triple for forwarding.
 *
 * Two resolution strategies, tried in order:
 *   1. Explicit prefix  — "anthropic/claude-haiku"  → provider=anthropic
 *   2. Pattern matching — "gpt-4o"                  → provider=openai
 *
 * For Google the forwarding path is dynamic (includes the model name).
 * For all other providers the path is a fixed default.
 *
 * Adding a new provider:
 *   1. Add a default path to PROVIDER_DEFAULT_PATHS (or null if dynamic).
 *   2. Add one or more patterns to MODEL_PATTERNS.
 *   3. Make sure the provider name matches an entry in src/providers.js.
 */

/**
 * Default inference path per provider.
 * Used when routing by explicit provider prefix ("anthropic/claude-…").
 *
 * null  → path is built dynamically (currently only Google).
 * Entry must exist for the prefix to be recognised as valid.
 */
const PROVIDER_DEFAULT_PATHS = {
  openai:             '/v1/chat/completions',
  anthropic:          '/v1/messages',
  google:             null,                         // dynamic: /v1beta/models/{model}:(stream)GenerateContent
  groq:               '/openai/v1/chat/completions',
  openrouter:         '/api/v1/chat/completions',
  mistral:            '/v1/chat/completions',
  // 'openai-compatible' is intentionally omitted — it requires x-relay-base-url,
  // which cannot be auto-resolved from a model name alone.
};

/**
 * Pattern-based routing for models that have no explicit provider prefix.
 * Evaluated in order; first match wins.
 *
 * path: string  → fixed forwarding path
 * path: null    → dynamic (Google only; built via buildGooglePath)
 */
const MODEL_PATTERNS = [
  // ── OpenAI ────────────────────────────────────────────────────────────────
  // GPT chat models (gpt-3.5-turbo, gpt-4, gpt-4o, gpt-4.5, …)
  { pattern: /^(gpt-|o[1-9][-\s]|chatgpt-)/i,  provider: 'openai',    path: '/v1/chat/completions' },
  // Embedding models
  { pattern: /^text-embedding-/i,               provider: 'openai',    path: '/v1/embeddings' },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  { pattern: /^claude-/i,                       provider: 'anthropic', path: '/v1/messages' },

  // ── Google ────────────────────────────────────────────────────────────────
  { pattern: /^gemini-/i,                       provider: 'google',    path: null }, // dynamic

  // ── Groq-hosted open models ───────────────────────────────────────────────
  { pattern: /^(llama-?[23]?[-_]|llama3?[-_])/i, provider: 'groq',    path: '/openai/v1/chat/completions' },
  { pattern: /^mixtral-/i,                      provider: 'groq',      path: '/openai/v1/chat/completions' },
  { pattern: /^gemma-/i,                        provider: 'groq',      path: '/openai/v1/chat/completions' },
  { pattern: /^qwen-/i,                         provider: 'groq',      path: '/openai/v1/chat/completions' },

  // ── Mistral ───────────────────────────────────────────────────────────────
  { pattern: /^(mistral-|codestral-|open-mistral)/i, provider: 'mistral', path: '/v1/chat/completions' },
];

/**
 * Build the Google Gemini inference path from a bare model name.
 *
 * @param {string} modelName - e.g. "gemini-2.0-flash" (no provider prefix)
 * @param {boolean} streaming - use streamGenerateContent when true
 * @returns {string}
 */
function buildGooglePath(modelName, streaming = false) {
  const action = streaming ? 'streamGenerateContent' : 'generateContent';
  return `/v1beta/models/${modelName}:${action}`;
}

/**
 * Resolve a model string to a routing triple.
 *
 * @param {string} model     - e.g. "anthropic/claude-3-5-haiku", "gpt-4o", "gemini-2.0-flash"
 * @param {boolean} streaming - whether the request will stream
 * @returns {{ provider: string, path: string, modelName: string } | null}
 *   Returns null when the model cannot be resolved to a known provider.
 */
function resolveModelRoute(model, streaming = false) {
  if (!model || typeof model !== 'string') return null;

  // ── Strategy 1: explicit provider prefix ("anthropic/claude-3-5-haiku") ──
  if (model.includes('/')) {
    const slashIdx  = model.indexOf('/');
    const prefix    = model.slice(0, slashIdx).toLowerCase();
    const modelName = model.slice(slashIdx + 1).trim();

    if (!modelName) return null;
    if (!Object.prototype.hasOwnProperty.call(PROVIDER_DEFAULT_PATHS, prefix)) {
      return null;
    }

    let path;
    if (prefix === 'google') {
      path = buildGooglePath(modelName, streaming);
    } else {
      path = PROVIDER_DEFAULT_PATHS[prefix];
    }
    // path can still be null for hypothetical future dynamic providers
    if (path === null) return null;
    return { provider: prefix, path, modelName };
  }

  // ── Strategy 2: pattern matching ─────────────────────────────────────────
  const bare = model;

  for (const { pattern, provider, path: basePath } of MODEL_PATTERNS) {
    if (pattern.test(bare)) {
      let path;
      if (provider === 'google') {
        path = buildGooglePath(bare, streaming);
      } else {
        path = basePath;
      }
      return { provider, path, modelName: bare };
    }
  }

  return null; // unrecognised model
}

module.exports = {
  resolveModelRoute,
  PROVIDER_DEFAULT_PATHS,
  MODEL_PATTERNS,
  buildGooglePath,
};

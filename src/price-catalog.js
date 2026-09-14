/**
 * Model price catalog for estimated cost tracking.
 *
 * All prices are in USD per 1,000,000 tokens (per million tokens).
 * Costs are estimates only; the upstream provider remains the billing source of truth.
 *
 * Format: { input_per_mtok: number, output_per_mtok: number }
 *   input_per_mtok  - cost per 1M input (prompt) tokens in USD
 *   output_per_mtok - cost per 1M output (completion) tokens in USD
 *
 * Lookup order: exact `provider/model` key, then model-only key (bare name).
 * Unknown models return null — never silently treated as zero.
 *
 * Last updated: 2026-09-13
 * Sources: provider pricing pages (approximate; subject to change)
 */

const CATALOG = {
  // ── OpenAI ──────────────────────────────────────────────────────────────
  'openai/gpt-4o':                  { input_per_mtok: 2.50,   output_per_mtok: 10.00  },
  'openai/gpt-4o-2024-11-20':      { input_per_mtok: 2.50,   output_per_mtok: 10.00  },
  'openai/gpt-4o-2024-08-06':      { input_per_mtok: 2.50,   output_per_mtok: 10.00  },
  'openai/gpt-4o-mini':            { input_per_mtok: 0.15,   output_per_mtok: 0.60   },
  'openai/gpt-4o-mini-2024-07-18': { input_per_mtok: 0.15,   output_per_mtok: 0.60   },
  'openai/gpt-4-turbo':            { input_per_mtok: 10.00,  output_per_mtok: 30.00  },
  'openai/gpt-4-turbo-preview':    { input_per_mtok: 10.00,  output_per_mtok: 30.00  },
  'openai/gpt-4':                  { input_per_mtok: 30.00,  output_per_mtok: 60.00  },
  'openai/gpt-3.5-turbo':          { input_per_mtok: 0.50,   output_per_mtok: 1.50   },
  'openai/gpt-3.5-turbo-0125':     { input_per_mtok: 0.50,   output_per_mtok: 1.50   },
  'openai/o1':                     { input_per_mtok: 15.00,  output_per_mtok: 60.00  },
  'openai/o1-mini':                { input_per_mtok: 3.00,   output_per_mtok: 12.00  },
  'openai/o1-preview':             { input_per_mtok: 15.00,  output_per_mtok: 60.00  },
  'openai/o3-mini':                { input_per_mtok: 1.10,   output_per_mtok: 4.40   },
  'openai/text-embedding-3-small': { input_per_mtok: 0.02,   output_per_mtok: 0      },
  'openai/text-embedding-3-large': { input_per_mtok: 0.13,   output_per_mtok: 0      },
  'openai/text-embedding-ada-002': { input_per_mtok: 0.10,   output_per_mtok: 0      },

  // ── Anthropic ────────────────────────────────────────────────────────────
  'anthropic/claude-3-5-sonnet-20241022': { input_per_mtok: 3.00,  output_per_mtok: 15.00 },
  'anthropic/claude-3-5-sonnet-latest':   { input_per_mtok: 3.00,  output_per_mtok: 15.00 },
  'anthropic/claude-3-5-haiku-20241022':  { input_per_mtok: 0.80,  output_per_mtok: 4.00  },
  'anthropic/claude-3-5-haiku-latest':    { input_per_mtok: 0.80,  output_per_mtok: 4.00  },
  'anthropic/claude-3-opus-20240229':     { input_per_mtok: 15.00, output_per_mtok: 75.00 },
  'anthropic/claude-3-opus-latest':       { input_per_mtok: 15.00, output_per_mtok: 75.00 },
  'anthropic/claude-3-sonnet-20240229':   { input_per_mtok: 3.00,  output_per_mtok: 15.00 },
  'anthropic/claude-3-haiku-20240307':    { input_per_mtok: 0.25,  output_per_mtok: 1.25  },
  'anthropic/claude-2.1':                 { input_per_mtok: 8.00,  output_per_mtok: 24.00 },
  'anthropic/claude-2.0':                 { input_per_mtok: 8.00,  output_per_mtok: 24.00 },
  'anthropic/claude-instant-1.2':         { input_per_mtok: 0.80,  output_per_mtok: 2.40  },
  'anthropic/claude-sonnet-4-5':          { input_per_mtok: 3.00,  output_per_mtok: 15.00 },
  'anthropic/claude-opus-4':              { input_per_mtok: 15.00, output_per_mtok: 75.00 },

  // ── Google / Gemini ──────────────────────────────────────────────────────
  'google/gemini-1.5-pro':         { input_per_mtok: 3.50,  output_per_mtok: 10.50  },
  'google/gemini-1.5-pro-latest':  { input_per_mtok: 3.50,  output_per_mtok: 10.50  },
  'google/gemini-1.5-flash':       { input_per_mtok: 0.075, output_per_mtok: 0.30   },
  'google/gemini-1.5-flash-latest':{ input_per_mtok: 0.075, output_per_mtok: 0.30   },
  'google/gemini-1.5-flash-8b':    { input_per_mtok: 0.0375,output_per_mtok: 0.15   },
  'google/gemini-2.0-flash':       { input_per_mtok: 0.10,  output_per_mtok: 0.40   },
  'google/gemini-2.0-flash-exp':   { input_per_mtok: 0,     output_per_mtok: 0      },
  'google/gemini-pro':             { input_per_mtok: 0.50,  output_per_mtok: 1.50   },
  'google/gemini-pro-vision':      { input_per_mtok: 0.50,  output_per_mtok: 1.50   },

  // ── Mistral ──────────────────────────────────────────────────────────────
  'mistral/mistral-large-latest':  { input_per_mtok: 3.00,  output_per_mtok: 9.00   },
  'mistral/mistral-medium-latest': { input_per_mtok: 2.70,  output_per_mtok: 8.10   },
  'mistral/mistral-small-latest':  { input_per_mtok: 0.20,  output_per_mtok: 0.60   },
  'mistral/mistral-7b-instruct':   { input_per_mtok: 0.25,  output_per_mtok: 0.25   },
  'mistral/mixtral-8x7b-instruct': { input_per_mtok: 0.70,  output_per_mtok: 0.70   },
  'mistral/mixtral-8x22b-instruct':{ input_per_mtok: 2.00,  output_per_mtok: 6.00   },
  'mistral/codestral-latest':      { input_per_mtok: 1.00,  output_per_mtok: 3.00   },

  // ── Groq ─────────────────────────────────────────────────────────────────
  'groq/llama-3.1-70b-versatile':  { input_per_mtok: 0.59,  output_per_mtok: 0.79   },
  'groq/llama-3.2-90b-vision-preview': { input_per_mtok: 0.90, output_per_mtok: 0.90 },
  'groq/llama-3.2-11b-vision-preview': { input_per_mtok: 0.18, output_per_mtok: 0.18 },
  'groq/llama-3.2-3b-preview':     { input_per_mtok: 0.06,  output_per_mtok: 0.06   },
  'groq/llama-3.2-1b-preview':     { input_per_mtok: 0.04,  output_per_mtok: 0.04   },
  'groq/mixtral-8x7b-32768':       { input_per_mtok: 0.24,  output_per_mtok: 0.24   },
  'groq/gemma2-9b-it':             { input_per_mtok: 0.20,  output_per_mtok: 0.20   },

  // ── OpenRouter (pass-through — provider unknown; no reliable price) ───────
  // OpenRouter prices vary by model and routing; we don't catalog them here.
  // Requests routed through OpenRouter are logged with null estimated_cost_usd.

  // ── ElevenLabs (character-based, not token-based) ─────────────────────────
  // ElevenLabs charges per character, not per token; not cataloged here.

  // ── HuggingFace Inference API (free tier / model-dependent) ───────────────
  // Prices vary by model; not cataloged here.

  // ── Deepgram (duration-based, not token-based) ────────────────────────────
  // Deepgram charges per second of audio; not cataloged here.
};

/**
 * Bare model names (without provider prefix) for reverse lookup.
 * These serve as fallbacks when a `provider/model` key is not found but
 * a bare model name can be resolved.
 * Preference: the most recent pricing entry for that model name.
 */
const BARE_MODEL_INDEX = (() => {
  const idx = {};
  for (const [key, pricing] of Object.entries(CATALOG)) {
    const slash = key.indexOf('/');
    if (slash !== -1) {
      const bare = key.slice(slash + 1);
      // First match wins (catalog is ordered most-specific first within each provider)
      if (!idx[bare]) idx[bare] = pricing;
    }
  }
  return idx;
})();

/**
 * Look up cost for a request.
 *
 * @param {string} provider   - Provider name (e.g. 'openai', 'anthropic')
 * @param {string|null} model - Model name, with or without provider prefix
 * @param {number|null} inputTokens
 * @param {number|null} outputTokens
 * @returns {{ estimated_cost_usd: number|null, pricing_known: boolean }}
 *   estimated_cost_usd is null when pricing is unknown (not silently treated as zero).
 *   pricing_known is false when the model is not in the catalog.
 */
function lookupCost(provider, model, inputTokens, outputTokens) {
  if (!model || (inputTokens == null && outputTokens == null)) {
    return { estimated_cost_usd: null, pricing_known: false };
  }
  if (provider === 'openrouter') {
    return { estimated_cost_usd: null, pricing_known: false };
  }

  const inTok  = typeof inputTokens  === 'number' ? inputTokens  : 0;
  const outTok = typeof outputTokens === 'number' ? outputTokens : 0;

  // Normalise: strip provider prefix if already present on the model string
  const normModel = model.includes('/') ? model : `${provider}/${model}`;

  let pricing = CATALOG[normModel];

  // Bare-name fallback
  if (!pricing) {
    const bare = normModel.slice(normModel.indexOf('/') + 1);
    pricing = BARE_MODEL_INDEX[bare];
  }

  if (!pricing) {
    return { estimated_cost_usd: null, pricing_known: false };
  }

  const cost = (inTok * pricing.input_per_mtok + outTok * pricing.output_per_mtok) / 1_000_000;
  return {
    estimated_cost_usd: +cost.toFixed(8),
    pricing_known: true,
  };
}

/**
 * Extract token counts from an upstream provider response body.
 * Supports OpenAI and Anthropic response shapes.
 *
 * @param {object} responseBody  - Parsed JSON response from the provider
 * @returns {{ input_tokens: number|null, output_tokens: number|null }}
 */
function extractTokenCounts(responseBody) {
  if (!responseBody || typeof responseBody !== 'object') {
    return { input_tokens: null, output_tokens: null };
  }

  // OpenAI / OpenAI-compatible (Groq, Mistral, OpenRouter, …)
  // shape: { usage: { prompt_tokens, completion_tokens } }
  if (responseBody.usage) {
    const u = responseBody.usage;
    const inputTokens  = typeof u.prompt_tokens     === 'number' ? u.prompt_tokens     : null;
    const outputTokens = typeof u.completion_tokens === 'number' ? u.completion_tokens : null;

    // Also handle Anthropic shape nested under usage
    const anthInput  = typeof u.input_tokens  === 'number' ? u.input_tokens  : null;
    const anthOutput = typeof u.output_tokens === 'number' ? u.output_tokens : null;

    return {
      input_tokens:  inputTokens  ?? anthInput  ?? null,
      output_tokens: outputTokens ?? anthOutput ?? null,
    };
  }

  // Anthropic top-level (messages API)
  // shape: { usage: { input_tokens, output_tokens } } — handled above via u.input_tokens
  // No other shapes currently needed.

  return { input_tokens: null, output_tokens: null };
}

module.exports = { lookupCost, extractTokenCounts, CATALOG };

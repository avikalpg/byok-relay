/**
 * @byok-relay/vercel-ai
 *
 * Vercel AI SDK custom provider adapter for byok-relay.
 * Implements the LanguageModelV1 spec so you can use byok-relay with
 * generateText, streamText, generateObject, and any other AI SDK function.
 *
 * Zero hard runtime dependencies on @ai-sdk/* — works via the published
 * LanguageModelV1 protocol and OpenAI-compatible relay endpoints.
 *
 * Usage:
 *   const { createByokRelayProvider } = require('@byok-relay/vercel-ai');
 *   const provider = await createByokRelayProvider({ relayUrl, appId });
 *   const model = provider.languageModel('openai/gpt-4o');
 *   const { text } = await generateText({ model, prompt: 'Hello!' });
 */

'use strict';

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function defaultStorage() {
  if (typeof localStorage !== 'undefined') return localStorage;
  // In-memory fallback for SSR / Node.js environments
  const store = Object.create(null);
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}

// ---------------------------------------------------------------------------
// Relay token management (same pattern as other @byok-relay/* packages)
// ---------------------------------------------------------------------------

async function registerToken({ relayUrl, appId, storage }) {
  const storageKey = `byok_relay_token_${appId}`;
  const stored = storage.getItem(storageKey);
  if (stored) return stored;

  const res = await fetch(`${relayUrl}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`byok-relay: failed to register (${res.status}): ${body}`);
  }
  const { token } = await res.json();
  storage.setItem(storageKey, token);
  return token;
}

async function storeProviderKey({ relayUrl, token, provider, apiKey }) {
  const res = await fetch(`${relayUrl}/keys/${provider}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ api_key: apiKey }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`byok-relay: failed to store key for ${provider} (${res.status}): ${body}`);
  }
  return res.json();
}

async function deleteAccount({ relayUrl, token, storage, appId }) {
  const res = await fetch(`${relayUrl}/users`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  storage.removeItem(`byok_relay_token_${appId}`);
  return res.ok;
}

// ---------------------------------------------------------------------------
// Prompt conversion: AI SDK LanguageModelV1Prompt → OpenAI messages
// ---------------------------------------------------------------------------

function partToOpenAI(part) {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'image') {
    const url =
      typeof part.image === 'string'
        ? part.image
        : `data:${part.mimeType ?? 'image/jpeg'};base64,${bufferToBase64(part.image)}`;
    return { type: 'image_url', image_url: { url } };
  }
  // tool-call / tool-result: forward as-is and let the provider handle it
  return part;
}

function bufferToBase64(buf) {
  if (typeof Buffer !== 'undefined') return Buffer.from(buf).toString('base64');
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function promptMessageToOpenAI(msg) {
  if (msg.role === 'system') {
    return { role: 'system', content: msg.content };
  }
  if (msg.role === 'user') {
    const content = Array.isArray(msg.content)
      ? msg.content.map(partToOpenAI)
      : msg.content;
    // If content is a single text part, flatten to a string
    if (Array.isArray(content) && content.length === 1 && content[0].type === 'text') {
      return { role: 'user', content: content[0].text };
    }
    return { role: 'user', content };
  }
  if (msg.role === 'assistant') {
    const content = Array.isArray(msg.content)
      ? msg.content
          .map((part) => {
            if (part.type === 'text') return part.text;
            // tool-call: forward in OpenAI format
            if (part.type === 'tool-call') {
              return {
                id: part.toolCallId,
                type: 'function',
                function: { name: part.toolName, arguments: JSON.stringify(part.args) },
              };
            }
            return null;
          })
          .filter(Boolean)
      : msg.content;
    const text = Array.isArray(content) ? content.filter((c) => typeof c === 'string').join('') : content;
    const toolCalls = Array.isArray(content) ? content.filter((c) => typeof c === 'object') : [];
    const out = { role: 'assistant', content: text || null };
    if (toolCalls.length) out.tool_calls = toolCalls;
    return out;
  }
  if (msg.role === 'tool') {
    return (Array.isArray(msg.content) ? msg.content : [msg.content]).map((part) => ({
      role: 'tool',
      tool_call_id: part?.toolCallId ?? '',
      content: JSON.stringify(part?.result ?? {}),
    }));
  }
  return { role: msg.role, content: '' };
}

function promptToMessages(prompt) {
  return prompt.flatMap(promptMessageToOpenAI);
}

// ---------------------------------------------------------------------------
// Map finishReason from OpenAI to AI SDK
// ---------------------------------------------------------------------------
function mapFinishReason(reason) {
  switch (reason) {
    case 'stop': return 'stop';
    case 'length': return 'length';
    case 'tool_calls': return 'tool-calls';
    case 'content_filter': return 'content-filter';
    default: return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Parse provider + model from a unified modelId string
// "openai/gpt-4o"       → provider=openai, model=gpt-4o
// "anthropic/claude-3-5-sonnet-20241022" → provider=anthropic, model=claude-3-5-sonnet...
// "gpt-4o"             → provider=openai (default)
// ---------------------------------------------------------------------------
function parseModelId(modelId) {
  const slash = modelId.indexOf('/');
  if (slash === -1) return { provider: 'openai', model: modelId };
  return { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
}

function normalizeSettings(source = {}) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    switch (key) {
      case 'maxTokens':
      case 'max_tokens':
        out.max_tokens = value;
        break;
      case 'topP':
      case 'top_p':
        out.top_p = value;
        break;
      case 'frequencyPenalty':
      case 'frequency_penalty':
        out.frequency_penalty = value;
        break;
      case 'presencePenalty':
      case 'presence_penalty':
        out.presence_penalty = value;
        break;
      case 'stopSequences':
        if (Array.isArray(value) && value.length) out.stop = value;
        break;
      case 'stop':
        if ((Array.isArray(value) && value.length) || typeof value === 'string') out.stop = value;
        break;
      case 'responseFormat':
        if (value?.type === 'json') out.response_format = { type: 'json_object' };
        break;
      case 'response_format':
        out.response_format = value;
        break;
      default:
        out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The LanguageModelV1 implementation
// ---------------------------------------------------------------------------

function createLanguageModel({ relayUrl, getToken, modelId, settings = {} }) {
  const { provider: relayProvider, model } = parseModelId(modelId);

  async function buildBody(options) {
    const messages = promptToMessages(options.prompt);
    const body = {
      model,
      messages,
      ...normalizeSettings(settings),
    };
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.topP !== undefined) body.top_p = options.topP;
    if (options.frequencyPenalty !== undefined) body.frequency_penalty = options.frequencyPenalty;
    if (options.presencePenalty !== undefined) body.presence_penalty = options.presencePenalty;
    if (options.stopSequences?.length) body.stop = options.stopSequences;
    if (options.seed !== undefined) body.seed = options.seed;
    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = options.toolChoice?.type === 'required'
        ? 'required'
        : options.toolChoice?.type === 'none'
        ? 'none'
        : 'auto';
    }
    if (options.responseFormat?.type === 'json') {
      body.response_format = { type: 'json_object' };
    }
    return body;
  }

  async function relay(body, stream) {
    const token = await getToken();
    const url = `${relayUrl}/relay/${relayProvider}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...body, stream }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`byok-relay [${res.status}]: ${errText}`);
    }
    return res;
  }

  return {
    specificationVersion: 'v1',
    provider: `byok-relay.${relayProvider}`,
    modelId,
    defaultObjectGenerationMode: 'json',

    // -----------------------------------------------------------------------
    // Non-streaming: doGenerate
    // -----------------------------------------------------------------------
    async doGenerate(options) {
      const body = await buildBody(options);
      const res = await relay(body, false);
      const data = await res.json();

      const choice = data.choices?.[0] ?? {};
      const msg = choice.message ?? {};
      const text = msg.content ?? '';
      const finishReason = mapFinishReason(choice.finish_reason);
      const usage = data.usage ?? {};

      const toolCalls = (msg.tool_calls ?? []).map((tc) => ({
        toolCallType: 'function',
        toolCallId: tc.id,
        toolName: tc.function.name,
        args: tc.function.arguments,
      }));

      return {
        text,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        finishReason,
        usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
        },
        rawCall: { rawPrompt: body.messages, rawSettings: body },
        rawResponse: { headers: Object.fromEntries(res.headers.entries()) },
        warnings: [],
      };
    },

    // -----------------------------------------------------------------------
    // Streaming: doStream
    // -----------------------------------------------------------------------
    async doStream(options) {
      const body = await buildBody(options);
      const res = await relay(body, true);

      const rawResponse = { headers: Object.fromEntries(res.headers.entries()) };

      // Parse SSE stream and yield LanguageModelV1StreamPart events
      const stream = new ReadableStream({
        async start(controller) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          let usage = { promptTokens: 0, completionTokens: 0 };

          function processLine(line) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') return;
            if (!trimmed.startsWith('data: ')) return;

            let chunk;
            try {
              chunk = JSON.parse(trimmed.slice(6));
            } catch {
              return;
            }

            const choice = chunk.choices?.[0];
            if (!choice) return;

            const delta = choice.delta ?? {};

            if (delta.content) {
              controller.enqueue({ type: 'text-delta', textDelta: delta.content });
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.function?.name) {
                  controller.enqueue({
                    type: 'tool-call-delta',
                    toolCallType: 'function',
                    toolCallId: tc.id ?? `tool_${tc.index ?? 0}`,
                    toolName: tc.function.name,
                    argsTextDelta: tc.function.arguments ?? '',
                  });
                } else if (tc.function?.arguments) {
                  controller.enqueue({
                    type: 'tool-call-delta',
                    toolCallType: 'function',
                    toolCallId: tc.id ?? `tool_${tc.index ?? 0}`,
                    toolName: '',
                    argsTextDelta: tc.function.arguments,
                  });
                }
              }
            }

            if (chunk.usage) {
              usage = {
                promptTokens: chunk.usage.prompt_tokens ?? 0,
                completionTokens: chunk.usage.completion_tokens ?? 0,
              };
            }

            if (choice.finish_reason) {
              controller.enqueue({
                type: 'finish',
                finishReason: mapFinishReason(choice.finish_reason),
                usage,
              });
            }
          }

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });

              const lines = buf.split('\n');
              buf = lines.pop() ?? '';

              for (const line of lines) processLine(line);
            }
            if (buf.trim()) processLine(buf);
          } catch (err) {
            controller.enqueue({ type: 'error', error: err });
          } finally {
            controller.close();
          }
        },
      });

      return {
        stream,
        rawCall: { rawPrompt: body.messages, rawSettings: body },
        rawResponse,
        warnings: [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Public API: createByokRelayProvider
// ---------------------------------------------------------------------------

/**
 * Create a byok-relay provider for the Vercel AI SDK.
 *
 * @param {object} config
 * @param {string} config.relayUrl - byok-relay base URL, e.g. 'https://relay.byokrelay.com'
 * @param {string} [config.appId='vercel-ai'] - Application identifier
 * @param {object} [config.storage] - Storage adapter (default: localStorage / in-memory)
 * @param {object} [config.settings] - Default model settings (temperature, maxTokens, …)
 * @returns {object} Provider with languageModel(modelId) and helper methods
 */
async function createByokRelayProvider({ relayUrl, appId = 'vercel-ai', storage, settings = {} } = {}) {
  if (!relayUrl) throw new Error('byok-relay: relayUrl is required');
  const store = storage ?? defaultStorage();
  const storageKey = `byok_relay_token_${appId}`;

  let _token = store.getItem(storageKey) ?? null;
  let _pending = null;

  async function getToken() {
    if (_token) return _token;
    if (!_pending) {
      _pending = registerToken({ relayUrl, appId, storage: store }).then((t) => {
        _token = t;
        _pending = null;
        return t;
      }, (err) => {
        _pending = null;
        throw err;
      });
    }
    return _pending;
  }

  return {
    /**
     * Register a provider API key with byok-relay.
     * Call this once with the user's API key before using the provider.
     *
     * @param {string} provider - e.g. 'openai', 'anthropic', 'groq'
     * @param {string} apiKey - User's API key for the provider
     */
    async storeKey(provider, apiKey) {
      const token = await getToken();
      return storeProviderKey({ relayUrl, token, provider, apiKey });
    },

    /**
     * Get or create the relay token for this app.
     * The token is persisted in storage automatically.
     */
    getToken,

    /**
     * Delete the user's account (GDPR erasure).
     */
    async deleteAccount() {
      const token = await getToken();
      return deleteAccount({ relayUrl, token, storage: store, appId });
    },

    /**
     * Create a LanguageModelV1-compatible model for use with AI SDK functions.
     *
     * @param {string} modelId - 'provider/model' or bare model name.
     *   Examples: 'openai/gpt-4o', 'anthropic/claude-3-5-sonnet-20241022',
     *             'groq/llama3-70b-8192', 'gpt-4o-mini'
     * @param {object} [overrides] - Per-model setting overrides
     */
    languageModel(modelId, overrides = {}) {
      return createLanguageModel({
        relayUrl,
        getToken,
        modelId,
        settings: { ...settings, ...overrides },
      });
    },

    /**
     * Alias for languageModel (matches @ai-sdk/openai API shape).
     */
    chat(modelId, overrides = {}) {
      return this.languageModel(modelId, overrides);
    },

    /**
     * Check relay health.
     */
    async health(deep = false) {
      const url = deep ? `${relayUrl}/health?deep=1` : `${relayUrl}/health`;
      const res = await fetch(url);
      return res.json();
    },

    /**
     * Get usage stats for this app.
     */
    async stats(appId_) {
      const token = await getToken();
      const path = appId_ ? `/stats/${appId_}` : '/stats';
      const res = await fetch(`${relayUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.json();
    },
  };
}

/**
 * Synchronous factory — returns a provider object whose languageModel() method
 * lazily handles registration on first use.  Useful when you can't await at
 * module scope (e.g. Next.js Edge Runtime).
 *
 * @param {object} config - Same as createByokRelayProvider
 */
function createByokRelayProviderSync({ relayUrl, appId = 'vercel-ai', storage, settings = {} } = {}) {
  if (!relayUrl) throw new Error('byok-relay: relayUrl is required');
  const store = storage ?? defaultStorage();
  let _token = store.getItem(`byok_relay_token_${appId}`) ?? null;
  let _pending = null;

  async function getToken() {
    if (_token) return _token;
    if (!_pending) {
      _pending = registerToken({ relayUrl, appId, storage: store }).then((t) => {
        _token = t;
        _pending = null;
        return t;
      });
    }
    return _pending;
  }

  return {
    async storeKey(provider, apiKey) {
      const token = await getToken();
      return storeProviderKey({ relayUrl, token, provider, apiKey });
    },
    getToken,
    async deleteAccount() {
      const token = await getToken();
      return deleteAccount({ relayUrl, token, storage: store, appId });
    },
    languageModel(modelId, overrides = {}) {
      return createLanguageModel({ relayUrl, getToken, modelId, settings: { ...settings, ...overrides } });
    },
    chat(modelId, overrides = {}) {
      return this.languageModel(modelId, overrides);
    },
    async health(deep = false) {
      const url = deep ? `${relayUrl}/health?deep=1` : `${relayUrl}/health`;
      const res = await fetch(url);
      return res.json();
    },
    async stats(appId_) {
      const token = await getToken();
      const path = appId_ ? `/stats/${appId_}` : '/stats';
      const res = await fetch(`${relayUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.json();
    },
  };
}

module.exports = {
  createByokRelayProvider,
  createByokRelayProviderSync,
  // Re-export internals for testing / advanced use
  parseModelId,
  promptToMessages,
};

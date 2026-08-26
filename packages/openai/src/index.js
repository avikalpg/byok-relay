/**
 * @byok-relay/openai
 * Drop-in OpenAI SDK-compatible client that routes through byok-relay.
 *
 * Three exports:
 *
 *   1. ByokRelayOpenAI     — mirrors the openai SDK's top-level interface:
 *      .chat.completions.create(), .embeddings.create(), .images.generate(),
 *      .models.list(), .audio.transcriptions.create(), .audio.speech.create().
 *      Supports streaming via async iteration (identical to openai SDK).
 *
 *   2. createByokRelayOpenAI — factory returning a ByokRelayOpenAI instance.
 *
 *   3. ByokRelayClient      — plain-JS key management + relay client.
 *
 * Usage mirrors the openai npm package so existing code needs minimal changes:
 *
 *   // Before (openai SDK)
 *   import OpenAI from 'openai';
 *   const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
 *
 *   // After (@byok-relay/openai)
 *   import { ByokRelayOpenAI } from '@byok-relay/openai';
 *   const client = new ByokRelayOpenAI({ relayUrl: 'https://relay.byokrelay.com' });
 *   // The relay stores the user's key encrypted at rest
 *
 * Runtime requirements: Node.js 18+ or any runtime with native fetch + ReadableStream.
 *
 * @example Chat completions (non-streaming)
 * const client = new ByokRelayOpenAI({ relayUrl: process.env.RELAY_URL });
 * const completion = await client.chat.completions.create({
 *   model: 'gpt-4o',
 *   messages: [{ role: 'user', content: 'Hello!' }],
 * });
 * console.log(completion.choices[0].message.content);
 *
 * @example Streaming (identical to openai SDK)
 * const stream = await client.chat.completions.create({
 *   model: 'gpt-4o',
 *   messages: [{ role: 'user', content: 'Hello!' }],
 *   stream: true,
 * });
 * for await (const chunk of stream) {
 *   process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
 * }
 *
 * @example Embeddings
 * const result = await client.embeddings.create({
 *   model: 'text-embedding-3-small',
 *   input: 'The food was great!',
 * });
 * console.log(result.data[0].embedding);
 *
 * @example Multi-provider (route to Anthropic via provider prefix)
 * const client = new ByokRelayOpenAI({ relayUrl, provider: 'anthropic' });
 * const completion = await client.chat.completions.create({
 *   model: 'claude-3-5-sonnet-20241022',
 *   messages: [{ role: 'user', content: 'Hello!' }],
 * });
 */

'use strict';

/* ========================================================================== */
/* Constants                                                                   */
/* ========================================================================== */

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';
const DEFAULT_PROVIDER = 'openai';
const DEFAULT_TIMEOUT_MS = 30_000;

/* ========================================================================== */
/* Storage helpers (localStorage in browser, in-memory on Node/edge)          */
/* ========================================================================== */

function _makeDefaultStorage () {
  try {
    if (typeof localStorage !== 'undefined') {
      return {
        getItem: (k) => localStorage.getItem(k),
        setItem: (k, v) => localStorage.setItem(k, v),
        removeItem: (k) => localStorage.removeItem(k),
      };
    }
  } catch (_) {}
  // In-memory fallback for Node.js / edge runtimes
  const store = new Map();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
}

/* ========================================================================== */
/* Hop-by-hop headers to strip from forwarded responses                       */
/* ========================================================================== */

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
  'content-encoding', // avoid double-decompression
]);

function _filterResponseHeaders (headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/* ========================================================================== */
/* SSE parsing helpers                                                         */
/* ========================================================================== */

async function * _parseSSE (response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;
        try { yield JSON.parse(data); } catch (_) {}
      }
    }
  }
}

/* ========================================================================== */
/* ByokRelayClient — plain-JS key management + relay client                   */
/* ========================================================================== */

class ByokRelayClient {
  /**
   * @param {object} opts
   * @param {string}  [opts.relayUrl]  – relay base URL (default: managed relay)
   * @param {string}  [opts.appId]     – app identifier forwarded as X-App-Id
   * @param {object}  [opts.storage]   – custom storage adapter { getItem, setItem, removeItem }
   */
  constructor (opts = {}) {
    this.relayUrl = (opts.relayUrl || DEFAULT_RELAY_URL).replace(/\/$/, '');
    this.appId = opts.appId || 'byok-relay-openai';
    this._storage = opts.storage || _makeDefaultStorage();
    this._token = null;
  }

  _storageKey () { return `byok_relay_token_${this.relayUrl}`; }

  _getStoredToken () {
    if (this._token) return this._token;
    try { this._token = this._storage.getItem(this._storageKey()) || null; } catch (_) {}
    return this._token;
  }

  _saveToken (token) {
    this._token = token;
    try { this._storage.setItem(this._storageKey(), token); } catch (_) {}
  }

  _clearToken () {
    this._token = null;
    try { this._storage.removeItem(this._storageKey()); } catch (_) {}
  }

  /** Register with the relay and obtain a relay token. */
  async register () {
    const res = await fetch(`${this.relayUrl}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`byok-relay register failed ${res.status}: ${text}`);
    }
    const { token } = await res.json();
    this._saveToken(token);
    return token;
  }

  /** Return stored token; auto-register if missing. */
  async ensureToken () {
    const stored = this._getStoredToken();
    if (stored) return stored;
    return this.register();
  }

  /** Logout — clears the local token. */
  logout () { this._clearToken(); }

  /** Store a provider API key in the relay (AES-256-GCM encrypted at rest). */
  async storeKey (provider, apiKey) {
    const token = await this.ensureToken();
    const res = await fetch(`${this.relayUrl}/keys/${provider}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ key: apiKey }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`byok-relay storeKey failed ${res.status}: ${text}`);
    }
    return res.json();
  }

  /** List stored provider keys. */
  async listKeys () {
    const token = await this.ensureToken();
    const res = await fetch(`${this.relayUrl}/keys`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`byok-relay listKeys failed ${res.status}`);
    return res.json();
  }

  /** Delete a stored provider key. */
  async deleteKey (provider) {
    const token = await this.ensureToken();
    const res = await fetch(`${this.relayUrl}/keys/${provider}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`byok-relay deleteKey failed ${res.status}`);
    return res.json();
  }

  /** Rotate a provider key — live-validates the new key before replacing. */
  async rotateKey (provider, newApiKey) {
    const token = await this.ensureToken();
    const res = await fetch(`${this.relayUrl}/keys/${provider}/rotate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ key: newApiKey }),
    });
    if (!res.ok) throw new Error(`byok-relay rotateKey failed ${res.status}`);
    return res.json();
  }

  /** Forward a raw request to the relay. */
  async relayRequest (provider, path, { method = 'POST', headers = {}, body } = {}) {
    const token = await this.ensureToken();
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.relayUrl}/relay/${provider}/${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          'Authorization': `Bearer ${token}`,
          'X-App-Id': this.appId,
        },
        body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        signal: controller.signal,
      });
      return res;
    } finally {
      clearTimeout(tid);
    }
  }

  /** Relay health check. */
  async health (deep = false) {
    const url = deep ? `${this.relayUrl}/health?deep=1` : `${this.relayUrl}/health`;
    const res = await fetch(url);
    return res.json();
  }

  /** Per-user usage stats. */
  async stats (appId) {
    const token = await this.ensureToken();
    const path = appId ? `/stats/${appId}` : '/stats';
    const res = await fetch(`${this.relayUrl}${path}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`byok-relay stats failed ${res.status}`);
    return res.json();
  }

  /** List available models via GET /models. */
  async getModels () {
    const res = await fetch(`${this.relayUrl}/models`);
    if (!res.ok) throw new Error(`byok-relay getModels failed ${res.status}`);
    return res.json();
  }

  /** Delete account + all stored keys (GDPR erasure). */
  async deleteAccount () {
    const token = await this.ensureToken();
    const res = await fetch(`${this.relayUrl}/users`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`byok-relay deleteAccount failed ${res.status}`);
    this._clearToken();
    return res.json();
  }
}

/* ========================================================================== */
/* Streaming response wrapper (mimics openai SDK's Stream class)              */
/* ========================================================================== */

class ByokRelayStream {
  /**
   * Async-iterable wrapper around an SSE fetch response.
   * Mirrors the openai SDK's streaming interface so `for await (const chunk of stream)` works.
   */
  constructor (response) {
    this._response = response;
    // Expose response headers for consumers that inspect them
    this.response = {
      headers: _filterResponseHeaders(response.headers),
      status: response.status,
    };
  }

  [Symbol.asyncIterator] () {
    return _parseSSE(this._response);
  }

  /** Convenience: collect all chunks and return a synthesised completion object. */
  async finalChatCompletion () {
    let content = '';
    let finishReason = null;
    let id = null;
    let model = null;
    const toolCalls = {};

    for await (const chunk of this) {
      if (!id && chunk.id) id = chunk.id;
      if (!model && chunk.model) model = chunk.model;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) content += delta.content;
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      // Accumulate tool call deltas
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: tc.id, type: tc.type || 'function', function: { name: '', arguments: '' } };
          }
          if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
    }

    const toolCallsList = Object.keys(toolCalls).length > 0
      ? Object.values(toolCalls).sort((a, b) => a.index - b.index)
      : undefined;

    return {
      id,
      object: 'chat.completion',
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: toolCallsList ? null : content,
          tool_calls: toolCallsList,
        },
        finish_reason: finishReason,
      }],
    };
  }
}

/* ========================================================================== */
/* ByokRelayOpenAI — drop-in OpenAI SDK-compatible client                     */
/* ========================================================================== */

/**
 * Mimics the `openai` npm package's client interface, routing all requests
 * through a byok-relay instance. The user's API key is stored in the relay
 * (AES-256-GCM encrypted) — it never touches your application code.
 *
 * @example
 * // Replace:  import OpenAI from 'openai';
 * // With:
 * import { ByokRelayOpenAI } from '@byok-relay/openai';
 *
 * const client = new ByokRelayOpenAI({
 *   relayUrl: process.env.RELAY_URL,
 *   provider: 'openai',   // default; use 'anthropic', 'groq', etc. for others
 * });
 *
 * // Store user's API key once (e.g. from a settings form)
 * await client.storeKey('openai', userApiKey);
 *
 * // Use exactly like the openai SDK:
 * const completion = await client.chat.completions.create({ ... });
 */
class ByokRelayOpenAI {
  /**
   * @param {object} opts
   * @param {string}  [opts.relayUrl]    – relay base URL (default: managed relay)
   * @param {string}  [opts.provider]    – default provider prefix (default: 'openai')
   * @param {string}  [opts.appId]       – app identifier forwarded as X-App-Id
   * @param {object}  [opts.storage]     – custom storage adapter { getItem, setItem, removeItem }
   * @param {string}  [opts.apiKey]      – optional: forward a raw API key instead of relay token
   *                                       (use for migration or testing; not the BYOK model)
   */
  constructor (opts = {}) {
    this._provider = opts.provider || DEFAULT_PROVIDER;
    this._apiKey = opts.apiKey || null;
    this._client = new ByokRelayClient({
      relayUrl: opts.relayUrl,
      appId: opts.appId,
      storage: opts.storage,
    });

    // Build the nested namespace structure that mirrors the openai SDK
    this.chat = {
      completions: {
        create: (params, options = {}) => this._chatCompletionsCreate(params, options),
      },
    };

    this.embeddings = {
      create: (params, options = {}) => this._embeddingsCreate(params, options),
    };

    this.images = {
      generate: (params, options = {}) => this._imagesGenerate(params, options),
      edit: (params, options = {}) => this._imagesEdit(params, options),
    };

    this.models = {
      list: (options = {}) => this._modelsList(options),
      retrieve: (model, options = {}) => this._modelsRetrieve(model, options),
    };

    this.audio = {
      transcriptions: {
        create: (params, options = {}) => this._audioTranscriptionsCreate(params, options),
      },
      speech: {
        create: (params, options = {}) => this._audioSpeechCreate(params, options),
      },
    };

    this.completions = {
      create: (params, options = {}) => this._completionsCreate(params, options),
    };
  }

  /* ---- Provider resolution -------------------------------------------- */

  _resolveProvider (model) {
    // If model contains a slash (e.g. 'anthropic/claude-3-5-sonnet'), extract provider prefix
    if (model && model.includes('/')) {
      const [prefix] = model.split('/');
      return prefix;
    }
    return this._provider;
  }

  _stripProviderPrefix (model) {
    if (model && model.includes('/')) {
      return model.split('/').slice(1).join('/');
    }
    return model;
  }

  /* ---- Auth header ----------------------------------------------------- */

  async _authHeader () {
    if (this._apiKey) return `Bearer ${this._apiKey}`;
    const token = await this._client.ensureToken();
    return `Bearer ${token}`;
  }

  /* ---- Core relay fetch ------------------------------------------------ */

  async _relayFetch (provider, path, { method = 'POST', body, stream = false, signal } = {}) {
    const relayUrl = this._client.relayUrl;
    const auth = await this._authHeader();

    const controller = new AbortController();
    const effectiveSignal = signal || controller.signal;
    const tid = signal ? null : setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const res = await fetch(`${relayUrl}/relay/${provider}/${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': auth,
          'X-App-Id': this._client.appId,
        },
        body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        signal: effectiveSignal,
      });

      if (!res.ok && !stream) {
        let errBody;
        try { errBody = await res.json(); } catch (_) { errBody = { error: { message: await res.text() } }; }
        const msg = errBody?.error?.message || `Request failed with status ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        err.error = errBody?.error;
        throw err;
      }

      return res;
    } finally {
      if (tid) clearTimeout(tid);
    }
  }

  /* ---- chat.completions.create ---------------------------------------- */

  async _chatCompletionsCreate (params, options = {}) {
    const provider = this._resolveProvider(params.model);
    const body = {
      ...params,
      model: this._stripProviderPrefix(params.model),
    };

    const res = await this._relayFetch(provider, 'chat/completions', {
      body,
      stream: !!params.stream,
      signal: options.signal,
    });

    if (params.stream) {
      if (!res.ok) {
        let errBody;
        try { errBody = await res.json(); } catch (_) { errBody = { error: { message: await res.text() } }; }
        const msg = errBody?.error?.message || `Stream failed with status ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      return new ByokRelayStream(res);
    }

    return res.json();
  }

  /* ---- completions.create (legacy non-chat) --------------------------- */

  async _completionsCreate (params, options = {}) {
    const provider = this._resolveProvider(params.model);
    const body = { ...params, model: this._stripProviderPrefix(params.model) };

    const res = await this._relayFetch(provider, 'completions', {
      body,
      stream: !!params.stream,
      signal: options.signal,
    });

    if (params.stream) {
      if (!res.ok) {
        let errBody;
        try { errBody = await res.json(); } catch (_) { errBody = { error: { message: await res.text() } }; }
        const msg = errBody?.error?.message || `Stream failed with status ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      return new ByokRelayStream(res);
    }
    return res.json();
  }

  /* ---- embeddings.create ---------------------------------------------- */

  async _embeddingsCreate (params, options = {}) {
    const provider = this._resolveProvider(params.model);
    const body = { ...params, model: this._stripProviderPrefix(params.model) };

    const res = await this._relayFetch(provider, 'embeddings', { body, signal: options.signal });
    return res.json();
  }

  /* ---- images.generate ------------------------------------------------ */

  async _imagesGenerate (params, options = {}) {
    const provider = this._provider;
    const res = await this._relayFetch(provider, 'images/generations', {
      body: params,
      signal: options.signal,
    });
    return res.json();
  }

  /* ---- images.edit ---------------------------------------------------- */

  async _imagesEdit (params, options = {}) {
    const provider = this._provider;
    const res = await this._relayFetch(provider, 'images/edits', {
      body: params,
      signal: options.signal,
    });
    return res.json();
  }

  /* ---- models.list ---------------------------------------------------- */

  async _modelsList (options = {}) {
    const relayUrl = this._client.relayUrl;
    const auth = await this._authHeader();
    const res = await fetch(`${relayUrl}/models`, {
      headers: { 'Authorization': auth },
      signal: options.signal,
    });
    if (!res.ok) throw new Error(`models.list failed with status ${res.status}`);
    return res.json();
  }

  /* ---- models.retrieve ------------------------------------------------ */

  async _modelsRetrieve (model, options = {}) {
    const relayUrl = this._client.relayUrl;
    const auth = await this._authHeader();
    const provider = this._resolveProvider(model);
    const modelId = this._stripProviderPrefix(model);
    // Forward to provider's model retrieve endpoint via relay
    const res = await fetch(`${relayUrl}/relay/${provider}/models/${modelId}`, {
      headers: { 'Authorization': auth },
      signal: options.signal,
    });
    if (!res.ok) throw new Error(`models.retrieve failed with status ${res.status}`);
    return res.json();
  }

  /* ---- audio.transcriptions.create ------------------------------------ */

  async _audioTranscriptionsCreate (params, options = {}) {
    // Audio transcription typically uses multipart/form-data — forward body as-is
    const provider = this._provider;
    const auth = await this._authHeader();
    const relayUrl = this._client.relayUrl;

    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const headers = {
        'Authorization': auth,
        'X-App-Id': this._client.appId,
      };

      let body;
      if (typeof FormData !== 'undefined' && params instanceof FormData) {
        // Caller passed a ready-made FormData
        body = params;
      } else {
        // Build FormData from params object
        const fd = new FormData();
        for (const [k, v] of Object.entries(params)) {
          fd.append(k, v);
        }
        body = fd;
      }

      const res = await fetch(`${relayUrl}/relay/${provider}/audio/transcriptions`, {
        method: 'POST',
        headers,
        body,
        signal: options.signal || controller.signal,
      });

      if (!res.ok) throw new Error(`audio.transcriptions failed with status ${res.status}`);
      return res.json();
    } finally {
      clearTimeout(tid);
    }
  }

  /* ---- audio.speech.create -------------------------------------------- */

  async _audioSpeechCreate (params, options = {}) {
    const provider = this._provider;
    const res = await this._relayFetch(provider, 'audio/speech', {
      body: params,
      signal: options.signal,
    });
    // Returns binary audio — expose as Response-like object with arrayBuffer()
    return res;
  }

  /* ---- Convenience passthrough methods -------------------------------- */

  /** Register and obtain a relay token. */
  async register () { return this._client.register(); }

  /** Ensure token exists, auto-registering if needed. */
  async ensureToken () { return this._client.ensureToken(); }

  /** Logout — clears local token storage. */
  logout () { return this._client.logout(); }

  /**
   * Store a provider API key in the relay.
   * This is the BYOK step: call this once from your settings UI.
   * @param {string} provider — 'openai' | 'anthropic' | 'groq' | 'mistral' | 'openrouter' | ...
   * @param {string} apiKey   — the user's API key
   */
  async storeKey (provider, apiKey) { return this._client.storeKey(provider, apiKey); }

  /** List stored provider keys. */
  async listKeys () { return this._client.listKeys(); }

  /** Delete a stored provider key. */
  async deleteKey (provider) { return this._client.deleteKey(provider); }

  /** Rotate a provider key — live-validates before replacing. */
  async rotateKey (provider, newApiKey) { return this._client.rotateKey(provider, newApiKey); }

  /** Health check. */
  async health (deep = false) { return this._client.health(deep); }

  /** Per-user usage stats. */
  async stats (appId) { return this._client.stats(appId); }

  /** Delete account + all keys (GDPR erasure). */
  async deleteAccount () { return this._client.deleteAccount(); }
}

/* ========================================================================== */
/* Factory function                                                            */
/* ========================================================================== */

/**
 * Create a ByokRelayOpenAI instance.
 * @param {object} opts — same as ByokRelayOpenAI constructor
 * @returns {ByokRelayOpenAI}
 */
function createByokRelayOpenAI (opts = {}) {
  return new ByokRelayOpenAI(opts);
}

/* ========================================================================== */
/* Exports                                                                     */
/* ========================================================================== */

module.exports = {
  ByokRelayOpenAI,
  ByokRelayClient,
  ByokRelayStream,
  createByokRelayOpenAI,
  // Default export compat: `import OpenAI from '@byok-relay/openai'` style
  default: ByokRelayOpenAI,
};

// ESM compat shim for `import OpenAI from '@byok-relay/openai'`
module.exports.default = ByokRelayOpenAI;

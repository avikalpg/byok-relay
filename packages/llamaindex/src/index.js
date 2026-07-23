/**
 * @byok-relay/llamaindex
 * LlamaIndex.TS custom LLM and embedding adapter for BYOK AI relay.
 *
 * Three exports:
 *
 *   1. ByokRelayLLM        — implements LlamaIndex LLM interface; non-streaming +
 *      async-generator streaming; tool calling via supportedToolCall / chat with tools.
 *
 *   2. ByokRelayEmbedding  — implements LlamaIndex BaseEmbedding interface;
 *      getTextEmbeddings() batch + getQueryEmbedding() single vector;
 *      routes to /relay/:provider/embeddings.
 *
 *   3. ByokRelayClient     — plain-JS key management + relay client (no LlamaIndex dep).
 *
 * llamaindex is a peer dependency (optional). Both classes degrade gracefully
 * without it; a descriptive error is thrown at call-time rather than import-time.
 *
 * Runtime requirements: Node.js 18+ or any runtime with native fetch + ReadableStream.
 *
 * @example Basic usage
 * import { ByokRelayLLM } from '@byok-relay/llamaindex';
 * const llm = new ByokRelayLLM({ model: 'openai/gpt-4o' });
 * await llm.storeKey('openai', 'sk-...');
 * const response = await llm.chat({ messages: [{ role: 'user', content: 'Hello' }] });
 * console.log(response.message.content);
 *
 * @example Streaming
 * for await (const chunk of llm.stream({ messages: [{ role: 'user', content: 'Hello' }] })) {
 *   process.stdout.write(chunk.delta);
 * }
 *
 * @example Tool calling
 * const response = await llm.chat({
 *   messages: [{ role: 'user', content: 'Weather in Tokyo?' }],
 *   tools: [weatherToolMetadata],
 * });
 *
 * @example Embeddings
 * import { ByokRelayEmbedding } from '@byok-relay/llamaindex';
 * const embed = new ByokRelayEmbedding({ model: 'openai/text-embedding-3-small' });
 * await embed.storeKey('openai', 'sk-...');
 * const vector = await embed.getQueryEmbedding('hello world');
 */

'use strict';

/* ========================================================================== */
/* Constants                                                                   */
/* ========================================================================== */

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';

/* ========================================================================== */
/* Lazy peer dependency helpers                                                */
/* ========================================================================== */

function _tryRequire (mod) {
  try { return require(mod); } catch (_) { return null; }
}

function _getBaseLLM () {
  const li = _tryRequire('llamaindex');
  if (li && li.BaseLLM) return li.BaseLLM;
  // Minimal shim so the package loads without llamaindex installed
  return class BaseLLMShim {
    constructor (init) { Object.assign(this, init || {}); }
    async chat () { throw new Error('llamaindex is required — npm install llamaindex'); }
    async * stream () { throw new Error('llamaindex is required — npm install llamaindex'); }
    async complete () { throw new Error('llamaindex is required — npm install llamaindex'); }
  };
}

function _getBaseEmbedding () {
  const li = _tryRequire('llamaindex');
  if (li && li.BaseEmbedding) return li.BaseEmbedding;
  return class BaseEmbeddingShim {
    constructor (init) { Object.assign(this, init || {}); }
    async getTextEmbedding () { throw new Error('llamaindex is required — npm install llamaindex'); }
    async getTextEmbeddings () { throw new Error('llamaindex is required — npm install llamaindex'); }
    async getQueryEmbedding () { throw new Error('llamaindex is required — npm install llamaindex'); }
  };
}

/* ========================================================================== */
/* Message + provider helpers                                                  */
/* ========================================================================== */

/**
 * Parse "provider/model" or bare model name.
 * Returns { provider, model }.
 */
function _parseModel (modelStr) {
  if (!modelStr) return { provider: 'openai', model: 'gpt-4o' };
  const slash = modelStr.indexOf('/');
  if (slash !== -1) {
    return {
      provider: modelStr.slice(0, slash),
      model:    modelStr.slice(slash + 1),
    };
  }
  return { provider: 'openai', model: modelStr };
}

/**
 * Convert LlamaIndex ChatMessage to OpenAI-compatible message.
 * Handles tool_calls and tool result messages.
 */
function _liToOpenAI (msg) {
  const role    = msg.role || 'user';
  const content = msg.content;

  // Tool response message
  if (role === 'tool') {
    return {
      role:         'tool',
      content:      typeof content === 'string' ? content : JSON.stringify(content),
      tool_call_id: msg.options?.toolCallId || msg.toolCallId || '',
    };
  }

  // Assistant message with tool calls
  if (role === 'assistant' && msg.options?.toolCall) {
    const openAiMsg = {
      role:       'assistant',
      content:    content || null,
      tool_calls: msg.options.toolCall.map(tc => ({
        id:       tc.id,
        type:     'function',
        function: { name: tc.name, arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input || {}) },
      })),
    };
    return openAiMsg;
  }

  // Standard message
  if (typeof content === 'string') {
    return { role, content };
  }

  // Multi-modal content array (LlamaIndex uses { type, text | imageUrl } format)
  if (Array.isArray(content)) {
    const parts = content.map(part => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'image_url') return { type: 'image_url', image_url: { url: part.imageUrl || part.image_url } };
      return { type: 'text', text: String(part) };
    });
    return { role, content: parts };
  }

  return { role, content: content ? String(content) : '' };
}

/**
 * Convert LlamaIndex ToolMetadata to OpenAI function tool spec.
 */
function _liToolToOpenAI (tool) {
  return {
    type:     'function',
    function: {
      name:        tool.name,
      description: tool.description || '',
      parameters:  tool.parameters || { type: 'object', properties: {} },
    },
  };
}

/**
 * Build ChatResponse-compatible object from OpenAI response JSON.
 */
function _buildChatResponse (json) {
  const choice  = (json.choices || [])[0] || {};
  const message = choice.message || {};
  const usage   = json.usage || {};

  const liMessage = {
    role:    message.role || 'assistant',
    content: message.content || '',
  };

  // Tool calls
  if (message.tool_calls && message.tool_calls.length > 0) {
    liMessage.options = {
      toolCall: message.tool_calls.map(tc => ({
        id:    tc.id,
        name:  tc.function.name,
        input: _tryParseJson(tc.function.arguments),
      })),
    };
  }

  return {
    message: liMessage,
    raw:     json,
    // LlamaIndex TokenUsage shape
    usage: {
      promptTokens:     usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens:      usage.total_tokens || 0,
    },
  };
}

function _tryParseJson (str) {
  if (typeof str !== 'string') return str;
  try { return JSON.parse(str); } catch (_) { return str; }
}

/* ========================================================================== */
/* ByokRelayClient                                                             */
/* ========================================================================== */

class ByokRelayClient {
  /**
   * @param {object} opts
   * @param {string} [opts.relayUrl]   - Relay base URL. Defaults to managed relay.
   * @param {string} [opts.appId]      - App identifier.
   * @param {object} [opts.storage]    - Custom storage adapter { getItem, setItem, removeItem }.
   */
  constructor (opts = {}) {
    this.relayUrl = (opts.relayUrl || DEFAULT_RELAY_URL).replace(/\/$/, '');
    this.appId    = opts.appId || 'llamaindex-app';
    this._token   = null;

    // Storage: localStorage in browser, in-memory fallback in Node.js/edge
    if (opts.storage) {
      this._storage = opts.storage;
    } else if (typeof localStorage !== 'undefined') {
      this._storage = localStorage;
    } else {
      const _mem = {};
      this._storage = {
        getItem    (k) { return _mem[k] ?? null; },
        setItem    (k, v) { _mem[k] = v; },
        removeItem (k) { delete _mem[k]; },
      };
    }
  }

  /* -- Token management -------------------------------------------------- */

  async ensureToken () {
    if (this._token) return this._token;
    const stored = this._storage.getItem('byok_relay_token');
    if (stored) { this._token = stored; return stored; }
    return this.register();
  }

  async register () {
    const res  = await fetch(`${this.relayUrl}/users`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ app_id: this.appId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Registration failed: ${data.error || res.status}`);
    this._token = data.token;
    this._storage.setItem('byok_relay_token', data.token);
    return data.token;
  }

  async logout () {
    this._token = null;
    this._storage.removeItem('byok_relay_token');
  }

  /* -- Key management ---------------------------------------------------- */

  async storeKey (provider, apiKey) {
    const token = await this.ensureToken();
    const res   = await fetch(`${this.relayUrl}/keys/${provider}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ api_key: apiKey }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Store key failed: ${data.error || res.status}`);
    return data;
  }

  async listKeys () {
    const token = await this.ensureToken();
    const res   = await fetch(`${this.relayUrl}/keys`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`List keys failed: ${data.error || res.status}`);
    return data;
  }

  async deleteKey (provider) {
    const token = await this.ensureToken();
    const res   = await fetch(`${this.relayUrl}/keys/${provider}`, {
      method:  'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Delete key failed: ${data.error || res.status}`);
    return data;
  }

  async rotateKey (provider, newApiKey) {
    const token = await this.ensureToken();
    const res   = await fetch(`${this.relayUrl}/keys/${provider}/rotate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ api_key: newApiKey }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Rotate key failed: ${data.error || res.status}`);
    return data;
  }

  /* -- Relay request ------------------------------------------------------ */

  async relayRequest (provider, path, init = {}) {
    const token = await this.ensureToken();
    const url   = `${this.relayUrl}/relay/${provider}/${path.replace(/^\//, '')}`;
    const res   = await fetch(url, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
    });
    return res;
  }

  /* -- Helpers ------------------------------------------------------------ */

  async health (deep = false) {
    const res  = await fetch(`${this.relayUrl}/health${deep ? '?deep=1' : ''}`);
    return res.json();
  }

  async stats (appId) {
    const token = await this.ensureToken();
    const path  = appId ? `/stats/${appId}` : '/stats';
    const res   = await fetch(`${this.relayUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.json();
  }

  async getModels () {
    const res = await fetch(`${this.relayUrl}/models`);
    return res.json();
  }

  async deleteAccount () {
    const token = await this.ensureToken();
    const res   = await fetch(`${this.relayUrl}/users`, {
      method:  'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Delete account failed: ${data.error || res.status}`);
    this._token = null;
    this._storage.removeItem('byok_relay_token');
    return data;
  }
}

/* ========================================================================== */
/* ByokRelayLLM                                                                */
/* ========================================================================== */

/**
 * LlamaIndex.TS-compatible LLM that routes through a BYOK relay.
 *
 * Inherits from BaseLLM (or a shim when llamaindex is not installed).
 * Usage mirrors any built-in LlamaIndex LLM: pass to SimpleDirectoryReader,
 * VectorStoreIndex, ReActAgent, etc.
 */
function createByokRelayLLM () {
  const Base = _getBaseLLM();

  return class ByokRelayLLM extends Base {
    /**
     * @param {object} opts
     * @param {string} [opts.model]      - "provider/model" or bare model name. Default "openai/gpt-4o".
     * @param {string} [opts.relayUrl]   - Relay base URL. Defaults to managed relay.
     * @param {string} [opts.appId]      - App identifier.
     * @param {object} [opts.storage]    - Custom storage adapter.
     * @param {number} [opts.maxTokens]  - max_tokens forwarded to provider.
     * @param {number} [opts.temperature] - temperature forwarded to provider.
     * @param {object} [opts.extraParams] - Additional body params forwarded to provider.
     */
    constructor (opts = {}) {
      super(opts);
      this.model        = opts.model || 'openai/gpt-4o';
      this.maxTokens    = opts.maxTokens;
      this.temperature  = opts.temperature;
      this.extraParams  = opts.extraParams || {};
      this._client      = new ByokRelayClient({
        relayUrl: opts.relayUrl,
        appId:    opts.appId,
        storage:  opts.storage,
      });
      this._tools = null;
    }

    /* -- Convenience passthrough to client -------------------------------- */

    async storeKey (provider, apiKey) { return this._client.storeKey(provider, apiKey); }
    async listKeys () { return this._client.listKeys(); }
    async deleteKey (provider) { return this._client.deleteKey(provider); }
    async rotateKey (provider, key) { return this._client.rotateKey(provider, key); }
    async health (deep) { return this._client.health(deep); }
    async stats (appId) { return this._client.stats(appId); }
    async deleteAccount () { return this._client.deleteAccount(); }

    /* -- LlamaIndex LLM interface ----------------------------------------- */

    get metadata () {
      return {
        model:              this.model,
        temperature:        this.temperature,
        maxTokens:          this.maxTokens,
        contextWindow:      128000,
        tokenizer:          undefined,
        structuredOutput:   false,
      };
    }

    /**
     * Non-streaming chat.
     * @param {object} params
     * @param {Array}  params.messages - Array of LlamaIndex ChatMessage objects.
     * @param {Array}  [params.tools]  - Array of LlamaIndex ToolMetadata objects.
     * @returns {Promise<ChatResponse>}
     */
    async chat ({ messages, tools, additionalChatOptions }) {
      const { provider, model } = _parseModel(this.model);
      const body = this._buildBody(model, messages, tools, additionalChatOptions);
      body.stream = false;

      const res  = await this._client.relayRequest(provider, 'chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Relay request failed (${res.status}): ${errText}`);
      }

      const json = await res.json();
      return _buildChatResponse(json);
    }

    /**
     * Streaming chat — async generator yielding ChatResponseChunk objects.
     * @param {object} params - Same as chat().
     * @yields {{ delta: string, raw: object }}
     */
    async * stream ({ messages, tools, additionalChatOptions }) {
      const { provider, model } = _parseModel(this.model);
      const body = this._buildBody(model, messages, tools, additionalChatOptions);
      body.stream = true;

      const res = await this._client.relayRequest(provider, 'chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Relay stream failed (${res.status}): ${errText}`);
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buf     = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') return;

          let parsed;
          try { parsed = JSON.parse(data); } catch (_) { continue; }

          const delta = parsed?.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            yield {
              delta:   delta.content,
              raw:     parsed,
              options: {},
            };
          }

          // Tool call deltas
          if (delta.tool_calls) {
            yield {
              delta:   '',
              raw:     parsed,
              options: { toolCallDelta: delta.tool_calls },
            };
          }
        }
      }
    }

    /**
     * complete() — single-turn completion (wraps chat with a user message).
     */
    async complete ({ prompt, stream }) {
      const messages = [{ role: 'user', content: prompt }];
      if (stream) {
        return this.stream({ messages });
      }
      const response = await this.chat({ messages });
      return {
        text:  response.message.content || '',
        raw:   response.raw,
        usage: response.usage,
      };
    }

    /* -- Internal helpers ------------------------------------------------- */

    _buildBody (model, messages, tools, extra) {
      const body = {
        model,
        messages: (messages || []).map(_liToOpenAI),
        ...this.extraParams,
        ...extra,
      };

      if (this.maxTokens   != null) body.max_tokens  = this.maxTokens;
      if (this.temperature != null) body.temperature = this.temperature;

      // Merge tools: instance-bound tools (from withTools) + per-call tools
      const allTools = [
        ...(this._tools || []),
        ...(tools || []),
      ];
      if (allTools.length > 0) {
        body.tools       = allTools.map(_liToolToOpenAI);
        body.tool_choice = 'auto';
      }

      return body;
    }

    /**
     * Return a new ByokRelayLLM with bound tools (LlamaIndex pattern).
     */
    withTools (tools) {
      const clone    = Object.create(Object.getPrototypeOf(this));
      Object.assign(clone, this);
      clone._tools   = [...(this._tools || []), ...tools];
      clone._client  = this._client; // share client (shared token)
      return clone;
    }
  };
}

/* ========================================================================== */
/* ByokRelayEmbedding                                                          */
/* ========================================================================== */

/**
 * LlamaIndex.TS-compatible embedding model that routes through a BYOK relay.
 *
 * Inherits from BaseEmbedding (or a shim when llamaindex is not installed).
 * Drop-in for any LlamaIndex VectorStore, FAISS, or Chroma constructor that
 * accepts an `embedModel` parameter.
 */
function createByokRelayEmbedding () {
  const Base = _getBaseEmbedding();

  return class ByokRelayEmbedding extends Base {
    /**
     * @param {object} opts
     * @param {string} [opts.model]      - "provider/model". Default "openai/text-embedding-3-small".
     * @param {string} [opts.relayUrl]   - Relay base URL. Defaults to managed relay.
     * @param {string} [opts.appId]      - App identifier.
     * @param {object} [opts.storage]    - Custom storage adapter.
     * @param {number} [opts.batchSize]  - Documents per batch. Default 512.
     * @param {string} [opts.encodingFormat] - "float" | "base64". Default "float".
     */
    constructor (opts = {}) {
      super(opts);
      this.model          = opts.model || 'openai/text-embedding-3-small';
      this.batchSize      = opts.batchSize || 512;
      this.encodingFormat = opts.encodingFormat || 'float';
      this._client        = new ByokRelayClient({
        relayUrl: opts.relayUrl,
        appId:    opts.appId,
        storage:  opts.storage,
      });
    }

    /* -- Convenience passthrough ------------------------------------------ */

    async storeKey (provider, apiKey) { return this._client.storeKey(provider, apiKey); }
    async listKeys () { return this._client.listKeys(); }
    async deleteKey (provider) { return this._client.deleteKey(provider); }
    async health (deep) { return this._client.health(deep); }

    /* -- LlamaIndex BaseEmbedding interface -------------------------------- */

    /**
     * Embed a single text string (query embedding).
     * @param {string} text
     * @returns {Promise<number[]>}
     */
    async getQueryEmbedding (text) {
      const vectors = await this._embedBatch([text]);
      return vectors[0];
    }

    /**
     * Embed a single text (document embedding, alias of getQueryEmbedding).
     * @param {string} text
     * @returns {Promise<number[]>}
     */
    async getTextEmbedding (text) {
      return this.getQueryEmbedding(text);
    }

    /**
     * Embed multiple texts with automatic batching.
     * @param {string[]} texts
     * @returns {Promise<number[][]>}
     */
    async getTextEmbeddings (texts) {
      const results = [];
      for (let i = 0; i < texts.length; i += this.batchSize) {
        const batch   = texts.slice(i, i + this.batchSize);
        const vectors = await this._embedBatch(batch);
        results.push(...vectors);
      }
      return results;
    }

    /* -- Internal helpers ------------------------------------------------- */

    async _embedBatch (texts) {
      const { provider, model } = _parseModel(this.model);

      const res = await this._client.relayRequest(provider, 'embeddings', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          model,
          input:           texts,
          encoding_format: this.encodingFormat,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Embeddings request failed (${res.status}): ${errText}`);
      }

      const json = await res.json();
      // OpenAI response: { data: [{ index, object, embedding }], ... }
      const sorted = (json.data || []).sort((a, b) => a.index - b.index);
      return sorted.map(d => d.embedding);
    }
  };
}

/* ========================================================================== */
/* Instantiate classes                                                         */
/* ========================================================================== */

const ByokRelayLLM       = createByokRelayLLM();
const ByokRelayEmbedding = createByokRelayEmbedding();

/* ========================================================================== */
/* Exports                                                                     */
/* ========================================================================== */

module.exports = {
  ByokRelayLLM,
  ByokRelayEmbedding,
  ByokRelayClient,
};

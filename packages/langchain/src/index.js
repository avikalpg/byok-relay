/**
 * @byok-relay/langchain
 * LangChain.js custom chat model and embeddings adapter for BYOK AI relay.
 *
 * Three exports:
 *
 *   1. ByokRelayChatModel   — extends BaseChatModel; non-streaming + streaming,
 *      tool calling via bindTools(), works in Node.js, edge, and browser.
 *
 *   2. ByokRelayEmbeddings  — extends Embeddings; embedDocuments() + embedQuery()
 *      batching; routes to provider embeddings endpoint via /relay/:provider/embeddings.
 *
 *   3. ByokRelayClient      — plain-JS key management + relay client (no LangChain dep).
 *
 * @langchain/core is a peer dependency (optional). Both classes degrade gracefully
 * without it; a descriptive error is thrown at call-time rather than import-time.
 *
 * Runtime requirements: Node.js 18+ or any runtime with native fetch + ReadableStream.
 *
 * @example Basic usage
 * import { ByokRelayChatModel } from '@byok-relay/langchain';
 * const model = new ByokRelayChatModel({ modelName: 'openai/gpt-4o' });
 * await model.storeKey('openai', 'sk-...');
 * const result = await model.invoke([new HumanMessage('Hello')]);
 *
 * @example Streaming
 * for await (const chunk of await model.stream([new HumanMessage('Hello')])) {
 *   process.stdout.write(chunk.content);
 * }
 *
 * @example Tool calling
 * const modelWithTools = model.bindTools([weatherTool]);
 * const result = await modelWithTools.invoke([new HumanMessage('Weather in Tokyo?')]);
 *
 * @example Embeddings
 * import { ByokRelayEmbeddings } from '@byok-relay/langchain';
 * const embeddings = new ByokRelayEmbeddings({ modelName: 'openai/text-embedding-3-small' });
 * await embeddings.storeKey('openai', 'sk-...');
 * const vectors = await embeddings.embedDocuments(['hello', 'world']);
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

function _getBaseChatModel () {
  const core = _tryRequire('@langchain/core/language_models/chat_models');
  if (core && core.BaseChatModel) return core.BaseChatModel;
  // Minimal shim so the package loads without @langchain/core installed
  return class BaseChatModelShim {
    constructor (fields) { Object.assign(this, fields || {}); }
    async _generate () { throw new Error('@langchain/core is required — npm install @langchain/core'); }
    async * _stream () { throw new Error('@langchain/core is required — npm install @langchain/core'); }
    _llmType () { return 'byok-relay'; }
    bindTools () { return this; }
    async invoke () { throw new Error('@langchain/core is required — npm install @langchain/core'); }
    async stream () { throw new Error('@langchain/core is required — npm install @langchain/core'); }
  };
}

function _getEmbeddingsBase () {
  const core = _tryRequire('@langchain/core/embeddings');
  if (core && core.Embeddings) return core.Embeddings;
  return class EmbeddingsShim {
    constructor (fields) { Object.assign(this, fields || {}); }
    async embedDocuments () { throw new Error('@langchain/core is required — npm install @langchain/core'); }
    async embedQuery () { throw new Error('@langchain/core is required — npm install @langchain/core'); }
  };
}

function _getMessages () {
  return _tryRequire('@langchain/core/messages') || {};
}

function _getOutputs () {
  return _tryRequire('@langchain/core/outputs') || {};
}

/**
 * Yield parsed payloads from an SSE response body. Handles chunk boundaries
 * and a final event without a trailing newline.
 */
async function * _parseSSE (body) {
  const reader  = body.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';

  const parseLine = line => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) return null;
    const raw = trimmed.slice(5).trim();
    if (raw === '[DONE]') return { done: true };
    try { return { payload: JSON.parse(raw) }; } catch (_) { return null; }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const event = parseLine(line);
      if (!event) continue;
      if (event.done) return;
      yield event.payload;
    }
  }

  buffer += decoder.decode();
  const event = parseLine(buffer);
  if (event && !event.done) yield event.payload;
}

/* ========================================================================== */
/* Message conversion helpers                                                  */
/* ========================================================================== */

/**
 * Convert a LangChain BaseMessage to an OpenAI-compatible message object.
 */
function _lcToOpenAI (msg) {
  // _getType() is the canonical way in LangChain; fall back to class name
  const type = (msg._getType && msg._getType()) || msg.constructor?.name || '';

  if (type === 'human' || type === 'HumanMessage') {
    return { role: 'user', content: _contentToStr(msg.content) };
  }
  if (type === 'ai' || type === 'AIMessage' || type === 'AIMessageChunk') {
    const m = { role: 'assistant', content: _contentToStr(msg.content) };
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      m.tool_calls = msg.tool_calls.map(tc => ({
        id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || {}),
        },
      }));
      if (!m.content) m.content = null;
    }
    return m;
  }
  if (type === 'system' || type === 'SystemMessage') {
    return { role: 'system', content: _contentToStr(msg.content) };
  }
  if (type === 'tool' || type === 'ToolMessage') {
    return {
      role: 'tool',
      content: _contentToStr(msg.content),
      tool_call_id: msg.tool_call_id || '',
    };
  }
  if (type === 'function' || type === 'FunctionMessage') {
    return {
      role: 'function',
      content: _contentToStr(msg.content),
      name: msg.name || '',
    };
  }
  // Generic fallback
  return { role: 'user', content: _contentToStr(msg.content) };
}

function _contentToStr (content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => {
      if (typeof c === 'string') return c;
      if (c && c.type === 'text') return c.text || '';
      return '';
    }).join('');
  }
  return String(content || '');
}

/**
 * Convert an OpenAI response to a LangChain ChatResult.
 */
function _openAIToChatResult (data) {
  const { AIMessage } = _getMessages();
  const choice = data.choices && data.choices[0];
  if (!choice) throw new Error('byok-relay: no choices in response');

  const msg = choice.message;
  const toolCalls = msg.tool_calls
    ? msg.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function && tc.function.name,
        args: _parseJSON(tc.function && tc.function.arguments),
        type: 'tool_call',
      }))
    : undefined;

  const aiMsg = AIMessage
    ? new AIMessage({
        content: msg.content || '',
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
        additional_kwargs: msg.tool_calls ? { tool_calls: msg.tool_calls } : {},
      })
    : { content: msg.content || '', _getType: () => 'ai' };

  return {
    generations: [{
      text:    msg.content || '',
      message: aiMsg,
    }],
    llmOutput: {
      tokenUsage: {
        promptTokens:     data.usage && data.usage.prompt_tokens,
        completionTokens: data.usage && data.usage.completion_tokens,
        totalTokens:      data.usage && data.usage.total_tokens,
      },
      model_name: data.model,
    },
  };
}

function _parseJSON (str) {
  if (!str) return {};
  try { return JSON.parse(str); } catch (_) { return str; }
}

/**
 * Convert LangChain tools (StructuredTool, Tool, or OpenAI format) to
 * OpenAI function-calling format.
 */
function _convertTools (tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map(tool => {
    // Already in OpenAI format
    if (tool.type === 'function' && tool.function) return tool;
    // Let LangChain convert StructuredTool Zod schemas to OpenAI JSON Schema.
    const functions = _tryRequire('@langchain/core/utils/function_calling');
    if (functions && typeof functions.convertToOpenAITool === 'function') {
      try { return functions.convertToOpenAITool(tool); } catch (_) {}
    }
    // LangChain StructuredTool with schema
    if (tool.name) {
      const schema = tool.schema || tool.parameters || tool.inputSchema || { type: 'object', properties: {} };
      return {
        type: 'function',
        function: {
          name:        tool.name,
          description: tool.description || '',
          parameters:  schema,
        },
      };
    }
    return tool;
  });
}

/* ========================================================================== */
/* Storage helpers                                                             */
/* ========================================================================== */

function _isClient () {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}
function _safeGet (key) {
  if (!_isClient()) return null;
  try { return window.localStorage.getItem(key); } catch (_) { return null; }
}
function _safeSet (key, val) {
  if (!_isClient()) return;
  try { window.localStorage.setItem(key, val); } catch (_) {}
}
function _safeRemove (key) {
  if (!_isClient()) return;
  try { window.localStorage.removeItem(key); } catch (_) {}
}

function _resolveRelayUrl (opt) {
  const envUrl = (typeof process !== 'undefined' && process.env && process.env.RELAY_URL)
    ? process.env.RELAY_URL : null;
  return opt || envUrl || DEFAULT_RELAY_URL;
}

function _defaultStorage () {
  return { get: _safeGet, set: _safeSet, remove: _safeRemove };
}

/* ========================================================================== */
/* Shared token management mixin (applied manually to avoid multiple-inherit) */
/* ========================================================================== */

function _mixTokens (inst) {
  inst._memStore = inst._memStore || {};

  inst._kget = function (key) {
    const s = this._storage;
    if (s && typeof s.get === 'function') {
      const v = s.get(key);
      if (v !== null && v !== undefined) return v;
    }
    return this._memStore[key] || null;
  };

  inst._kset = function (key, val) {
    if (this._storage && typeof this._storage.set === 'function') this._storage.set(key, val);
    this._memStore[key] = val;
  };

  inst._kremove = function (key) {
    if (this._storage && typeof this._storage.remove === 'function') this._storage.remove(key);
    delete this._memStore[key];
  };

  inst._ensureToken = async function () {
    const k = `byok_relay_token_${this._appId}`;
    const existing = this._kget(k);
    if (existing) return existing;
    if (!this._pendingToken) {
      this._pendingToken = (async () => {
        const res = await fetch(`${this._relayUrl}/users`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ app_id: this._appId }),
        });
        if (!res.ok) throw new Error(`byok-relay register failed: ${res.status}`);
        const data = await res.json();
        this._kset(k, data.token);
        return data.token;
      })();
    }
    try {
      return await this._pendingToken;
    } finally {
      this._pendingToken = null;
    }
  };

  inst.storeKey = async function (provider, apiKey) {
    const token = await this._ensureToken();
    const res = await fetch(`${this._relayUrl}/keys/${provider}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify({ api_key: apiKey }),
    });
    if (!res.ok) throw new Error(`storeKey failed: ${res.status}`);
    return res.json();
  };

  inst.listKeys = async function () {
    const token = await this._ensureToken();
    const res = await fetch(`${this._relayUrl}/keys`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`listKeys failed: ${res.status}`);
    return res.json();
  };
}

/* ========================================================================== */
/* ByokRelayChatModel                                                          */
/* ========================================================================== */

// Lazily built so @langchain/core is only required at first instantiation
let _ChatModelClass = null;

function _buildChatModel () {
  if (_ChatModelClass) return _ChatModelClass;

  const BaseChatModel = _getBaseChatModel();

  class ByokRelayChatModel extends BaseChatModel {
    /**
     * @param {object}  fields
     * @param {string}  [fields.relayUrl]   – upstream relay URL (default: RELAY_URL env or managed)
     * @param {string}  [fields.appId]      – app identifier stored in localStorage
     * @param {string}  [fields.modelName]  – 'provider/model' e.g. 'openai/gpt-4o' (default)
     * @param {number}  [fields.temperature]
     * @param {number}  [fields.maxTokens]
     * @param {object}  [fields.storage]    – custom { get, set, remove } adapter
     */
    constructor (fields = {}) {
      super(fields);
      this._relayUrl   = _resolveRelayUrl(fields.relayUrl);
      this._appId      = fields.appId || 'langchain-app';
      this._storage    = fields.storage || _defaultStorage();
      this._memStore   = {};
      this.modelName   = fields.modelName || fields.model || 'openai/gpt-4o';
      this.temperature = fields.temperature !== undefined ? fields.temperature : 0.7;
      this.maxTokens   = fields.maxTokens || undefined;
      this._tools      = fields._tools || null;
      this._toolChoice = fields._toolChoice || undefined;
      _mixTokens(this);
    }

    _llmType () { return 'byok-relay'; }

    /**
     * Return a new model instance with tools bound (for tool/function calling).
     *
     * @param {Array}  tools     – LangChain StructuredTools or OpenAI tool schemas
     * @param {object} [kwargs]
     * @param {string} [kwargs.toolChoice]  – 'auto' | 'none' | { type: 'function', function: { name } }
     */
    bindTools (tools, kwargs = {}) {
      return new ByokRelayChatModel({
        relayUrl:    this._relayUrl,
        appId:       this._appId,
        storage:     this._storage,
        modelName:   this.modelName,
        temperature: this.temperature,
        maxTokens:   this.maxTokens,
        _tools:      _convertTools(tools),
        _toolChoice: kwargs.toolChoice,
      });
    }

    /** Build the JSON body for a relay request. */
    _buildBody (messages, options = {}) {
      return {
        model:       this.modelName,
        messages:    messages.map(_lcToOpenAI),
        temperature: this.temperature,
        ...(this.maxTokens   ? { max_tokens:   this.maxTokens }    : {}),
        ...(this._tools      ? { tools:        this._tools }        : {}),
        ...(this._toolChoice ? { tool_choice:  this._toolChoice }   : {}),
        ...(options.stop     ? { stop:         options.stop }       : {}),
      };
    }

    /**
     * Non-streaming generation (called by .invoke(), .call(), chains, etc.)
     */
    async _generate (messages, options = {}, runManager) {
      const token = await this._ensureToken();
      const res   = await fetch(`${this._relayUrl}/relay`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body:   JSON.stringify(this._buildBody(messages, options)),
        signal: options.signal,
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`byok-relay chat failed (${res.status}): ${err}`);
      }
      return _openAIToChatResult(await res.json());
    }

    /**
     * Streaming generation (called by .stream(), streamEvents(), etc.)
     * Yields ChatGenerationChunk objects including partial tool-call deltas.
     */
    async * _stream (messages, options = {}, runManager) {
      const token = await this._ensureToken();
      const res   = await fetch(`${this._relayUrl}/relay`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body:   JSON.stringify({ ...this._buildBody(messages, options), stream: true }),
        signal: options.signal,
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`byok-relay stream failed (${res.status}): ${err}`);
      }

      const { ChatGenerationChunk } = _getOutputs();
      const { AIMessageChunk }      = _getMessages();

      for await (const parsed of _parseSSE(res.body)) {
        const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
        if (!delta) continue;

        const text = delta.content || '';
        const toolCallChunks = delta.tool_calls && delta.tool_calls.map(toolCall => ({
          id:    toolCall.id,
          index: toolCall.index,
          name:  toolCall.function && toolCall.function.name,
          args:  toolCall.function && toolCall.function.arguments,
          type:  'tool_call_chunk',
        }));
        const msgChunk = AIMessageChunk
          ? new AIMessageChunk({
              content: text,
              ...(toolCallChunks ? { tool_call_chunks: toolCallChunks } : {}),
              additional_kwargs: delta.tool_calls ? { tool_calls: delta.tool_calls } : {},
            })
          : { content: text, _getType: () => 'AIMessageChunk' };

        const genChunk = ChatGenerationChunk
          ? new ChatGenerationChunk({
              text,
              message:        msgChunk,
              generationInfo: { finish_reason: parsed.choices[0].finish_reason },
            })
          : { text, message: msgChunk };

        if (runManager && typeof runManager.handleLLMNewToken === 'function') {
          await runManager.handleLLMNewToken(text, genChunk);
        }
        yield genChunk;
      }
    }
  }

  _ChatModelClass = ByokRelayChatModel;
  return ByokRelayChatModel;
}

/* ========================================================================== */
/* ByokRelayEmbeddings                                                         */
/* ========================================================================== */

let _EmbeddingsClass = null;

function _buildEmbeddings () {
  if (_EmbeddingsClass) return _EmbeddingsClass;

  const EmbeddingsBase = _getEmbeddingsBase();

  class ByokRelayEmbeddings extends EmbeddingsBase {
    /**
     * @param {object}  fields
     * @param {string}  [fields.relayUrl]   – upstream relay URL
     * @param {string}  [fields.appId]
     * @param {string}  [fields.modelName]  – 'provider/model' e.g. 'openai/text-embedding-3-small'
     * @param {number}  [fields.batchSize]  – texts per request (default: 512)
     * @param {object}  [fields.storage]    – custom { get, set, remove } adapter
     */
    constructor (fields = {}) {
      super(fields);
      this._relayUrl = _resolveRelayUrl(fields.relayUrl);
      this._appId    = fields.appId || 'langchain-app';
      this._storage  = fields.storage || _defaultStorage();
      this._memStore = {};
      this.modelName = fields.modelName || fields.model || 'openai/text-embedding-3-small';
      this.batchSize = fields.batchSize || 512;
      _mixTokens(this);
    }

    /**
     * Internal: embed one batch of texts.
     */
    async _embedBatch (input) {
      const token    = await this._ensureToken();
      const model    = this.modelName.includes('/') ? this.modelName : `openai/${this.modelName}`;
      const provider = model.split('/')[0];
      const modelId  = model.split('/').slice(1).join('/');

      const res = await fetch(`${this._relayUrl}/relay/${provider}/embeddings`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ model: modelId, input }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`byok-relay embeddings failed (${res.status}): ${err}`);
      }
      const data = await res.json();
      // OpenAI returns data[].embedding sorted by index
      return data.data.sort((a, b) => a.index - b.index).map(item => item.embedding);
    }

    /**
     * Embed multiple documents. Automatically batches into batchSize chunks.
     *
     * @param {string[]} texts
     * @returns {Promise<number[][]>}
     */
    async embedDocuments (texts) {
      const results = [];
      for (let i = 0; i < texts.length; i += this.batchSize) {
        const batch = texts.slice(i, i + this.batchSize);
        const vecs  = await this._embedBatch(batch);
        results.push(...vecs);
      }
      return results;
    }

    /**
     * Embed a single query string.
     *
     * @param {string} text
     * @returns {Promise<number[]>}
     */
    async embedQuery (text) {
      const [vec] = await this._embedBatch(text);
      return vec;
    }
  }

  _EmbeddingsClass = ByokRelayEmbeddings;
  return ByokRelayEmbeddings;
}

/* ========================================================================== */
/* ByokRelayClient (full key management + relay — no LangChain dep)           */
/* ========================================================================== */

class ByokRelayClient {
  /**
   * @param {object}  opts
   * @param {string}  [opts.relayUrl]  – relay base URL
   * @param {string}  [opts.appId]     – app identifier
   * @param {object}  [opts.storage]   – custom { get, set, remove } adapter
   */
  constructor (opts = {}) {
    this._relayUrl = _resolveRelayUrl(opts.relayUrl);
    this._appId    = opts.appId || 'langchain-app';
    this._storage  = opts.storage || _defaultStorage();
    this._memStore = {};
    _mixTokens(this);
  }

  get _tokenKey () { return `byok_relay_token_${this._appId}`; }

  async register (appId) {
    if (appId) this._appId = appId;
    return this._ensureToken();
  }

  async ensureToken () {
    return this._ensureToken();
  }

  logout () { this._kremove(this._tokenKey); }

  async deleteKey (provider) {
    const token = await this.ensureToken();
    const res   = await fetch(`${this._relayUrl}/keys/${provider}`, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`deleteKey failed: ${res.status}`);
    return res.json();
  }

  async rotateKey (provider, newApiKey) {
    const token = await this.ensureToken();
    const res   = await fetch(`${this._relayUrl}/keys/${provider}/rotate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify({ api_key: newApiKey }),
    });
    if (!res.ok) throw new Error(`rotateKey failed: ${res.status}`);
    return res.json();
  }

  async relayRequest (providerPath, body, extraHeaders = {}) {
    const token = await this.ensureToken();
    return fetch(`${this._relayUrl}/relay/${providerPath}`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
  }

  async chat ({ model, messages, extraParams = {} }) {
    const token = await this.ensureToken();
    const res   = await fetch(`${this._relayUrl}/relay`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify({ model, messages, ...extraParams }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`chat failed (${res.status}): ${err}`);
    }
    return res.json();
  }

  async * streamChat ({ model, messages, extraParams = {}, signal }) {
    const token = await this.ensureToken();
    const res   = await fetch(`${this._relayUrl}/relay`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify({ model, messages, stream: true, ...extraParams }),
      signal,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`streamChat failed (${res.status}): ${err}`);
    }
    for await (const parsed of _parseSSE(res.body)) {
      const chunk = (parsed.choices && parsed.choices[0].delta.content) || '';
      if (chunk) yield chunk;
    }
  }

  async health (deep = false) {
    const res = await fetch(`${this._relayUrl}/health${deep ? '?deep=1' : ''}`);
    return res.json();
  }

  async stats (appId) {
    const token = await this.ensureToken();
    const path  = appId ? `/stats/${appId}` : '/stats';
    const res   = await fetch(`${this._relayUrl}${path}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`stats failed: ${res.status}`);
    return res.json();
  }

  async getModels () {
    const res = await fetch(`${this._relayUrl}/models`);
    if (!res.ok) throw new Error(`getModels failed: ${res.status}`);
    return res.json();
  }

  async deleteAccount () {
    const token = await this.ensureToken();
    const res   = await fetch(`${this._relayUrl}/users`, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`deleteAccount failed: ${res.status}`);
    this.logout();
    return res.json();
  }
}

/* ========================================================================== */
/* Exports — lazy getters so @langchain/core is only resolved at first use    */
/* ========================================================================== */

module.exports = {
  get ByokRelayChatModel   () { return _buildChatModel();    },
  get ByokRelayEmbeddings  () { return _buildEmbeddings();   },
  ByokRelayClient,
};

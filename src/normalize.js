/**
 * Protocol normalization layer — closes byok-relay issue #97.
 *
 * Translates between the OpenAI Chat Completions request/response format
 * and provider-native formats so that callers can send a single OpenAI-format
 * request body to POST /relay/v1/chat/completions and receive an OpenAI-format
 * response regardless of the underlying provider.
 *
 * Supported translations:
 *   openai             → pass-through (already OpenAI format)
 *   groq               → pass-through (already OpenAI-compatible)
 *   mistral            → pass-through (already OpenAI-compatible)
 *   openrouter         → pass-through (already OpenAI-compatible)
 *   openai-compatible  → pass-through (already OpenAI-compatible)
 *   anthropic          → full translation: request + non-streaming response + streaming
 *   google             → full translation: request + non-streaming response + streaming
 */

'use strict';

const { Transform } = require('stream');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Providers that already speak OpenAI Chat Completions format. */
const PASSTHROUGH_PROVIDERS = new Set([
  'openai',
  'groq',
  'mistral',
  'openrouter',
  'openai-compatible',
]);

/**
 * Returns true when the provider's native format is already OpenAI-compatible
 * and no translation is needed.
 */
function isPassthrough(provider) {
  return PASSTHROUGH_PROVIDERS.has(provider);
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI → Anthropic request
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract system messages from an OpenAI messages array, returning the
 * concatenated system text and the remaining non-system messages.
 */
function extractSystemFromMessages(messages) {
  const systemParts = [];
  const userAssistantMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join('\n')
            : '';
      if (text) systemParts.push(text);
    } else {
      userAssistantMessages.push(msg);
    }
  }

  return {
    system: systemParts.join('\n\n') || undefined,
    messages: userAssistantMessages,
  };
}

/**
 * Convert an OpenAI message content (string or content-parts array) to the
 * Anthropic content representation.  Anthropic accepts either a plain string
 * or an array of typed content blocks for user messages.
 */
function convertContentToAnthropic(content, role) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;

  // Convert OpenAI multi-part content to Anthropic blocks
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image_url') {
      // OpenAI image_url → Anthropic image block
      const url = part.image_url?.url || '';
      if (url.startsWith('data:')) {
        // data: URI — extract media type and base64 data
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          return {
            type: 'image',
            source: { type: 'base64', media_type: match[1], data: match[2] },
          };
        }
      }
      return { type: 'image', source: { type: 'url', url } };
    }
    // Fallback: pass through unchanged
    return part;
  });
}

/**
 * Convert an OpenAI tool definition to an Anthropic tool definition.
 * OpenAI: { type: "function", function: { name, description, parameters } }
 * Anthropic: { name, description, input_schema }
 */
function convertToolToAnthropic(oaiTool) {
  const fn = oaiTool.function || {};
  return {
    name: fn.name,
    description: fn.description,
    input_schema: fn.parameters || { type: 'object', properties: {} },
  };
}

/**
 * Convert an OpenAI tool_choice value to the Anthropic tool_choice format.
 */
function convertToolChoiceToAnthropic(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === 'none') return { type: 'none' };
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'required') return { type: 'any' };
  if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
    return { type: 'tool', name: toolChoice.function?.name };
  }
  return undefined;
}

/**
 * Convert an OpenAI-format assistant message (may contain tool_calls) to the
 * Anthropic message format.
 */
function convertAssistantMessageToAnthropic(msg) {
  const blocks = [];

  // Text content
  if (msg.content !== undefined && msg.content !== null) {
    const content = convertContentToAnthropic(msg.content, 'assistant');
    if (typeof content === 'string') {
      blocks.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      // Preserve each OpenAI content part as its corresponding Anthropic block.
      // Serializing the whole array as text loses multimodal structure.
      blocks.push(...content);
    }
  }

  // Tool calls
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input;
      try {
        input = JSON.parse(tc.function?.arguments || '{}');
      } catch {
        input = {};
      }
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name,
        input,
      });
    }
  }

  return {
    role: 'assistant',
    content: blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks,
  };
}

/**
 * Convert an OpenAI "tool" role message (tool result) to Anthropic's
 * tool_result block inside a user turn.
 */
function convertToolMessageToAnthropic(msg) {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      },
    ],
  };
}

/**
 * Translate an OpenAI Chat Completions request body to an Anthropic Messages
 * API request body.
 *
 * @param {object} oaiBody - OpenAI-format request body
 * @returns {object} Anthropic-format request body
 */
function toAnthropicRequest(oaiBody) {
  const {
    messages = [],
    model,
    stream,
    max_tokens,
    temperature,
    top_p,
    stop,
    tools,
    tool_choice,
  } = oaiBody;

  const { system, messages: nonSystemMessages } = extractSystemFromMessages(messages);

  // Convert messages to Anthropic format
  const antMessages = [];
  for (const msg of nonSystemMessages) {
    if (msg.role === 'user') {
      antMessages.push({
        role: 'user',
        content: convertContentToAnthropic(msg.content, 'user'),
      });
    } else if (msg.role === 'assistant') {
      antMessages.push(convertAssistantMessageToAnthropic(msg));
    } else if (msg.role === 'tool') {
      antMessages.push(convertToolMessageToAnthropic(msg));
    }
    // Other roles (function, etc.) are dropped
  }

  const body = {
    model,
    messages: antMessages,
    // Anthropic requires max_tokens; default to a generous value if not set
    max_tokens: max_tokens || 4096,
  };

  if (system) body.system = system;
  if (stream) body.stream = true;
  // Anthropic temperature range is 0–1; OpenAI allows up to 2 — clamp it
  if (temperature !== undefined) body.temperature = Math.min(1, Math.max(0, temperature));
  if (top_p !== undefined) body.top_p = top_p;
  if (stop) body.stop_sequences = Array.isArray(stop) ? stop : [stop];
  if (tools && tools.length > 0) body.tools = tools.map(convertToolToAnthropic);
  const antToolChoice = convertToolChoiceToAnthropic(tool_choice);
  if (antToolChoice) body.tool_choice = antToolChoice;

  return body;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic → OpenAI response
// ─────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_STOP_REASON_MAP = {
  end_turn: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  stop_sequence: 'stop',
};

/**
 * Translate an Anthropic Messages API response to an OpenAI Chat Completions
 * response.
 *
 * @param {object} antRes - Anthropic API response object
 * @param {string} requestedModel - The model string the caller sent (for response.model)
 * @returns {object} OpenAI-format chat completion response
 */
function fromAnthropicResponse(antRes, requestedModel) {
  const content = antRes.content || [];
  const textBlocks = content.filter((b) => b.type === 'text');
  const toolBlocks = content.filter((b) => b.type === 'tool_use');

  const message = { role: 'assistant', content: null };

  if (textBlocks.length > 0) {
    message.content = textBlocks.map((b) => b.text).join('');
  }

  if (toolBlocks.length > 0) {
    message.tool_calls = toolBlocks.map((b, i) => ({
      id: b.id || `call_${i}`,
      type: 'function',
      function: {
        name: b.name,
        arguments: JSON.stringify(b.input || {}),
      },
    }));
  }

  const finishReason =
    ANTHROPIC_STOP_REASON_MAP[antRes.stop_reason] || antRes.stop_reason || 'stop';

  return {
    id: antRes.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || antRes.model || 'unknown',
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: antRes.usage
      ? {
          prompt_tokens: antRes.usage.input_tokens || 0,
          completion_tokens: antRes.usage.output_tokens || 0,
          total_tokens:
            (antRes.usage.input_tokens || 0) + (antRes.usage.output_tokens || 0),
        }
      : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic streaming → OpenAI SSE Transform
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Node.js Transform stream that translates Anthropic SSE events to OpenAI
 * SSE chunks.
 *
 * Anthropic emits named SSE events (event: <type>\ndata: <json>\n\n).
 * OpenAI emits only data-only SSE lines (data: <json>\n\n) with a final
 * data: [DONE]\n\n.
 *
 * State tracked across events:
 *   - completionId  — from message_start.message.id
 *   - model         — from message_start.message.model (or caller-supplied)
 *   - inputTokens   — from message_start.message.usage.input_tokens
 *   - toolBlocks    — accumulator for tool_use content blocks (by index)
 */
class AnthropicToOAIStream extends Transform {
  constructor(requestedModel) {
    super({ readableObjectMode: false, writableObjectMode: false });
    this._requestedModel = requestedModel;
    this._buffer = '';
    this._completionId = `chatcmpl-${Date.now()}`;
    this._created = Math.floor(Date.now() / 1000);
    this._model = requestedModel;
    this._inputTokens = 0;
    // Map from Anthropic content-block index → OpenAI tool-call metadata.
    this._toolBlocks = {};
    this._nextToolCallIndex = 0;
    this._firstChunk = true;
    this._doneEmitted = false;
  }

  _transform(chunk, _encoding, callback) {
    this._buffer += chunk.toString();
    this._flushBuffer();
    callback();
  }

  _flush(callback) {
    if (this._buffer.trim()) {
      // Treat a final event without a terminating blank line as complete.
      this._buffer += '\n\n';
      this._flushBuffer();
    }
    // Providers occasionally close after message_delta without message_stop.
    // OpenAI clients still require one terminal sentinel.
    this._emitDone();
    callback();
  }

  /** Emit one OpenAI SSE chunk as a raw string. */
  _emitChunk(payload) {
    this.push(`data: ${JSON.stringify(payload)}\n\n`);
  }

  _emitDone() {
    if (this._doneEmitted) return;
    this._doneEmitted = true;
    this.push('data: [DONE]\n\n');
  }

  /** Emit the OpenAI role chunk that opens a new streaming message. */
  _emitRoleChunk() {
    this._emitChunk({
      id: this._completionId,
      object: 'chat.completion.chunk',
      created: this._created,
      model: this._model,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: '' },
          finish_reason: null,
        },
      ],
    });
  }

  _flushBuffer() {
    // Anthropic SSE: each event is separated by a blank line.
    // Lines starting with "event: " carry the event type.
    // Lines starting with "data: " carry the JSON payload.
    const events = this._buffer.split(/\r?\n\r?\n/);
    // The last element may be an incomplete event — keep it in the buffer.
    this._buffer = events.pop() || '';

    for (const raw of events) {
      const lines = raw.split(/\r?\n/);
      let eventType = null;
      let dataLine = null;

      for (const line of lines) {
        if (line.startsWith('event: ')) eventType = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLine = line.slice(6).trim();
      }

      if (!dataLine) continue;

      let parsed;
      try {
        parsed = JSON.parse(dataLine);
      } catch {
        continue; // malformed — skip
      }

      this._handleAnthropicEvent(eventType || parsed.type, parsed);
    }
  }

  _handleAnthropicEvent(type, parsed) {
    switch (type) {
      case 'message_start': {
        const msg = parsed.message || {};
        if (msg.id) this._completionId = msg.id;
        if (msg.model) this._model = this._requestedModel || msg.model;
        if (msg.usage?.input_tokens) this._inputTokens = msg.usage.input_tokens;
        // Emit the opening role chunk
        this._emitRoleChunk();
        this._firstChunk = false;
        break;
      }

      case 'content_block_start': {
        const block = parsed.content_block || {};
        const index = parsed.index ?? 0;
        if (block.type === 'text') {
          // Text block started; nothing to emit yet
        } else if (block.type === 'tool_use') {
          // Tool use block — record metadata and emit tool_call start chunk
          this._toolBlocks[index] = {
            id: block.id,
            name: block.name,
            partial_json: '',
            toolCallIndex: this._nextToolCallIndex++,
          };
          this._emitChunk({
            id: this._completionId,
            object: 'chat.completion.chunk',
            created: this._created,
            model: this._model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: this._toolBlocks[index].toolCallIndex,
                      id: block.id,
                      type: 'function',
                      function: { name: block.name, arguments: '' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
        }
        break;
      }

      case 'content_block_delta': {
        const delta = parsed.delta || {};
        const index = parsed.index ?? 0;

        if (delta.type === 'text_delta') {
          if (this._firstChunk) {
            this._emitRoleChunk();
            this._firstChunk = false;
          }
          this._emitChunk({
            id: this._completionId,
            object: 'chat.completion.chunk',
            created: this._created,
            model: this._model,
            choices: [
              {
                index: 0,
                delta: { content: delta.text },
                finish_reason: null,
              },
            ],
          });
        } else if (delta.type === 'input_json_delta') {
          // Append to tool-call arguments.
          const toolBlock = this._toolBlocks[index];
          if (!toolBlock) break;
          toolBlock.partial_json += delta.partial_json || '';
          this._emitChunk({
            id: this._completionId,
            object: 'chat.completion.chunk',
            created: this._created,
            model: this._model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: toolBlock.toolCallIndex,
                      function: { arguments: delta.partial_json || '' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
        }
        break;
      }

      case 'content_block_stop':
        // Nothing to emit; next delta / message_delta will handle it
        break;

      case 'message_delta': {
        const stopReason =
          ANTHROPIC_STOP_REASON_MAP[parsed.delta?.stop_reason] ||
          parsed.delta?.stop_reason ||
          'stop';
        const outputTokens = parsed.usage?.output_tokens || 0;
        this._emitChunk({
          id: this._completionId,
          object: 'chat.completion.chunk',
          created: this._created,
          model: this._model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: stopReason,
            },
          ],
          // Emit usage summary in final chunk (OpenAI stream_options compat)
          usage: {
            prompt_tokens: this._inputTokens,
            completion_tokens: outputTokens,
            total_tokens: this._inputTokens + outputTokens,
          },
        });
        break;
      }

      case 'message_stop':
        this._emitDone();
        break;

      case 'ping':
      case 'error':
      default:
        // Ignore ping; errors are handled at the HTTP level
        break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI → Google (Gemini) request
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert an OpenAI role to a Google Gemini role.
 * OpenAI uses "user" / "assistant"; Gemini uses "user" / "model".
 */
function oaiRoleToGemini(role) {
  if (role === 'assistant') return 'model';
  return 'user'; // "user", "function", "tool" all map to user in Gemini
}

/**
 * Convert an OpenAI messages array to a Gemini `contents` array plus optional
 * `systemInstruction`.
 */
function convertMessagesToGemini(messages) {
  const systemParts = [];
  const contents = [];
  const toolNamesById = new Map();

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join('\n')
            : '';
      if (text) systemParts.push({ text });
      continue;
    }

    const parts = [];
    if (typeof msg.content === 'string' && msg.role !== 'tool') {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content) && msg.role !== 'tool') {
      for (const part of msg.content) {
        if (part.type === 'text') {
          parts.push({ text: part.text });
        } else if (part.type === 'image_url') {
          const url = part.image_url?.url || '';
          if (url.startsWith('data:')) {
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
            }
          } else {
            // External URL — Gemini supports fileData for GCS URIs only;
            // fall back to text representation for other URLs
            parts.push({ text: `[image: ${url}]` });
          }
        }
      }
    }

    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const toolCall of msg.tool_calls) {
        const fn = toolCall.function || {};
        let args = {};
        try {
          args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : fn.arguments || {};
        } catch {
          args = {};
        }
        if (toolCall.id && fn.name) toolNamesById.set(toolCall.id, fn.name);
        parts.push({ functionCall: { name: fn.name, args } });
      }
    }

    if (msg.role === 'tool') {
      let response;
      try {
        response = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
      } catch {
        response = { content: msg.content == null ? '' : String(msg.content) };
      }
      if (response === null || typeof response !== 'object' || Array.isArray(response)) {
        response = { content: response };
      }
      parts.push({
        functionResponse: {
          name: toolNamesById.get(msg.tool_call_id) || 'function',
          response,
        },
      });
    }

    if (parts.length > 0) {
      contents.push({ role: oaiRoleToGemini(msg.role), parts });
    }
  }

  return {
    contents,
    systemInstruction: systemParts.length > 0 ? { parts: systemParts } : undefined,
  };
}

/**
 * Translate an OpenAI Chat Completions request body to a Google Gemini
 * `generateContent` request body.
 *
 * @param {object} oaiBody - OpenAI-format request body
 * @returns {object} Gemini-format request body
 */
function toGoogleRequest(oaiBody) {
  const { messages = [], max_tokens, temperature, top_p, stop, stream, tools, tool_choice } = oaiBody;

  const { contents, systemInstruction } = convertMessagesToGemini(messages);

  const body = { contents };

  if (systemInstruction) body.systemInstruction = systemInstruction;

  const generationConfig = {};
  if (max_tokens) generationConfig.maxOutputTokens = max_tokens;
  if (temperature !== undefined) generationConfig.temperature = temperature;
  if (top_p !== undefined) generationConfig.topP = top_p;
  if (stop) generationConfig.stopSequences = Array.isArray(stop) ? stop : [stop];
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

  const functionDeclarations = (tools || [])
    .filter((tool) => tool?.type === 'function' && tool.function?.name)
    .map((tool) => ({
      name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      parameters: tool.function.parameters || { type: 'object', properties: {} },
    }));
  if (functionDeclarations.length > 0) {
    body.tools = [{ functionDeclarations }];
  }

  const functionCallingConfig = (() => {
    if (!tool_choice || tool_choice === 'auto') return null;
    if (tool_choice === 'none') return { mode: 'NONE' };
    if (tool_choice === 'required') return { mode: 'ANY' };
    if (typeof tool_choice === 'object' && tool_choice.type === 'function' && tool_choice.function?.name) {
      return { mode: 'ANY', allowedFunctionNames: [tool_choice.function.name] };
    }
    return null;
  })();
  if (functionCallingConfig) body.toolConfig = { functionCallingConfig };

  // Gemini streaming uses streamGenerateContent endpoint (handled in routing);
  // the request body itself does not need a `stream` flag.
  void stream;

  return body;
}

// ─────────────────────────────────────────────────────────────────────────────
// Google → OpenAI response
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_FINISH_REASON_MAP = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  OTHER: 'stop',
  FINISH_REASON_UNSPECIFIED: 'stop',
};

/**
 * Translate a Google Gemini `generateContent` response to an OpenAI Chat
 * Completions response.
 *
 * @param {object} gRes - Gemini API response object
 * @param {string} requestedModel - Model string the caller sent
 * @returns {object} OpenAI-format chat completion response
 */
function fromGoogleResponse(gRes, requestedModel) {
  const candidate = (gRes.candidates || [])[0] || {};
  const parts = candidate.content?.parts || [];
  const text = parts
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
  const functionCalls = parts
    .filter((p) => p.functionCall?.name)
    .map((p, index) => ({
      id: p.functionCall.id || `call_${index}`,
      type: 'function',
      function: {
        name: p.functionCall.name,
        arguments: JSON.stringify(p.functionCall.args || {}),
      },
    }));
  const message = { role: 'assistant', content: text || null };
  if (functionCalls.length > 0) message.tool_calls = functionCalls;

  const finishReason =
    GEMINI_FINISH_REASON_MAP[candidate.finishReason] || candidate.finishReason || 'stop';

  const usage = gRes.usageMetadata
    ? {
        prompt_tokens: gRes.usageMetadata.promptTokenCount || 0,
        completion_tokens: gRes.usageMetadata.candidatesTokenCount || 0,
        total_tokens: gRes.usageMetadata.totalTokenCount || 0,
      }
    : undefined;

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || 'gemini',
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Google streaming → OpenAI SSE Transform
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Transform stream that translates Google Gemini SSE streaming events to
 * OpenAI SSE chunks.
 *
 * Gemini `streamGenerateContent` returns SSE events where each `data:` line
 * contains a full (partial) GenerateContentResponse JSON object.
 */
class GoogleToOAIStream extends Transform {
  constructor(requestedModel) {
    super({ readableObjectMode: false, writableObjectMode: false });
    this._requestedModel = requestedModel;
    this._completionId = `chatcmpl-${Date.now()}`;
    this._created = Math.floor(Date.now() / 1000);
    this._buffer = '';
    this._firstChunk = true;
    this._promptTokens = 0;
    this._functionCallIndexes = new Map();
    this._nextToolCallIndex = 0;
  }

  _transform(chunk, _encoding, callback) {
    this._buffer += chunk.toString();
    this._flushBuffer();
    callback();
  }

  _flush(callback) {
    if (this._buffer.trim()) this._flushBuffer();
    callback();
  }

  _flushBuffer() {
    const events = this._buffer.split(/\r?\n\r?\n/);
    this._buffer = events.pop() || '';

    for (const raw of events) {
      const lines = raw.split(/\r?\n/);
      let dataLine = null;
      for (const line of lines) {
        if (line.startsWith('data: ')) dataLine = line.slice(6).trim();
      }
      if (!dataLine) continue;

      let parsed;
      try {
        parsed = JSON.parse(dataLine);
      } catch {
        continue;
      }

      this._handleGeminiEvent(parsed);
    }
  }

  _handleGeminiEvent(parsed) {
    const candidate = (parsed.candidates || [])[0];
    if (!candidate) return;

    const parts = candidate.content?.parts || [];
    const text = parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    const functionCalls = parts.filter((p) => p.functionCall?.name);

    if (this._firstChunk) {
      // Emit role chunk
      this.push(
        `data: ${JSON.stringify({
          id: this._completionId,
          object: 'chat.completion.chunk',
          created: this._created,
          model: this._requestedModel,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        })}\n\n`,
      );
      this._firstChunk = false;
    }

    if (parsed.usageMetadata?.promptTokenCount) {
      this._promptTokens = parsed.usageMetadata.promptTokenCount;
    }

    const finishReason = candidate.finishReason
      ? GEMINI_FINISH_REASON_MAP[candidate.finishReason] || candidate.finishReason
      : null;

    const delta = text ? { content: text } : {};
    if (functionCalls.length > 0) {
      delta.tool_calls = functionCalls.map((part, partIndex) => {
        const call = part.functionCall;
        const key = call.id || `${call.name}:${partIndex}`;
        let index = this._functionCallIndexes.get(key);
        const initial = index === undefined;
        if (initial) {
          index = this._nextToolCallIndex++;
          this._functionCallIndexes.set(key, index);
        }
        return initial
          ? {
              index,
              id: call.id || `call_${index}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
            }
          : { index, function: { arguments: JSON.stringify(call.args || {}) } };
      });
    }

    const chunk = {
      id: this._completionId,
      object: 'chat.completion.chunk',
      created: this._created,
      model: this._requestedModel,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
    };

    if (finishReason && parsed.usageMetadata) {
      chunk.usage = {
        prompt_tokens: this._promptTokens,
        completion_tokens: parsed.usageMetadata.candidatesTokenCount || 0,
        total_tokens: parsed.usageMetadata.totalTokenCount || 0,
      };
    }

    this.push(`data: ${JSON.stringify(chunk)}\n\n`);

    if (finishReason) {
      this.push('data: [DONE]\n\n');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate an OpenAI Chat Completions request body to the provider-native
 * request body.  Returns the body unchanged for pass-through providers.
 *
 * @param {object} oaiBody  - OpenAI format request body
 * @param {string} provider - Resolved provider name
 * @returns {object} Provider-format request body
 */
function toProviderRequest(oaiBody, provider) {
  if (isPassthrough(provider)) return oaiBody;
  if (provider === 'anthropic') return toAnthropicRequest(oaiBody);
  if (provider === 'google') return toGoogleRequest(oaiBody);
  // Unknown provider — pass through and let the forward layer handle errors
  return oaiBody;
}

/**
 * Translate a provider-native JSON response to an OpenAI Chat Completions
 * response object.  Returns the body unchanged for pass-through providers.
 *
 * @param {object} providerBody  - Provider-format response body
 * @param {string} provider      - Provider name
 * @param {string} requestedModel - Original model string from caller
 * @returns {object} OpenAI-format response
 */
function fromProviderResponse(providerBody, provider, requestedModel) {
  if (isPassthrough(provider)) return providerBody;
  if (provider === 'anthropic') return fromAnthropicResponse(providerBody, requestedModel);
  if (provider === 'google') return fromGoogleResponse(providerBody, requestedModel);
  return providerBody;
}

/**
 * Create a Transform stream that translates a provider's SSE output to
 * OpenAI-format SSE output.  Returns null for pass-through providers
 * (caller should pipe the response body directly).
 *
 * @param {string} provider      - Provider name
 * @param {string} requestedModel - Original model string for response.model
 * @returns {Transform|null}
 */
function createProviderStreamTransform(provider, requestedModel) {
  if (isPassthrough(provider)) return null;
  if (provider === 'anthropic') return new AnthropicToOAIStream(requestedModel);
  if (provider === 'google') return new GoogleToOAIStream(requestedModel);
  return null;
}

module.exports = {
  isPassthrough,
  toProviderRequest,
  fromProviderResponse,
  createProviderStreamTransform,
  // Exported for unit tests
  toAnthropicRequest,
  fromAnthropicResponse,
  toGoogleRequest,
  fromGoogleResponse,
  AnthropicToOAIStream,
  GoogleToOAIStream,
};

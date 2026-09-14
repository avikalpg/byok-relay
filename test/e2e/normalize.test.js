/**
 * normalize.test.js — Tests for the cross-provider protocol normalization layer
 * and the POST /relay/v1/chat/completions endpoint (closes #97).
 *
 * Unit tests (no relay process):
 *   - isPassthrough classification
 *   - toProviderRequest: pass-through, Anthropic, Google translation
 *   - fromProviderResponse: pass-through, Anthropic, Google translation
 *   - createProviderStreamTransform: null vs. Transform instances
 *   - AnthropicToOAIStream: SSE event translation
 *   - GoogleToOAIStream: SSE data-line translation
 *
 * E2E tests (relay child process + mock):
 *   - Error paths: missing model, unknown model, no auth token, no stored key
 *   - Pass-through (openai-compatible) non-streaming: OAI response forwarded
 *   - Pass-through (openai-compatible) streaming: SSE forwarded
 *   - X-Byok-Relay-Normalized header absent for pass-through providers
 *
 * Anthropic/Google translation correctness is covered by unit tests above;
 * full E2E provider translation requires wiring provider base-URL overrides
 * which would expand the scope of this PR beyond issue #97.
 *
 * Run: node --test test/e2e/normalize.test.js
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const { spawn } = require('node:child_process');
const os     = require('node:os');
const path   = require('node:path');
const fs     = require('node:fs');
const crypto = require('node:crypto');

const {
  isPassthrough,
  toProviderRequest,
  fromProviderResponse,
  createProviderStreamTransform,
  toAnthropicRequest,
  fromAnthropicResponse,
  toGoogleRequest,
  fromGoogleResponse,
  AnthropicToOAIStream,
  GoogleToOAIStream,
} = require('../../src/normalize');

const { createMockProvider } = require('./mock-provider');

function randomTestSecret(label) {
  return `${label}-${crypto.randomBytes(24).toString('hex')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit: isPassthrough
// ─────────────────────────────────────────────────────────────────────────────

describe('isPassthrough', () => {
  it('returns true for openai', () => assert.equal(isPassthrough('openai'), true));
  it('returns true for groq', () => assert.equal(isPassthrough('groq'), true));
  it('returns true for mistral', () => assert.equal(isPassthrough('mistral'), true));
  it('returns true for openrouter', () => assert.equal(isPassthrough('openrouter'), true));
  it('returns true for openai-compatible', () => assert.equal(isPassthrough('openai-compatible'), true));
  it('returns false for anthropic', () => assert.equal(isPassthrough('anthropic'), false));
  it('returns false for google', () => assert.equal(isPassthrough('google'), false));
  it('returns false for unknown provider', () => assert.equal(isPassthrough('unknown-xyz'), false));
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: toProviderRequest
// ─────────────────────────────────────────────────────────────────────────────

describe('toProviderRequest — pass-through providers', () => {
  const oaiBody = {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello' }],
    temperature: 0.7,
  };
  for (const provider of ['openai', 'groq', 'mistral', 'openrouter', 'openai-compatible']) {
    it(`returns body unchanged for ${provider}`, () => {
      const result = toProviderRequest(oaiBody, provider);
      assert.deepEqual(result, oaiBody, `${provider} should be pass-through`);
    });
  }
});

describe('toAnthropicRequest', () => {
  it('converts a simple user message', () => {
    const body = {
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Say hi' }],
      max_tokens: 100,
    };
    const result = toAnthropicRequest(body);
    assert.equal(result.model, 'claude-3-5-haiku-20241022');
    assert.equal(result.max_tokens, 100);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, 'user');
    // For a simple string content, convertContentToAnthropic returns the string as-is
    assert.ok(
      typeof result.messages[0].content === 'string' || Array.isArray(result.messages[0].content),
      'content should be a string or content-blocks array',
    );
    assert.equal(result.system, undefined, 'no system message → no system field');
  });

  it('extracts system message from messages array', () => {
    const body = {
      model: 'claude-3-haiku-20240307',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ],
    };
    const result = toAnthropicRequest(body);
    assert.equal(result.system, 'You are a helpful assistant.');
    assert.equal(result.messages.length, 1, 'system message should be removed from messages');
    assert.equal(result.messages[0].role, 'user');
  });

  it('defaults max_tokens to 4096 when not specified', () => {
    const body = { model: 'claude-3-5-haiku-20241022', messages: [{ role: 'user', content: 'Hi' }] };
    const result = toAnthropicRequest(body);
    assert.equal(result.max_tokens, 4096);
  });

  it('clamps temperature above 1.0 to 1.0', () => {
    const body = {
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 1.8,
    };
    const result = toAnthropicRequest(body);
    assert.equal(result.temperature, 1);
  });

  it('converts stop string to stop_sequences array', () => {
    const body = {
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
      stop: 'END',
    };
    const result = toAnthropicRequest(body);
    assert.deepEqual(result.stop_sequences, ['END']);
  });

  it('converts stop array to stop_sequences directly', () => {
    const body = {
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
      stop: ['END', 'STOP'],
    };
    const result = toAnthropicRequest(body);
    assert.deepEqual(result.stop_sequences, ['END', 'STOP']);
  });

  it('propagates stream flag', () => {
    const body = {
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    };
    const result = toAnthropicRequest(body);
    assert.equal(result.stream, true);
  });

  it('preserves assistant content parts as individual Anthropic blocks', () => {
    const result = toAnthropicRequest({
      model: 'claude-3-5-haiku-20241022',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'I found this:' },
          { type: 'image_url', image_url: { url: 'https://example.test/image.png' } },
        ],
      }],
    });
    assert.deepEqual(result.messages[0].content, [
      { type: 'text', text: 'I found this:' },
      { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } },
    ]);
  });

  it('does not include undefined fields in result', () => {
    const body = { model: 'claude-3-5-haiku-20241022', messages: [{ role: 'user', content: 'Hi' }] };
    const result = toAnthropicRequest(body);
    assert.equal(result.temperature, undefined);
    assert.equal(result.top_p, undefined);
    assert.equal(result.stop_sequences, undefined);
    assert.equal(result.tools, undefined);
  });
});

describe('toGoogleRequest', () => {
  it('converts a simple user message to Gemini contents format', () => {
    const body = {
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'Tell me a joke' }],
      max_tokens: 200,
    };
    const result = toGoogleRequest(body);
    assert.ok(Array.isArray(result.contents), 'result.contents should be an array');
    assert.equal(result.contents[0].role, 'user');
    assert.equal(result.generationConfig?.maxOutputTokens, 200);
  });

  it('extracts system message as systemInstruction', () => {
    const body = {
      model: 'gemini-2.0-flash',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' },
      ],
    };
    const result = toGoogleRequest(body);
    assert.ok(result.systemInstruction, 'should have systemInstruction');
    assert.equal(result.contents.length, 1, 'system message removed from contents');
    assert.equal(result.contents[0].role, 'user');
  });

  it('does not include a stream flag in the request body', () => {
    const body = {
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    };
    const result = toGoogleRequest(body);
    assert.equal(result.stream, undefined, 'Gemini uses URL suffix for streaming, not body flag');
  });

  it('converts OpenAI function tools and tool choice to Gemini declarations', () => {
    const result = toGoogleRequest({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'What is the weather?' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Gets weather by city',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      }],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    });
    assert.deepEqual(result.tools, [{ functionDeclarations: [{
      name: 'get_weather',
      description: 'Gets weather by city',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    }] }]);
    assert.deepEqual(result.toolConfig, {
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: fromProviderResponse
// ─────────────────────────────────────────────────────────────────────────────

describe('fromProviderResponse — pass-through providers', () => {
  const oaiRes = {
    id: 'chatcmpl-123',
    object: 'chat.completion',
    choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  };
  for (const provider of ['openai', 'groq', 'mistral', 'openrouter']) {
    it(`returns body unchanged for ${provider}`, () => {
      const result = fromProviderResponse(oaiRes, provider, 'gpt-4o');
      assert.deepEqual(result, oaiRes);
    });
  }
});

describe('fromAnthropicResponse', () => {
  it('converts text-only response to OpenAI format', () => {
    const antRes = {
      id: 'msg_abc123',
      model: 'claude-3-5-haiku-20241022',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hello, I am Claude!' }],
      usage: { input_tokens: 10, output_tokens: 7 },
    };
    const result = fromAnthropicResponse(antRes, 'anthropic/claude-3-5-haiku-20241022');
    assert.equal(result.object, 'chat.completion');
    assert.equal(result.id, 'msg_abc123');
    assert.equal(result.model, 'anthropic/claude-3-5-haiku-20241022');
    assert.equal(result.choices.length, 1);
    assert.equal(result.choices[0].message.role, 'assistant');
    assert.equal(result.choices[0].message.content, 'Hello, I am Claude!');
    assert.equal(result.choices[0].finish_reason, 'stop');
    assert.equal(result.usage.prompt_tokens, 10);
    assert.equal(result.usage.completion_tokens, 7);
    assert.equal(result.usage.total_tokens, 17);
  });

  it('maps anthropic stop reasons to OpenAI finish reasons', () => {
    const cases = [
      ['end_turn', 'stop'],
      ['max_tokens', 'length'],
      ['tool_use', 'tool_calls'],
      ['stop_sequence', 'stop'],
    ];
    for (const [antReason, oaiReason] of cases) {
      const result = fromAnthropicResponse(
        { id: 'x', content: [{ type: 'text', text: 'x' }], stop_reason: antReason },
        'anthropic/claude-3-5-haiku-20241022',
      );
      assert.equal(result.choices[0].finish_reason, oaiReason, `stop_reason=${antReason}`);
    }
  });

  it('converts tool_use content blocks to tool_calls format', () => {
    const antRes = {
      id: 'msg_tool',
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { location: 'London' } },
      ],
    };
    const result = fromAnthropicResponse(antRes, 'claude-3-5-haiku-20241022');
    assert.equal(result.choices[0].finish_reason, 'tool_calls');
    const toolCall = result.choices[0].message.tool_calls[0];
    assert.equal(toolCall.id, 'toolu_01');
    assert.equal(toolCall.type, 'function');
    assert.equal(toolCall.function.name, 'get_weather');
    assert.deepEqual(JSON.parse(toolCall.function.arguments), { location: 'London' });
  });

  it('handles missing usage gracefully', () => {
    const antRes = {
      id: 'msg_no_usage',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hi' }],
    };
    const result = fromAnthropicResponse(antRes, 'anthropic/claude-3');
    assert.equal(result.usage, undefined, 'should not include usage when absent');
    assert.equal(result.object, 'chat.completion');
  });
});

describe('fromGoogleResponse', () => {
  it('converts a Gemini generateContent response to OpenAI format', () => {
    const gRes = {
      candidates: [{
        content: { role: 'model', parts: [{ text: 'Hello from Gemini!' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6, totalTokenCount: 11 },
    };
    const result = fromGoogleResponse(gRes, 'google/gemini-2.0-flash');
    assert.equal(result.object, 'chat.completion');
    assert.equal(result.model, 'google/gemini-2.0-flash');
    assert.equal(result.choices[0].message.role, 'assistant');
    assert.equal(result.choices[0].message.content, 'Hello from Gemini!');
    assert.equal(result.choices[0].finish_reason, 'stop');
    assert.equal(result.usage.prompt_tokens, 5);
    assert.equal(result.usage.completion_tokens, 6);
    assert.equal(result.usage.total_tokens, 11);
  });

  it('maps Gemini finish reasons to OpenAI finish reasons', () => {
    const cases = [
      ['STOP', 'stop'],
      ['MAX_TOKENS', 'length'],
      ['SAFETY', 'content_filter'],
      ['RECITATION', 'content_filter'],
    ];
    for (const [geminiReason, oaiReason] of cases) {
      const result = fromGoogleResponse(
        { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: geminiReason }] },
        'gemini-2.0-flash',
      );
      assert.equal(result.choices[0].finish_reason, oaiReason, `finishReason=${geminiReason}`);
    }
  });

  it('concatenates multiple text parts', () => {
    const gRes = {
      candidates: [{
        content: { parts: [{ text: 'Hello ' }, { text: 'world' }] },
        finishReason: 'STOP',
      }],
    };
    const result = fromGoogleResponse(gRes, 'gemini-2.0-flash');
    assert.equal(result.choices[0].message.content, 'Hello world');
  });

  it('converts Gemini function calls to OpenAI tool calls', () => {
    const result = fromGoogleResponse({
      candidates: [{
        content: { parts: [{ functionCall: { id: 'gem_call_1', name: 'get_weather', args: { city: 'London' } } }] },
        finishReason: 'STOP',
      }],
    }, 'gemini-2.0-flash');
    assert.equal(result.choices[0].message.content, null);
    assert.deepEqual(result.choices[0].message.tool_calls, [{
      id: 'gem_call_1', type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"London"}' },
    }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: createProviderStreamTransform
// ─────────────────────────────────────────────────────────────────────────────

describe('createProviderStreamTransform', () => {
  it('returns null for pass-through providers', () => {
    assert.equal(createProviderStreamTransform('openai', 'gpt-4o'), null);
    assert.equal(createProviderStreamTransform('groq', 'llama-3'), null);
    assert.equal(createProviderStreamTransform('mistral', 'mistral-large'), null);
    assert.equal(createProviderStreamTransform('openrouter', 'openrouter/gpt-4o'), null);
  });

  it('returns an AnthropicToOAIStream instance for anthropic', () => {
    const t = createProviderStreamTransform('anthropic', 'claude-3-5-haiku-20241022');
    assert.ok(t instanceof AnthropicToOAIStream);
  });

  it('returns a GoogleToOAIStream instance for google', () => {
    const t = createProviderStreamTransform('google', 'gemini-2.0-flash');
    assert.ok(t instanceof GoogleToOAIStream);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: AnthropicToOAIStream
// ─────────────────────────────────────────────────────────────────────────────

function pipeThrough(Transform, input) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    Transform.on('data', (c) => chunks.push(c.toString()));
    Transform.on('end', () => resolve(chunks.join('')));
    Transform.on('error', reject);
    Transform.write(Buffer.from(input));
    Transform.end();
  });
}

describe('AnthropicToOAIStream', () => {
  it('converts content_block_delta events to OAI SSE chunks', async () => {
    const stream = new AnthropicToOAIStream('anthropic/claude-3-5-haiku-20241022');
    const input = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01","model":"claude-3-5-haiku-20241022","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello!"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');

    const output = await pipeThrough(stream, input);
    // Must emit at least one data: line
    assert.ok(output.includes('data: '), 'should emit SSE data lines');
    // Must end with [DONE]
    assert.ok(output.includes('[DONE]'), 'should emit [DONE] sentinel');
    // Must NOT leak raw Anthropic event types
    assert.ok(!output.includes('event: content_block_delta'), 'should not forward Anthropic event types');
    // The text content should appear in a chunk
    assert.ok(output.includes('Hello!'), 'content should appear in OAI chunks');
  });

  it('emits [DONE] sentinel on message_stop', async () => {
    const stream = new AnthropicToOAIStream('claude-3-5-haiku-20241022');
    const input = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const output = await pipeThrough(stream, input);
    assert.ok(output.includes('[DONE]'), 'message_stop must trigger [DONE]');
  });

  it('emits exactly one [DONE] fallback when message_stop is absent', async () => {
    const stream = new AnthropicToOAIStream('claude-3-5-haiku-20241022');
    const input = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}';
    const output = await pipeThrough(stream, input);
    assert.equal((output.match(/data: \[DONE\]/g) || []).length, 1);
  });

  it('uses tool-call ordinals rather than raw Anthropic block indexes', async () => {
    const stream = new AnthropicToOAIStream('claude-3-5-haiku-20241022');
    const input = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"tool_1","name":"first","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":5,"content_block":{"type":"tool_use","id":"tool_2","name":"second","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":5,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
    ].join('');
    const chunks = (await pipeThrough(stream, input))
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)));
    const toolDeltas = chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls || []);
    assert.deepEqual(toolDeltas.map((call) => call.index), [0, 0, 1, 1]);
  });

  it('emits OAI chunk shape (id, object, choices) in data lines', async () => {
    const stream = new AnthropicToOAIStream('anthropic/claude-3-5-haiku-20241022');
    const input = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');

    const output = await pipeThrough(stream, input);
    // Find first actual data chunk (not [DONE])
    const lines = output.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'));
    assert.ok(lines.length > 0, 'should have at least one data chunk');
    const parsed = JSON.parse(lines[0].slice(6));
    assert.ok(parsed.id, 'chunk should have id');
    assert.equal(parsed.object, 'chat.completion.chunk');
    assert.ok(Array.isArray(parsed.choices), 'chunk should have choices');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: GoogleToOAIStream
// ─────────────────────────────────────────────────────────────────────────────

describe('GoogleToOAIStream', () => {
  it('converts a Gemini SSE data line to OAI SSE chunks', async () => {
    const stream = new GoogleToOAIStream('google/gemini-2.0-flash');
    const geminiChunk = JSON.stringify({
      candidates: [{
        content: { parts: [{ text: 'Hi there' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
    });
    const input = `data: ${geminiChunk}\n\n`;
    const output = await pipeThrough(stream, input);
    assert.ok(output.includes('data: '), 'should emit SSE data lines');
    assert.ok(output.includes('[DONE]'), 'should emit [DONE] on finishReason=STOP');
    assert.ok(output.includes('Hi there'), 'should include text content');
  });

  it('emits OAI chunk shape in data lines', async () => {
    const stream = new GoogleToOAIStream('google/gemini-2.0-flash');
    const geminiChunk = JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'hey' }] }, finishReason: 'STOP' }],
    });
    const output = await pipeThrough(stream, `data: ${geminiChunk}\n\n`);
    const lines = output.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'));
    if (lines.length > 0) {
      const parsed = JSON.parse(lines[0].slice(6));
      assert.ok(parsed.id, 'chunk should have id');
      assert.equal(parsed.object, 'chat.completion.chunk');
      assert.ok(Array.isArray(parsed.choices));
    }
    // Either has data chunks OR just [DONE] — both are valid for a single-part response
    assert.ok(output.includes('[DONE]'), 'should always end with [DONE] when finishReason present');
  });

  it('converts Gemini streaming function calls to OpenAI tool-call deltas', async () => {
    const stream = new GoogleToOAIStream('google/gemini-2.0-flash');
    const input = `data: ${JSON.stringify({
      candidates: [{
        content: { parts: [{ functionCall: { id: 'gem_call_1', name: 'get_weather', args: { city: 'London' } } }] },
        finishReason: 'STOP',
      }],
    })}\n\n`;
    const chunks = (await pipeThrough(stream, input))
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)));
    const toolCall = chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls || [])[0];
    assert.deepEqual(toolCall, {
      index: 0,
      id: 'gem_call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"London"}' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E: POST /relay/v1/chat/completions — error paths + pass-through
// ─────────────────────────────────────────────────────────────────────────────

describe('E2E — POST /relay/v1/chat/completions', () => {
  let mock, mockPort;
  let relayProc, relayPort;
  let relayToken;
  let tmpDir, dbPath;
  let e2eToken;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-relay-norm-e2e-'));
    dbPath = path.join(tmpDir, 'relay.db');

    mock = createMockProvider();
    mockPort = await mock.start();
    relayPort = await getFreePort();
    e2eToken = randomTestSecret('e2e-norm');

    const env = {
      ...process.env,
      PORT:              String(relayPort),
      DB_PATH:           dbPath,
      ENCRYPTION_SECRET: randomTestSecret('enc-norm'),
      LOG_LEVEL:         'silent',
      NODE_ENV:          'test',
      E2E_OPENAI_COMPATIBLE_BASE_URL:       `http://127.0.0.1:${mockPort}`,
      E2E_OPENAI_COMPATIBLE_BASE_URL_TOKEN: e2eToken,
    };
    relayProc = spawn(process.execPath, [path.resolve(__dirname, '../../src/index.js')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    relayProc.on('error', (e) => { throw e; });

    await waitForHealth(relayPort);

    // Register a user
    const reg = await req(relayPort, 'POST', '/users', { app_id: 'norm-e2e' });
    assert.ok([200, 201].includes(reg.status), `Registration failed: ${JSON.stringify(reg.body)}`);
    relayToken = reg.body.token;
    assert.ok(relayToken, 'should receive a relay token');

    // Store an openai-compatible key pointing at the mock (via E2E override).
    // Field name is `key` (not `api_key`) — matches POST /keys/:provider body schema.
    const storeKey = await req(relayPort, 'POST', '/keys/openai-compatible',
      { key: 'sk-fake-' + 'x'.repeat(30) },
      { 'x-relay-token': relayToken });
    assert.ok([200, 201].includes(storeKey.status), `Key store failed: ${JSON.stringify(storeKey.body)}`);
  });

  after(async () => {
    if (relayProc) relayProc.kill('SIGTERM');
    if (mock?.stop) await mock.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Error paths ────────────────────────────────────────────────────────

  it('returns 401 without an x-relay-token header', async () => {
    const res = await req(relayPort, 'POST', '/relay/v1/chat/completions',
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 401);
  });

  it('returns 400 when model field is absent', async () => {
    const res = await req(relayPort, 'POST', '/relay/v1/chat/completions',
      { messages: [{ role: 'user', content: 'hi' }] },
      { 'x-relay-token': relayToken });
    assert.equal(res.status, 400);
    assert.ok(res.body.error?.toLowerCase().includes('model'), 'error should mention model field');
  });

  it('returns 400 for an unroutable model string', async () => {
    const res = await req(relayPort, 'POST', '/relay/v1/chat/completions',
      { model: 'totally-unrecognized-model-xyz-999', messages: [{ role: 'user', content: 'hi' }] },
      { 'x-relay-token': relayToken });
    assert.equal(res.status, 400);
  });

  it('returns 400 when no key is stored for the resolved provider', async () => {
    // groq key is not stored; llama-3 routes to groq
    const res = await req(relayPort, 'POST', '/relay/v1/chat/completions',
      { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }] },
      { 'x-relay-token': relayToken });
    assert.equal(res.status, 400);
    assert.ok(
      res.body.error?.toLowerCase().includes('key') || res.body.error?.toLowerCase().includes('provider'),
      `expected key/provider error, got: ${JSON.stringify(res.body)}`,
    );
  });

  // ── Pass-through via openai-compatible (E2E mock) ──────────────────────

  it('forwards openai-compatible request and returns OAI-format JSON response', async () => {
    mock.clearRequests();
    const res = await req(
      relayPort,
      'POST',
      '/relay/v1/chat/completions',
      { model: 'openai-compatible/gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
      { 'x-relay-token': relayToken, 'x-relay-e2e-base-url-token': e2eToken },
    );
    assert.equal(res.status, 200, `Unexpected status: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.object, 'chat.completion');
    assert.ok(res.body.choices?.[0]?.message?.content, 'should have assistant message content');
    assert.equal(res.body.choices[0].finish_reason, 'stop');
  });

  it('does NOT set X-Byok-Relay-Normalized for pass-through openai-compatible', async () => {
    mock.clearRequests();
    const res = await reqRaw(
      relayPort,
      'POST',
      '/relay/v1/chat/completions',
      { model: 'openai-compatible/gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
      { 'x-relay-token': relayToken, 'x-relay-e2e-base-url-token': e2eToken },
    );
    assert.equal(res.status, 200);
    assert.equal(
      res.headers['x-byok-relay-normalized'],
      undefined,
      'pass-through should not set X-Byok-Relay-Normalized',
    );
  });

  it('forwards openai-compatible streaming request and returns OAI SSE', async () => {
    mock.clearRequests();
    const res = await reqRaw(
      relayPort,
      'POST',
      '/relay/v1/chat/completions',
      {
        model: 'openai-compatible/gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      },
      { 'x-relay-token': relayToken, 'x-relay-e2e-base-url-token': e2eToken },
    );
    assert.equal(res.status, 200, `Streaming status: ${res.status}`);
    assert.ok(
      res.headers['content-type']?.includes('text/event-stream'),
      'streaming should return text/event-stream content-type',
    );
    assert.ok(res.raw.includes('[DONE]'), 'SSE stream must end with [DONE]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = require('node:net').createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForHealth(port, maxMs = 10000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await req(port, 'GET', '/health');
      if (r.status === 200) return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`relay on port ${port} did not become healthy within ${maxMs}ms`);
}

/** Returns { status, body } where body is parsed JSON or raw string. */
function req(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options = {
      hostname: '127.0.0.1', port, path: urlPath, method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    };
    const r = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** Returns { status, headers, raw } — keeps raw SSE string and exposes response headers. */
function reqRaw(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options = {
      hostname: '127.0.0.1', port, path: urlPath, method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    };
    const r = http.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

'use strict';

/**
 * Smoke tests for @byok-relay/vercel-ai
 * Run with: node packages/vercel-ai/test/smoke.test.js
 * No network calls — all relay fetch() calls are intercepted.
 */

const { createByokRelayProvider, createByokRelayProviderSync, parseModelId, promptToMessages } = require('../src/index.js');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

function assertEq(a, b, label) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}\n     expected: ${JSON.stringify(b)}\n     got:      ${JSON.stringify(a)}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStorage(init = {}) {
  const store = { ...init };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
}

function makeHeaders(obj = {}) {
  // Minimal headers shim compatible with res.headers.entries()
  return {
    entries: () => Object.entries(obj)[Symbol.iterator](),
  };
}

function makeMockResponse({ json, body, ok = true, status = 200, headers = {} } = {}) {
  return {
    ok,
    status,
    headers: makeHeaders(headers),
    json: json ? async () => json : undefined,
    body: body ?? null,
  };
}

function ndjsonStream(chunks) {
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------

async function runTests() {
  // ----- Suite 1: parseModelId -----
  console.log('\n⚙️  parseModelId');
  assertEq(parseModelId('openai/gpt-4o'), { provider: 'openai', model: 'gpt-4o' }, 'openai/gpt-4o');
  assertEq(parseModelId('anthropic/claude-3-5-sonnet-20241022'), { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' }, 'anthropic/...');
  assertEq(parseModelId('groq/llama3-70b-8192'), { provider: 'groq', model: 'llama3-70b-8192' }, 'groq/...');
  assertEq(parseModelId('gpt-4o-mini'), { provider: 'openai', model: 'gpt-4o-mini' }, 'bare model → openai default');

  // ----- Suite 2: promptToMessages -----
  console.log('\n⚙️  promptToMessages');

  const simplePrompt = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: [{ type: 'text', text: 'Hello!' }] },
  ];
  const msgs = promptToMessages(simplePrompt);
  assertEq(msgs[0], { role: 'system', content: 'You are helpful.' }, 'system message passthrough');
  assertEq(msgs[1], { role: 'user', content: 'Hello!' }, 'single text part flattened to string');

  const multiPartPrompt = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image.' },
        { type: 'image', image: 'https://example.com/img.jpg' },
      ],
    },
  ];
  const multiMsgs = promptToMessages(multiPartPrompt);
  assert(Array.isArray(multiMsgs[0].content), 'multi-part user message stays as array');
  assertEq(multiMsgs[0].content[1], { type: 'image_url', image_url: { url: 'https://example.com/img.jpg' } }, 'image part converted to image_url');

  const assistantPrompt = [
    { role: 'assistant', content: [{ type: 'text', text: 'I can help.' }] },
  ];
  const assistantMsgs = promptToMessages(assistantPrompt);
  assertEq(assistantMsgs[0].role, 'assistant', 'assistant role preserved');
  assertEq(assistantMsgs[0].content, 'I can help.', 'assistant text part flattened');

  // ----- Suite 3: createByokRelayProviderSync — provider shape -----
  console.log('\n⚙️  createByokRelayProviderSync — provider shape');
  {
    const storage = makeStorage({ 'byok_relay_token_shape-test': 'existing-token' });
    const provider = createByokRelayProviderSync({ relayUrl: 'https://relay.example.com', appId: 'shape-test', storage });
    assert(typeof provider.languageModel === 'function', 'languageModel() is a function');
    assert(typeof provider.chat === 'function', 'chat() alias exists');
    assert(typeof provider.storeKey === 'function', 'storeKey() exists');
    assert(typeof provider.deleteAccount === 'function', 'deleteAccount() exists');
    assert(typeof provider.health === 'function', 'health() exists');
    assert(typeof provider.stats === 'function', 'stats() exists');
  }

  // ----- Suite 4: languageModel — LanguageModelV1 shape -----
  console.log('\n⚙️  languageModel — LanguageModelV1 shape');
  {
    const storage = makeStorage({ 'byok_relay_token_model-test': 'tok-abc' });
    const provider = createByokRelayProviderSync({ relayUrl: 'https://relay.example.com', appId: 'model-test', storage });
    const model = provider.languageModel('openai/gpt-4o');

    assertEq(model.specificationVersion, 'v1', 'specificationVersion = v1');
    assert(model.provider.startsWith('byok-relay.'), 'provider starts with byok-relay.');
    assertEq(model.modelId, 'openai/gpt-4o', 'modelId preserved');
    assert(typeof model.doGenerate === 'function', 'doGenerate is a function');
    assert(typeof model.doStream === 'function', 'doStream is a function');

    const modelAnthro = provider.languageModel('anthropic/claude-3-5-sonnet-20241022');
    assert(modelAnthro.provider === 'byok-relay.anthropic', 'anthropic provider parsed');

    const modelBare = provider.languageModel('gpt-4o-mini');
    assert(modelBare.provider === 'byok-relay.openai', 'bare model defaults to openai');
  }

  // ----- Suite 5: doGenerate — mock fetch -----
  console.log('\n⚙️  doGenerate — mock fetch');
  {
    const storage = makeStorage({ 'byok_relay_token_gen-test': 'tok-gen' });
    const provider = createByokRelayProviderSync({ relayUrl: 'https://relay.example.com', appId: 'gen-test', storage });
    const model = provider.languageModel('openai/gpt-4o');

    const mockJson = {
      choices: [{
        message: { role: 'assistant', content: 'Hello, world!' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };

    let capturedUrl, capturedBody;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return makeMockResponse({ json: mockJson, headers: { 'content-type': 'application/json' } });
    };

    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello!' }] }],
      maxTokens: 100,
      temperature: 0.5,
    });

    globalThis.fetch = origFetch;

    assertEq(result.text, 'Hello, world!', 'doGenerate returns text');
    assertEq(result.finishReason, 'stop', 'finishReason mapped to stop');
    assertEq(result.usage.promptTokens, 10, 'promptTokens');
    assertEq(result.usage.completionTokens, 5, 'completionTokens');
    assert(capturedUrl && capturedUrl.includes('/relay/openai/chat/completions'), 'relays to correct URL');
    assert(capturedBody && capturedBody.model === 'gpt-4o', 'model field stripped of provider prefix');
    assertEq(capturedBody.max_tokens, 100, 'maxTokens mapped to max_tokens');
    assertEq(capturedBody.temperature, 0.5, 'temperature forwarded');
    assert(!capturedBody.stream, 'stream=false for doGenerate');
  }

  // ----- Suite 6: doStream — SSE parsing -----
  console.log('\n⚙️  doStream — SSE parsing');
  {
    const storage = makeStorage({ 'byok_relay_token_stream-test': 'tok-stream' });
    const provider = createByokRelayProviderSync({ relayUrl: 'https://relay.example.com', appId: 'stream-test', storage });
    const model = provider.languageModel('anthropic/claude-3-5-haiku-20241022');

    const chunks = [
      { choices: [{ delta: { content: 'Hi ' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'there!' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3 } },
    ];

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => makeMockResponse({
      body: ndjsonStream(chunks),
      headers: { 'content-type': 'text/event-stream' },
    });

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hey' }] }],
    });

    globalThis.fetch = origFetch;

    const parts = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    const textDeltas = parts.filter((p) => p.type === 'text-delta');
    const finish = parts.find((p) => p.type === 'finish');

    assertEq(textDeltas.map((p) => p.textDelta).join(''), 'Hi there!', 'SSE text deltas assembled correctly');
    assert(finish !== undefined, 'finish event emitted');
    assertEq(finish.finishReason, 'stop', 'finish reason = stop');
    assertEq(finish.usage.completionTokens, 3, 'streaming usage forwarded');
  }

  // ----- Suite 7: createByokRelayProvider (async) — auto-registers -----
  console.log('\n⚙️  createByokRelayProvider (async) — auto-register');
  {
    const storage = makeStorage();  // empty — no stored token
    let registered = false;

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.endsWith('/users') && opts && opts.method === 'POST') {
        registered = true;
        return makeMockResponse({ json: { token: 'fresh-tok' } });
      }
      // Relay call
      return makeMockResponse({
        json: {
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      });
    };

    const provider = await createByokRelayProvider({ relayUrl: 'https://relay.example.com', appId: 'async-test', storage });
    const model = provider.languageModel('openai/gpt-4o-mini');
    await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] });

    globalThis.fetch = origFetch;

    assert(registered, 'auto-registered when no stored token');
    assertEq(storage.getItem('byok_relay_token_async-test'), 'fresh-tok', 'token persisted in storage');
  }

  // ----- Suite 8: settings overrides -----
  console.log('\n⚙️  settings overrides');
  {
    const storage = makeStorage({ 'byok_relay_token_settings-test': 'tok-s' });
    const provider = createByokRelayProviderSync({
      relayUrl: 'https://relay.example.com',
      appId: 'settings-test',
      storage,
      settings: { temperature: 0.2 },
    });
    const model = provider.languageModel('groq/llama3-70b-8192', { top_p: 0.9 });

    let body;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      body = JSON.parse(opts.body);
      return makeMockResponse({ json: { choices: [{ message: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0 } } });
    };

    await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] });
    globalThis.fetch = origFetch;

    assertEq(body.temperature, 0.2, 'default temperature from provider settings');
    assertEq(body.top_p, 0.9, 'model-level override applied');
    assert(body.model === 'llama3-70b-8192', 'groq model without provider prefix');
  }

  // ----- Suite 9: tool call support -----
  console.log('\n⚙️  tool calls');
  {
    const storage = makeStorage({ 'byok_relay_token_tools-test': 'tok-tools' });
    const provider = createByokRelayProviderSync({ relayUrl: 'https://relay.example.com', appId: 'tools-test', storage });
    const model = provider.languageModel('openai/gpt-4o');

    const mockJson = {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'call_abc',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 20, completion_tokens: 15 },
    };

    let body;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      body = JSON.parse(opts.body);
      return makeMockResponse({ json: mockJson });
    };

    const tools = [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }];
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] }],
      tools,
      toolChoice: { type: 'auto' },
    });

    globalThis.fetch = origFetch;

    assertEq(result.finishReason, 'tool-calls', 'finish_reason=tool_calls mapped to tool-calls');
    assert(result.toolCalls && result.toolCalls.length === 1, 'tool call returned');
    assertEq(result.toolCalls[0].toolName, 'get_weather', 'tool name');
    assert(body.tools && body.tools.length === 1, 'tools forwarded to relay');
    assertEq(body.tool_choice, 'auto', 'tool_choice forwarded');
  }

  // ----- Suite 10: error handling -----
  console.log('\n⚙️  error handling');
  {
    const storage = makeStorage({ 'byok_relay_token_err-test': 'tok-e' });
    const provider = createByokRelayProviderSync({ relayUrl: 'https://relay.example.com', appId: 'err-test', storage });
    const model = provider.languageModel('openai/gpt-4o');

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      headers: makeHeaders(),
      text: async () => 'Unauthorized',
    });

    let threw = false;
    try {
      await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] });
    } catch (e) {
      threw = true;
      assert(e.message.includes('401'), 'error includes status code');
    }
    globalThis.fetch = origFetch;
    assert(threw, 'throws on non-ok relay response');
  }

  // ----- Final report -----
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('\n💥 Test runner crashed:', err);
  process.exit(1);
});

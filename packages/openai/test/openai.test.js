/**
 * @byok-relay/openai — smoke tests
 * Run: node test/openai.test.js
 */

'use strict';

const { ByokRelayOpenAI, ByokRelayClient, ByokRelayStream, createByokRelayOpenAI } = require('../src/index.js');

let passed = 0;
let failed = 0;

function assert (condition, msg) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

function assertEqual (a, b, msg) {
  assert(a === b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}

/* ============================================================ */
/* 1. Module exports                                            */
/* ============================================================ */
console.log('\n1. Module exports');
assert(typeof ByokRelayOpenAI === 'function', 'ByokRelayOpenAI is a constructor');
assert(typeof ByokRelayClient === 'function', 'ByokRelayClient is a constructor');
assert(typeof ByokRelayStream === 'function', 'ByokRelayStream is a constructor');
assert(typeof createByokRelayOpenAI === 'function', 'createByokRelayOpenAI is a factory function');

/* ============================================================ */
/* 2. ByokRelayClient construction                             */
/* ============================================================ */
console.log('\n2. ByokRelayClient construction');

const client = new ByokRelayClient({ relayUrl: 'https://relay.byokrelay.com', appId: 'test-app' });
assertEqual(client.relayUrl, 'https://relay.byokrelay.com', 'relayUrl stored correctly');
assertEqual(client.appId, 'test-app', 'appId stored correctly');

const clientDefault = new ByokRelayClient();
assertEqual(clientDefault.relayUrl, 'https://relay.byokrelay.com', 'default relay URL is managed relay');
assertEqual(clientDefault.appId, 'byok-relay-openai', 'default appId set');

// trailing slash stripped
const clientSlash = new ByokRelayClient({ relayUrl: 'https://relay.byokrelay.com/' });
assertEqual(clientSlash.relayUrl, 'https://relay.byokrelay.com', 'trailing slash stripped from relayUrl');

/* ============================================================ */
/* 3. ByokRelayClient in-memory storage                        */
/* ============================================================ */
console.log('\n3. ByokRelayClient in-memory storage');

const memClient = new ByokRelayClient({ relayUrl: 'https://relay.byokrelay.com' });
assert(memClient._getStoredToken() === null, 'no token initially');
memClient._saveToken('test-token-123');
assertEqual(memClient._getStoredToken(), 'test-token-123', 'token saved and retrieved');
memClient._clearToken();
assert(memClient._getStoredToken() === null, 'token cleared');

/* ============================================================ */
/* 4. ByokRelayClient custom storage adapter                   */
/* ============================================================ */
console.log('\n4. ByokRelayClient custom storage adapter');

const customStore = new Map();
const customStorage = {
  getItem: (k) => customStore.get(k) ?? null,
  setItem: (k, v) => customStore.set(k, v),
  removeItem: (k) => customStore.delete(k),
};
const customClient = new ByokRelayClient({ storage: customStorage, relayUrl: 'https://relay.byokrelay.com' });
customClient._saveToken('custom-tok');
assertEqual(customClient._getStoredToken(), 'custom-tok', 'custom storage getItem works');
assert(customStore.size > 0, 'custom storage setItem called');
customClient._clearToken();
assertEqual(customClient._getStoredToken(), null, 'custom storage removeItem works');

/* ============================================================ */
/* 5. ByokRelayOpenAI construction                             */
/* ============================================================ */
console.log('\n5. ByokRelayOpenAI construction');

const openai = new ByokRelayOpenAI({ relayUrl: 'https://relay.byokrelay.com', provider: 'openai' });
assert(openai._provider === 'openai', 'provider set');
assert(openai._client instanceof ByokRelayClient, '_client is ByokRelayClient');

// factory function
const openai2 = createByokRelayOpenAI({ relayUrl: 'https://relay.byokrelay.com' });
assert(openai2 instanceof ByokRelayOpenAI, 'createByokRelayOpenAI returns ByokRelayOpenAI instance');

// default export compat
const { default: DefaultExport } = require('../src/index.js');
assertEqual(DefaultExport, ByokRelayOpenAI, 'default export is ByokRelayOpenAI');

/* ============================================================ */
/* 6. Namespace structure mirrors openai SDK                   */
/* ============================================================ */
console.log('\n6. Namespace structure mirrors openai SDK');

assert(typeof openai.chat === 'object', 'openai.chat exists');
assert(typeof openai.chat.completions === 'object', 'openai.chat.completions exists');
assert(typeof openai.chat.completions.create === 'function', 'openai.chat.completions.create is a function');

assert(typeof openai.embeddings === 'object', 'openai.embeddings exists');
assert(typeof openai.embeddings.create === 'function', 'openai.embeddings.create is a function');

assert(typeof openai.images === 'object', 'openai.images exists');
assert(typeof openai.images.generate === 'function', 'openai.images.generate is a function');
assert(typeof openai.images.edit === 'function', 'openai.images.edit is a function');

assert(typeof openai.models === 'object', 'openai.models exists');
assert(typeof openai.models.list === 'function', 'openai.models.list is a function');
assert(typeof openai.models.retrieve === 'function', 'openai.models.retrieve is a function');

assert(typeof openai.audio === 'object', 'openai.audio exists');
assert(typeof openai.audio.transcriptions === 'object', 'openai.audio.transcriptions exists');
assert(typeof openai.audio.transcriptions.create === 'function', 'openai.audio.transcriptions.create is a function');
assert(typeof openai.audio.speech === 'object', 'openai.audio.speech exists');
assert(typeof openai.audio.speech.create === 'function', 'openai.audio.speech.create is a function');

assert(typeof openai.completions === 'object', 'openai.completions exists (legacy)');
assert(typeof openai.completions.create === 'function', 'openai.completions.create is a function');

/* ============================================================ */
/* 7. Provider resolution from model prefix                    */
/* ============================================================ */
console.log('\n7. Provider resolution from model prefix');

assertEqual(openai._resolveProvider('gpt-4o'), 'openai', 'bare model uses default provider');
assertEqual(openai._resolveProvider('openai/gpt-4o'), 'openai', 'openai/ prefix resolved');
assertEqual(openai._resolveProvider('anthropic/claude-3-5-sonnet'), 'anthropic', 'anthropic/ prefix resolved');
assertEqual(openai._resolveProvider('groq/llama-3.1-70b'), 'groq', 'groq/ prefix resolved');
assertEqual(openai._resolveProvider('mistral/mistral-large'), 'mistral', 'mistral/ prefix resolved');
assertEqual(openai._resolveProvider('openrouter/meta-llama/llama-3.1-405b'), 'openrouter', 'openrouter/ prefix resolved');

assertEqual(openai._stripProviderPrefix('gpt-4o'), 'gpt-4o', 'bare model unchanged');
assertEqual(openai._stripProviderPrefix('openai/gpt-4o'), 'gpt-4o', 'openai prefix stripped');
assertEqual(openai._stripProviderPrefix('anthropic/claude-3-5-sonnet'), 'claude-3-5-sonnet', 'anthropic prefix stripped');
assertEqual(openai._stripProviderPrefix('openrouter/meta-llama/llama-3.1-405b'), 'meta-llama/llama-3.1-405b', 'only first segment stripped for nested paths');

/* ============================================================ */
/* 8. Convenience passthrough methods exist                    */
/* ============================================================ */
console.log('\n8. Convenience passthrough methods');

assert(typeof openai.register === 'function', 'register() exists');
assert(typeof openai.ensureToken === 'function', 'ensureToken() exists');
assert(typeof openai.logout === 'function', 'logout() exists');
assert(typeof openai.storeKey === 'function', 'storeKey() exists');
assert(typeof openai.listKeys === 'function', 'listKeys() exists');
assert(typeof openai.deleteKey === 'function', 'deleteKey() exists');
assert(typeof openai.rotateKey === 'function', 'rotateKey() exists');
assert(typeof openai.health === 'function', 'health() exists');
assert(typeof openai.stats === 'function', 'stats() exists');
assert(typeof openai.deleteAccount === 'function', 'deleteAccount() exists');

/* ============================================================ */
/* 9. apiKey passthrough mode (migration path)                 */
/* ============================================================ */
console.log('\n9. apiKey passthrough mode');

const withApiKey = new ByokRelayOpenAI({ relayUrl: 'https://relay.byokrelay.com', apiKey: 'sk-test-key' });
assert(withApiKey._apiKey === 'sk-test-key', 'apiKey stored for passthrough mode');

// _authHeader should use the raw key without calling ensureToken
withApiKey._authHeader().then(header => {
  assert(header === 'Bearer sk-test-key', '_authHeader returns raw apiKey when set');
}).catch(err => {
  assert(false, `_authHeader should not throw: ${err.message}`);
});

/* ============================================================ */
/* 10. ByokRelayStream async iterator interface                */
/* ============================================================ */
console.log('\n10. ByokRelayStream interface');

// Mock response with SSE body
function makeMockSSEResponse (lines) {
  const encoder = new TextEncoder();
  let idx = 0;
  const readable = new ReadableStream({
    pull (controller) {
      if (idx < lines.length) {
        controller.enqueue(encoder.encode(lines[idx++] + '\n'));
      } else {
        controller.close();
      }
    },
  });
  return {
    body: readable,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    status: 200,
    ok: true,
  };
}

const sseLines = [
  'data: {"id":"chatcmpl-1","choices":[{"delta":{"role":"assistant"},"index":0}],"model":"gpt-4o"}',
  'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hello"},"index":0}],"model":"gpt-4o"}',
  'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":" world"},"index":0}],"model":"gpt-4o"}',
  'data: {"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"stop","index":0}],"model":"gpt-4o"}',
  'data: [DONE]',
];

const mockRes = makeMockSSEResponse(sseLines);
const stream = new ByokRelayStream(mockRes);

assert(typeof stream[Symbol.asyncIterator] === 'function', 'ByokRelayStream is async-iterable');
assert(typeof stream.finalChatCompletion === 'function', 'finalChatCompletion() exists');
assert(stream.response.status === 200, 'response.status exposed');

// Test async iteration + finalChatCompletion
(async () => {
  const mockRes2 = makeMockSSEResponse(sseLines);
  const stream2 = new ByokRelayStream(mockRes2);
  const final = await stream2.finalChatCompletion();
  assert(final.id === 'chatcmpl-1', 'finalChatCompletion: id correct');
  assert(final.choices[0].message.content === 'Hello world', 'finalChatCompletion: content accumulated correctly');
  assert(final.choices[0].finish_reason === 'stop', 'finalChatCompletion: finish_reason captured');
  assert(final.object === 'chat.completion', 'finalChatCompletion: object type correct');

  /* ============================================================ */
  /* 11. Tool call delta accumulation                            */
  /* ============================================================ */
  console.log('\n11. Tool call delta accumulation');

  const toolSSELines = [
    'data: {"id":"chatcmpl-2","choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_we","arguments":""}}]},"index":0}]}',
    'data: {"id":"chatcmpl-2","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"ather","arguments":""}}]},"index":0}]}',
    'data: {"id":"chatcmpl-2","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"(\\"loc"}}]},"index":0}]}',
    'data: {"id":"chatcmpl-2","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ation\\": \\"Tokyo\\")"}}]},"index":0}],"finish_reason":"tool_calls"}',
    'data: [DONE]',
  ];
  const toolMockRes = makeMockSSEResponse(toolSSELines);
  const toolStream = new ByokRelayStream(toolMockRes);
  const toolFinal = await toolStream.finalChatCompletion();
  assert(Array.isArray(toolFinal.choices[0].message.tool_calls), 'tool_calls is array');
  assert(toolFinal.choices[0].message.tool_calls[0].function.name === 'get_weather', 'tool name accumulated');
  assert(toolFinal.choices[0].message.tool_calls[0].function.arguments.includes('Tokyo'), 'tool arguments accumulated');
  assert(toolFinal.choices[0].message.content === null, 'content null when tool_calls present');

  /* ============================================================ */
  /* 12. Streaming error handling                                 */
  /* ============================================================ */
  console.log('\n12. Streaming error handling');

  const failingClient = new ByokRelayOpenAI();
  failingClient._relayFetch = async () => new Response('<html>gateway error</html>', { status: 502 });
  try {
    await failingClient.completions.create({ model: 'gpt-4o', prompt: 'Hello', stream: true });
    assert(false, 'legacy streaming errors should reject');
  } catch (error) {
    assertEqual(error.message, '<html>gateway error</html>', 'legacy streaming error preserves a non-JSON response body');
    assertEqual(error.status, 502, 'legacy streaming error preserves the response status');
  }

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch(err => {
  console.error('Async test error:', err);
  process.exit(1);
});

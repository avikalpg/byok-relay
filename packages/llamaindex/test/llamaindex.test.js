/**
 * @byok-relay/llamaindex smoke tests
 * Run: node test/llamaindex.test.js
 *
 * Tests run WITHOUT a live relay and WITHOUT llamaindex installed.
 * They verify: exports exist, shim behaviour, message conversion helpers,
 * tool conversion, ByokRelayClient wiring, and storage adapter logic.
 */

'use strict';

const assert = require('assert');
const path   = require('path');

/* ------------------------------------------------------------------ */
/* Load the package under test                                          */
/* ------------------------------------------------------------------ */

const pkg = require(path.join(__dirname, '..', 'src', 'index.js'));

async function main () {

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function test (name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

async function testAsync (name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

/* ------------------------------------------------------------------ */
/* Mock fetch for ByokRelayClient tests                                 */
/* ------------------------------------------------------------------ */

let _fetchCalls     = [];
let _fetchResponses = [];

function mockFetch (responses) {
  _fetchCalls     = [];
  _fetchResponses = [...responses];
  global.fetch    = async (url, opts) => {
    _fetchCalls.push({ url, opts });
    const resp = _fetchResponses.shift();
    if (!resp) throw new Error(`Unexpected fetch call to ${url}`);
    return {
      ok:       resp.ok !== false,
      status:   resp.status || 200,
      json:     async () => resp.body,
      text:     async () => JSON.stringify(resp.body),
      body: {
        getReader: () => {
          const chunks = resp.stream || [];
          let i = 0;
          return {
            read: async () => {
              if (i >= chunks.length) return { done: true };
              return { done: false, value: new TextEncoder().encode(chunks[i++]) };
            },
          };
        },
      },
    };
  };
}

function restoreFetch () { delete global.fetch; }

/* ------------------------------------------------------------------ */
/* 1. Package exports                                                   */
/* ------------------------------------------------------------------ */

console.log('\n── Exports ──────────────────────────────────────────────────');

test('ByokRelayLLM is exported', () => {
  assert.ok(pkg.ByokRelayLLM, 'ByokRelayLLM missing');
});

test('ByokRelayEmbedding is exported', () => {
  assert.ok(pkg.ByokRelayEmbedding, 'ByokRelayEmbedding missing');
});

test('ByokRelayClient is exported', () => {
  assert.ok(pkg.ByokRelayClient, 'ByokRelayClient missing');
});

/* ------------------------------------------------------------------ */
/* 2. ByokRelayClient — constructor + storage                          */
/* ------------------------------------------------------------------ */

console.log('\n── ByokRelayClient — constructor ────────────────────────────');

test('defaults to managed relay URL', () => {
  const c = new pkg.ByokRelayClient();
  assert.ok(c.relayUrl.includes('byokrelay'), `unexpected relayUrl: ${c.relayUrl}`);
});

test('accepts custom relayUrl (trailing slash stripped)', () => {
  const c = new pkg.ByokRelayClient({ relayUrl: 'https://r.example.com/' });
  assert.strictEqual(c.relayUrl, 'https://r.example.com');
});

test('defaults appId to llamaindex-app', () => {
  const c = new pkg.ByokRelayClient();
  assert.strictEqual(c.appId, 'llamaindex-app');
});

test('uses custom storage adapter', () => {
  const store = {};
  const adapter = {
    getItem:    k      => store[k] ?? null,
    setItem:    (k, v) => { store[k] = v; },
    removeItem: k      => { delete store[k]; },
  };
  const c = new pkg.ByokRelayClient({ storage: adapter });
  c._storage.setItem('test', 'val');
  assert.strictEqual(c._storage.getItem('test'), 'val');
});

test('scopes stored tokens by appId', () => {
  const store = {};
  const adapter = {
    getItem:    k      => store[k] ?? null,
    setItem:    (k, v) => { store[k] = v; },
    removeItem: k      => { delete store[k]; },
  };
  const first = new pkg.ByokRelayClient({ appId: 'first-app', storage: adapter });
  const second = new pkg.ByokRelayClient({ appId: 'second-app', storage: adapter });
  first._storage.setItem(first._tokenKey, 'first-token');
  assert.strictEqual(second._storage.getItem(second._tokenKey), null);
});

test('in-memory storage fallback works without localStorage', () => {
  const c = new pkg.ByokRelayClient();
  c._storage.setItem('k', 'v');
  assert.strictEqual(c._storage.getItem('k'), 'v');
  c._storage.removeItem('k');
  assert.strictEqual(c._storage.getItem('k'), null);
});

/* ------------------------------------------------------------------ */
/* 3. ByokRelayClient — register                                       */
/* ------------------------------------------------------------------ */

console.log('\n── ByokRelayClient — register ───────────────────────────────');

await testAsync('register() posts to /users and stores token', async () => {
  mockFetch([{ body: { token: 'tok-abc' } }]);
  const c = new pkg.ByokRelayClient({ relayUrl: 'https://relay.test' });
  const token = await c.register();
  assert.strictEqual(token, 'tok-abc');
  assert.strictEqual(c._token, 'tok-abc');
  assert.ok(_fetchCalls[0].url.endsWith('/users'));
  restoreFetch();
});

await testAsync('ensureToken() returns cached token without refetching', async () => {
  const c = new pkg.ByokRelayClient({ relayUrl: 'https://relay.test' });
  c._token = 'cached-tok';
  const token = await c.ensureToken();
  assert.strictEqual(token, 'cached-tok');
});

await testAsync('logout() clears token', async () => {
  const c = new pkg.ByokRelayClient({ relayUrl: 'https://relay.test' });
  c._token = 'tok';
  await c.logout();
  assert.strictEqual(c._token, null);
});

/* ------------------------------------------------------------------ */
/* 4. ByokRelayClient — key management                                 */
/* ------------------------------------------------------------------ */

console.log('\n── ByokRelayClient — key management ─────────────────────────');

await testAsync('storeKey() posts to /keys/:provider with Bearer token', async () => {
  mockFetch([{ body: { ok: true } }]);
  const c = new pkg.ByokRelayClient({ relayUrl: 'https://relay.test' });
  c._token = 'tok';
  await c.storeKey('openai', 'sk-test');
  const call = _fetchCalls[0];
  assert.ok(call.url.includes('/keys/openai'));
  assert.ok(call.opts.headers.Authorization.includes('tok'));
  restoreFetch();
});

await testAsync('listKeys() GET /keys with Bearer token', async () => {
  mockFetch([{ body: { keys: ['openai'] } }]);
  const c = new pkg.ByokRelayClient({ relayUrl: 'https://relay.test' });
  c._token = 'tok';
  const data = await c.listKeys();
  assert.ok(Array.isArray(data.keys));
  restoreFetch();
});

await testAsync('deleteKey() DELETE /keys/:provider', async () => {
  mockFetch([{ body: { ok: true } }]);
  const c = new pkg.ByokRelayClient({ relayUrl: 'https://relay.test' });
  c._token = 'tok';
  await c.deleteKey('anthropic');
  assert.ok(_fetchCalls[0].url.includes('/keys/anthropic'));
  assert.strictEqual(_fetchCalls[0].opts.method, 'DELETE');
  restoreFetch();
});

await testAsync('rotateKey() posts to /keys/:provider/rotate', async () => {
  mockFetch([{ body: { ok: true, rotated: true } }]);
  const c = new pkg.ByokRelayClient({ relayUrl: 'https://relay.test' });
  c._token = 'tok';
  const data = await c.rotateKey('openai', 'sk-new');
  assert.strictEqual(data.rotated, true);
  assert.ok(_fetchCalls[0].url.includes('/rotate'));
  restoreFetch();
});

/* ------------------------------------------------------------------ */
/* 5. ByokRelayClient — helpers                                        */
/* ------------------------------------------------------------------ */

console.log('\n── ByokRelayClient — helpers ────────────────────────────────');

await testAsync('health() fetches /health', async () => {
  mockFetch([{ body: { status: 'ok' } }]);
  const c = new pkg.ByokRelayClient({ relayUrl: 'https://relay.test' });
  const h = await c.health();
  assert.strictEqual(h.status, 'ok');
  assert.ok(_fetchCalls[0].url.includes('/health'));
  restoreFetch();
});

await testAsync('health(true) fetches /health?deep=1', async () => {
  mockFetch([{ body: { status: 'ok' } }]);
  const c = new pkg.ByokRelayClient({ relayUrl: 'https://relay.test' });
  await c.health(true);
  assert.ok(_fetchCalls[0].url.includes('?deep=1'));
  restoreFetch();
});

await testAsync('getModels() fetches /models', async () => {
  mockFetch([{ body: { models: [] } }]);
  const c = new pkg.ByokRelayClient({ relayUrl: 'https://relay.test' });
  await c.getModels();
  assert.ok(_fetchCalls[0].url.includes('/models'));
  restoreFetch();
});

await testAsync('stats() fetches /stats', async () => {
  mockFetch([{ body: { total: 0 } }]);
  const c = new pkg.ByokRelayClient({ relayUrl: 'https://relay.test' });
  c._token = 'tok';
  await c.stats();
  assert.ok(_fetchCalls[0].url.includes('/stats'));
  restoreFetch();
});

await testAsync('deleteAccount() clears token after success', async () => {
  mockFetch([{ body: { ok: true } }]);
  const c = new pkg.ByokRelayClient({ relayUrl: 'https://relay.test' });
  c._token = 'tok';
  await c.deleteAccount();
  assert.strictEqual(c._token, null);
  restoreFetch();
});

/* ------------------------------------------------------------------ */
/* 6. ByokRelayLLM — construction + metadata                          */
/* ------------------------------------------------------------------ */

console.log('\n── ByokRelayLLM — construction ──────────────────────────────');

test('constructs with default model', () => {
  const llm = new pkg.ByokRelayLLM();
  assert.strictEqual(llm.model, 'openai/gpt-4o');
});

test('constructs with custom model', () => {
  const llm = new pkg.ByokRelayLLM({ model: 'anthropic/claude-opus-4-5' });
  assert.strictEqual(llm.model, 'anthropic/claude-opus-4-5');
});

test('metadata returns model name', () => {
  const llm  = new pkg.ByokRelayLLM({ model: 'groq/llama-3.1-70b' });
  assert.strictEqual(llm.metadata.model, 'groq/llama-3.1-70b');
});

test('withTools() returns new instance with bound tools', () => {
  const llm  = new pkg.ByokRelayLLM({ model: 'openai/gpt-4o' });
  const tool  = { name: 'calc', description: 'Calculator', parameters: {} };
  const bound = llm.withTools([tool]);
  assert.strictEqual(bound._tools.length, 1);
  assert.strictEqual(bound._tools[0].name, 'calc');
  // original unmodified
  assert.strictEqual(llm._tools, null);
});

test('withTools() accumulates tools across chained calls', () => {
  const llm   = new pkg.ByokRelayLLM({ model: 'openai/gpt-4o' });
  const tool1  = { name: 't1', description: 'T1', parameters: {} };
  const tool2  = { name: 't2', description: 'T2', parameters: {} };
  const bound  = llm.withTools([tool1]).withTools([tool2]);
  assert.strictEqual(bound._tools.length, 2);
});

/* ------------------------------------------------------------------ */
/* 7. ByokRelayLLM — chat()                                           */
/* ------------------------------------------------------------------ */

console.log('\n── ByokRelayLLM — chat() ────────────────────────────────────');

await testAsync('chat() posts to correct relay URL with model stripped of prefix', async () => {
  mockFetch([
    { body: { token: 'tok' } },
    {
      body: {
        choices: [{ message: { role: 'assistant', content: 'Hi there!' } }],
        usage:   { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
      },
    },
  ]);
  const llm = new pkg.ByokRelayLLM({ model: 'openai/gpt-4o', relayUrl: 'https://relay.test' });
  // Pre-seed token to skip register call
  llm._client._token = 'tok';
  _fetchCalls = []; _fetchResponses = [{ body: { choices: [{ message: { role: 'assistant', content: 'Hi!' } }], usage: {} } }];

  const res = await llm.chat({ messages: [{ role: 'user', content: 'Hello' }] });
  assert.strictEqual(res.message.content, 'Hi!');
  assert.ok(_fetchCalls[0].url.includes('/relay/openai/chat/completions'));
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.strictEqual(body.model, 'gpt-4o');  // prefix stripped
  assert.strictEqual(body.stream, false);
  restoreFetch();
});

await testAsync('chat() returns usage object with camelCase keys', async () => {
  mockFetch([{
    body: {
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage:   { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 },
    },
  }]);
  const llm = new pkg.ByokRelayLLM({ model: 'openai/gpt-4o', relayUrl: 'https://relay.test' });
  llm._client._token = 'tok';
  const res = await llm.chat({ messages: [{ role: 'user', content: 'ok' }] });
  assert.strictEqual(res.usage.promptTokens, 3);
  assert.strictEqual(res.usage.completionTokens, 7);
  assert.strictEqual(res.usage.totalTokens, 10);
  restoreFetch();
});

await testAsync('chat() includes tool_calls in response.message.options', async () => {
  mockFetch([{
    body: {
      choices: [{
        message: {
          role:       'assistant',
          content:    null,
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'weather', arguments: '{"city":"Tokyo"}' } }],
        },
      }],
      usage: {},
    },
  }]);
  const llm = new pkg.ByokRelayLLM({ model: 'openai/gpt-4o', relayUrl: 'https://relay.test' });
  llm._client._token = 'tok';
  const res = await llm.chat({ messages: [{ role: 'user', content: 'weather?' }] });
  const calls = res.message.options?.toolCall || [];
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, 'weather');
  assert.deepStrictEqual(calls[0].input, { city: 'Tokyo' });
  restoreFetch();
});

await testAsync('chat() with per-call tools sends tools array to relay', async () => {
  mockFetch([{ body: { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} } }]);
  const llm  = new pkg.ByokRelayLLM({ model: 'openai/gpt-4o', relayUrl: 'https://relay.test' });
  llm._client._token = 'tok';
  await llm.chat({
    messages: [{ role: 'user', content: 'hi' }],
    tools:    [{ name: 'calc', description: 'calc', parameters: {} }],
  });
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.ok(Array.isArray(body.tools));
  assert.strictEqual(body.tools[0].type, 'function');
  assert.strictEqual(body.tools[0].function.name, 'calc');
  restoreFetch();
});

await testAsync('chat() normalizes object-shaped image URLs', async () => {
  mockFetch([{ body: { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} } }]);
  const llm = new pkg.ByokRelayLLM({ model: 'openai/gpt-4o', relayUrl: 'https://relay.test' });
  llm._client._token = 'tok';
  await llm.chat({
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }],
    }],
  });
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.strictEqual(body.messages[0].content[0].image_url.url, 'https://example.test/image.png');
  restoreFetch();
});

await testAsync('chat() with bound tools (withTools) forwards them automatically', async () => {
  mockFetch([{ body: { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} } }]);
  const llm  = new pkg.ByokRelayLLM({ model: 'openai/gpt-4o', relayUrl: 'https://relay.test' });
  llm._client._token = 'tok';
  const bound = llm.withTools([{ name: 'lookup', description: 'lookup', parameters: {} }]);
  bound._client._token = 'tok';
  await bound.chat({ messages: [{ role: 'user', content: 'hi' }] });
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.strictEqual(body.tools[0].function.name, 'lookup');
  restoreFetch();
});

await testAsync('chat() throws on non-ok response', async () => {
  mockFetch([{ ok: false, status: 401, body: { error: 'Unauthorized' } }]);
  const llm = new pkg.ByokRelayLLM({ model: 'openai/gpt-4o', relayUrl: 'https://relay.test' });
  llm._client._token = 'tok';
  try {
    await llm.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.fail('Should have thrown');
  } catch (e) {
    assert.ok(e.message.includes('401'));
  }
  restoreFetch();
});

/* ------------------------------------------------------------------ */
/* 8. ByokRelayLLM — complete()                                       */
/* ------------------------------------------------------------------ */

console.log('\n── ByokRelayLLM — complete() ────────────────────────────────');

await testAsync('complete() wraps prompt in user message and returns text', async () => {
  mockFetch([{ body: { choices: [{ message: { role: 'assistant', content: 'answer' } }], usage: {} } }]);
  const llm = new pkg.ByokRelayLLM({ model: 'openai/gpt-4o', relayUrl: 'https://relay.test' });
  llm._client._token = 'tok';
  const res = await llm.complete({ prompt: 'what is 1+1?' });
  assert.strictEqual(res.text, 'answer');
  restoreFetch();
});

/* ------------------------------------------------------------------ */
/* 9. ByokRelayLLM — streaming                                        */
/* ------------------------------------------------------------------ */

console.log('\n── ByokRelayLLM — stream() ──────────────────────────────────');

await testAsync('stream() yields delta strings from SSE chunks', async () => {
  const sseChunks = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n',
    'data: [DONE]\n',
  ];
  mockFetch([{ ok: true, stream: sseChunks }]);
  const llm = new pkg.ByokRelayLLM({ model: 'openai/gpt-4o', relayUrl: 'https://relay.test' });
  llm._client._token = 'tok';
  const chunks = [];
  for await (const chunk of llm.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
    chunks.push(chunk.delta);
  }
  assert.deepStrictEqual(chunks, ['Hello', ' world']);
  restoreFetch();
});

await testAsync('stream() skips non-data lines and empty lines', async () => {
  const sseChunks = [
    ': comment\n',
    '\n',
    'data: {"choices":[{"delta":{"content":"A"}}]}\n',
    'data: [DONE]\n',
  ];
  mockFetch([{ ok: true, stream: sseChunks }]);
  const llm = new pkg.ByokRelayLLM({ model: 'openai/gpt-4o', relayUrl: 'https://relay.test' });
  llm._client._token = 'tok';
  const chunks = [];
  for await (const chunk of llm.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
    chunks.push(chunk.delta);
  }
  assert.deepStrictEqual(chunks, ['A']);
  restoreFetch();
});

await testAsync('stream() sets stream:true in request body', async () => {
  mockFetch([{ ok: true, stream: ['data: [DONE]\n'] }]);
  const llm = new pkg.ByokRelayLLM({ model: 'openai/gpt-4o', relayUrl: 'https://relay.test' });
  llm._client._token = 'tok';
  // eslint-disable-next-line no-unused-vars
  for await (const _ of llm.stream({ messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ }
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.strictEqual(body.stream, true);
  restoreFetch();
});

/* ------------------------------------------------------------------ */
/* 10. ByokRelayLLM — message format helpers                          */
/* ------------------------------------------------------------------ */

console.log('\n── ByokRelayLLM — message conversion ────────────────────────');

await testAsync('user message passes through as { role, content }', async () => {
  mockFetch([{ body: { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} } }]);
  const llm = new pkg.ByokRelayLLM({ model: 'openai/gpt-4o', relayUrl: 'https://relay.test' });
  llm._client._token = 'tok';
  await llm.chat({ messages: [{ role: 'user', content: 'hello' }] });
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.strictEqual(body.messages[0].role, 'user');
  assert.strictEqual(body.messages[0].content, 'hello');
  restoreFetch();
});

await testAsync('system message passes through correctly', async () => {
  mockFetch([{ body: { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} } }]);
  const llm = new pkg.ByokRelayLLM({ model: 'openai/gpt-4o', relayUrl: 'https://relay.test' });
  llm._client._token = 'tok';
  await llm.chat({
    messages: [
      { role: 'system',  content: 'You are helpful.' },
      { role: 'user',    content: 'hi' },
    ],
  });
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.strictEqual(body.messages[0].role, 'system');
  restoreFetch();
});

await testAsync('tool result message maps to { role: tool, tool_call_id }', async () => {
  mockFetch([{ body: { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} } }]);
  const llm = new pkg.ByokRelayLLM({ model: 'openai/gpt-4o', relayUrl: 'https://relay.test' });
  llm._client._token = 'tok';
  await llm.chat({
    messages: [
      { role: 'user',  content: 'weather?' },
      { role: 'tool',  content: 'sunny', options: { toolCallId: 'tc1' } },
    ],
  });
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.strictEqual(body.messages[1].role, 'tool');
  assert.strictEqual(body.messages[1].tool_call_id, 'tc1');
  assert.strictEqual(body.messages[1].content, 'sunny');
  restoreFetch();
});

/* ------------------------------------------------------------------ */
/* 11. ByokRelayLLM — model/param forwarding                          */
/* ------------------------------------------------------------------ */

console.log('\n── ByokRelayLLM — param forwarding ──────────────────────────');

await testAsync('maxTokens forwarded as max_tokens', async () => {
  mockFetch([{ body: { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} } }]);
  const llm = new pkg.ByokRelayLLM({ model: 'openai/gpt-4o', relayUrl: 'https://relay.test', maxTokens: 256 });
  llm._client._token = 'tok';
  await llm.chat({ messages: [{ role: 'user', content: 'hi' }] });
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.strictEqual(body.max_tokens, 256);
  restoreFetch();
});

await testAsync('temperature forwarded correctly', async () => {
  mockFetch([{ body: { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} } }]);
  const llm = new pkg.ByokRelayLLM({ model: 'openai/gpt-4o', relayUrl: 'https://relay.test', temperature: 0.2 });
  llm._client._token = 'tok';
  await llm.chat({ messages: [{ role: 'user', content: 'hi' }] });
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.strictEqual(body.temperature, 0.2);
  restoreFetch();
});

await testAsync('extraParams merged into request body', async () => {
  mockFetch([{ body: { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} } }]);
  const llm = new pkg.ByokRelayLLM({
    model:       'openai/gpt-4o',
    relayUrl:    'https://relay.test',
    extraParams: { presence_penalty: 0.5 },
  });
  llm._client._token = 'tok';
  await llm.chat({ messages: [{ role: 'user', content: 'hi' }] });
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.strictEqual(body.presence_penalty, 0.5);
  restoreFetch();
});

await testAsync('bare model name (no prefix) defaults to openai provider', async () => {
  mockFetch([{ body: { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} } }]);
  const llm = new pkg.ByokRelayLLM({ model: 'gpt-4o-mini', relayUrl: 'https://relay.test' });
  llm._client._token = 'tok';
  await llm.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(_fetchCalls[0].url.includes('/relay/openai/'), `url: ${_fetchCalls[0].url}`);
  restoreFetch();
});

/* ------------------------------------------------------------------ */
/* 12. ByokRelayEmbedding — construction                              */
/* ------------------------------------------------------------------ */

console.log('\n── ByokRelayEmbedding — construction ────────────────────────');

test('constructs with default model', () => {
  const e = new pkg.ByokRelayEmbedding();
  assert.ok(e.model.includes('text-embedding'));
});

test('constructs with custom model', () => {
  const e = new pkg.ByokRelayEmbedding({ model: 'openai/text-embedding-ada-002' });
  assert.strictEqual(e.model, 'openai/text-embedding-ada-002');
});

test('default batchSize is 512', () => {
  const e = new pkg.ByokRelayEmbedding();
  assert.strictEqual(e.batchSize, 512);
});

test('custom batchSize accepted', () => {
  const e = new pkg.ByokRelayEmbedding({ batchSize: 128 });
  assert.strictEqual(e.batchSize, 128);
});

/* ------------------------------------------------------------------ */
/* 13. ByokRelayEmbedding — getQueryEmbedding                         */
/* ------------------------------------------------------------------ */

console.log('\n── ByokRelayEmbedding — embedding ───────────────────────────');

await testAsync('getQueryEmbedding() returns a number array', async () => {
  mockFetch([{
    body: { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] },
  }]);
  const e = new pkg.ByokRelayEmbedding({ model: 'openai/text-embedding-3-small', relayUrl: 'https://relay.test' });
  e._client._token = 'tok';
  const vec = await e.getQueryEmbedding('hello');
  assert.deepStrictEqual(vec, [0.1, 0.2, 0.3]);
  restoreFetch();
});

await testAsync('getTextEmbedding() aliases getQueryEmbedding()', async () => {
  mockFetch([{
    body: { data: [{ index: 0, embedding: [0.5] }] },
  }]);
  const e = new pkg.ByokRelayEmbedding({ model: 'openai/text-embedding-3-small', relayUrl: 'https://relay.test' });
  e._client._token = 'tok';
  const vec = await e.getTextEmbedding('hello');
  assert.deepStrictEqual(vec, [0.5]);
  restoreFetch();
});

await testAsync('getTextEmbeddings() returns array of vectors in order', async () => {
  mockFetch([{
    body: {
      data: [
        { index: 1, embedding: [0.2] },
        { index: 0, embedding: [0.1] },
      ],
    },
  }]);
  const e = new pkg.ByokRelayEmbedding({ model: 'openai/text-embedding-3-small', relayUrl: 'https://relay.test' });
  e._client._token = 'tok';
  const vecs = await e.getTextEmbeddings(['a', 'b']);
  // sorted by index: first [0.1], second [0.2]
  assert.deepStrictEqual(vecs[0], [0.1]);
  assert.deepStrictEqual(vecs[1], [0.2]);
  restoreFetch();
});

await testAsync('getTextEmbeddings() batches large input sets', async () => {
  // batchSize=2, 5 texts → 3 batch calls
  const makeBatch = (items) => ({ body: { data: items.map((_, i) => ({ index: i, embedding: [i * 0.1] })) } });
  mockFetch([makeBatch([0, 1]), makeBatch([2, 3]), makeBatch([4])]);
  const e = new pkg.ByokRelayEmbedding({
    model:     'openai/text-embedding-3-small',
    relayUrl:  'https://relay.test',
    batchSize: 2,
  });
  e._client._token = 'tok';
  const vecs = await e.getTextEmbeddings(['a', 'b', 'c', 'd', 'e']);
  assert.strictEqual(vecs.length, 5);
  assert.strictEqual(_fetchCalls.length, 3);
  restoreFetch();
});

await testAsync('embeddings request posts to /relay/:provider/embeddings', async () => {
  mockFetch([{ body: { data: [{ index: 0, embedding: [0.1] }] } }]);
  const e = new pkg.ByokRelayEmbedding({ model: 'openai/text-embedding-3-small', relayUrl: 'https://relay.test' });
  e._client._token = 'tok';
  await e.getQueryEmbedding('hello');
  assert.ok(_fetchCalls[0].url.includes('/relay/openai/embeddings'), `url: ${_fetchCalls[0].url}`);
  restoreFetch();
});

await testAsync('embeddings request strips provider prefix from model in body', async () => {
  mockFetch([{ body: { data: [{ index: 0, embedding: [0.1] }] } }]);
  const e = new pkg.ByokRelayEmbedding({ model: 'openai/text-embedding-3-small', relayUrl: 'https://relay.test' });
  e._client._token = 'tok';
  await e.getQueryEmbedding('hello');
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.strictEqual(body.model, 'text-embedding-3-small');
  restoreFetch();
});

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

console.log(`\n── Result ───────────────────────────────────────────────────`);
console.log(`   Passed: ${passed}`);
console.log(`   Failed: ${failed}`);
console.log('');

if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed ✓\n');
}

} // end main()

main().catch(err => {
  console.error(err);
  process.exit(1);
});

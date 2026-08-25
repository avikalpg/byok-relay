/**
 * @byok-relay/langchain smoke tests
 * Run: node test/langchain.test.js
 *
 * Tests run WITHOUT a live relay and WITHOUT @langchain/core installed.
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

let _fetchCalls = [];
let _fetchResponses = [];

function mockFetch (responses) {
  _fetchCalls    = [];
  _fetchResponses = [...responses];
  global.fetch = async (url, opts) => {
    _fetchCalls.push({ url, opts });
    const resp = _fetchResponses.shift();
    if (!resp) throw new Error(`Unexpected fetch call to ${url}`);
    return {
      ok:     resp.ok !== false,
      status: resp.status || 200,
      json:   async () => resp.body,
      text:   async () => JSON.stringify(resp.body),
    };
  };
}

function restoreFetch () {
  delete global.fetch;
}

/* ================================================================== */
/* 1. Export shape                                                      */
/* ================================================================== */

console.log('\n1. Export shape');

test('ByokRelayChatModel is exported', () => {
  assert.ok(pkg.ByokRelayChatModel, 'ByokRelayChatModel export missing');
});

test('ByokRelayEmbeddings is exported', () => {
  assert.ok(pkg.ByokRelayEmbeddings, 'ByokRelayEmbeddings export missing');
});

test('ByokRelayClient is exported', () => {
  assert.ok(pkg.ByokRelayClient, 'ByokRelayClient export missing');
});

/* ================================================================== */
/* 2. ByokRelayClient — construction and storage                       */
/* ================================================================== */

console.log('\n2. ByokRelayClient — construction and storage');

test('constructs with defaults', () => {
  const c = new pkg.ByokRelayClient({});
  assert.ok(c._relayUrl, 'relayUrl missing');
  assert.strictEqual(c._appId, 'langchain-app');
});

test('accepts custom relayUrl and appId', () => {
  const c = new pkg.ByokRelayClient({ relayUrl: 'http://localhost:3000', appId: 'test-app' });
  assert.strictEqual(c._relayUrl, 'http://localhost:3000');
  assert.strictEqual(c._appId, 'test-app');
});

test('uses custom storage adapter', () => {
  const store = {};
  const adapter = {
    get:    (k) => store[k] || null,
    set:    (k, v) => { store[k] = v; },
    remove: (k) => { delete store[k]; },
  };
  const c = new pkg.ByokRelayClient({ storage: adapter });
  c._kset('foo', 'bar');
  assert.strictEqual(store['foo'], 'bar', 'custom storage set not called');
  assert.strictEqual(c._kget('foo'), 'bar', 'custom storage get not called');
  c._kremove('foo');
  assert.strictEqual(store['foo'], undefined, 'custom storage remove not called');
});

test('in-memory fallback when no storage', () => {
  const c = new pkg.ByokRelayClient({ storage: null });
  c._kset('hello', 'world');
  assert.strictEqual(c._kget('hello'), 'world');
  c._kremove('hello');
  assert.strictEqual(c._kget('hello'), null);
});

/* ================================================================== */
/* 3. ByokRelayClient — register + ensureToken                         */
/* ================================================================== */

console.log('\n3. ByokRelayClient — register + ensureToken');

await testAsync('register() stores token and returns it', async () => {
  mockFetch([{ body: { token: 'tok_abc123', expires_at: '2027-01-01' } }]);
  const c = new pkg.ByokRelayClient({ relayUrl: 'http://r', appId: 'app1' });
  const tok = await c.register('app1');
  assert.strictEqual(tok, 'tok_abc123');
  assert.strictEqual(_fetchCalls[0].url, 'http://r/users');
  assert.strictEqual(JSON.parse(_fetchCalls[0].opts.body).app_id, 'app1');
  restoreFetch();
});

await testAsync('ensureToken() returns cached token without re-fetching', async () => {
  const store = {};
  const c = new pkg.ByokRelayClient({
    relayUrl: 'http://r',
    appId: 'app2',
    storage: { get: k => store[k] || null, set: (k,v) => { store[k]=v; }, remove: k => { delete store[k]; } },
  });
  store['byok_relay_token_app2'] = 'cached_tok';
  mockFetch([]);
  const tok = await c.ensureToken();
  assert.strictEqual(tok, 'cached_tok');
  assert.strictEqual(_fetchCalls.length, 0, 'should not call fetch when token cached');
  restoreFetch();
});

await testAsync('register() refreshes an existing token', async () => {
  const store = { 'byok_relay_token_app2': 'cached_tok' };
  const c = new pkg.ByokRelayClient({
    relayUrl: 'http://r',
    appId: 'app2',
    storage: { get: k => store[k] || null, set: (k,v) => { store[k]=v; }, remove: k => { delete store[k]; } },
  });
  mockFetch([{ body: { token: 'fresh_tok' } }]);
  const tok = await c.register();
  assert.strictEqual(tok, 'fresh_tok');
  assert.strictEqual(store['byok_relay_token_app2'], 'fresh_tok');
  assert.strictEqual(_fetchCalls.length, 1, 'register should request a fresh token');
  restoreFetch();
});


await testAsync('ensureToken() shares one in-flight registration', async () => {
  const c = new pkg.ByokRelayClient({ relayUrl: 'http://r', appId: 'app-race', storage: null });
  mockFetch([{ body: { token: 'tok_shared' } }]);
  const [first, second] = await Promise.all([c.ensureToken(), c.ensureToken()]);
  assert.strictEqual(first, 'tok_shared');
  assert.strictEqual(second, 'tok_shared');
  assert.strictEqual(_fetchCalls.length, 1, 'concurrent calls should register once');
  restoreFetch();
});

await testAsync('logout() removes token from storage', async () => {
  const store = {};
  const c = new pkg.ByokRelayClient({
    relayUrl: 'http://r', appId: 'app3',
    storage: { get: k => store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  store['byok_relay_token_app3'] = 'some_tok';
  c.logout();
  assert.strictEqual(store['byok_relay_token_app3'], undefined);
});

/* ================================================================== */
/* 4. ByokRelayClient — storeKey / listKeys                            */
/* ================================================================== */

console.log('\n4. ByokRelayClient — storeKey / listKeys');

await testAsync('storeKey() calls POST /keys/:provider with bearer token', async () => {
  const store = { 'byok_relay_token_a': 'tok' };
  mockFetch([{ body: { ok: true } }]);
  const c = new pkg.ByokRelayClient({
    relayUrl: 'http://r', appId: 'a',
    storage: { get: k=>store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  await c.storeKey('openai', 'sk-test');
  assert.ok(_fetchCalls[0].url.includes('/keys/openai'));
  assert.ok(_fetchCalls[0].opts.headers['Authorization'].includes('tok'));
  restoreFetch();
});

await testAsync('listKeys() calls GET /keys', async () => {
  const store = { 'byok_relay_token_b': 'tok2' };
  mockFetch([{ body: { keys: ['openai'] } }]);
  const c = new pkg.ByokRelayClient({
    relayUrl: 'http://r', appId: 'b',
    storage: { get: k=>store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  const result = await c.listKeys();
  assert.deepStrictEqual(result, { keys: ['openai'] });
  restoreFetch();
});

/* ================================================================== */
/* 5. ByokRelayClient — chat / health / getModels                      */
/* ================================================================== */

console.log('\n5. ByokRelayClient — chat / health / getModels');

await testAsync('chat() sends correct body and returns parsed JSON', async () => {
  const store = { 'byok_relay_token_c': 'tok3' };
  const respBody = { choices: [{ message: { content: 'hi', role: 'assistant' } }] };
  mockFetch([{ body: respBody }]);
  const c = new pkg.ByokRelayClient({
    relayUrl: 'http://r', appId: 'c',
    storage: { get: k=>store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  const data = await c.chat({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepStrictEqual(data, respBody);
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.strictEqual(body.model, 'openai/gpt-4o');
  restoreFetch();
});

await testAsync('health() calls GET /health', async () => {
  mockFetch([{ body: { status: 'ok' } }]);
  const c = new pkg.ByokRelayClient({ relayUrl: 'http://r' });
  const h = await c.health();
  assert.strictEqual(h.status, 'ok');
  assert.ok(_fetchCalls[0].url.includes('/health'));
  restoreFetch();
});

await testAsync('health(deep=true) appends ?deep=1', async () => {
  mockFetch([{ body: { status: 'ok' } }]);
  const c = new pkg.ByokRelayClient({ relayUrl: 'http://r' });
  await c.health(true);
  assert.ok(_fetchCalls[0].url.includes('?deep=1'));
  restoreFetch();
});

await testAsync('getModels() calls GET /models', async () => {
  mockFetch([{ body: { models: ['openai/gpt-4o'] } }]);
  const c = new pkg.ByokRelayClient({ relayUrl: 'http://r' });
  const m = await c.getModels();
  assert.ok(m.models);
  assert.ok(_fetchCalls[0].url.includes('/models'));
  restoreFetch();
});

/* ================================================================== */
/* 6. ByokRelayClient — deleteKey / rotateKey / deleteAccount          */
/* ================================================================== */

console.log('\n6. ByokRelayClient — deleteKey / rotateKey / deleteAccount');

await testAsync('deleteKey() calls DELETE /keys/:provider', async () => {
  const store = { 'byok_relay_token_d': 'tok4' };
  mockFetch([{ body: { ok: true } }]);
  const c = new pkg.ByokRelayClient({
    relayUrl: 'http://r', appId: 'd',
    storage: { get: k=>store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  await c.deleteKey('anthropic');
  assert.ok(_fetchCalls[0].url.includes('/keys/anthropic'));
  assert.strictEqual(_fetchCalls[0].opts.method, 'DELETE');
  restoreFetch();
});

await testAsync('rotateKey() calls POST /keys/:provider/rotate', async () => {
  const store = { 'byok_relay_token_e': 'tok5' };
  mockFetch([{ body: { rotated: true } }]);
  const c = new pkg.ByokRelayClient({
    relayUrl: 'http://r', appId: 'e',
    storage: { get: k=>store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  const r = await c.rotateKey('openai', 'sk-new');
  assert.strictEqual(r.rotated, true);
  assert.ok(_fetchCalls[0].url.includes('/rotate'));
  restoreFetch();
});

await testAsync('deleteAccount() calls DELETE /users and logs out', async () => {
  const store = { 'byok_relay_token_f': 'tok6' };
  mockFetch([{ body: { deleted: true } }]);
  const c = new pkg.ByokRelayClient({
    relayUrl: 'http://r', appId: 'f',
    storage: { get: k=>store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  await c.deleteAccount();
  assert.strictEqual(store['byok_relay_token_f'], undefined, 'token should be removed after deleteAccount');
  restoreFetch();
});

/* ================================================================== */
/* 7. ByokRelayChatModel — construction (shim path)                    */
/* ================================================================== */

console.log('\n7. ByokRelayChatModel — construction (shim / no @langchain/core)');

test('ByokRelayChatModel can be instantiated', () => {
  const ChatModel = pkg.ByokRelayChatModel;
  const m = new ChatModel({ relayUrl: 'http://r', modelName: 'openai/gpt-4o' });
  assert.strictEqual(m.modelName, 'openai/gpt-4o');
  assert.strictEqual(m._relayUrl, 'http://r');
});

test('_llmType() returns byok-relay', () => {
  const m = new pkg.ByokRelayChatModel({});
  assert.strictEqual(m._llmType(), 'byok-relay');
});

test('bindTools() returns new model with tools attached', () => {
  const m = new pkg.ByokRelayChatModel({ relayUrl: 'http://r', modelName: 'openai/gpt-4o' });
  const withTools = m.bindTools([
    { name: 'get_weather', description: 'Get weather', schema: { type: 'object', properties: {} } },
  ]);
  assert.ok(withTools._tools, 'tools should be set');
  assert.strictEqual(withTools._tools[0].type, 'function');
  assert.strictEqual(withTools._tools[0].function.name, 'get_weather');
  // original model unchanged
  assert.strictEqual(m._tools, null);
});

test('temperature and maxTokens are stored', () => {
  const m = new pkg.ByokRelayChatModel({ temperature: 0.1, maxTokens: 200 });
  assert.strictEqual(m.temperature, 0.1);
  assert.strictEqual(m.maxTokens, 200);
});

/* ================================================================== */
/* 8. ByokRelayChatModel — _generate (mock relay)                      */
/* ================================================================== */

console.log('\n8. ByokRelayChatModel — _generate (mock relay)');

await testAsync('_generate() posts to /relay and returns ChatResult shape', async () => {
  const store = { 'byok_relay_token_langchain-app': 'tok7' };
  const oaiResp = {
    model:   'gpt-4o',
    choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
    usage:   { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
  mockFetch([{ body: oaiResp }]);
  const ChatModel = pkg.ByokRelayChatModel;
  const m = new ChatModel({
    relayUrl: 'http://r', appId: 'langchain-app',
    storage: { get: k=>store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  // Simulate LangChain message objects with _getType
  const msgs = [{ _getType: () => 'human', content: 'Hi', constructor: { name: 'HumanMessage' } }];
  const result = await m._generate(msgs);
  assert.ok(result.generations, 'generations missing');
  assert.strictEqual(result.generations[0].text, 'Hello!');
  assert.ok(_fetchCalls[0].url.includes('/relay'));
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.strictEqual(body.model, 'openai/gpt-4o');
  assert.strictEqual(body.messages[0].role, 'user');
  restoreFetch();
});

await testAsync('_generate() with tools sends tools array', async () => {
  const store = { 'byok_relay_token_langchain-app': 'tok8' };
  const oaiResp = {
    choices: [{ message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } }] },
      finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  mockFetch([{ body: oaiResp }]);
  const m = new pkg.ByokRelayChatModel({
    relayUrl: 'http://r', appId: 'langchain-app',
    storage: { get: k=>store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  const withTools = m.bindTools([{ name: 'get_weather', description: 'Get weather', schema: { type: 'object' } }]);
  const msgs = [{ _getType: () => 'human', content: 'Weather in Tokyo?', constructor: { name: 'HumanMessage' } }];
  const result = await withTools._generate(msgs);
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.ok(body.tools, 'tools not in request body');
  assert.strictEqual(body.tools[0].function.name, 'get_weather');
  restoreFetch();
});


await testAsync('_stream() parses chunked SSE content and a trailing tool-call delta', async () => {
  const store = { 'byok_relay_token_langchain-app': 'tok-stream' };
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode('data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n'),
    encoder.encode('data: {\"choices\":[{\"delta\":{\"content\":\"world\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"{\\\"city\\\":\\\"Tokyo\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}'),
  ];
  _fetchCalls = [];
  global.fetch = async (url, opts) => {
    _fetchCalls.push({ url, opts });
    let offset = 0;
    return {
      ok: true,
      status: 200,
      body: { getReader: () => ({ read: async () => offset < chunks.length
        ? { done: false, value: chunks[offset++] }
        : { done: true }, }) },
    };
  };
  const m = new pkg.ByokRelayChatModel({
    relayUrl: 'http://r', appId: 'langchain-app',
    storage: { get: k=>store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  const messages = [{ _getType: () => 'human', content: 'Hi', constructor: { name: 'HumanMessage' } }];
  const streamed = [];
  for await (const chunk of m._stream(messages)) streamed.push(chunk.text);
  assert.deepStrictEqual(streamed, ['Hello ', 'world']);
  assert.strictEqual(_fetchCalls.length, 1);
  restoreFetch();
});

await testAsync('_stream() cancels and releases the reader after early termination', async () => {
  const store = { 'byok_relay_token_langchain-app': 'tok-stream' };
  const encoder = new TextEncoder();
  let cancelled = false;
  let released = false;
  global.fetch = async () => {
    let sent = false;
    return {
      ok: true,
      status: 200,
      body: { getReader: () => ({
        read: async () => sent ? { done: true } : (sent = true, {
          done: false,
          value: encoder.encode('data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n'),
        }),
        cancel: async () => { cancelled = true; },
        releaseLock: () => { released = true; },
      }) },
    };
  };
  const m = new pkg.ByokRelayChatModel({
    relayUrl: 'http://r', appId: 'langchain-app',
    storage: { get: k=>store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  const messages = [{ _getType: () => 'human', content: 'Hi', constructor: { name: 'HumanMessage' } }];
  for await (const _chunk of m._stream(messages)) break;
  assert.ok(cancelled, 'reader should be cancelled after early termination');
  assert.ok(released, 'reader lock should be released after early termination');
  restoreFetch();
});

await testAsync('streamChat() ignores terminal chunks without a delta', async () => {
  const store = { 'byok_relay_token_langchain-app': 'tok-stream' };
  const encoder = new TextEncoder();
  global.fetch = async () => {
    let offset = 0;
    const chunks = [encoder.encode('data: {\"choices\":[]}\n'), encoder.encode('data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n')];
    return {
      ok: true,
      status: 200,
      body: { getReader: () => ({
        read: async () => offset < chunks.length ? { done: false, value: chunks[offset++] } : { done: true },
      }) },
    };
  };
  const c = new pkg.ByokRelayClient({
    relayUrl: 'http://r', appId: 'langchain-app',
    storage: { get: k=>store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  const streamed = [];
  for await (const chunk of c.streamChat({ model: 'openai/gpt-4o', messages: [] })) streamed.push(chunk);
  assert.deepStrictEqual(streamed, ['ok']);
  restoreFetch();
});

/* ================================================================== */
/* 9. ByokRelayEmbeddings — construction and embedDocuments            */
/* ================================================================== */

console.log('\n9. ByokRelayEmbeddings — construction and embedDocuments');

test('ByokRelayEmbeddings constructs with defaults', () => {
  const Emb = pkg.ByokRelayEmbeddings;
  const e = new Emb({});
  assert.strictEqual(e.modelName, 'openai/text-embedding-3-small');
  assert.strictEqual(e.batchSize, 512);
});

test('ByokRelayEmbeddings accepts custom model and batchSize', () => {
  const e = new pkg.ByokRelayEmbeddings({ modelName: 'openai/text-embedding-ada-002', batchSize: 100 });
  assert.strictEqual(e.modelName, 'openai/text-embedding-ada-002');
  assert.strictEqual(e.batchSize, 100);
});

await testAsync('embedDocuments() calls /relay/:provider/embeddings and returns vectors', async () => {
  const store = { 'byok_relay_token_langchain-app': 'tok9' };
  const vec1 = [0.1, 0.2, 0.3];
  const vec2 = [0.4, 0.5, 0.6];
  mockFetch([{
    body: { data: [{ index: 0, embedding: vec1 }, { index: 1, embedding: vec2 }], model: 'text-embedding-3-small' },
  }]);
  const e = new pkg.ByokRelayEmbeddings({
    relayUrl: 'http://r', appId: 'langchain-app',
    storage: { get: k=>store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  const vecs = await e.embedDocuments(['hello', 'world']);
  assert.deepStrictEqual(vecs, [vec1, vec2]);
  assert.ok(_fetchCalls[0].url.includes('/relay/openai/embeddings'));
  restoreFetch();
});

await testAsync('embedQuery() returns a single vector', async () => {
  const store = { 'byok_relay_token_langchain-app': 'tokA' };
  const vec = [0.7, 0.8, 0.9];
  mockFetch([{
    body: { data: [{ index: 0, embedding: vec }], model: 'text-embedding-3-small' },
  }]);
  const e = new pkg.ByokRelayEmbeddings({
    relayUrl: 'http://r', appId: 'langchain-app',
    storage: { get: k=>store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  const result = await e.embedQuery('search term');
  assert.deepStrictEqual(result, vec);
  restoreFetch();
});

await testAsync('embedDocuments() batches large input', async () => {
  const store = { 'byok_relay_token_langchain-app': 'tokB' };
  const texts = Array.from({ length: 5 }, (_, i) => `text_${i}`);
  // batchSize=3 → 2 batches
  mockFetch([
    { body: { data: [0,1,2].map(i => ({ index: i, embedding: [i] })) } },
    { body: { data: [0,1].map(i => ({ index: i, embedding: [i+3] })) } },
  ]);
  const e = new pkg.ByokRelayEmbeddings({
    relayUrl: 'http://r', appId: 'langchain-app', batchSize: 3,
    storage: { get: k=>store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  const vecs = await e.embedDocuments(texts);
  assert.strictEqual(vecs.length, 5, 'should return 5 vectors');
  assert.strictEqual(_fetchCalls.length, 2, 'should make 2 batched requests');
  restoreFetch();
});

/* ================================================================== */
/* 10. Message conversion (_lcToOpenAI internal fn via _generate)      */
/* ================================================================== */

console.log('\n10. Message conversion — via _generate inspection');

await testAsync('converts HumanMessage to role=user', async () => {
  const store = { 'byok_relay_token_langchain-app': 'tokC' };
  mockFetch([{ body: { choices: [{ message: { role:'assistant', content:'ok'} }], usage:{} } }]);
  const m = new pkg.ByokRelayChatModel({
    relayUrl:'http://r', appId:'langchain-app',
    storage: { get:k=>store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  const msgs = [{ _getType:()=>'human', content:'Question', constructor:{name:'HumanMessage'} }];
  await m._generate(msgs);
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.strictEqual(body.messages[0].role, 'user');
  assert.strictEqual(body.messages[0].content, 'Question');
  restoreFetch();
});

await testAsync('converts SystemMessage to role=system', async () => {
  const store = { 'byok_relay_token_langchain-app': 'tokD' };
  mockFetch([{ body: { choices: [{ message: { role:'assistant', content:'ok'} }], usage:{} } }]);
  const m = new pkg.ByokRelayChatModel({
    relayUrl:'http://r', appId:'langchain-app',
    storage: { get:k=>store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  const msgs = [
    { _getType:()=>'system', content:'You are helpful.', constructor:{name:'SystemMessage'} },
    { _getType:()=>'human',  content:'Hi',               constructor:{name:'HumanMessage'} },
  ];
  await m._generate(msgs);
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.strictEqual(body.messages[0].role, 'system');
  restoreFetch();
});

await testAsync('converts AIMessage with tool_calls', async () => {
  const store = { 'byok_relay_token_langchain-app': 'tokE' };
  mockFetch([{ body: { choices: [{ message: { role:'assistant', content:''} }], usage:{} } }]);
  const m = new pkg.ByokRelayChatModel({
    relayUrl:'http://r', appId:'langchain-app',
    storage: { get:k=>store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  const toolCallMsg = {
    _getType: () => 'ai',
    content: '',
    constructor: { name: 'AIMessage' },
    tool_calls: [{ id: 'call_x', name: 'get_weather', args: { city: 'Tokyo' }, type: 'tool_call' }],
  };
  const msgs = [toolCallMsg];
  await m._generate(msgs);
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.strictEqual(body.messages[0].role, 'assistant');
  assert.ok(body.messages[0].tool_calls, 'tool_calls should be present');
  assert.strictEqual(body.messages[0].tool_calls[0].function.name, 'get_weather');
  restoreFetch();
});

await testAsync('converts ToolMessage to role=tool', async () => {
  const store = { 'byok_relay_token_langchain-app': 'tokF' };
  mockFetch([{ body: { choices: [{ message: { role:'assistant', content:'ok'} }], usage:{} } }]);
  const m = new pkg.ByokRelayChatModel({
    relayUrl:'http://r', appId:'langchain-app',
    storage: { get:k=>store[k]||null, set:(k,v)=>{store[k]=v;}, remove:k=>{delete store[k];} },
  });
  const msgs = [
    { _getType:()=>'tool', content:'{"temp":22}', tool_call_id:'call_x', constructor:{name:'ToolMessage'} },
  ];
  await m._generate(msgs);
  const body = JSON.parse(_fetchCalls[0].opts.body);
  assert.strictEqual(body.messages[0].role, 'tool');
  assert.strictEqual(body.messages[0].tool_call_id, 'call_x');
  restoreFetch();
});

/* ================================================================== */
/* Summary                                                              */
/* ================================================================== */

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed ✓');
}

} // end main()

main().catch(err => { console.error(err); process.exit(1); });

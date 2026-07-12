/**
 * @byok-relay/expo — smoke test suite
 *
 * Run: node test/hooks.test.js
 *
 * Tests run entirely in Node (no React Native, no AsyncStorage installed).
 * - The in-memory storage fallback is exercised directly.
 * - ByokRelayClient API is tested against a mock fetch.
 * - Hooks are tested through the ByokRelayClient layer (no React renderer needed).
 * - createAsyncStorage() in-memory fallback is tested.
 */

'use strict';

const {
  ByokRelayClient,
  createAsyncStorage,
} = require('../src/index.js');

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

// ─── Fetch mock ───────────────────────────────────────────────────────────────

let mockHandlers = [];

function mockFetch(url, opts = {}) {
  for (const { pattern, handler } of mockHandlers) {
    if (pattern.test(url)) return handler(url, opts);
  }
  return Promise.reject(new Error(`Unmocked fetch: ${url}`));
}

function registerMock(pattern, handler) {
  mockHandlers.unshift({ pattern, handler });
}

function clearMocks() { mockHandlers = []; }

global.fetch = mockFetch;

// ─── SSE stream mock ──────────────────────────────────────────────────────────

function makeSSEStream(chunks) {
  let i = 0;
  const encoder = new TextEncoder();
  return {
    body: {
      getReader() {
        return {
          async read() {
            if (i >= chunks.length) return { done: true, value: undefined };
            const chunk = chunks[i++];
            return { done: false, value: encoder.encode(chunk) };
          },
        };
      },
    },
    ok: true,
    headers: { get: () => 'text/event-stream' },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

(async () => {

console.log('\n@byok-relay/expo — smoke tests\n');

// 1. createAsyncStorage — in-memory fallback (no AsyncStorage installed)
console.log('createAsyncStorage (in-memory fallback)');

await test('getItem returns null for missing key', async () => {
  const store = createAsyncStorage(null);
  const val = await store.getItem('missing');
  assertEqual(val, null);
});

await test('setItem and getItem round-trip', async () => {
  const store = createAsyncStorage(null);
  await store.setItem('foo', 'bar');
  const val = await store.getItem('foo');
  assertEqual(val, 'bar');
});

await test('removeItem deletes a stored value', async () => {
  const store = createAsyncStorage(null);
  await store.setItem('key', 'value');
  await store.removeItem('key');
  const val = await store.getItem('key');
  assertEqual(val, null);
});

await test('custom AsyncStorage adapter is used when provided', async () => {
  const mem = {};
  const adapter = {
    getItem:    (k) => Promise.resolve(mem[k] || null),
    setItem:    (k, v) => { mem[k] = v; return Promise.resolve(); },
    removeItem: (k) => { delete mem[k]; return Promise.resolve(); },
  };
  const store = createAsyncStorage(adapter);
  await store.setItem('x', '42');
  assertEqual(await store.getItem('x'), '42');
  await store.removeItem('x');
  assertEqual(await store.getItem('x'), null);
});

// 2. ByokRelayClient — token management
console.log('\nByokRelayClient — token management');

await test('register() stores token in AsyncStorage and in-memory', async () => {
  clearMocks();
  registerMock(/\/users$/, () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ token: 'tok-abc123', expires_at: null }),
  }));
  const storage = createAsyncStorage(null);
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  const token = await client.register('test-app');
  assertEqual(token, 'tok-abc123');
  assertEqual(client._token, 'tok-abc123');
  const stored = await storage.getItem('byok_relay_token');
  assertEqual(stored, 'tok-abc123');
});

await test('ensureToken() returns in-memory token without hitting network', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  client._token = 'already-set';
  const token = await client.ensureToken();
  assertEqual(token, 'already-set');
});

await test('ensureToken() restores token from AsyncStorage', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem('byok_relay_token', 'stored-tok');
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  const token = await client.ensureToken();
  assertEqual(token, 'stored-tok');
});

await test('ensureToken() registers when no token exists', async () => {
  clearMocks();
  registerMock(/\/users$/, () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ token: 'new-tok', expires_at: null }),
  }));
  const storage = createAsyncStorage(null);
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  const token = await client.ensureToken();
  assertEqual(token, 'new-tok');
});

await test('logout() clears token from memory and storage', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem('byok_relay_token', 'tok');
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  client._token = 'tok';
  await client.logout();
  assertEqual(client._token, null);
  assertEqual(await storage.getItem('byok_relay_token'), null);
});

// 3. ByokRelayClient — key management
console.log('\nByokRelayClient — key management');

await test('storeKey() sends POST /keys/:provider with Relay-Token header', async () => {
  clearMocks();
  registerMock(/\/users$/, () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ token: 'tok', expires_at: null }),
  }));
  let capturedHeaders = null;
  registerMock(/\/keys\/openai$/, (_url, opts) => {
    capturedHeaders = opts.headers;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  });
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage: createAsyncStorage(null) });
  await client.storeKey('openai', 'sk-test-key');
  assert(capturedHeaders['Relay-Token'] === 'tok', 'Relay-Token header should be set');
});

await test('listKeys() returns key metadata array', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem('byok_relay_token', 'tok');
  registerMock(/\/keys$/, () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve([{ provider: 'openai', stored: true }]),
  }));
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  const keys = await client.listKeys();
  assert(Array.isArray(keys), 'listKeys should return an array');
  assertEqual(keys[0].provider, 'openai');
});

await test('deleteKey() sends DELETE /keys/:provider', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem('byok_relay_token', 'tok');
  let method = null;
  registerMock(/\/keys\/anthropic$/, (_url, opts) => {
    method = opts.method;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  });
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  await client.deleteKey('anthropic');
  assertEqual(method, 'DELETE');
});

await test('rotateKey() sends POST /keys/:provider/rotate', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem('byok_relay_token', 'tok');
  let captured = null;
  registerMock(/\/keys\/openai\/rotate$/, (_url, opts) => {
    captured = JSON.parse(opts.body);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, rotated: true }) });
  });
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  const result = await client.rotateKey('openai', 'sk-new-key');
  assert(result.rotated === true, 'rotateKey should return { rotated: true }');
  assertEqual(captured.api_key, 'sk-new-key');
});

// 4. ByokRelayClient — chat (non-streaming)
console.log('\nByokRelayClient — chat (non-streaming)');

await test('chat() sends request to relay and returns completion', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem('byok_relay_token', 'tok');
  registerMock(/\/relay\/openai\//, () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      choices: [{ message: { role: 'assistant', content: 'Hello from relay!' } }],
    }),
  }));
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  const data = await client.chat('openai/gpt-4o', [{ role: 'user', content: 'hi' }]);
  assertEqual(data.choices[0].message.content, 'Hello from relay!');
});

await test('chat() resolves provider from bare model name (claude-*)', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem('byok_relay_token', 'tok');
  let capturedUrl = null;
  registerMock(/\/relay\/anthropic\//, (url) => {
    capturedUrl = url;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { role: 'assistant', content: 'Anthropic here' } }],
      }),
    });
  });
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  await client.chat('claude-opus-4-5', [{ role: 'user', content: 'hi' }]);
  assert(capturedUrl && capturedUrl.includes('/relay/anthropic/'), 'Should route to anthropic');
});

// 5. ByokRelayClient — streaming chat
console.log('\nByokRelayClient — streaming chat');

await test('streamChat() yields text deltas from SSE stream', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem('byok_relay_token', 'tok');

  const sseChunks = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  registerMock(/\/relay\/openai\//, () => Promise.resolve(makeSSEStream(sseChunks)));

  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  const chunks = [];
  for await (const chunk of client.streamChat('openai/gpt-4o', [{ role: 'user', content: 'hi' }])) {
    chunks.push(chunk);
  }
  assertEqual(chunks.join(''), 'Hello world');
});

await test('streamChat() handles Anthropic streaming format', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem('byok_relay_token', 'tok');

  const sseChunks = [
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}\n\n',
    'data: [DONE]\n\n',
  ];
  registerMock(/\/relay\/anthropic\//, () => Promise.resolve(makeSSEStream(sseChunks)));

  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  const chunks = [];
  for await (const chunk of client.streamChat('anthropic/claude-opus-4-5', [{ role: 'user', content: 'hi' }])) {
    chunks.push(chunk);
  }
  assertEqual(chunks.join(''), 'Hi there');
});

await test('streamChat() skips [DONE] and unparseable chunks', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem('byok_relay_token', 'tok');

  const sseChunks = [
    'data: {broken json}\n\n',
    'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  registerMock(/\/relay\/openai\//, () => Promise.resolve(makeSSEStream(sseChunks)));

  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  const chunks = [];
  for await (const chunk of client.streamChat('openai/gpt-4o', [{ role: 'user', content: 'hi' }])) {
    chunks.push(chunk);
  }
  assertEqual(chunks.join(''), 'OK');
});

// 6. ByokRelayClient — health & stats
console.log('\nByokRelayClient — health & stats');

await test('health() returns parsed JSON from /health', async () => {
  clearMocks();
  registerMock(/\/health/, () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ status: 'ok', db: 'connected' }),
  }));
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage: createAsyncStorage(null) });
  const data = await client.health();
  assertEqual(data.status, 'ok');
});

await test('health(deep=true) adds ?deep=1 query param', async () => {
  clearMocks();
  let capturedUrl = null;
  registerMock(/\/health/, (url) => {
    capturedUrl = url;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });
  });
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage: createAsyncStorage(null) });
  await client.health(true);
  assert(capturedUrl.includes('deep=1'), 'URL should include deep=1');
});

await test('stats() requests /stats with Relay-Token', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem('byok_relay_token', 'tok');
  let capturedHeaders = null;
  registerMock(/\/stats$/, (_url, opts) => {
    capturedHeaders = opts.headers;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ requests: 42 }) });
  });
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  const data = await client.stats();
  assertEqual(data.requests, 42);
  assert(capturedHeaders['Relay-Token'] === 'tok', 'Relay-Token header should be set');
});

await test('getModels() returns available models list', async () => {
  clearMocks();
  registerMock(/\/models$/, () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ restricted: false, allowed_models: [] }),
  }));
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage: createAsyncStorage(null) });
  const data = await client.getModels();
  assert('restricted' in data, 'getModels should return restricted flag');
});

await test('deleteAccount() clears token after DELETE /users', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem('byok_relay_token', 'tok');
  registerMock(/\/users$/, (_url, opts) => {
    if (opts.method === 'DELETE') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: 'tok' }) });
  });
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  client._token = 'tok';
  await client.deleteAccount();
  assertEqual(client._token, null);
  assertEqual(await storage.getItem('byok_relay_token'), null);
});

// 7. Expo SecureStore adapter pattern
console.log('\nExpo SecureStore adapter pattern');

await test('custom SecureStore-style adapter works with ByokRelayClient', async () => {
  clearMocks();
  registerMock(/\/users$/, () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ token: 'secure-tok', expires_at: null }),
  }));

  // Simulate expo-secure-store API
  const secureStore = {};
  const adapter = {
    getItem:    (k) => Promise.resolve(secureStore[k] || null),
    setItem:    (k, v) => { secureStore[k] = v; return Promise.resolve(); },
    removeItem: (k) => { delete secureStore[k]; return Promise.resolve(); },
  };

  const client = new ByokRelayClient({
    relayUrl: 'https://relay.test',
    storage: adapter,
  });
  const token = await client.register('secure-app');
  assertEqual(token, 'secure-tok');
  assertEqual(secureStore['byok_relay_token'], 'secure-tok');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

})();

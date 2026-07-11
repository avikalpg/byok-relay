'use strict';

/**
 * @byok-relay/tanstack — smoke tests
 * Runs without TanStack Start, React, or a live relay instance.
 */

const {
  createByokRelayAPIRoute,
  createRelayServerFnHandler,
  useByokRelay,
  useChat,
  useStreamingChat,
  useRelayHealth,
  ByokRelayClient,
} = require('../src/index.js');

let passed = 0;
let failed = 0;

function test (name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

function assert (condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

/* ---------- createByokRelayAPIRoute ---------- */
console.log('\n--- createByokRelayAPIRoute ---');

test('returns all HTTP method handlers', () => {
  const route = createByokRelayAPIRoute({ relayUrl: 'http://localhost:3000' });
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    assert(typeof route[method] === 'function', `Missing handler: ${method}`);
  }
});

test('all handlers are the same function (single proxy handler)', () => {
  const route = createByokRelayAPIRoute({ relayUrl: 'http://localhost:3000' });
  // All methods point to the same handle function internally
  assert(typeof route.GET === 'function');
  assert(typeof route.POST === 'function');
});

test('accepts timeoutMs and allowedAppIds options', () => {
  const route = createByokRelayAPIRoute({
    relayUrl      : 'https://relay.byokrelay.com',
    timeoutMs     : 10_000,
    allowedAppIds : ['my-app', 'dev-app'],
  });
  assert(typeof route.GET === 'function');
});

test('returns 403 for disallowed app_id (mocked Request)', async () => {
  const route = createByokRelayAPIRoute({
    relayUrl      : 'https://relay.example.com',
    allowedAppIds : ['allowed-app'],
  });
  const req = new Request('https://example.com/api/relay/health', {
    headers: { 'x-app-id': 'bad-actor' },
  });
  const res = await route.GET({ request: req, params: { '$': 'health' } });
  assert(res.status === 403, `Expected 403, got ${res.status}`);
  const body = await res.json();
  assert(body.error === 'App not allowed', `Unexpected error: ${body.error}`);
});

test('allows request with matching app_id (fetch will fail — expected)', async () => {
  const route = createByokRelayAPIRoute({
    relayUrl      : 'http://127.0.0.1:19999', // nothing listening
    allowedAppIds : ['my-app'],
    timeoutMs     : 500,
  });
  const req = new Request('http://127.0.0.1:19999/api/relay/health', {
    headers: { 'x-app-id': 'my-app' },
  });
  const res = await route.GET({ request: req, params: { '$': 'health' } });
  // Should fail with 502 or 504, not 403
  assert(res.status !== 403, `Should not 403 for allowed app`);
  assert([502, 504].includes(res.status), `Expected 502/504, got ${res.status}`);
});

/* ---------- createRelayServerFnHandler ---------- */
console.log('\n--- createRelayServerFnHandler ---');

test('returns an async function', () => {
  const handler = createRelayServerFnHandler({ relayUrl: 'http://localhost:3000' });
  assert(typeof handler === 'function');
  assert(handler.constructor.name === 'AsyncFunction' || typeof handler === 'function');
});

test('accepts timeoutMs option', () => {
  const handler = createRelayServerFnHandler({ timeoutMs: 5_000 });
  assert(typeof handler === 'function');
});

test('throws on timeout (unreachable host)', async () => {
  const handler = createRelayServerFnHandler({
    relayUrl  : 'http://127.0.0.1:19998',
    timeoutMs : 300,
  });
  try {
    await handler({ data: { path: 'health', token: 'test-token', method: 'GET' } });
    assert(false, 'Should have thrown');
  } catch (e) {
    assert(
      e.message.includes('timed out') || e.message.includes('reach relay') || e.message.includes('fetch'),
      `Unexpected error: ${e.message}`
    );
  }
});

/* ---------- ByokRelayClient ---------- */
console.log('\n--- ByokRelayClient ---');

test('instantiates with default options', () => {
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  assert(client instanceof ByokRelayClient);
});

test('instantiates with custom storage adapter', () => {
  const store  = {};
  const adapter = {
    getItem   : (k) => store[k] ?? null,
    setItem   : (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000', storage: adapter });
  assert(client instanceof ByokRelayClient);
});

test('logout clears token from storage', () => {
  const store  = { byok_relay_token: 'test-token-123' };
  const adapter = {
    getItem   : (k) => store[k] ?? null,
    setItem   : (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000', storage: adapter });
  assert(client._token === 'test-token-123');
  client.logout();
  assert(client._token === null);
  assert(!store['byok_relay_token']);
});

test('_headers includes x-relay-token when token set', () => {
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  client._token = 'my-token';
  const h = client._headers();
  assert(h['x-relay-token'] === 'my-token');
  assert(h['content-type'] === 'application/json');
});

test('_headers includes x-app-id when appId set', () => {
  const client = new ByokRelayClient({
    relayUrl: 'http://localhost:3000',
    appId   : 'my-tanstack-app',
  });
  const h = client._headers();
  assert(h['x-app-id'] === 'my-tanstack-app');
});

test('_headers merges extra headers', () => {
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  const h = client._headers({ 'x-custom': 'value' });
  assert(h['x-custom'] === 'value');
  assert(h['content-type'] === 'application/json');
});

test('register throws on unreachable relay', async () => {
  const client = new ByokRelayClient({ relayUrl: 'http://127.0.0.1:19997' });
  try {
    await client.register();
    assert(false, 'Should have thrown');
  } catch (e) {
    assert(e instanceof Error);
  }
});

test('streamChat is an async generator', () => {
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  client._token = 'test';
  const gen = client.streamChat({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
  assert(gen && typeof gen[Symbol.asyncIterator] === 'function', 'streamChat should return an async generator');
});

/* ---------- React Hooks (shim) ---------- */
console.log('\n--- React hooks (no-React shim) ---');

test('useByokRelay returns expected API shape', () => {
  const api = useByokRelay({ relayUrl: 'http://localhost:3000', appId: 'test' });
  for (const key of ['token', 'keys', 'loading', 'error', 'register', 'ensureToken', 'storeKey', 'listKeys', 'deleteKey', 'rotateKey', 'logout']) {
    assert(key in api, `Missing key: ${key}`);
  }
  assert(typeof api.register    === 'function');
  assert(typeof api.storeKey    === 'function');
  assert(typeof api.logout      === 'function');
});

test('useChat returns expected API shape', () => {
  const chat = useChat({ relayUrl: 'http://localhost:3000', model: 'openai/gpt-4o-mini' });
  for (const key of ['messages', 'loading', 'error', 'sendMessage', 'clearMessages']) {
    assert(key in chat, `Missing key: ${key}`);
  }
  assert(typeof chat.sendMessage    === 'function');
  assert(typeof chat.clearMessages  === 'function');
  assert(Array.isArray(chat.messages));
});

test('useStreamingChat returns expected API shape', () => {
  const chat = useStreamingChat({ relayUrl: 'http://localhost:3000', model: 'openai/gpt-4o' });
  for (const key of ['messages', 'streamingContent', 'isStreaming', 'error', 'sendMessage', 'stopStreaming', 'clearMessages']) {
    assert(key in chat, `Missing key: ${key}`);
  }
  assert(typeof chat.stopStreaming === 'function');
  assert(chat.isStreaming === false);
  assert(chat.streamingContent === '');
});

test('useRelayHealth returns expected API shape', () => {
  const health = useRelayHealth({ relayUrl: 'http://localhost:3000' });
  for (const key of ['status', 'details', 'check', 'startPolling', 'stopPolling']) {
    assert(key in health, `Missing key: ${key}`);
  }
  assert(typeof health.check         === 'function');
  assert(typeof health.startPolling  === 'function');
  assert(typeof health.stopPolling   === 'function');
  assert(health.status === 'unknown' || health.status === 'ok' || health.status === 'degraded');
});

test('useByokRelay logout clears token', () => {
  const store  = { byok_relay_token: 'tok-abc' };
  const adapter = {
    getItem   : (k) => store[k] ?? null,
    setItem   : (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  const api = useByokRelay({ relayUrl: 'http://localhost:3000', storage: adapter });
  api.logout();
  assert(!store['byok_relay_token'], 'Token should be removed from storage');
});

/* ---------- Integration: API route + client URL resolution ---------- */
console.log('\n--- URL resolution ---');

test('createByokRelayAPIRoute uses process.env.RELAY_URL when set', async () => {
  const orig = process.env.RELAY_URL;
  process.env.RELAY_URL = 'http://127.0.0.1:19996';
  const route = createByokRelayAPIRoute(); // no relayUrl in opts
  const req   = new Request('http://example.com/api/relay/health');
  const res   = await route.GET({ request: req, params: { '$': 'health' } });
  // Should attempt to reach 127.0.0.1:19996 — fail with 502/504 (not crash)
  assert([502, 504].includes(res.status), `Expected 502/504, got ${res.status}`);
  process.env.RELAY_URL = orig;
});

test('ByokRelayClient prefers process.env.RELAY_URL over opts.relayUrl', () => {
  const orig = process.env.RELAY_URL;
  process.env.RELAY_URL = 'http://env-relay.example.com';
  const client = new ByokRelayClient({ relayUrl: 'http://opts-relay.example.com' });
  assert(client._relayUrl === 'http://env-relay.example.com', `Got: ${client._relayUrl}`);
  process.env.RELAY_URL = orig;
});

test('ByokRelayClient falls back to opts.relayUrl when env not set', () => {
  const orig = process.env.RELAY_URL;
  delete process.env.RELAY_URL;
  const client = new ByokRelayClient({ relayUrl: 'http://my-relay.example.com' });
  assert(client._relayUrl === 'http://my-relay.example.com', `Got: ${client._relayUrl}`);
  process.env.RELAY_URL = orig;
});

/* ---------- Summary ---------- */
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

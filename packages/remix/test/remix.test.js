/**
 * @byok-relay/remix — smoke tests
 * Run with: node test/remix.test.js
 * No external dependencies required.
 */

'use strict';

const assert = require('assert');

// ── Polyfills for Node < 18 (env may vary) ──────────────────────────────────
if (typeof globalThis.fetch === 'undefined') {
  // Provide a minimal stub; real fetch is tested in integration
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0), headers: new Map(), body: null });
}
if (typeof globalThis.AbortController === 'undefined') {
  globalThis.AbortController = class { abort () {} get signal () { return {}; } };
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class { decode (v) { return v ? v.toString() : ''; } };
}

const {
  createRelayLoader,
  createRelayAction,
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
    console.error(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

function asyncTest (name, fn) {
  return fn()
    .then(() => { console.log(`  ✅ ${name}`); passed++; })
    .catch(e => { console.error(`  ❌ ${name}: ${e.message}`); failed++; });
}

// ── 1. Export shape ──────────────────────────────────────────────────────────
console.log('\n1. Export shape');
test('createRelayLoader is a function', () => assert.strictEqual(typeof createRelayLoader, 'function'));
test('createRelayAction is a function', () => assert.strictEqual(typeof createRelayAction, 'function'));
test('useByokRelay is a function', () => assert.strictEqual(typeof useByokRelay, 'function'));
test('useChat is a function', () => assert.strictEqual(typeof useChat, 'function'));
test('useStreamingChat is a function', () => assert.strictEqual(typeof useStreamingChat, 'function'));
test('useRelayHealth is a function', () => assert.strictEqual(typeof useRelayHealth, 'function'));
test('ByokRelayClient is a class', () => assert.strictEqual(typeof ByokRelayClient, 'function'));

// ── 2. createRelayLoader ─────────────────────────────────────────────────────
console.log('\n2. createRelayLoader');
test('returns a function', () => {
  const loader = createRelayLoader({ relayUrl: 'https://relay.example.com' });
  assert.strictEqual(typeof loader, 'function');
});

test('rejects disallowed app_id', async () => {
  const loader = createRelayLoader({
    relayUrl: 'https://relay.example.com',
    allowedApps: ['allowed-app'],
  });
  const req = {
    url: 'https://myapp.com/api/relay/health',
    headers: { get: () => '' },
  };
  const res = await loader({ request: req, params: { '*': 'health' } });
  assert.strictEqual(res.status, 403);
});

// ── 3. createRelayAction ─────────────────────────────────────────────────────
console.log('\n3. createRelayAction');
test('returns a function', () => {
  const action = createRelayAction({ relayUrl: 'https://relay.example.com' });
  assert.strictEqual(typeof action, 'function');
});

test('rejects disallowed app_id in action', async () => {
  const action = createRelayAction({
    relayUrl: 'https://relay.example.com',
    allowedApps: ['allowed-app'],
  });
  const req = {
    url: 'https://myapp.com/api/relay/users',
    method: 'POST',
    headers: { get: () => '' },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
  const res = await action({ request: req, params: { '*': 'users' } });
  assert.strictEqual(res.status, 403);
});

// ── 4. ByokRelayClient ───────────────────────────────────────────────────────
console.log('\n4. ByokRelayClient');
test('constructs with defaults', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(client.relayUrl, 'https://relay.byokrelay.com');
  assert.strictEqual(client.appId, '');
  assert.strictEqual(client.token, null);
});

test('constructs with custom relayUrl and appId', () => {
  const client = new ByokRelayClient({ relayUrl: 'https://my.relay.com/', appId: 'my-app' });
  assert.strictEqual(client.relayUrl, 'https://my.relay.com');
  assert.strictEqual(client.appId, 'my-app');
});

test('custom storage adapter is used', () => {
  const store = {};
  const storage = {
    get: (k) => store[k] || null,
    set: (k, v) => { store[k] = v; },
    remove: (k) => { delete store[k]; },
  };
  const client = new ByokRelayClient({ relayUrl: 'https://relay.example.com', storage });
  assert.strictEqual(client.token, null);
});

test('logout clears token', () => {
  const store = {};
  const storage = { get: (k) => store[k] || null, set: (k, v) => { store[k] = v; }, remove: (k) => { delete store[k]; } };
  const client = new ByokRelayClient({ relayUrl: 'https://relay.example.com', storage });
  client.token = 'test-token';
  store[client._storageKey] = 'test-token';
  client.logout();
  assert.strictEqual(client.token, null);
  assert.strictEqual(store[client._storageKey], undefined);
});

test('_headers includes x-relay-token and x-app-id when set', () => {
  const client = new ByokRelayClient({ relayUrl: 'https://relay.example.com', appId: 'app1' });
  client.token = 'tok123';
  const h = client._headers();
  assert.strictEqual(h['x-relay-token'], 'tok123');
  assert.strictEqual(h['x-app-id'], 'app1');
  assert.strictEqual(h['Content-Type'], 'application/json');
});

test('_headers omits x-relay-token when token is null', () => {
  const client = new ByokRelayClient({ relayUrl: 'https://relay.example.com' });
  const h = client._headers();
  assert.ok(!('x-relay-token' in h));
});

// ── 5. ByokRelayClient network calls (mocked fetch) ─────────────────────────
console.log('\n5. ByokRelayClient — mocked fetch calls');

async function withMockFetch (mockFn, testFn) {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFn;
  try { await testFn(); } finally { globalThis.fetch = orig; }
}

const promises = [];

promises.push(asyncTest('register stores token', async () => {
  await withMockFetch(async (url, opts) => ({
    ok: true,
    status: 200,
    json: async () => ({ token: 'relay-tok-abc', expires_at: '2027-01-01T00:00:00Z' }),
  }), async () => {
    const store = {};
    const client = new ByokRelayClient({
      relayUrl: 'https://relay.example.com',
      storage: { get: k => store[k] || null, set: (k, v) => { store[k] = v; }, remove: k => { delete store[k]; } },
    });
    const d = await client.register('my-app');
    assert.strictEqual(d.token, 'relay-tok-abc');
    assert.strictEqual(client.token, 'relay-tok-abc');
    assert.strictEqual(store[client._storageKey], 'relay-tok-abc');
  });
}));

promises.push(asyncTest('ensureToken returns existing token without fetching', async () => {
  let fetchCount = 0;
  await withMockFetch(async () => { fetchCount++; return { ok: true, json: async () => ({ token: 'new-tok' }) }; }, async () => {
    const client = new ByokRelayClient({ relayUrl: 'https://relay.example.com' });
    client.token = 'existing-tok';
    const t = await client.ensureToken();
    assert.strictEqual(t, 'existing-tok');
    assert.strictEqual(fetchCount, 0);
  });
}));

promises.push(asyncTest('storeKey sends POST to /keys/:provider', async () => {
  let capturedUrl, capturedBody;
  await withMockFetch(async (url, opts) => {
    capturedUrl = url; capturedBody = opts.body;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }, async () => {
    const client = new ByokRelayClient({ relayUrl: 'https://relay.example.com' });
    client.token = 'tok';
    await client.storeKey('openai', 'sk-test-123');
    assert.ok(capturedUrl.endsWith('/keys/openai'));
    assert.ok(capturedBody.includes('sk-test-123'));
  });
}));

promises.push(asyncTest('listKeys sends GET to /keys', async () => {
  let capturedUrl;
  await withMockFetch(async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => ({ providers: ['openai'] }) };
  }, async () => {
    const client = new ByokRelayClient({ relayUrl: 'https://relay.example.com' });
    client.token = 'tok';
    await client.listKeys();
    assert.ok(capturedUrl.endsWith('/keys'));
  });
}));

promises.push(asyncTest('deleteKey sends DELETE to /keys/:provider', async () => {
  let method;
  await withMockFetch(async (url, opts) => {
    method = opts.method;
    return { ok: true, json: async () => ({ ok: true }) };
  }, async () => {
    const client = new ByokRelayClient({ relayUrl: 'https://relay.example.com' });
    client.token = 'tok';
    await client.deleteKey('anthropic');
    assert.strictEqual(method, 'DELETE');
  });
}));

promises.push(asyncTest('rotateKey sends POST to /keys/:provider/rotate', async () => {
  let capturedUrl;
  await withMockFetch(async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ ok: true, rotated: true }) };
  }, async () => {
    const client = new ByokRelayClient({ relayUrl: 'https://relay.example.com' });
    client.token = 'tok';
    await client.rotateKey('openai', 'sk-new-key');
    assert.ok(capturedUrl.endsWith('/keys/openai/rotate'));
  });
}));

promises.push(asyncTest('chat sends POST with model and messages', async () => {
  let capturedBody;
  await withMockFetch(async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Hi!' } }] }) };
  }, async () => {
    const client = new ByokRelayClient({ relayUrl: 'https://relay.example.com' });
    client.token = 'tok';
    const d = await client.chat({ provider: 'openai', model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] });
    assert.strictEqual(capturedBody.model, 'gpt-4o');
    assert.ok(Array.isArray(capturedBody.messages));
  });
}));

promises.push(asyncTest('health calls /health', async () => {
  let capturedUrl;
  await withMockFetch(async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ status: 'ok', uptime: 100 }) };
  }, async () => {
    const client = new ByokRelayClient({ relayUrl: 'https://relay.example.com' });
    const d = await client.health();
    assert.ok(capturedUrl.endsWith('/health'));
    assert.strictEqual(d.status, 'ok');
  });
}));

promises.push(asyncTest('health(true) calls /health?deep=1', async () => {
  let capturedUrl;
  await withMockFetch(async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ status: 'ok' }) };
  }, async () => {
    const client = new ByokRelayClient({ relayUrl: 'https://relay.example.com' });
    await client.health(true);
    assert.ok(capturedUrl.includes('deep=1'));
  });
}));

promises.push(asyncTest('getModels calls /models', async () => {
  let capturedUrl;
  await withMockFetch(async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ models: [] }) };
  }, async () => {
    const client = new ByokRelayClient({ relayUrl: 'https://relay.example.com' });
    client.token = 'tok';
    await client.getModels();
    assert.ok(capturedUrl.endsWith('/models'));
  });
}));

promises.push(asyncTest('deleteAccount sends DELETE and logs out', async () => {
  let method, capturedUrl;
  await withMockFetch(async (url, opts) => {
    capturedUrl = url; method = opts.method;
    return { ok: true, json: async () => ({ ok: true }) };
  }, async () => {
    const client = new ByokRelayClient({ relayUrl: 'https://relay.example.com' });
    client.token = 'tok';
    await client.deleteAccount();
    assert.strictEqual(method, 'DELETE');
    assert.ok(capturedUrl.endsWith('/users'));
    assert.strictEqual(client.token, null);
  });
}));

// ── 6. React hooks smoke (shim path) ────────────────────────────────────────
console.log('\n6. React hooks — shim path (no React installed)');
test('useByokRelay returns expected shape', () => {
  const result = useByokRelay({ relayUrl: 'https://relay.example.com', appId: 'test' });
  assert.ok('token' in result);
  assert.ok('loading' in result);
  assert.ok('error' in result);
  assert.ok(typeof result.storeKey === 'function');
  assert.ok(typeof result.listKeys === 'function');
  assert.ok(typeof result.deleteKey === 'function');
  assert.ok(typeof result.rotateKey === 'function');
  assert.ok(typeof result.logout === 'function');
});

test('useChat returns expected shape', () => {
  const result = useChat({ relayUrl: 'https://relay.example.com', token: 'tok' });
  assert.ok(Array.isArray(result.messages));
  assert.ok(typeof result.send === 'function');
  assert.ok(typeof result.clear === 'function');
  assert.ok('loading' in result);
  assert.ok('error' in result);
});

test('useStreamingChat returns expected shape', () => {
  const result = useStreamingChat({ relayUrl: 'https://relay.example.com', token: 'tok' });
  assert.ok(Array.isArray(result.messages));
  assert.ok('streamingContent' in result);
  assert.ok(typeof result.send === 'function');
  assert.ok(typeof result.stopStreaming === 'function');
  assert.ok(typeof result.clear === 'function');
});

test('useRelayHealth returns expected shape', () => {
  const result = useRelayHealth({ relayUrl: 'https://relay.example.com', intervalMs: 0 });
  assert.ok('status' in result);
  assert.ok('checks' in result);
  assert.ok('warnings' in result);
  assert.ok(typeof result.refetch === 'function');
  assert.ok(typeof result.check === 'function');
});

// ── Run async tests then summarise ──────────────────────────────────────────
Promise.all(promises).then(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});

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
  useChat,
  useRelayHealth,
  useStreamingChat,
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

function tokenKey(relayUrl = 'https://relay.test') {
  return `byok_relay_token:${encodeURIComponent(relayUrl)}`;
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

async function withMockReact(run, options = {}) {
  const Module = require('module');
  const originalLoad = Module._load;
  const state = [];
  const refs = [];
  let stateCursor = 0;
  let refCursor = 0;
  const react = {
    useState(initial) {
      const idx = stateCursor++;
      if (!(idx in state)) state[idx] = initial;
      return [state[idx], (next) => {
        state[idx] = typeof next === 'function' ? next(state[idx]) : next;
      }];
    },
    useEffect(fn) { return options.runEffects === false ? undefined : fn(); },
    useCallback(fn) { return fn; },
    useRef(initial) {
      const idx = refCursor++;
      if (!refs[idx]) refs[idx] = { current: initial };
      return refs[idx];
    },
  };
  Module._load = function mockReactLoad(request, parent, isMain) {
    if (request === 'react') return react;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return await run({
      render(hook, opts) {
        stateCursor = 0;
        refCursor = 0;
        return hook(opts);
      },
      state,
    });
  } finally {
    Module._load = originalLoad;
  }
}

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
  const stored = await storage.getItem(tokenKey());
  assertEqual(stored, 'tok-abc123');
});

await test('register() namespaces persisted tokens by relay URL', async () => {
  clearMocks();
  registerMock(/\/users$/, (url) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      token: url.includes('other.relay') ? 'tok-other' : 'tok-main',
      expires_at: null,
    }),
  }));
  const storage = createAsyncStorage(null);
  const main = new ByokRelayClient({ relayUrl: 'https://relay.test/', storage });
  const other = new ByokRelayClient({ relayUrl: 'https://other.relay', storage });
  await main.register('main-app');
  await other.register('other-app');
  assertEqual(await storage.getItem(tokenKey('https://relay.test')), 'tok-main');
  assertEqual(await storage.getItem(tokenKey('https://other.relay')), 'tok-other');
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
  await storage.setItem(tokenKey(), 'stored-tok');
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  const token = await client.ensureToken();
  assertEqual(token, 'stored-tok');
});

await test('restoreToken() and token getter expose restored token publicly', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem(tokenKey(), 'stored-tok');
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  const token = await client.restoreToken();
  assertEqual(token, 'stored-tok');
  assertEqual(client.token, 'stored-tok');
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

await test('ensureToken() serializes concurrent registrations', async () => {
  clearMocks();
  let registrations = 0;
  registerMock(/\/users$/, () => {
    registrations++;
    return new Promise(resolve => setTimeout(() => resolve({
      ok: true,
      json: () => Promise.resolve({ token: 'shared-tok', expires_at: null }),
    }), 5));
  });
  const storage = createAsyncStorage(null);
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  const [a, b] = await Promise.all([client.ensureToken(), client.ensureToken()]);
  assertEqual(a, 'shared-tok');
  assertEqual(b, 'shared-tok');
  assertEqual(registrations, 1, 'Concurrent ensureToken() calls should register once');
});

await test('logout() clears token from memory and storage', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem(tokenKey(), 'tok');
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  client._token = 'tok';
  await client.logout();
  assertEqual(client._token, null);
  assertEqual(await storage.getItem(tokenKey()), null);
});

await test('logout() prevents stale registration from restoring a token', async () => {
  clearMocks();
  let finishRegistration;
  registerMock(/\/users$/, () => new Promise(resolve => {
    finishRegistration = () => resolve({
      ok: true,
      json: () => Promise.resolve({ token: 'late-tok', expires_at: null }),
    });
  }));
  const storage = createAsyncStorage(null);
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  const registration = client.register('test-app');
  await client.logout();
  finishRegistration();
  const token = await registration;
  assertEqual(token, null);
  assertEqual(client._token, null);
  assertEqual(await storage.getItem(tokenKey()), null);
});

await test('register() removes a token persisted after logout', async () => {
  clearMocks();
  registerMock(/\/users$/, () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ token: 'late-tok', expires_at: null }),
  }));
  const key = tokenKey();
  const mem = {};
  let client;
  const storage = {
    getItem: (k) => Promise.resolve(k in mem ? mem[k] : null),
    setItem: async (k, v) => { mem[k] = v; await client.logout(); },
    removeItem: (k) => { delete mem[k]; return Promise.resolve(); },
  };
  client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  const token = await client.register('test-app');
  assertEqual(token, null);
  assertEqual(client._token, null);
  assertEqual(mem[key], undefined);
});

await test('default global fetch is bound, supplied fetch is not rebound', async () => {
  clearMocks();
  const originalFetch = global.fetch;
  try {
    let defaultFetchThis = null;
    global.fetch = function boundCheckFetch() {
      defaultFetchThis = this;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });
    };
    const defaultClient = new ByokRelayClient({ relayUrl: 'https://relay.test', storage: createAsyncStorage(null) });
    await defaultClient.health();
    assertEqual(defaultFetchThis, globalThis, 'default fetch should be bound to globalThis');

    let suppliedFetchThis = null;
    const suppliedFetch = function suppliedFetch() {
      suppliedFetchThis = this;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });
    };
    const suppliedClient = new ByokRelayClient({
      relayUrl: 'https://relay.test',
      storage: createAsyncStorage(null),
      fetch: suppliedFetch,
    });
    await suppliedClient.health();
    assertEqual(suppliedFetchThis, suppliedClient, 'supplied fetch should be stored untouched');
  } finally {
    global.fetch = originalFetch;
  }
});

await test('logout() prevents stale AsyncStorage restoration from restoring a token', async () => {
  clearMocks();
  const key = tokenKey();
  const mem = { [key]: 'stored-tok' };
  let finishRestore;
  const storage = {
    getItem: (k) => k === key
      ? new Promise(resolve => { finishRestore = () => resolve('stored-tok'); })
      : Promise.resolve(null),
    setItem: (k, v) => { mem[k] = v; return Promise.resolve(); },
    removeItem: (k) => { delete mem[k]; return Promise.resolve(); },
  };
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  const restore = client._restoreToken();
  await client.logout();
  finishRestore();
  const token = await restore;
  assertEqual(token, null);
  assertEqual(client._token, null);
  assertEqual(mem[key], undefined);
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
  await storage.setItem(tokenKey(), 'tok');
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
  await storage.setItem(tokenKey(), 'tok');
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
  await storage.setItem(tokenKey(), 'tok');
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
  await storage.setItem(tokenKey(), 'tok');
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
  await storage.setItem(tokenKey(), 'tok');
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

await test('useChat() rolls back only the failed optimistic message and hides markers from provider messages', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem(tokenKey(), 'tok');
  const seenBodies = [];
  let failReject;
  let okResolve;
  registerMock(/\/relay\/openai\//, (_url, opts) => {
    seenBodies.push(opts.body);
    const body = JSON.parse(opts.body);
    const content = body.messages[body.messages.length - 1].content;
    if (content === 'fail') {
      return new Promise((_resolve, reject) => { failReject = reject; });
    }
    return new Promise(resolve => { okResolve = resolve; });
  });

  await withMockReact(async ({ render, state }) => {
    const hook = render(useChat, { relayUrl: 'https://relay.test', storage });
    const failSend = hook.sendMessage('fail');
    await Promise.resolve();
    const okSend = hook.sendMessage('ok');
    await Promise.resolve();
    okResolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: 'ok reply' } }] }) });
    await okSend;
    failReject(new Error('boom'));
    await failSend.catch(() => {});

    assertEqual(state[0].length, 2);
    assertEqual(state[0][0].role, 'user');
    assertEqual(state[0][0].content, 'ok');
    assertEqual(state[0][1].role, 'assistant');
    assertEqual(state[0][1].content, 'ok reply');
    assertEqual(Object.getOwnPropertySymbols(state[0][0]).length, 0, 'resolved user message should not expose marker');
    assert(seenBodies.every(body => !body.includes('byokRelayOptimisticMessageId') && !body.includes('pendingMessage')), 'provider messages should not expose optimistic markers');
  });
});

// 5. ByokRelayClient — streaming chat
console.log('\nByokRelayClient — streaming chat');

await test('streamChat() yields text deltas from SSE stream', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem(tokenKey(), 'tok');

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
  await storage.setItem(tokenKey(), 'tok');

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
  await storage.setItem(tokenKey(), 'tok');

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

await test('streamChat() cancels and releases the reader on early termination', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem(tokenKey(), 'tok');
  let cancelled = false;
  let released = false;
  const encoder = new TextEncoder();
  registerMock(/\/relay\/openai\//, () => Promise.resolve({
    ok: true,
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader() {
        return {
          read: () => Promise.resolve({
            done: false,
            value: encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
          }),
          cancel: () => { cancelled = true; return Promise.resolve(); },
          releaseLock: () => { released = true; },
        };
      },
    },
  }));

  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage });
  for await (const _chunk of client.streamChat('openai/gpt-4o', [{ role: 'user', content: 'hi' }])) {
    break;
  }
  assert(cancelled, 'Reader should be cancelled when stream consumption stops early');
  assert(released, 'Reader lock should be released when stream consumption stops early');
});

await test('useStreamingChat() rolls back only the failed optimistic message and hides markers from provider messages', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem(tokenKey(), 'tok');
  const seenBodies = [];
  let failReject;
  let okResolve;
  registerMock(/\/relay\/openai\//, (_url, opts) => {
    seenBodies.push(opts.body);
    const body = JSON.parse(opts.body);
    const content = body.messages[body.messages.length - 1].content;
    if (content === 'fail') {
      return new Promise((_resolve, reject) => {
        failReject = reject;
        if (opts.signal.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return new Promise(resolve => { okResolve = resolve; });
  });

  await withMockReact(async ({ render, state }) => {
    const hook = render(useStreamingChat, { relayUrl: 'https://relay.test', storage });
    const failSend = hook.sendMessage('fail');
    await Promise.resolve();
    const okSend = hook.sendMessage('ok');
    await Promise.resolve();
    okResolve(makeSSEStream(['data: {"choices":[{"delta":{"content":"ok reply"}}]}\n\n']));
    await okSend;
    await failSend.catch(() => {});

    assertEqual(state[0].length, 2);
    assertEqual(state[0][0].role, 'user');
    assertEqual(state[0][0].content, 'ok');
    assertEqual(state[0][1].role, 'assistant');
    assertEqual(state[0][1].content, 'ok reply');
    assertEqual(Object.getOwnPropertySymbols(state[0][0]).length, 0, 'resolved user message should not expose marker');
    assert(seenBodies.every(body => !body.includes('byokRelayOptimisticMessageId') && !body.includes('pendingMessage')), 'provider messages should not expose optimistic markers');
  });
});

await test('useStreamingChat() public stopStreaming ignores React Native press events', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem(tokenKey(), 'tok');
  registerMock(/\/relay\/openai\//, (_url, opts) => new Promise((_resolve, reject) => {
    if (opts.signal.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));

  await withMockReact(async ({ render, state }) => {
    const hook = render(useStreamingChat, { relayUrl: 'https://relay.test', storage });
    const send = hook.sendMessage('hello');
    await Promise.resolve();
    hook.stopStreaming({ nativeEvent: {} });
    await send;

    assertEqual(state[0].length, 1);
    assertEqual(state[0][0].role, 'user');
    assertEqual(state[0][0].content, 'hello');
  });
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

await test('health(false, provider) builds ?provider= without deep', async () => {
  clearMocks();
  let capturedUrl = null;
  registerMock(/\/health/, (url) => {
    capturedUrl = url;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });
  });
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage: createAsyncStorage(null) });
  await client.health(false, 'openai');
  assert(capturedUrl.endsWith('/health?provider=openai'), 'URL should include provider as a query param');
});

await test('health() rejects non-OK responses', async () => {
  clearMocks();
  registerMock(/\/health/, () => Promise.resolve({
    ok: false,
    status: 503,
    json: () => Promise.resolve({ status: 'error' }),
  }));
  const client = new ByokRelayClient({ relayUrl: 'https://relay.test', storage: createAsyncStorage(null) });
  let threw = false;
  try {
    await client.health();
  } catch (e) {
    threw = e.message.includes('503');
  }
  assert(threw, 'health() should reject non-OK responses');
});

await test('useRelayHealth() defers fetch resolution and keeps mount options fixed', async () => {
  const originalFetch = global.fetch;
  try {
    delete global.fetch;
    await withMockReact(async ({ render }) => {
      assert(render(useRelayHealth, {}), 'render should not resolve fetch or throw');
    }, { runEffects: false });
  } finally {
    global.fetch = originalFetch;
  }

  let firstUrl = null;
  let secondCalled = false;
  const firstFetch = (url) => {
    firstUrl = url;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });
  };
  const secondFetch = () => {
    secondCalled = true;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });
  };

  await withMockReact(async ({ render }) => {
    render(useRelayHealth, { relayUrl: 'https://relay-one.test', intervalMs: 0, fetch: firstFetch });
    const hook = render(useRelayHealth, { relayUrl: 'https://relay-two.test', intervalMs: 10, fetch: secondFetch });
    await hook.check(true, 'openai');
    assertEqual(firstUrl, 'https://relay-one.test/health?deep=1&provider=openai');
    assertEqual(secondCalled, false, 'updated fetch option should not replace mount fetch');
  }, { runEffects: false });
});

await test('stats() requests /stats with Relay-Token', async () => {
  clearMocks();
  const storage = createAsyncStorage(null);
  await storage.setItem(tokenKey(), 'tok');
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
  await storage.setItem(tokenKey(), 'tok');
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
  assertEqual(await storage.getItem(tokenKey()), null);
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
  assertEqual(secureStore[tokenKey()], 'secure-tok');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

})();

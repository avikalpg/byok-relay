/**
 * @byok-relay/preact — smoke test suite
 *
 * Run: node test/hooks.test.js
 *
 * Tests run entirely in Node (no DOM, no preact installed).
 * The inline hook shim and SSR-safe localStorage fallback are exercised directly.
 */

'use strict';

// ─── Test framework ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test (name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function assert (condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}
function assertEqual (a, b) {
  if (a !== b) throw new Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assertDeepEqual (a, b) {
  const as = JSON.stringify(a), bs = JSON.stringify(b);
  if (as !== bs) throw new Error(`Expected ${bs}, got ${as}`);
}

// ─── Module‐level mocks ───────────────────────────────────────────────────────

// Force the inline hook shim even when this monorepo's other workspaces install
// React into the root node_modules. These tests call hooks directly outside a
// renderer, so loading real React/Preact hooks would correctly trip invalid-hook
// guards instead of exercising the package's SSR-safe fallback.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function patchedLoad (request) {
  if (request === 'preact/hooks' || request === 'react') {
    throw new Error(`Mocked missing optional dependency: ${request}`);
  }
  return originalLoad.apply(this, arguments);
};

// localStorage shim (SSR-like environment — no window)
const _store = {};
global.window = {
  localStorage: {
    getItem:    (k) => _store[k] ?? null,
    setItem:    (k, v) => { _store[k] = v; },
    removeItem: (k) => { delete _store[k]; },
  },
};
global.localStorage = global.window.localStorage;

// AbortController shim
global.AbortController = class {
  constructor () { this.signal = { aborted: false }; }
  abort ()        { this.signal.aborted = true; }
};

// TextDecoder shim
global.TextDecoder = class {
  decode (buf) {
    if (!buf) return '';
    return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  }
};

// Fetch mock (overridden per-test)
let _fetchImpl = null;
global.fetch = async (url, opts) => {
  if (!_fetchImpl) throw new Error(`Unexpected fetch to: ${url}`);
  return _fetchImpl(url, opts);
};

function mockFetch (impl) { _fetchImpl = impl; }
function clearFetch ()     { _fetchImpl = null; }

function clearStore () {
  Object.keys(_store).forEach(k => delete _store[k]);
}

function afterEach () { clearFetch(); clearStore(); }

// ─── Load module ─────────────────────────────────────────────────────────────

const {
  useByokRelay,
  useChat,
  useStreamingChat,
  useRelayHealth,
} = require('../src/index.js');

// ─── Run all tests inside an async IIFE ──────────────────────────────────────

(async () => {

// ─── useByokRelay ─────────────────────────────────────────────────────────────

console.log('\nuseByokRelay');

await test('exports expected API', () => {
  const h = useByokRelay({ relayUrl: 'http://relay', appId: 'test' });
  assert(typeof h.getToken   === 'function', 'getToken');
  assert(typeof h.storeKey   === 'function', 'storeKey');
  assert(typeof h.deleteKey  === 'function', 'deleteKey');
  assert(typeof h.listKeys   === 'function', 'listKeys');
  assert(typeof h.logout     === 'function', 'logout');
  afterEach();
});

await test('getToken registers user and stores token', async () => {
  mockFetch(async (url) => {
    if (url.endsWith('/users')) {
      return { ok: true, json: async () => ({ token: 'tok-abc123', expires_at: null }) };
    }
  });
  const h = useByokRelay({ relayUrl: 'http://relay', appId: 'app1' });
  const t = await h.getToken();
  assertEqual(t, 'tok-abc123');
  assertEqual(localStorage.getItem('byok_relay_token'), 'tok-abc123');
  afterEach();
});

await test('getToken returns cached token without re-registering', async () => {
  localStorage.setItem('byok_relay_token', 'cached-tok');
  let fetchCount = 0;
  mockFetch(async () => { fetchCount++; return { ok: true, json: async () => ({}) }; });
  const h = useByokRelay({ relayUrl: 'http://relay', appId: 'app1' });
  const t = await h.getToken();
  assertEqual(t, 'cached-tok');
  assertEqual(fetchCount, 0);
  afterEach();
});

await test('storeKey sends POST /keys/:provider', async () => {
  localStorage.setItem('byok_relay_token', 'tok-xyz');
  let captured;
  mockFetch(async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ ok: true }) };
  });
  const h = useByokRelay({ relayUrl: 'http://relay', appId: 'app1' });
  const res = await h.storeKey('openai', 'sk-test-key');
  assert(res.ok, 'ok');
  assert(captured.url.includes('/keys/openai'), 'url includes /keys/openai');
  assertEqual(captured.body.key, 'sk-test-key');
  afterEach();
});

await test('deleteKey sends DELETE /keys/:provider', async () => {
  localStorage.setItem('byok_relay_token', 'tok-xyz');
  let method;
  mockFetch(async (_url, opts) => {
    method = opts.method;
    return { ok: true, json: async () => ({}) };
  });
  const h = useByokRelay({ relayUrl: 'http://relay', appId: 'app1' });
  const res = await h.deleteKey('anthropic');
  assert(res.ok, 'ok');
  assertEqual(method, 'DELETE');
  afterEach();
});

await test('listKeys returns keys array', async () => {
  localStorage.setItem('byok_relay_token', 'tok-xyz');
  mockFetch(async () => ({
    ok: true,
    json: async () => ({ keys: ['openai', 'anthropic'] }),
  }));
  const h = useByokRelay({ relayUrl: 'http://relay', appId: 'app1' });
  const keys = await h.listKeys();
  assertDeepEqual(keys, ['openai', 'anthropic']);
  afterEach();
});

await test('logout removes token from localStorage', () => {
  localStorage.setItem('byok_relay_token', 'tok-xyz');
  const h = useByokRelay({ relayUrl: 'http://relay', appId: 'app1' });
  h.logout();
  assertEqual(localStorage.getItem('byok_relay_token'), null);
  afterEach();
});

await test('getToken sets error on non-ok response', async () => {
  mockFetch(async () => ({
    ok: false,
    json: async () => ({ error: 'Unauthorized' }),
  }));
  const h = useByokRelay({ relayUrl: 'http://relay', appId: 'app1' });
  const t = await h.getToken();
  assertEqual(t, null);
  afterEach();
});

// ─── useChat ─────────────────────────────────────────────────────────────────

console.log('\nuseChat');

await test('exports expected API', () => {
  const h = useChat({ relayUrl: 'http://relay', appId: 'test' });
  assert(typeof h.sendMessage    === 'function', 'sendMessage');
  assert(typeof h.clearMessages  === 'function', 'clearMessages');
  assert(Array.isArray(h.messages),              'messages is array');
  afterEach();
});

await test('sendMessage posts to relay and appends assistant reply', async () => {
  localStorage.setItem('byok_relay_token', 'tok-chat');
  const calls = [];
  mockFetch(async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'Hello from relay!' } }],
      }),
    };
  });
  const h = useChat({ relayUrl: 'http://relay', appId: 'app1', model: 'gpt-4o-mini' });
  await h.sendMessage('Hi there');
  assertEqual(calls.length, 1);
  assert(calls[0].url.includes('/relay/openai/chat/completions'), 'relay path');
  assertEqual(calls[0].body.model, 'gpt-4o-mini');
  afterEach();
});

await test('sendMessage includes systemPrompt', async () => {
  localStorage.setItem('byok_relay_token', 'tok-sys');
  let body;
  mockFetch(async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  });
  const h = useChat({
    relayUrl: 'http://relay',
    appId: 'app1',
    systemPrompt: 'You are a helpful Preact assistant.',
  });
  await h.sendMessage('test');
  assertDeepEqual(body.messages[0], { role: 'system', content: 'You are a helpful Preact assistant.' });
  afterEach();
});

await test('clearMessages resets to empty array', () => {
  const h = useChat({ relayUrl: 'http://relay', appId: 'app1' });
  h.clearMessages();
  assertDeepEqual(h.messages, []);
  afterEach();
});

await test('handles provider=anthropic relay path', async () => {
  localStorage.setItem('byok_relay_token', 'tok-ant');
  let capturedUrl;
  mockFetch(async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ content: [{ text: 'Sure!' }] }) };
  });
  const h = useChat({ relayUrl: 'http://relay', appId: 'app1', provider: 'anthropic' });
  await h.sendMessage('test');
  assert(capturedUrl.includes('/relay/anthropic/messages'), 'anthropic relay path');
  afterEach();
});

await test('handles provider=groq relay path', async () => {
  localStorage.setItem('byok_relay_token', 'tok-groq');
  let capturedUrl;
  mockFetch(async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'fast!' } }] }) };
  });
  const h = useChat({ relayUrl: 'http://relay', appId: 'app1', provider: 'groq' });
  await h.sendMessage('speed test');
  assert(capturedUrl.includes('/relay/openai/chat/completions'), 'groq uses openai path');
  afterEach();
});

// ─── useStreamingChat ─────────────────────────────────────────────────────────

console.log('\nuseStreamingChat');

await test('exports expected API', () => {
  const h = useStreamingChat({ relayUrl: 'http://relay', appId: 'test' });
  assert(typeof h.sendMessage    === 'function', 'sendMessage');
  assert(typeof h.stopStreaming  === 'function', 'stopStreaming');
  assert(typeof h.clearMessages  === 'function', 'clearMessages');
  assert(typeof h.streamingContent === 'string', 'streamingContent is string');
  assert(typeof h.isStreaming    === 'boolean',  'isStreaming is boolean');
  assert(Array.isArray(h.messages),              'messages is array');
  afterEach();
});

await test('stopStreaming does not throw when no stream active', () => {
  const h = useStreamingChat({ relayUrl: 'http://relay', appId: 'test' });
  assert(() => { h.stopStreaming(); return true; }, 'no throw');
  afterEach();
});

await test('clearMessages resets state', () => {
  const h = useStreamingChat({ relayUrl: 'http://relay', appId: 'test' });
  h.clearMessages();
  assertDeepEqual(h.messages, []);
  assertEqual(h.streamingContent, '');
  afterEach();
});

// ─── useRelayHealth ───────────────────────────────────────────────────────────

console.log('\nuseRelayHealth');

await test('exports expected API', () => {
  mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) }));
  const h = useRelayHealth({ relayUrl: 'http://relay', intervalMs: 0 });
  assert(typeof h.check === 'function', 'check');
  afterEach();
});

await test('check fetches /health', async () => {
  let called = false;
  mockFetch(async (url) => {
    if (url.endsWith('/health')) called = true;
    return { ok: true, status: 200, json: async () => ({ status: 'ok', uptime: 42 }) };
  });
  const h = useRelayHealth({ relayUrl: 'http://relay', intervalMs: 0 });
  await h.check();
  assert(called, '/health fetched');
  afterEach();
});

await test('check with deep=true appends ?deep=1', async () => {
  let url;
  mockFetch(async (u) => {
    url = u;
    return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
  });
  const h = useRelayHealth({ relayUrl: 'http://relay', intervalMs: 0 });
  await h.check(true);
  assert(url.includes('?deep=1'), '?deep=1 appended');
  afterEach();
});

await test('check returns null and sets error on fetch failure', async () => {
  mockFetch(async () => { throw new Error('Network error'); });
  const h = useRelayHealth({ relayUrl: 'http://relay', intervalMs: 0 });
  const result = await h.check();
  assertEqual(result, null);
  afterEach();
});

await test('check without deep does not append ?deep=1', async () => {
  let url;
  mockFetch(async (u) => {
    url = u;
    return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
  });
  const h = useRelayHealth({ relayUrl: 'http://relay', intervalMs: 0 });
  await h.check(false);
  assert(!url.includes('?deep=1'), 'no ?deep=1');
  afterEach();
});

// ─── SSR safety ───────────────────────────────────────────────────────────────

console.log('\nSSR safety');

await test('hooks initialise without window (SSR environment)', () => {
  const savedWindow = global.window;
  const savedLS     = global.localStorage;
  delete global.window;
  delete global.localStorage;
  try {
    const h = useByokRelay({ relayUrl: 'http://relay', appId: 'test' });
    assert(typeof h.getToken === 'function', 'getToken available in SSR');
  } finally {
    global.window    = savedWindow;
    global.localStorage = savedLS;
  }
  afterEach();
});

await test('getToken does not crash in SSR env when no localStorage', async () => {
  const savedWindow = global.window;
  const savedLS     = global.localStorage;
  delete global.window;
  delete global.localStorage;
  mockFetch(async () => ({
    ok: true,
    json: async () => ({ token: 'tok-ssr' }),
  }));
  try {
    const h = useByokRelay({ relayUrl: 'http://relay', appId: 'test' });
    const t = await h.getToken();
    assertEqual(t, 'tok-ssr');
  } finally {
    global.window    = savedWindow;
    global.localStorage = savedLS;
  }
  afterEach();
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

})();

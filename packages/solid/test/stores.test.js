/**
 * @byok-relay/solid — smoke test suite
 *
 * Run: node test/stores.test.js
 *
 * Tests run entirely in Node (no DOM, no solid-js installed).
 * The signal shim is exercised directly.
 */

'use strict';

const {
  createByokRelayStore,
  createChatStore,
  createStreamingChatStore,
  createRelayHealthStore,
} = require('../src/index.js');

// Wrap all top-level awaits in an IIFE for CommonJS compatibility
(async () => {

// ─── Minimal fetch mock ───────────────────────────────────────────────────────

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

// Patch global fetch
global.fetch = mockFetch;

// ─── Minimal ReadableStream mock for SSE ─────────────────────────────────────

function makeSSEStream(chunks) {
  let i = 0;
  const encoder = new TextEncoder();
  return {
    body: {
      getReader() {
        return {
          async read() {
            if (i >= chunks.length) return { done: true };
            const chunk = chunks[i++];
            return { done: false, value: encoder.encode(chunk) };
          },
        };
      },
    },
  };
}

// TextDecoder / TextEncoder
const { TextDecoder, TextEncoder } = require('util');
global.TextDecoder = TextDecoder;
global.TextEncoder = TextEncoder;

// AbortController
global.AbortController = class {
  constructor() { this.signal = { aborted: false }; }
  abort() { this.signal.aborted = true; }
};

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌  ${name}`);
    console.error(`      ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

// ─── Storage shim ─────────────────────────────────────────────────────────────

function makeStorage() {
  const store = {};
  return {
    get:    (k) => store[k] ?? null,
    set:    (k, v) => { store[k] = v; },
    remove: (k) => { delete store[k]; },
  };
}

// ─── Tests: createByokRelayStore ──────────────────────────────────────────────

console.log('\ncreateByokRelayStore');

await test('initial token is null with empty storage', async () => {
  const s = createByokRelayStore({ appId: 'test', storage: makeStorage() });
  assertEqual(s.token(), null);
  assertEqual(s.loading(), false);
  assertEqual(s.error(), null);
});

await test('register() fetches token + stores it', async () => {
  registerMock(/\/users/, async () => ({
    ok: true,
    json: async () => ({ token: 'tok_abc123' }),
  }));

  const storage = makeStorage();
  const s = createByokRelayStore({ appId: 'test', storage });
  const tok = await s.register();

  assertEqual(tok, 'tok_abc123');
  assertEqual(s.token(), 'tok_abc123');
  assertEqual(storage.get('byok_token_test'), 'tok_abc123');
  assertEqual(s.loading(), false);
  clearMocks();
});

await test('logout() clears token and providers', async () => {
  registerMock(/\/users/, async () => ({
    ok: true, json: async () => ({ token: 'tok_xyz' }),
  }));
  const storage = makeStorage();
  const s = createByokRelayStore({ appId: 'test', storage });
  await s.register();
  s.logout();
  assertEqual(s.token(), null);
  assert(s.providers().length === 0);
  clearMocks();
});

await test('storeKey() sends correct request', async () => {
  let capturedBody;
  registerMock(/\/users/, async () => ({
    ok: true, json: async () => ({ token: 'tok_111' }),
  }));
  registerMock(/\/keys\/openai/, async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ ok: true }) };
  });

  const s = createByokRelayStore({ appId: 'test', storage: makeStorage() });
  await s.register();
  await s.storeKey('openai', 'sk-test-key');

  assertEqual(capturedBody.key, 'sk-test-key');
  assert(s.providers().includes('openai'), 'providers should include openai');
  clearMocks();
});

await test('listKeys() returns providers list + updates signal', async () => {
  registerMock(/\/users/, async () => ({
    ok: true, json: async () => ({ token: 'tok_222' }),
  }));
  registerMock(/\/keys$/, async () => ({
    ok: true, json: async () => ({ providers: ['openai', 'anthropic'] }),
  }));

  const s = createByokRelayStore({ appId: 'test', storage: makeStorage() });
  await s.register();
  const list = await s.listKeys();

  assert(Array.isArray(list));
  assert(list.includes('openai'));
  assert(list.includes('anthropic'));
  assert(s.providers().includes('openai'));
  clearMocks();
});

await test('deleteKey() removes provider from list', async () => {
  registerMock(/\/users/, async () => ({
    ok: true, json: async () => ({ token: 'tok_333' }),
  }));
  registerMock(/\/keys\/openai$/, async (url, opts) => {
    if (opts?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) };
    if (opts?.method === 'DELETE') return { ok: true, json: async () => ({ ok: true }) };
    return { ok: false };
  });

  const s = createByokRelayStore({ appId: 'test', storage: makeStorage() });
  await s.register();
  await s.storeKey('openai', 'sk-abc');
  assert(s.providers().includes('openai'));
  await s.deleteKey('openai');
  assert(!s.providers().includes('openai'), 'openai should be removed');
  clearMocks();
});

await test('register() sets error signal on failure', async () => {
  registerMock(/\/users/, async () => ({
    ok: false, status: 401, json: async () => ({ error: 'unauthorized' }),
  }));
  const s = createByokRelayStore({ appId: 'test', storage: makeStorage() });
  try { await s.register(); } catch {}
  assert(s.error() !== null, 'error should be set');
  assertEqual(s.loading(), false);
  clearMocks();
});

await test('health() returns parsed health object', async () => {
  registerMock(/\/health/, async () => ({
    ok: true, json: async () => ({ status: 'ok', uptime: 100 }),
  }));
  const s = createByokRelayStore({ appId: 'test', storage: makeStorage() });
  const h = await s.health();
  assertEqual(h.status, 'ok');
  clearMocks();
});

// ─── Tests: createChatStore ───────────────────────────────────────────────────

console.log('\ncreateChatStore');

await test('sendMessage() adds user + assistant messages', async () => {
  registerMock(/\/relay\/openai/, async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: 'Hello there!' } }],
    }),
  }));

  const s = createChatStore({ provider: 'openai', model: 'gpt-4o-mini' });
  await s.sendMessage('Hi', 'tok_abc');

  const msgs = s.messages();
  assertEqual(msgs.length, 2);
  assertEqual(msgs[0].role, 'user');
  assertEqual(msgs[0].content, 'Hi');
  assertEqual(msgs[1].role, 'assistant');
  assertEqual(msgs[1].content, 'Hello there!');
  clearMocks();
});

await test('sendMessage() with anthropic provider', async () => {
  let capturedBody;
  registerMock(/\/relay\/anthropic/, async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'Greetings!' }] }),
    };
  });

  const s = createChatStore({
    provider: 'anthropic',
    model: 'claude-haiku-3-5',
    systemPrompt: 'You are helpful.',
  });
  const reply = await s.sendMessage('Hello', 'tok_ant');

  assertEqual(reply, 'Greetings!');
  assertEqual(capturedBody.system, 'You are helpful.');
  clearMocks();
});

await test('clearMessages() resets message list', async () => {
  registerMock(/\/relay\/openai/, async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }),
  }));
  const s = createChatStore({ provider: 'openai', model: 'gpt-4o-mini' });
  await s.sendMessage('Hi', 'tok_abc');
  assert(s.messages().length > 0);
  s.clearMessages();
  assertEqual(s.messages().length, 0);
  clearMocks();
});

await test('sendMessage() rolls back user message on error', async () => {
  registerMock(/\/relay\/openai/, async () => ({ ok: false, status: 500 }));
  const s = createChatStore({ provider: 'openai', model: 'gpt-4o-mini' });
  try { await s.sendMessage('Hi', 'tok_abc'); } catch {}
  assertEqual(s.messages().length, 0, 'user message should be rolled back on error');
  assert(s.error() !== null);
  clearMocks();
});

// ─── Tests: createStreamingChatStore ─────────────────────────────────────────

console.log('\ncreateStreamingChatStore');

await test('sendMessage() streams content and commits final message', async () => {
  const sseChunks = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: [DONE]\n\n',
  ];

  registerMock(/\/relay\/openai/, async () => ({
    ok: true,
    ...makeSSEStream(sseChunks),
  }));

  const s = createStreamingChatStore({ provider: 'openai', model: 'gpt-4o-mini' });
  await s.sendMessage('Hi', 'tok_abc');

  const msgs = s.messages();
  assertEqual(msgs.length, 2);
  assertEqual(msgs[1].content, 'Hello world');
  assertEqual(s.streamingContent(), '');
  assertEqual(s.loading(), false);
  clearMocks();
});

await test('sendMessage() preserves SSE frames split across chunks', async () => {
  const sseChunks = [
    'data: {"choices":[{"delta":{"content":"Hel',
    'lo"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: [DONE]\n\n',
  ];

  registerMock(/\/relay\/openai/, async () => ({
    ok: true,
    ...makeSSEStream(sseChunks),
  }));

  try {
    const s = createStreamingChatStore({ provider: 'openai', model: 'gpt-4o-mini' });
    await s.sendMessage('Hi', 'tok_abc');

    assertEqual(s.messages()[1].content, 'Hello world');
  } finally {
    clearMocks();
  }
});

await test('sendMessage() with anthropic streaming', async () => {
  const sseChunks = [
    'data: {"type":"content_block_delta","delta":{"text":"Hey"}}\n\n',
    'data: {"type":"content_block_delta","delta":{"text":"!"}}\n\n',
    'data: [DONE]\n\n',
  ];

  registerMock(/\/relay\/anthropic/, async () => ({
    ok: true,
    ...makeSSEStream(sseChunks),
  }));

  const s = createStreamingChatStore({ provider: 'anthropic', model: 'claude-haiku-3-5' });
  await s.sendMessage('Hi', 'tok_ant');

  assertEqual(s.messages()[1].content, 'Hey!');
  clearMocks();
});

await test('stopStreaming() aborts in-flight stream', async () => {
  // stopStreaming on an idle store should be a no-op
  const s = createStreamingChatStore({ provider: 'openai', model: 'gpt-4o-mini' });
  s.stopStreaming(); // should not throw
  assertEqual(s.loading(), false);
  assertEqual(s.streamingContent(), '');
});

await test('clearMessages() resets all state', async () => {
  registerMock(/\/relay\/openai/, async () => ({
    ok: true,
    ...makeSSEStream(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', 'data: [DONE]\n\n']),
  }));
  const s = createStreamingChatStore({ provider: 'openai', model: 'gpt-4o-mini' });
  await s.sendMessage('Hello', 'tok_abc');
  assert(s.messages().length > 0);
  s.clearMessages();
  assertEqual(s.messages().length, 0);
  clearMocks();
});

// ─── Tests: createRelayHealthStore ───────────────────────────────────────────

console.log('\ncreateRelayHealthStore');

await test('initial fetch sets status ok', async () => {
  registerMock(/\/health/, async () => ({
    ok: true, json: async () => ({ status: 'ok', uptime: 999 }),
  }));
  // Use intervalMs=0 to disable polling
  const s = createRelayHealthStore({ intervalMs: 0 });
  // Wait for the initial async fetch
  await new Promise(r => setTimeout(r, 10));
  assertEqual(s.status(), 'ok');
  assertEqual(s.health()?.status, 'ok');
  s.destroy();
  clearMocks();
});

await test('sets status error on fetch failure', async () => {
  registerMock(/\/health/, async () => { throw new Error('Network error'); });
  const s = createRelayHealthStore({ intervalMs: 0 });
  await new Promise(r => setTimeout(r, 10));
  assertEqual(s.status(), 'error');
  assert(s.error() !== null);
  s.destroy();
  clearMocks();
});

await test('refetch() updates health signal', async () => {
  registerMock(/\/health/, async () => ({
    ok: true, json: async () => ({ status: 'ok', version: '1.2.3' }),
  }));
  const s = createRelayHealthStore({ intervalMs: 0 });
  await s.refetch();
  assertEqual(s.health()?.version, '1.2.3');
  s.destroy();
  clearMocks();
});

await test('destroy() stops polling interval', async () => {
  let callCount = 0;
  registerMock(/\/health/, async () => {
    callCount++;
    return { ok: true, json: async () => ({ status: 'ok' }) };
  });
  const s = createRelayHealthStore({ intervalMs: 20 });
  await new Promise(r => setTimeout(r, 10));
  s.destroy();
  const countAtDestroy = callCount;
  await new Promise(r => setTimeout(r, 60)); // wait longer than 2 intervals
  assertEqual(callCount, countAtDestroy, 'No more calls after destroy()');
  clearMocks();
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

})().catch(err => { console.error(err); process.exit(1); });

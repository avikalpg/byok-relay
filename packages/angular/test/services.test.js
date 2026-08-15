/**
 * @byok-relay/angular — smoke test suite
 *
 * Run: node test/services.test.js
 *
 * Tests run entirely in Node (no DOM, no @angular/core installed).
 * The signal shim and in-memory storage fallback are exercised directly.
 */

'use strict';

const {
  ByokRelayService,
  ChatService,
  StreamingChatService,
  RelayHealthService,
  createByokRelayBundle,
} = require('../src/index.js');

// ─── Test framework ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
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

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(a, b, label) {
  if (a !== b) throw new Error(`${label ?? 'assert equal'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// Wrap all top-level awaits in an IIFE for CommonJS compatibility
(async () => {

// ─── Fetch mock ───────────────────────────────────────────────────────────────

let _handlers = [];

function mockFetch(url, opts = {}) {
  for (const { pattern, handler } of _handlers) {
    if (pattern.test(url)) return handler(url, opts);
  }
  return Promise.reject(new Error(`Unmocked fetch: ${url}`));
}

function registerMock(pattern, handler) {
  _handlers.unshift({ pattern, handler });
}

function clearMocks() { _handlers = []; }

global.fetch = mockFetch;

// ─── In-memory storage helper ─────────────────────────────────────────────────

function makeStorage() {
  const store = new Map();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
}

// ─── SSE stream helper ────────────────────────────────────────────────────────

function makeSseStream(chunks) {
  let i = 0;
  const encoder = new TextEncoder();
  return {
    body: {
      getReader() {
        return {
          async read() {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(chunks[i++]) };
          },
        };
      },
    },
  };
}

// ─── ByokRelayService tests ───────────────────────────────────────────────────

console.log('\n── ByokRelayService ──');

await test('instantiates with default relayUrl', () => {
  const relay = new ByokRelayService({ storage: makeStorage() });
  assert(relay._relayUrl === 'https://relay.byokrelay.com', 'default URL');
});

await test('instantiates with custom relayUrl (trailing slash stripped)', () => {
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000/', storage: makeStorage() });
  assertEqual(relay._relayUrl, 'http://localhost:3000', 'trailing slash stripped');
});

await test('token() returns null before registration', () => {
  const relay = new ByokRelayService({ storage: makeStorage() });
  assertEqual(relay.token(), null, 'token signal is null initially');
});

await test('register() posts to /users and persists token', async () => {
  clearMocks();
  registerMock(/\/users$/, () =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ token: 'tok-abc123' }) }),
  );
  const storage = makeStorage();
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage });
  const data = await relay.register('test-app');
  assertEqual(data.token, 'tok-abc123', 'token in response');
  assertEqual(relay.token(), 'tok-abc123', 'token signal updated');
  assertEqual(storage.getItem('byok_relay_token'), 'tok-abc123', 'token persisted');
});

await test('getOrRegister() returns stored token without re-registering', async () => {
  clearMocks();
  const storage = makeStorage();
  storage.setItem('byok_relay_token', 'existing-tok');
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage });
  const data = await relay.getOrRegister('test-app');
  assertEqual(data.token, 'existing-tok', 'returned existing token');
});

await test('register() throws on non-OK response', async () => {
  clearMocks();
  registerMock(/\/users$/, () =>
    Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve('Forbidden') }),
  );
  const relay = new ByokRelayService({ storage: makeStorage() });
  let threw = false;
  try { await relay.register('test-app'); } catch { threw = true; }
  assert(threw, 'should throw on 403');
  assert(relay.error() !== null, 'error signal should be set');
});

await test('storeKey() sends POST /keys/:provider', async () => {
  clearMocks();
  let capturedHeaders = null;
  registerMock(/\/keys\/openai$/, (url, opts) => {
    capturedHeaders = opts.headers;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  });
  const storage = makeStorage();
  storage.setItem('byok_relay_token', 'tok-123');
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage });
  await relay.storeKey('openai', 'sk-test');
  assertEqual(capturedHeaders['x-relay-token'], 'tok-123', 'relay token sent');
});

await test('storeKey() throws when not registered', async () => {
  const relay = new ByokRelayService({ storage: makeStorage() });
  let threw = false;
  try { await relay.storeKey('openai', 'sk-x'); } catch { threw = true; }
  assert(threw, 'should throw when not registered');
});

await test('listKeys() returns provider list', async () => {
  clearMocks();
  registerMock(/\/keys$/, () =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ keys: ['openai', 'anthropic'] }) }),
  );
  const storage = makeStorage();
  storage.setItem('byok_relay_token', 'tok-abc');
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage });
  const data = await relay.listKeys();
  assert(data.keys.includes('openai'), 'includes openai');
});

await test('deleteKey() sends DELETE /keys/:provider', async () => {
  clearMocks();
  let method = null;
  registerMock(/\/keys\/anthropic$/, (url, opts) => {
    method = opts.method;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  });
  const storage = makeStorage();
  storage.setItem('byok_relay_token', 'tok-abc');
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage });
  await relay.deleteKey('anthropic');
  assertEqual(method, 'DELETE', 'DELETE method used');
});

await test('rotateKey() sends POST /keys/:provider/rotate', async () => {
  clearMocks();
  registerMock(/\/keys\/openai\/rotate$/, () =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, rotated: true }) }),
  );
  const storage = makeStorage();
  storage.setItem('byok_relay_token', 'tok-abc');
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage });
  const data = await relay.rotateKey('openai', 'sk-new');
  assert(data.rotated === true, 'rotated flag set');
});

await test('logout() clears token from storage and signal', () => {
  const storage = makeStorage();
  storage.setItem('byok_relay_token', 'tok-abc');
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage });
  relay._token.set('tok-abc');
  relay.logout();
  assertEqual(storage.getItem('byok_relay_token'), null, 'token removed from storage');
  assertEqual(relay.token(), null, 'token signal cleared');
});

// ─── ChatService tests ────────────────────────────────────────────────────────

console.log('\n── ChatService ──');

await test('instantiates and starts with empty messages', () => {
  const relay = new ByokRelayService({ storage: makeStorage() });
  const chat = new ChatService(relay);
  assert(Array.isArray(chat.messages()), 'messages is array');
  assertEqual(chat.messages().length, 0, 'starts empty');
});

await test('throws without relayService', () => {
  let threw = false;
  try { new ChatService(null); } catch { threw = true; }
  assert(threw, 'should throw without relayService');
});

await test('sendMessage() appends user + assistant messages', async () => {
  clearMocks();
  registerMock(/\/relay\/openai\//, () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: 'Hello from OpenAI!' } }] }),
    }),
  );
  const storage = makeStorage();
  storage.setItem('byok_relay_token', 'tok-123');
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage });
  const chat = new ChatService(relay);
  const reply = await chat.sendMessage('Hi there');
  assertEqual(reply, 'Hello from OpenAI!', 'reply returned');
  assertEqual(chat.messages().length, 2, '2 messages in history');
  assertEqual(chat.messages()[0].role, 'user', 'first message is user');
  assertEqual(chat.messages()[1].role, 'assistant', 'second message is assistant');
});

await test('sendMessage() rejects empty content before mutating history', async () => {
  const relay = new ByokRelayService({ storage: makeStorage() });
  const chat = new ChatService(relay);
  let error = null;
  try { await chat.sendMessage('   '); } catch (err) { error = err; }
  assert(error, 'should throw for empty content');
  assertEqual(error.message, 'Message content is required', 'clear validation error');
  assertEqual(chat.messages().length, 0, 'history remains empty');
});

await test('sendMessage() builds Anthropic Messages payload shape', async () => {
  clearMocks();
  let capturedBody = null;
  registerMock(/\/relay\/anthropic\/messages$/, (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ content: [{ text: 'Hello from Claude!' }] }),
    });
  });
  const storage = makeStorage();
  storage.setItem('byok_relay_token', 'tok-123');
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage });
  const chat = new ChatService(relay);
  const reply = await chat.sendMessage('  Hi Claude  ', {
    provider: 'anthropic',
    model: 'claude-test',
    systemPrompt: 'Be brief.',
  });
  assertEqual(reply, 'Hello from Claude!', 'anthropic reply returned');
  assertEqual(capturedBody.model, 'claude-test', 'model forwarded');
  assertEqual(capturedBody.max_tokens, 1024, 'default max_tokens set');
  assertEqual(capturedBody.system, 'Be brief.', 'system prompt is top-level');
  assert(!capturedBody.messages.some((m) => m.role === 'system'), 'no system role in Anthropic messages');
  assertEqual(capturedBody.messages[0].content, 'Hi Claude', 'content trimmed before send');
});

await test('sendMessage() rolls back user message on error', async () => {
  clearMocks();
  registerMock(/\/relay\//, () =>
    Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('Server error') }),
  );
  const storage = makeStorage();
  storage.setItem('byok_relay_token', 'tok-123');
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage });
  const chat = new ChatService(relay);
  let threw = false;
  try { await chat.sendMessage('Ping'); } catch { threw = true; }
  assert(threw, 'should throw on error');
  assertEqual(chat.messages().length, 0, 'message rolled back');
  assert(chat.error() !== null, 'error signal set');
});

await test('clearMessages() resets history', async () => {
  clearMocks();
  registerMock(/\/relay\//, () =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] }) }),
  );
  const storage = makeStorage();
  storage.setItem('byok_relay_token', 'tok-123');
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage });
  const chat = new ChatService(relay);
  await chat.sendMessage('Hello');
  chat.clearMessages();
  assertEqual(chat.messages().length, 0, 'messages cleared');
});

// ─── StreamingChatService tests ───────────────────────────────────────────────

console.log('\n── StreamingChatService ──');

await test('instantiates with empty state', () => {
  const relay = new ByokRelayService({ storage: makeStorage() });
  const streaming = new StreamingChatService(relay);
  assertEqual(streaming.messages().length, 0, 'empty messages');
  assertEqual(streaming.streamingContent(), '', 'empty streamingContent');
  assertEqual(streaming.streaming(), false, 'not streaming');
});

await test('throws without relayService', () => {
  let threw = false;
  try { new StreamingChatService(null); } catch { threw = true; }
  assert(threw, 'should throw');
});

await test('streamMessage() collects SSE chunks and commits to messages', async () => {
  clearMocks();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  registerMock(/\/relay\//, () => Promise.resolve({ ok: true, ...makeSseStream(chunks) }));

  const storage = makeStorage();
  storage.setItem('byok_relay_token', 'tok-123');
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage });
  const streaming = new StreamingChatService(relay);

  const collected = [];
  const result = await streaming.streamMessage('Hi', { onChunk: (delta) => collected.push(delta) });

  assertEqual(result, 'Hello world', 'full response returned');
  assert(collected.includes('Hello'), 'onChunk called with first delta');
  assert(collected.includes(' world'), 'onChunk called with second delta');
  assertEqual(streaming.messages().length, 2, 'user + assistant messages committed');
  assertEqual(streaming.streamingContent(), '', 'streamingContent cleared after done');
});

await test('streamMessage() rejects empty content before mutating history', async () => {
  const relay = new ByokRelayService({ storage: makeStorage() });
  const streaming = new StreamingChatService(relay);
  let error = null;
  try { await streaming.streamMessage('\t'); } catch (err) { error = err; }
  assert(error, 'should throw for empty content');
  assertEqual(error.message, 'Message content is required', 'clear validation error');
  assertEqual(streaming.messages().length, 0, 'history remains empty');
});

await test('streamMessage() builds Anthropic payload and parses Anthropic deltas', async () => {
  clearMocks();
  let capturedBody = null;
  const chunks = [
    'data: {"type":"content_block_delta","delta":{"text":"Hi"}}\n\n',
    'data: [DONE]\n\n',
  ];
  registerMock(/\/relay\/anthropic\/messages$/, (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return Promise.resolve({ ok: true, ...makeSseStream(chunks) });
  });
  const storage = makeStorage();
  storage.setItem('byok_relay_token', 'tok-123');
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage });
  const streaming = new StreamingChatService(relay);

  const result = await streaming.streamMessage('Hello', {
    provider: 'anthropic',
    model: 'claude-test',
    systemPrompt: 'Be concise.',
  });

  assertEqual(result, 'Hi', 'anthropic stream returned text');
  assertEqual(capturedBody.max_tokens, 1024, 'default max_tokens set');
  assertEqual(capturedBody.stream, true, 'stream flag set');
  assertEqual(capturedBody.system, 'Be concise.', 'system prompt is top-level');
  assert(!capturedBody.messages.some((m) => m.role === 'system'), 'no system role in Anthropic messages');
});

await test('streamMessage() stops reading after terminal DONE event', async () => {
  clearMocks();
  const encoder = new TextEncoder();
  let reads = 0;
  registerMock(/\/relay\//, () => Promise.resolve({
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            reads++;
            if (reads === 1) return { done: false, value: encoder.encode('data: [DONE]\n\n') };
            throw new Error('read called after DONE');
          },
        };
      },
    },
  }));

  const storage = makeStorage();
  storage.setItem('byok_relay_token', 'tok-123');
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage });
  const streaming = new StreamingChatService(relay);
  const result = await streaming.streamMessage('Hi');
  assertEqual(result, '', 'empty terminal stream returns empty content');
  assertEqual(reads, 1, 'reader not called after DONE');
});

await test('stopStreaming() partial-commits accumulated content', async () => {
  clearMocks();
  let resolveRead;
  const pendingRead = new Promise((res) => { resolveRead = res; });

  // Simulate a stream that delivers one chunk then hangs until aborted
  let readCount = 0;
  const encoder = new TextEncoder();
  registerMock(/\/relay\//, (url, opts) => Promise.resolve({
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (readCount === 0) {
              readCount++;
              return { done: false, value: encoder.encode('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n') };
            }
            // Hang until aborted or resolved
            await pendingRead;
            // Simulate AbortError when signal is aborted
            if (opts && opts.signal && opts.signal.aborted) {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              throw err;
            }
            return { done: true, value: undefined };
          },
        };
      },
    },
  }));

  const storage = makeStorage();
  storage.setItem('byok_relay_token', 'tok-123');
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage });
  const streaming = new StreamingChatService(relay);

  const streamPromise = streaming.streamMessage('Test');
  // Give one tick for the first chunk to arrive, then abort
  await new Promise((r) => setTimeout(r, 10));
  streaming.stopStreaming();
  resolveRead(); // unblock the hanging read so it can check abort signal

  await streamPromise; // should resolve (not reject) on abort

  const msgs = streaming.messages();
  assert(msgs.length === 2, 'user + partial assistant message committed');
  assert(msgs[1].content.includes('Partial'), 'partial content committed');
  assert(msgs[1].content.includes('[stopped]'), '[stopped] appended');
});

// ─── RelayHealthService tests ─────────────────────────────────────────────────

console.log('\n── RelayHealthService ──');

await test('instantiates with null status', () => {
  const relay = new ByokRelayService({ storage: makeStorage() });
  const health = new RelayHealthService(relay);
  assertEqual(health.status(), null, 'status starts null');
  assertEqual(health.isHealthy, false, 'isHealthy is false initially');
});

await test('throws without relayService', () => {
  let threw = false;
  try { new RelayHealthService(null); } catch { threw = true; }
  assert(threw, 'should throw');
});

await test('check() fetches /health and updates status signal', async () => {
  clearMocks();
  registerMock(/\/health$/, () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', uptime: 3600 }),
    }),
  );
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage: makeStorage() });
  const health = new RelayHealthService(relay);
  const data = await health.check();
  assertEqual(data.status, 'ok', 'status ok');
  assert(health.isHealthy === true, 'isHealthy is true');
  assertEqual(health.error(), null, 'no error');
});

await test('check(deep=true) fetches /health?deep=1', async () => {
  clearMocks();
  let capturedUrl = null;
  registerMock(/\/health/, (url) => {
    capturedUrl = url;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', checks: { upstream: { ok: true } } }),
    });
  });
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage: makeStorage() });
  const health = new RelayHealthService(relay);
  await health.check(true);
  assert(capturedUrl.includes('deep=1'), 'deep=1 param included');
});

await test('check() sets error signal on failure', async () => {
  clearMocks();
  registerMock(/\/health/, () => Promise.reject(new Error('Network error')));
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage: makeStorage() });
  const health = new RelayHealthService(relay);
  let threw = false;
  try { await health.check(); } catch { threw = true; }
  assert(threw, 'should throw on network error');
  assert(health.error() !== null, 'error signal set');
  assertEqual(health.status(), null, 'status remains null');
});

await test('check() preserves previous health status on transient failure', async () => {
  clearMocks();
  registerMock(/\/health$/, () =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', uptime: 1 }) }),
  );
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage: makeStorage() });
  const health = new RelayHealthService(relay);
  await health.check();
  clearMocks();
  registerMock(/\/health$/, () => Promise.reject(new Error('Network error')));
  let threw = false;
  try { await health.check(); } catch { threw = true; }
  assert(threw, 'should throw on transient failure');
  assertEqual(health.status().status, 'ok', 'last known-good status preserved');
  assert(health.error() !== null, 'error signal set');
});

await test('startPolling() / destroy() lifecycle', async () => {
  clearMocks();
  let checkCount = 0;
  registerMock(/\/health/, () => {
    checkCount++;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });
  });
  const relay = new ByokRelayService({ relayUrl: 'http://localhost:3000', storage: makeStorage() });
  const health = new RelayHealthService(relay, 50); // 50ms interval
  health.startPolling(50);
  await new Promise((r) => setTimeout(r, 120)); // wait for 2+ polls
  health.destroy();
  const countAfterStop = checkCount;
  await new Promise((r) => setTimeout(r, 80)); // confirm no more polls fire
  assert(checkCount === countAfterStop, 'no more polls after destroy()');
  assert(checkCount >= 2, 'at least 2 polls ran');
});

// ─── createByokRelayBundle tests ──────────────────────────────────────────────

console.log('\n── createByokRelayBundle ──');

await test('returns all four services pre-wired', () => {
  const bundle = createByokRelayBundle({ relayUrl: 'http://localhost:3000' });
  assert(bundle.relayService instanceof ByokRelayService, 'relayService is ByokRelayService');
  assert(bundle.chatService instanceof ChatService, 'chatService is ChatService');
  assert(bundle.streamingChatService instanceof StreamingChatService, 'streamingChatService is StreamingChatService');
  assert(bundle.healthService instanceof RelayHealthService, 'healthService is RelayHealthService');
});

await test('bundle services share the same relayService instance', () => {
  const bundle = createByokRelayBundle({ relayUrl: 'http://localhost:3000' });
  assert(bundle.chatService._relay === bundle.relayService, 'chat uses same relay');
  assert(bundle.streamingChatService._relay === bundle.relayService, 'streaming uses same relay');
  assert(bundle.healthService._relay === bundle.relayService, 'health uses same relay');
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
if (failed > 0) process.exit(1);

})();

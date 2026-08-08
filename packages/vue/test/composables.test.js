/**
 * Smoke tests for @byok-relay/vue composables.
 * Runs in plain Node.js — Vue reactivity APIs are mocked.
 *
 * Tests are intentionally lightweight: they verify that the composables
 * export the right shape, call the right endpoints, and handle errors
 * without needing a full Vue runtime or browser environment.
 */

'use strict';

// ─── Mock Vue Composition API ─────────────────────────────────────────────────

function ref(initial) {
  const box = { value: initial };
  return box;
}

function computed(fn) {
  return {
    get value() { return fn(); },
  };
}

function readonly(r) { return r; }

function onMounted(fn) { /* no-op in test */ }
function onUnmounted(fn) { /* no-op in test */ }

// Inject mock Vue before requiring the module
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vue') {
    return { ref, computed, readonly, onMounted, onUnmounted };
  }
  return _origLoad.call(this, request, ...rest);
};

const { useByokRelay, useChat, useStreamingChat, useRelayHealth } = require('../src/index.js');

// ─── Test helpers ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌  ${name}`);
    console.log(`       ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(a, b) {
  if (a !== b) throw new Error(`Expected ${JSON.stringify(a)} to equal ${JSON.stringify(b)}`);
}

// ─── Mock fetch ───────────────────────────────────────────────────────────────

function mockFetch(handler) {
  global.fetch = async (url, opts = {}) => {
    return handler(url, opts);
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// ─── localStorage mock ────────────────────────────────────────────────────────

const _store = {};
global.localStorage = {
  getItem:    (k) => _store[k] ?? null,
  setItem:    (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\n@byok-relay/vue composable smoke tests\n');

async function runTests() {

// --- useByokRelay ---

console.log('useByokRelay');

await test('exports correct shape', async () => {
  const relay = useByokRelay({ appId: 'test-app' });
  assert('token'          in relay, 'missing token');
  assert('isRegistered'   in relay, 'missing isRegistered');
  assert('error'          in relay, 'missing error');
  assert('register'       in relay, 'missing register');
  assert('storeKey'       in relay, 'missing storeKey');
  assert('deleteKey'      in relay, 'missing deleteKey');
  assert('listProviders'  in relay, 'missing listProviders');
  assert('logout'         in relay, 'missing logout');
});

await test('isRegistered is false before registration', async () => {
  const relay = useByokRelay({ appId: 'test-unregistered' });
  assert(!relay.isRegistered.value, 'should be false initially');
});

await test('register() stores token and sets isRegistered', async () => {
  mockFetch(() => jsonResponse({ token: 'tok_abc123' }));
  const relay = useByokRelay({ appId: 'test-register' });
  await relay.register();
  assertEqual(relay.token.value, 'tok_abc123');
  assert(relay.isRegistered.value, 'isRegistered should be true');
});

await test('register() sets error on failure', async () => {
  mockFetch(() => jsonResponse({ error: 'Registration failed (503)' }, 503));
  const relay = useByokRelay({ appId: 'test-register-fail' });
  await relay.register();
  assert(relay.error.value, 'error should be set');
  assert(!relay.isRegistered.value, 'isRegistered should remain false');
});

await test('logout() clears token', async () => {
  mockFetch(() => jsonResponse({ token: 'tok_logout' }));
  const relay = useByokRelay({ appId: 'test-logout' });
  await relay.register();
  assert(relay.isRegistered.value, 'should be registered');
  relay.logout();
  assert(!relay.token.value, 'token should be null after logout');
  assert(!relay.isRegistered.value, 'isRegistered should be false');
});

await test('storeKey() calls /keys/:provider', async () => {
  let capturedUrl = null;
  mockFetch((url) => { capturedUrl = url; return jsonResponse({ ok: true }); });
  const relay = useByokRelay({ appId: 'test-storekey' });
  relay.token.value = 'tok_store';
  await relay.storeKey('openai', 'sk-test-12345678');
  assert(capturedUrl && capturedUrl.includes('/keys/openai'), `URL should include /keys/openai, got ${capturedUrl}`);
});

await test('listProviders() returns array', async () => {
  mockFetch(() => jsonResponse({ providers: ['openai', 'anthropic'] }));
  const relay = useByokRelay({ appId: 'test-list' });
  relay.token.value = 'tok_list';
  const providers = await relay.listProviders();
  assert(Array.isArray(providers), 'should return array');
  assertEqual(providers.length, 2);
});

await test('listProviders() returns empty array if not registered', async () => {
  const relay = useByokRelay({ appId: 'test-list-noauth' });
  const providers = await relay.listProviders();
  assert(Array.isArray(providers), 'should return array');
  assertEqual(providers.length, 0);
});

// --- useChat ---

console.log('\nuseChat');

await test('exports correct shape', async () => {
  const chat = useChat({ token: 'tok_chat', appId: 'test-app' });
  assert('messages'     in chat, 'missing messages');
  assert('isLoading'    in chat, 'missing isLoading');
  assert('error'        in chat, 'missing error');
  assert('sendMessage'  in chat, 'missing sendMessage');
  assert('clearMessages'in chat, 'missing clearMessages');
});

await test('sendMessage() appends user message and assistant response', async () => {
  mockFetch(() => jsonResponse({
    choices: [{ message: { role: 'assistant', content: 'Hello!' } }],
  }));
  const tokenRef = ref('tok_chat');
  const chat = useChat({ token: tokenRef, provider: 'openai', model: 'gpt-4o-mini' });
  await chat.sendMessage('Hi');
  assertEqual(chat.messages.value.length, 2);
  assertEqual(chat.messages.value[0].role, 'user');
  assertEqual(chat.messages.value[1].role, 'assistant');
  assertEqual(chat.messages.value[1].content, 'Hello!');
});

await test('sendMessage() handles anthropic response shape', async () => {
  mockFetch(() => jsonResponse({
    content: [{ type: 'text', text: 'Hello from Claude!' }],
  }));
  const chat = useChat({ token: 'tok_anthropic', provider: 'anthropic', model: 'claude-haiku-3-5' });
  await chat.sendMessage('Hi Claude');
  const lastMsg = chat.messages.value[chat.messages.value.length - 1];
  assertEqual(lastMsg.content, 'Hello from Claude!');
});

await test('sendMessage() sets error and rolls back on failure', async () => {
  mockFetch(() => jsonResponse({ error: 'Rate limited' }, 429));
  const chat = useChat({ token: 'tok_err', provider: 'openai' });
  await chat.sendMessage('Fail me');
  assert(chat.error.value, 'error should be set');
  assertEqual(chat.messages.value.length, 0, 'user message should be rolled back');
});

await test('clearMessages() resets state', async () => {
  mockFetch(() => jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Hi' } }] }));
  const chat = useChat({ token: 'tok_clear', provider: 'openai' });
  await chat.sendMessage('Hello');
  assert(chat.messages.value.length > 0, 'should have messages');
  chat.clearMessages();
  assertEqual(chat.messages.value.length, 0);
});

// --- useStreamingChat ---

console.log('\nuseStreamingChat');

await test('exports correct shape', async () => {
  const chat = useStreamingChat({ token: 'tok_stream' });
  assert('messages'         in chat, 'missing messages');
  assert('streamingContent' in chat, 'missing streamingContent');
  assert('isStreaming'      in chat, 'missing isStreaming');
  assert('error'            in chat, 'missing error');
  assert('sendMessage'      in chat, 'missing sendMessage');
  assert('stopStreaming'     in chat, 'missing stopStreaming');
  assert('clearMessages'    in chat, 'missing clearMessages');
});

await test('sendMessage() streams and commits final message', async () => {
  // Simulate an SSE stream with two chunks
  const sseChunks = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  let chunkIndex = 0;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    body: {
      getReader() {
        return {
          async read() {
            if (chunkIndex < sseChunks.length) {
              const chunk = sseChunks[chunkIndex++];
              return { value: new TextEncoder().encode(chunk), done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    },
  });

  const chat = useStreamingChat({ token: 'tok_sse', provider: 'openai', model: 'gpt-4o-mini' });
  await chat.sendMessage('Stream me');

  assertEqual(chat.messages.value.length, 2);
  assertEqual(chat.messages.value[1].content, 'Hello world');
});

await test('stopStreaming() aborts in-flight request', async () => {
  let aborted = false;
  global.fetch = async (url, { signal }) => {
    signal.addEventListener('abort', () => { aborted = true; });
    // Hang indefinitely until aborted
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  };

  const chat = useStreamingChat({ token: 'tok_abort', provider: 'openai' });
  const sendPromise = chat.sendMessage('Abort me');
  // Allow the fetch to start
  await new Promise(r => setTimeout(r, 10));
  chat.stopStreaming();
  await sendPromise;
  assert(aborted, 'fetch should have been aborted');
});

// --- useRelayHealth ---

console.log('\nuseRelayHealth');

await test('exports correct shape', async () => {
  const health = useRelayHealth();
  assert('isHealthy'  in health, 'missing isHealthy');
  assert('status'     in health, 'missing status');
  assert('isLoading'  in health, 'missing isLoading');
  assert('error'      in health, 'missing error');
  assert('refetch'    in health, 'missing refetch');
});

await test('refetch() sets isHealthy and status on success', async () => {
  mockFetch(() => jsonResponse({ status: 'ok', uptime: 12345 }));
  const health = useRelayHealth({ intervalMs: 0 });
  await health.refetch();
  assert(health.isHealthy.value === true, 'isHealthy should be true');
  assert(health.status.value !== null, 'status should be set');
});

await test('refetch() sets isHealthy=false on non-ok response', async () => {
  mockFetch(() => jsonResponse({ status: 'error', message: 'DB unreachable' }, 503));
  const health = useRelayHealth({ intervalMs: 0 });
  await health.refetch();
  assert(health.isHealthy.value === false, 'isHealthy should be false');
});

await test('refetch() sets error on network failure', async () => {
  global.fetch = async () => { throw new Error('Network error'); };
  const health = useRelayHealth({ intervalMs: 0 });
  await health.refetch();
  assert(health.error.value, 'error should be set');
  assert(health.isHealthy.value === false, 'isHealthy should be false');
});

await test('deep=true appends deep=1 to URL', async () => {
  let capturedUrl = null;
  mockFetch((url) => { capturedUrl = url; return jsonResponse({ status: 'ok' }); });
  const health = useRelayHealth({ intervalMs: 0, deep: true, provider: 'openai' });
  await health.refetch();
  assert(capturedUrl && capturedUrl.includes('deep=1'), `URL should include deep=1, got ${capturedUrl}`);
  assert(capturedUrl && capturedUrl.includes('provider=openai'), `URL should include provider=openai, got ${capturedUrl}`);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

} // end runTests

runTests().catch(err => { console.error(err); process.exit(1); });

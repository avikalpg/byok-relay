/**
 * @byok-relay/qwik smoke tests
 *
 * Pure Node.js — no Qwik runtime required.
 * Tests exercise every public export with fetch mocked via globalThis.
 */

'use strict';

const {
  ByokRelayClient,
  createRelayLoader,
  createRelayAction,
  createByokRelayStore,
  createChatStore,
  createStreamingChatStore,
  createRelayHealthStore,
} = require('../src/index.js');

/* ─── Minimal fetch mock ──────────────────────────────────────────────────── */

let _fetchCalls = [];
let _fetchQueue = [];

function _pushResponse (body, opts) {
  opts = opts || {};
  _fetchQueue.push({
    body        : body,
    status      : opts.status || 200,
    contentType : opts.contentType || 'application/json',
  });
}

globalThis.fetch = async function (url, init) {
  init = init || {};
  _fetchCalls.push({ url: url, method: init.method || 'GET', body: init.body });
  const next = _fetchQueue.shift();
  if (!next) return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  const isJSON  = next.contentType.includes('json');
  const bodyStr = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
  return {
    ok          : next.status >= 200 && next.status < 300,
    status      : next.status,
    headers     : { get: function(k) { return k === 'content-type' ? next.contentType : null; } },
    json        : async function() { return isJSON ? (typeof next.body === 'string' ? JSON.parse(next.body) : next.body) : {}; },
    text        : async function() { return bodyStr; },
    body        : {
      getReader: function() {
        let done = false;
        return {
          read: async function() {
            if (done) return { done: true, value: undefined };
            done = true;
            const chunk = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n';
            const bytes = Buffer.from(chunk);
            return { done: false, value: bytes };
          },
        };
      },
    },
  };
};

// TextDecoder shim for environments that need it
if (typeof TextDecoder === 'undefined') {
  const u = require('util');
  globalThis.TextDecoder = u.TextDecoder;
  globalThis.TextEncoder = u.TextEncoder;
}

/* ─── Test helpers ────────────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;

async function testAsync (name, fn) {
  _fetchCalls = [];
  _fetchQueue = [];
  try {
    await fn();
    console.log('  \u2705 ' + name);
    passed++;
  } catch (err) {
    console.error('  \u274c ' + name + '\n     ' + err.message);
    failed++;
  }
}

function assertEqual (a, b, msg) {
  if (a !== b) throw new Error(msg || ('Expected ' + JSON.stringify(a) + ' === ' + JSON.stringify(b)));
}

function assertTrue (cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

/* ═══════════════════════════════════════════════════════════════════════════ */

async function main () {

/* ─── ByokRelayClient ─────────────────────────────────────────────────────── */

console.log('\nByokRelayClient');

await testAsync('register() stores token and returns data', async function() {
  const client = new ByokRelayClient({ relayUrl: 'http://relay.test', appId: 'qwik-test' });
  _pushResponse({ token: 'tok_abc123', user_id: 'u1' });
  const data = await client.register();
  assertEqual(data.token, 'tok_abc123', 'token mismatch');
  assertEqual(client._storeGet('byok_relay_token'), 'tok_abc123', 'token not stored');
});

await testAsync('ensureToken() returns existing token without re-registering', async function() {
  const client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
  client._storeSet('byok_relay_token', 'existing_tok');
  const tok = await client.ensureToken();
  assertEqual(tok, 'existing_tok');
  assertEqual(_fetchCalls.length, 0, 'should not call fetch');
});

await testAsync('ensureToken() registers when no token stored', async function() {
  const client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
  _pushResponse({ token: 'new_tok' });
  const tok = await client.ensureToken();
  assertEqual(tok, 'new_tok');
  assertEqual(_fetchCalls.length, 1);
  assertTrue(_fetchCalls[0].url.includes('/users'));
});

await testAsync('logout() clears stored token', async function() {
  const client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
  client._storeSet('byok_relay_token', 'tok_to_clear');
  client.logout();
  assertTrue(!client._storeGet('byok_relay_token'), 'token should be cleared');
});

await testAsync('storeKey() calls /keys/:provider with Authorization', async function() {
  const client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
  client._storeSet('byok_relay_token', 'tok_xyz');
  _pushResponse({ ok: true });
  await client.storeKey('openai', 'sk-test-key');
  assertTrue(_fetchCalls[0].url.includes('/keys/openai'));
  assertTrue(_fetchCalls[0].body.includes('sk-test-key'));
});

await testAsync('listKeys() calls /keys with Authorization', async function() {
  const client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
  client._storeSet('byok_relay_token', 'tok_xyz');
  _pushResponse({ keys: [{ provider: 'openai' }] });
  const data = await client.listKeys();
  assertTrue(Array.isArray(data.keys));
  assertTrue(_fetchCalls[0].url.includes('/keys'));
});

await testAsync('deleteKey() calls DELETE /keys/:provider', async function() {
  const client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
  client._storeSet('byok_relay_token', 'tok_xyz');
  _pushResponse({ ok: true });
  await client.deleteKey('anthropic');
  assertEqual(_fetchCalls[0].method, 'DELETE');
  assertTrue(_fetchCalls[0].url.includes('/keys/anthropic'));
});

await testAsync('rotateKey() calls POST /keys/:provider/rotate', async function() {
  const client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
  client._storeSet('byok_relay_token', 'tok_xyz');
  _pushResponse({ ok: true, rotated: true });
  const result = await client.rotateKey('openai', 'sk-new-key');
  assertTrue(result.rotated);
  assertTrue(_fetchCalls[0].url.includes('/rotate'));
});

await testAsync('chat() calls unified POST /relay', async function() {
  const client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
  client._storeSet('byok_relay_token', 'tok_xyz');
  _pushResponse({ choices: [{ message: { content: 'Hi there!' } }] });
  const data = await client.chat('openai/gpt-4o-mini', [{ role: 'user', content: 'Hello' }]);
  assertEqual(data.choices[0].message.content, 'Hi there!');
  assertTrue(_fetchCalls[0].url.includes('/relay'));
  assertTrue(_fetchCalls[0].body.includes('gpt-4o-mini'));
});

await testAsync('streamChat() yields text chunks from SSE stream', async function() {
  const client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
  client._storeSet('byok_relay_token', 'tok_xyz');
  _pushResponse('', { status: 200, contentType: 'text/event-stream' });
  const chunks = [];
  for await (const chunk of client.streamChat('openai/gpt-4o', [{ role: 'user', content: 'Hello' }])) {
    chunks.push(chunk);
  }
  assertTrue(chunks.indexOf('Hello') !== -1, 'Expected "Hello" in chunks, got ' + JSON.stringify(chunks));
});

await testAsync('health() calls /health', async function() {
  const client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
  _pushResponse({ status: 'ok', uptime: 100 });
  const result = await client.health();
  assertTrue(result.ok);
  assertTrue(_fetchCalls[0].url.includes('/health'));
});

await testAsync('deepHealth() calls /health?deep=1', async function() {
  const client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
  _pushResponse({ status: 'ok' });
  await client.deepHealth();
  assertTrue(_fetchCalls[0].url.includes('deep=1'));
});

await testAsync('stats() calls /stats with auth header', async function() {
  const client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
  client._storeSet('byok_relay_token', 'tok_xyz');
  _pushResponse({ total: 42 });
  const data = await client.stats();
  assertEqual(data.total, 42);
  assertTrue(_fetchCalls[0].url.includes('/stats'));
});

await testAsync('getModels() calls /models', async function() {
  const client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
  _pushResponse({ restricted: false, allowed_models: [] });
  await client.getModels();
  assertTrue(_fetchCalls[0].url.includes('/models'));
});

await testAsync('deleteAccount() calls DELETE /users and clears token', async function() {
  const client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
  client._storeSet('byok_relay_token', 'tok_xyz');
  _pushResponse({ ok: true });
  await client.deleteAccount();
  assertEqual(_fetchCalls[0].method, 'DELETE');
  assertTrue(!client._storeGet('byok_relay_token'), 'token should be cleared');
});

await testAsync('custom storage adapter is used', async function() {
  const store = {};
  const client = new ByokRelayClient({
    relayUrl : 'http://relay.test',
    storage  : {
      get    : function(k)    { return store[k] || null; },
      set    : function(k, v) { store[k] = v; },
      remove : function(k)    { delete store[k]; },
    },
  });
  _pushResponse({ token: 'custom_tok' });
  await client.register();
  assertEqual(store['byok_relay_token'], 'custom_tok');
});

/* ─── Server helpers ──────────────────────────────────────────────────────── */

console.log('\ncreateRelayLoader / createRelayAction');

await testAsync('createRelayLoader returns an async function', async function() {
  const loader = createRelayLoader({ relayUrl: 'http://relay.test' });
  assertTrue(typeof loader === 'function');
});

await testAsync('createRelayLoader proxies path and parses JSON', async function() {
  const loader = createRelayLoader({ relayUrl: 'http://relay.test' });
  _pushResponse({ status: 'ok', version: '1.2.0' });
  const mockEvent = {
    request : {
      method  : 'GET',
      headers : {
        get     : function() { return null; },
        entries : function() { return [][Symbol.iterator](); },
      },
    },
    params  : { path: 'health' },
    error   : function(code, msg) { const e = new Error(msg); e.status = code; return e; },
  };
  const result = await loader(mockEvent);
  assertTrue(result.status === 'ok' || result.version === '1.2.0', 'Expected proxied JSON');
  assertTrue(_fetchCalls[0].url.includes('health'));
});

await testAsync('createRelayAction returns an async function', async function() {
  const action = createRelayAction({ relayUrl: 'http://relay.test' });
  assertTrue(typeof action === 'function');
});

await testAsync('createRelayAction forwards body to relay', async function() {
  const action = createRelayAction({ relayUrl: 'http://relay.test' });
  _pushResponse({ choices: [{ message: { content: 'Sure!' } }] });
  const mockEvent = {
    request : {
      method  : 'POST',
      headers : {
        get     : function() { return null; },
        entries : function() { return [][Symbol.iterator](); },
      },
    },
    error : function(code, msg) { const e = new Error(msg); e.status = code; return e; },
  };
  const result = await action(
    { path: 'relay', token: 'tok_xyz', body: { model: 'gpt-4o', messages: [] } },
    mockEvent,
  );
  assertTrue(result.success, 'Expected success, got ' + JSON.stringify(result));
});

await testAsync('createRelayAction returns { success: false } on upstream error', async function() {
  const action = createRelayAction({ relayUrl: 'http://relay.test' });
  _pushResponse('Upstream error', { status: 502, contentType: 'text/plain' });
  const mockEvent = {
    request : {
      method  : 'POST',
      headers : {
        get     : function() { return null; },
        entries : function() { return [][Symbol.iterator](); },
      },
    },
    error : function(code, msg) { const e = new Error(msg); e.status = code; return e; },
  };
  const result = await action({ path: 'relay', token: 'tok_xyz', body: {} }, mockEvent);
  assertTrue(!result.success);
  assertEqual(result.status, 502);
});


await testAsync('createRelayAction rejects client-supplied appId without trusted header', async function() {
  const action = createRelayAction({
    relayUrl    : 'http://relay.test',
    allowedApps : ['allowed-app'],
  });
  let errorThrown = false;
  const mockEvent = {
    request : {
      method  : 'POST',
      headers : {
        get     : function() { return null; },
        entries : function() { return [][Symbol.iterator](); },
      },
    },
    error : function(code, msg) {
      errorThrown = true;
      const e = new Error(msg);
      e.status = code;
      throw e;
    },
  };
  try {
    await action({ path: 'relay', token: 'tok_xyz', appId: 'allowed-app', body: {} }, mockEvent);
  } catch (e) {
    assertEqual(e.status, 403);
  }
  assertTrue(errorThrown, 'Should reject client-controlled appId without x-app-id');
  assertEqual(_fetchCalls.length, 0);
});

await testAsync('createRelayLoader respects allowedApps', async function() {
  const loader = createRelayLoader({
    relayUrl     : 'http://relay.test',
    allowedApps  : ['allowed-app'],
  });
  let errorThrown = false;
  const mockEvent = {
    request : {
      method  : 'GET',
      headers : {
        get     : function(k) { return k === 'x-app-id' ? 'blocked-app' : null; },
        entries : function() { return [][Symbol.iterator](); },
      },
    },
    params  : { path: 'health' },
    error   : function(code) {
      errorThrown = true;
      const e = new Error('blocked');
      e.status = code;
      throw e;
    },
  };
  try { await loader(mockEvent); } catch (_) {}
  assertTrue(errorThrown, 'Should throw for disallowed app');
});

/* ─── Reactive stores ────────────────────────────────────────────────────── */

console.log('\ncreateByokRelayStore');

await testAsync('store has correct initial state shape', async function() {
  const relay = createByokRelayStore({ relayUrl: 'http://relay.test' });
  assertTrue('token' in relay.state);
  assertTrue('loading' in relay.state);
  assertTrue('error' in relay.state);
  assertTrue('keys' in relay.state);
});

await testAsync('storeKey() updates state.keys', async function() {
  const relay = createByokRelayStore({ relayUrl: 'http://relay.test' });
  _pushResponse({ token: 'tok_store_test' }); // register
  _pushResponse({ ok: true });                // storeKey
  _pushResponse({ keys: [{ provider: 'openai' }] }); // listKeys
  await relay.storeKey('openai', 'sk-test');
  assertTrue(Array.isArray(relay.state.keys));
});

await testAsync('logout() clears token in state', async function() {
  const relay = createByokRelayStore({ relayUrl: 'http://relay.test' });
  relay.state.token = 'tok_something';
  relay.logout();
  assertTrue(relay.state.token === null, 'token should be null after logout');
});

console.log('\ncreateChatStore');

await testAsync('sendMessage() appends user and assistant messages', async function() {
  const chat = createChatStore({ relayUrl: 'http://relay.test', model: 'openai/gpt-4o' });
  _pushResponse({ token: 'tok_chat' }); // register
  _pushResponse({ choices: [{ message: { content: 'World!' } }] }); // chat
  await chat.sendMessage('Hello');
  assertEqual(chat.state.messages.length, 2);
  assertEqual(chat.state.messages[0].role, 'user');
  assertEqual(chat.state.messages[1].role, 'assistant');
  assertEqual(chat.state.messages[1].content, 'World!');
});

await testAsync('clearMessages() empties message list', async function() {
  const chat = createChatStore({ relayUrl: 'http://relay.test', model: 'openai/gpt-4o' });
  chat.state.messages = [{ role: 'user', content: 'hi' }];
  chat.clearMessages();
  assertEqual(chat.state.messages.length, 0);
});

await testAsync('sendMessage() prepends systemPrompt when set', async function() {
  const chat = createChatStore({
    relayUrl     : 'http://relay.test',
    model        : 'openai/gpt-4o',
    systemPrompt : 'You are helpful.',
  });
  _pushResponse({ token: 'tok_sys' });
  _pushResponse({ choices: [{ message: { content: 'Sure' } }] });
  await chat.sendMessage('Help me');
  const body = JSON.parse(_fetchCalls[_fetchCalls.length - 1].body);
  assertEqual(body.messages[0].role, 'system');
});

console.log('\ncreateStreamingChatStore');

await testAsync('sendMessage() streams and commits final message', async function() {
  const chat = createStreamingChatStore({
    relayUrl : 'http://relay.test',
    model    : 'openai/gpt-4o',
  });
  _pushResponse({ token: 'tok_stream' });
  _pushResponse('', { status: 200, contentType: 'text/event-stream' });
  await chat.sendMessage('Hello stream');
  assertTrue(chat.state.messages.length >= 1, 'Should have at least user message committed');
  assertTrue(!chat.state.isStreaming, 'Should not be streaming after completion');
});

await testAsync('clearMessages() resets all stream state', async function() {
  const chat = createStreamingChatStore({ relayUrl: 'http://relay.test', model: 'openai/gpt-4o' });
  chat.state.messages         = [{ role: 'user', content: 'hi' }];
  chat.state.streamingContent = 'partial';
  chat.clearMessages();
  assertEqual(chat.state.messages.length, 0);
  assertEqual(chat.state.streamingContent, '');
});

await testAsync('stopStreaming() is a safe no-op when not streaming', async function() {
  const chat = createStreamingChatStore({ relayUrl: 'http://relay.test', model: 'openai/gpt-4o' });
  chat.stopStreaming(); // no-op when not streaming
  assertTrue(!chat.state.isStreaming);
});

console.log('\ncreateRelayHealthStore');

await testAsync('check() sets status to ok on healthy response', async function() {
  const health = createRelayHealthStore({ relayUrl: 'http://relay.test' });
  _pushResponse({ status: 'ok', uptime: 1000 });
  await health.check();
  assertEqual(health.state.status, 'ok');
  assertTrue(health.state.lastCheck > 0);
});

await testAsync('check() sets status to degraded on non-ok response', async function() {
  const health = createRelayHealthStore({ relayUrl: 'http://relay.test' });
  _pushResponse({ status: 'degraded' }, { status: 503 });
  await health.check();
  assertEqual(health.state.status, 'degraded');
});

await testAsync('destroy() can be called safely without throwing', async function() {
  const health = createRelayHealthStore({ relayUrl: 'http://relay.test' });
  health.destroy(); // no-op when not polling
  assertTrue(true);
});

/* ─── Summary ─────────────────────────────────────────────────────────────── */

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed.\n');
if (failed > 0) process.exit(1);

}

main().catch(function(err) { console.error(err); process.exit(1); });

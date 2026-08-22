/**
 * @byok-relay/nuxt smoke tests
 *
 * Pure Node.js — no Nuxt/Vue runtime required.
 * Tests cover every public export with fetch mocked via globalThis.
 */

'use strict';

const {
  ByokRelayClient,
  createRelayServerRoute,
  defineByokRelayModule,
  useByokRelay,
  useChat,
  useStreamingChat,
  useRelayHealth,
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
    stream      : opts.stream || null,
  });
}

function _makeStreamReader (chunks) {
  let idx = 0;
  return {
    getReader: function () {
      return {
        read: async function () {
          if (idx >= chunks.length) return { done: true, value: undefined };
          const bytes = Buffer.from(chunks[idx++]);
          return { done: false, value: bytes };
        },
      };
    },
  };
}

globalThis.fetch = async function (url, init) {
  init = init || {};
  _fetchCalls.push({ url: url, method: init.method || 'GET', body: init.body });
  const next = _fetchQueue.shift();
  if (!next) {
    return {
      ok: true, status: 200,
      headers: { get: function() { return 'application/json'; } },
      json        : async function() { return {}; },
      text        : async function() { return '{}'; },
      arrayBuffer : async function() { return Buffer.from('{}'); },
      body        : _makeStreamReader([]),
    };
  }
  const isJSON  = next.contentType.includes('json');
  const bodyStr = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
  return {
    ok          : next.status >= 200 && next.status < 300,
    status      : next.status,
    headers     : { get: function(k) { return k === 'content-type' ? next.contentType : null; } },
    json        : async function() { return isJSON ? (typeof next.body === 'string' ? JSON.parse(next.body) : next.body) : {}; },
    text        : async function() { return bodyStr; },
    arrayBuffer : async function() { return Buffer.from(bodyStr); },
    body        : next.stream ? _makeStreamReader(next.stream) : _makeStreamReader([]),
  };
};

// TextDecoder shim
if (typeof TextDecoder === 'undefined') {
  var u = require('util');
  globalThis.TextDecoder = u.TextDecoder;
  globalThis.TextEncoder = u.TextEncoder;
}

// AbortController shim
if (typeof AbortController === 'undefined') {
  globalThis.AbortController = function () {
    this.signal = { aborted: false };
    this.abort  = function () { this.signal.aborted = true; };
  };
}

/* ─── Test helpers ────────────────────────────────────────────────────────── */

var passed = 0;
var failed = 0;

async function testAsync (name, fn) {
  _fetchCalls = [];
  _fetchQueue = [];
  try {
    await fn();
    console.log('  \u2705  ' + name);
    passed++;
  } catch (e) {
    console.error('  \u274C  ' + name);
    console.error('       ' + e.message);
    failed++;
  }
}

function assert (cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

/* ─── Helper: make a minimal H3-like event object ─────────────────────────── */

function _makeEvent (opts) {
  opts = opts || {};
  var mockRes = {
    statusCode : 200,
    _headers   : {},
    _body      : null,
    setHeader  : function(k, v) { this._headers[k] = v; },
    end        : function(body) { this._body = body; },
  };
  var mockReq = { method: opts.method || 'GET', headers: opts.headers || {} };
  return {
    req     : mockReq,
    res     : mockRes,
    node    : { req: mockReq, res: mockRes },
    context : { params: opts.params || { _: 'openai/chat/completions' } },
  };
}

/* ─── Main test runner ────────────────────────────────────────────────────── */

async function main () {

  /* ── ByokRelayClient ── */

  console.log('\n@byok-relay/nuxt \u2014 ByokRelayClient\n');

  await testAsync('register() POSTs to /users and stores token', async function() {
    _pushResponse({ token: 'tok-123' });
    var client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
    var tok = await client.register('nuxt-test');
    assert(tok === 'tok-123', 'expected tok-123 got ' + tok);
    assert(_fetchCalls[0].url === 'http://relay.test/users', 'wrong URL');
    assert(_fetchCalls[0].method === 'POST', 'wrong method');
  });

  await testAsync('ensureToken() returns cached token without re-registering', async function() {
    var client  = new ByokRelayClient({ relayUrl: 'http://relay.test' });
    var storage = {};
    client._storage = {
      getItem    : function(k) { return storage[k] || null; },
      setItem    : function(k, v) { storage[k] = v; },
      removeItem : function(k) { delete storage[k]; },
    };
    storage[client._TOKEN_KEY] = 'cached-tok';
    var tok = await client.ensureToken();
    assert(tok === 'cached-tok', 'expected cached-tok, got ' + tok);
    assert(_fetchCalls.length === 0, 'unexpected fetch call');
  });

  await testAsync('storeKey() POSTs to /keys/:provider', async function() {
    _pushResponse({ ok: true });
    var client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
    client._storage = { getItem: function() { return 'tok-456'; }, setItem: function() {}, removeItem: function() {} };
    await client.storeKey('openai', 'sk-test-key');
    assert(_fetchCalls.some(function(c) { return c.url.includes('/keys/openai') && c.method === 'POST'; }), 'POST /keys/openai not called');
  });

  await testAsync('listKeys() GETs /keys', async function() {
    _pushResponse({ providers: ['openai', 'anthropic'] });
    var client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
    client._storage = { getItem: function() { return 'tok-789'; }, setItem: function() {}, removeItem: function() {} };
    var data = await client.listKeys();
    assert(Array.isArray(data.providers), 'expected providers array');
    assert(data.providers.includes('openai'), 'openai missing');
  });

  await testAsync('deleteKey() DELETEs /keys/:provider', async function() {
    _pushResponse({ ok: true });
    var client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
    client._storage = { getItem: function() { return 'tok-del'; }, setItem: function() {}, removeItem: function() {} };
    await client.deleteKey('anthropic');
    assert(_fetchCalls.some(function(c) { return c.url.includes('/keys/anthropic') && c.method === 'DELETE'; }), 'DELETE /keys/anthropic not called');
  });

  await testAsync('rotateKey() POSTs to /keys/:provider/rotate', async function() {
    _pushResponse({ ok: true, rotated: true });
    var client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
    client._storage = { getItem: function() { return 'tok-rot'; }, setItem: function() {}, removeItem: function() {} };
    var res = await client.rotateKey('openai', 'sk-new');
    assert(res.rotated === true, 'rotated should be true');
    assert(_fetchCalls[0].url.includes('/rotate'), 'missing /rotate');
  });

  await testAsync('chat() POSTs to /relay', async function() {
    _pushResponse({ choices: [{ message: { content: 'Hello from relay' } }] });
    var client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
    client._storage = { getItem: function() { return 'tok-chat'; }, setItem: function() {}, removeItem: function() {} };
    var res = await client.chat([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' });
    assert(res.choices[0].message.content === 'Hello from relay', 'wrong response');
    assert(_fetchCalls[0].url === 'http://relay.test/relay', 'wrong URL');
  });

  await testAsync('streamChat() yields text chunks via SSE', async function() {
    var chunk = 'data: {"choices":[{"delta":{"content":"chunk1"}}]}\n\ndata: [DONE]\n\n';
    _fetchQueue.push({ body: '', status: 200, contentType: 'text/event-stream', stream: [chunk] });
    var client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
    client._storage = { getItem: function() { return 'tok-stream'; }, setItem: function() {}, removeItem: function() {} };
    var chunks = [];
    for await (var delta of client.streamChat([{ role: 'user', content: 'stream me' }], { model: 'gpt-4o' }, function(c) { chunks.push(c); })) {}
    assert(chunks.includes('chunk1'), 'expected chunk1 in ' + JSON.stringify(chunks));
  });

  await testAsync('health() fetches /health', async function() {
    _pushResponse({ status: 'ok', uptime: 12345 });
    var client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
    var res = await client.health();
    assert(res.status === 'ok', 'health status not ok');
    assert(_fetchCalls[0].url === 'http://relay.test/health', 'wrong URL');
  });

  await testAsync('health(deep=true) fetches /health?deep=1', async function() {
    _pushResponse({ status: 'ok', checks: { db: true, upstream: { ok: true } } });
    var client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
    await client.health(true);
    assert(_fetchCalls[0].url.includes('deep=1'), 'deep=1 missing from URL');
  });

  await testAsync('stats() fetches /stats with auth header', async function() {
    _pushResponse({ total: 10, byProvider: {} });
    var client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
    client._storage = { getItem: function() { return 'tok-stats'; }, setItem: function() {}, removeItem: function() {} };
    await client.stats();
    assert(_fetchCalls[0].url === 'http://relay.test/stats', 'wrong URL');
  });

  await testAsync('getModels() fetches /models', async function() {
    _pushResponse({ models: ['gpt-4o', 'claude-3-5-sonnet'] });
    var client = new ByokRelayClient({ relayUrl: 'http://relay.test' });
    var res = await client.getModels();
    assert(Array.isArray(res.models), 'expected models array');
  });

  await testAsync('logout() clears stored token', async function() {
    var storage = {};
    var client  = new ByokRelayClient({ relayUrl: 'http://relay.test' });
    storage[client._TOKEN_KEY] = 'tok-to-clear';
    client._storage = {
      getItem    : function(k) { return storage[k] || null; },
      setItem    : function(k, v) { storage[k] = v; },
      removeItem : function(k) { delete storage[k]; },
    };
    client.logout();
    assert(!storage[client._TOKEN_KEY], 'token not removed');
  });

  await testAsync('deleteAccount() DELETEs /users and clears token', async function() {
    _pushResponse({ ok: true });
    var storage = {};
    var client  = new ByokRelayClient({ relayUrl: 'http://relay.test' });
    storage[client._TOKEN_KEY] = 'tok-gdpr';
    client._storage = {
      getItem    : function(k) { return storage[k] || null; },
      setItem    : function(k, v) { storage[k] = v; },
      removeItem : function(k) { delete storage[k]; },
    };
    await client.deleteAccount();
    assert(_fetchCalls[0].method === 'DELETE', 'expected DELETE');
    assert(!storage[client._TOKEN_KEY], 'token should be cleared');
  });

  /* ── createRelayServerRoute ── */

  console.log('\n@byok-relay/nuxt \u2014 createRelayServerRoute\n');

  await testAsync('createRelayServerRoute() returns a function', function() {
    var handler = createRelayServerRoute({ relayUrl: 'http://relay.test' });
    assert(typeof handler === 'function', 'expected function');
  });

  await testAsync('handler proxies GET request to upstream relay URL', async function() {
    _pushResponse({ status: 'ok' });
    var handler = createRelayServerRoute({ relayUrl: 'http://relay.test' });
    var event   = _makeEvent({ method: 'GET', params: { _: 'openai/models' } });
    await handler(event);
    assert(_fetchCalls.some(function(c) { return c.url.includes('http://relay.test/relay/'); }), 'upstream URL not called');
  });

  await testAsync('handler proxies POST request to upstream', async function() {
    _pushResponse({ choices: [{ message: { content: 'ok' } }] });
    var handler = createRelayServerRoute({ relayUrl: 'http://relay.test' });
    var event   = _makeEvent({ method: 'POST', params: { _: 'openai/chat/completions' } });
    await handler(event);
    assert(_fetchCalls.some(function(c) { return c.method === 'POST'; }), 'POST not forwarded');
  });

  await testAsync('handler returns 504 on AbortError (timeout)', async function() {
    var origFetch = globalThis.fetch;
    globalThis.fetch = async function() { var e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    var handler = createRelayServerRoute({ relayUrl: 'http://relay.test', timeoutMs: 1 });
    var event   = _makeEvent({ method: 'GET', params: { _: 'openai/models' } });
    await handler(event);
    assert(event.res._body && event.res._body.includes('timeout'), 'expected timeout body, got ' + event.res._body);
    globalThis.fetch = origFetch;
  });

  await testAsync('handler returns 502 on network error', async function() {
    var origFetch = globalThis.fetch;
    globalThis.fetch = async function() { throw new Error('ECONNREFUSED'); };
    var handler = createRelayServerRoute({ relayUrl: 'http://relay.test' });
    var event   = _makeEvent({ method: 'GET', params: { _: 'openai/models' } });
    await handler(event);
    assert(event.res._body && event.res._body.includes('relay'), 'expected relay error body, got ' + event.res._body);
    globalThis.fetch = origFetch;
  });

  /* ── defineByokRelayModule ── */

  console.log('\n@byok-relay/nuxt \u2014 defineByokRelayModule\n');

  await testAsync('defineByokRelayModule() returns a function', function() {
    var mod = defineByokRelayModule({ relayUrl: 'http://relay.test' });
    assert(typeof mod === 'function', 'expected function');
  });

  await testAsync('module sets public.relayUrl on runtimeConfig', function() {
    var mod = defineByokRelayModule({ relayUrl: 'http://relay.test', publicRelayUrl: '/relay' });
    var nuxtApp = {
      options            : { runtimeConfig: {} },
      addServerHandler   : function() {},
    };
    mod(nuxtApp, {});
    assert(nuxtApp.options.runtimeConfig.public.relayUrl === '/relay', 'public relayUrl not set');
  });

  await testAsync('module sets server-only relayUrl from opts', function() {
    var mod = defineByokRelayModule({ relayUrl: 'http://relay.test' });
    var nuxtApp = {
      options            : { runtimeConfig: {} },
      addServerHandler   : function() {},
    };
    mod(nuxtApp, {});
    assert(nuxtApp.options.runtimeConfig.relayUrl === 'http://relay.test', 'server relayUrl not set');
  });

  await testAsync('module calls addServerHandler when available', function() {
    var handlerAdded = false;
    var mod = defineByokRelayModule({ relayUrl: 'http://relay.test' });
    var nuxtApp = {
      options            : { runtimeConfig: {} },
      addServerHandler   : function() { handlerAdded = true; },
    };
    mod(nuxtApp, {});
    assert(handlerAdded, 'addServerHandler not called');
  });

  await testAsync('module is no-op when nuxtApp is null', function() {
    var mod = defineByokRelayModule({ relayUrl: 'http://relay.test' });
    mod(null, {});  // should not throw
    assert(true, 'should not throw');
  });

  /* ── Vue composables ── */

  console.log('\n@byok-relay/nuxt \u2014 Vue composables\n');

  await testAsync('useByokRelay() returns expected shape', function() {
    var r = useByokRelay({ relayUrl: 'http://relay.test' });
    var keys = ['token','loading','error','providers','register','ensureToken','storeKey','listKeys','deleteKey','rotateKey','logout'];
    for (var i = 0; i < keys.length; i++) assert(keys[i] in r, 'missing key: ' + keys[i]);
  });

  await testAsync('useByokRelay.register() posts to /users', async function() {
    _pushResponse({ token: 'tok-composable' });
    var r   = useByokRelay({ relayUrl: 'http://relay.test' });
    var tok = await r.register('test-app');
    assert(tok === 'tok-composable', 'expected tok-composable, got ' + tok);
  });

  await testAsync('useByokRelay.logout() clears token signal', async function() {
    _pushResponse({ token: 'tok-logout' });
    var r = useByokRelay({ relayUrl: 'http://relay.test' });
    await r.register();
    r.logout();
    assert(r.token.value === null, 'token should be null after logout');
  });

  await testAsync('useChat() returns expected shape', function() {
    var r    = useChat({ relayUrl: 'http://relay.test' });
    var keys = ['messages','loading','error','sendMessage','clearMessages'];
    for (var i = 0; i < keys.length; i++) assert(keys[i] in r, 'missing key: ' + keys[i]);
  });

  await testAsync('useChat.sendMessage() appends user + assistant messages', async function() {
    _pushResponse({ token: 'tok-uc' });   // ensureToken
    _pushResponse({ choices: [{ message: { content: 'Nuxt says hi' } }] });
    var r       = useChat({ relayUrl: 'http://relay.test', model: 'gpt-4o' });
    var content = await r.sendMessage('Hello');
    assert(content === 'Nuxt says hi', 'unexpected content: ' + content);
    assert(r.messages.value.some(function(m) { return m.role === 'assistant'; }), 'assistant message missing');
  });

  await testAsync('useChat.clearMessages() empties messages', async function() {
    _pushResponse({ token: 'tok-clr' });
    _pushResponse({ choices: [{ message: { content: 'ok' } }] });
    var r = useChat({ relayUrl: 'http://relay.test', model: 'gpt-4o' });
    await r.sendMessage('hi');
    r.clearMessages();
    assert(r.messages.value.length === 0, 'messages not cleared');
  });

  await testAsync('useStreamingChat() returns expected shape', function() {
    var r    = useStreamingChat({ relayUrl: 'http://relay.test' });
    var keys = ['messages','streamingContent','loading','error','sendMessage','stopStreaming','clearMessages'];
    for (var i = 0; i < keys.length; i++) assert(keys[i] in r, 'missing key: ' + keys[i]);
  });

  await testAsync('useStreamingChat.sendMessage() accumulates stream chunks into assistant message', async function() {
    var chunk = 'data: {"choices":[{"delta":{"content":"stream-chunk"}}]}\n\ndata: [DONE]\n\n';
    _pushResponse({ token: 'tok-stream' });  // for ensureToken (register)
    _fetchQueue.push({ body: '', status: 200, contentType: 'text/event-stream', stream: [chunk] });
    var r = useStreamingChat({ relayUrl: 'http://relay.test', model: 'gpt-4o' });
    await r.sendMessage('stream test');
    var assistant = r.messages.value.find(function(m) { return m.role === 'assistant'; });
    assert(assistant && assistant.content.includes('stream-chunk'), 'wrong content: ' + (assistant && assistant.content));
  });

  await testAsync('useStreamingChat.stopStreaming() does not throw', function() {
    var r = useStreamingChat({ relayUrl: 'http://relay.test' });
    r.stopStreaming();  // no-op when not streaming
    assert(true, 'should not throw');
  });

  await testAsync('useStreamingChat.clearMessages() empties messages', function() {
    var r = useStreamingChat({ relayUrl: 'http://relay.test' });
    r.messages.value = [{ role: 'user', content: 'hi' }];
    r.clearMessages();
    assert(r.messages.value.length === 0, 'messages not cleared');
  });

  await testAsync('useRelayHealth() returns expected shape', function() {
    var r    = useRelayHealth({ relayUrl: 'http://relay.test' });
    var keys = ['status','data','loading','error','check','startPolling','stopPolling','destroy'];
    for (var i = 0; i < keys.length; i++) assert(keys[i] in r, 'missing key: ' + keys[i]);
  });

  await testAsync('useRelayHealth.check() fetches /health and sets status', async function() {
    _pushResponse({ status: 'ok', uptime: 999 });
    var r = useRelayHealth({ relayUrl: 'http://relay.test' });
    await r.check();
    assert(r.status.value === 'ok', 'expected ok, got ' + r.status.value);
    assert(r.data.value && r.data.value.uptime === 999, 'data not set');
  });

  await testAsync('useRelayHealth.check(deep=true) fetches /health?deep=1', async function() {
    _pushResponse({ status: 'ok', checks: { upstream: { ok: true } } });
    var r = useRelayHealth({ relayUrl: 'http://relay.test' });
    await r.check(true);
    assert(_fetchCalls.some(function(c) { return c.url.includes('deep=1'); }), 'deep=1 not in URL');
  });

  await testAsync('useRelayHealth.destroy() stops polling without throwing', function() {
    _pushResponse({ status: 'ok' });
    var r = useRelayHealth({ relayUrl: 'http://relay.test' });
    r.startPolling(100000);
    r.destroy();
    assert(true, 'destroy did not throw');
  });

  /* ─── Summary ─────────────────────────────────────────────────────────────── */

  console.log('\n' + '\u2500'.repeat(50));
  console.log('  Passed: ' + passed + '   Failed: ' + failed);
  console.log('\u2500'.repeat(50) + '\n');
  if (failed > 0) process.exit(1);
}

main().catch(function (err) { console.error(err); process.exit(1); });

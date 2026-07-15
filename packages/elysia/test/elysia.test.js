/**
 * Smoke tests for @byok-relay/elysia
 * Run with: node test/elysia.test.js
 *
 * Tests run without a real Elysia instance — they verify the exported API,
 * handler behaviour against a mock fetch, and the ByokRelayClient class.
 */

'use strict';

let passed = 0;
let failed = 0;

function assert (condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

/* ========================================================================== */
/* Setup: mock globals                                                         */
/* ========================================================================== */

// Mock fetch globally for tests
let _mockFetchResponse = null;
let _lastFetchCall     = null;

global.fetch = async function mockFetch (url, init = {}) {
  _lastFetchCall = { url, init };
  if (_mockFetchResponse) return _mockFetchResponse(url, init);
  return new Response(JSON.stringify({ ok: true }), {
    status:  200,
    headers: { 'content-type': 'application/json' },
  });
};

// Minimal Response shim (Node 18+ has it natively; this is a fallback for CI)
if (typeof Response === 'undefined') {
  global.Response = class Response {
    constructor (body, init = {}) {
      this.body    = body;
      this.status  = init.status || 200;
      this.headers = new Map(Object.entries(init.headers || {}));
      this.headers.get = (k) => this.headers.has(k.toLowerCase())
        ? this.headers.get(k.toLowerCase())
        : null;
      this._body   = body;
      this.ok      = this.status >= 200 && this.status < 300;
    }
    async json () {
      if (typeof this._body === 'string') return JSON.parse(this._body);
      return this._body;
    }
    async text () {
      if (typeof this._body === 'string') return this._body;
      return JSON.stringify(this._body);
    }
  };
}

/* ========================================================================== */
/* Import the module                                                           */
/* ========================================================================== */

const {
  byokRelayPlugin,
  createRelayRouteHandler,
  ByokRelayClient,
} = require('../src/index.js');

;(async function main () {

/* ========================================================================== */
/* 1. Module exports                                                           */
/* ========================================================================== */

console.log('\n--- 1. Module exports ---');
assert(typeof byokRelayPlugin     === 'function', 'byokRelayPlugin is a function');
assert(typeof createRelayRouteHandler === 'function', 'createRelayRouteHandler is a function');
assert(typeof ByokRelayClient     === 'function', 'ByokRelayClient is a class (function)');

/* ========================================================================== */
/* 2. byokRelayPlugin — called without Elysia installed                       */
/* ========================================================================== */

console.log('\n--- 2. byokRelayPlugin (no elysia installed) ---');
{
  // When elysia is not installed the plugin factory should throw
  try {
    byokRelayPlugin();
    assert(false, 'should have thrown when elysia not installed');
  } catch (err) {
    assert(
      err.message.includes('@byok-relay/elysia') || err.message.includes('elysia'),
      'throws descriptive error when elysia peer dep is missing'
    );
  }
}

/* ========================================================================== */
/* 3. createRelayRouteHandler — behaviour tests                               */
/* ========================================================================== */

console.log('\n--- 3. createRelayRouteHandler ---');

async function runHandlerTests () {
  // 3.1 Returns a function
  const handler = createRelayRouteHandler({ relayUrl: 'http://relay.test' });
  assert(typeof handler === 'function', 'returns a handler function');

  // Helper to build a mock Elysia context
  function makeCtx ({ method = 'GET', url = 'http://app/relay/models', headers = {}, params = {}, body = null } = {}) {
    const reqHeaders = new Headers(headers);
    return {
      request: {
        method,
        url,
        headers: reqHeaders,
        arrayBuffer: async () => body ? Buffer.from(JSON.stringify(body)) : new ArrayBuffer(0),
      },
      params: { '*': params['*'] || url.replace(/^http:\/\/app\/relay\//, '') },
      query:  {},
    };
  }

  // 3.2 GET /models — proxied to upstream
  {
    let capturedUrl;
    _mockFetchResponse = (url) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ models: [] }), {
        status:  200,
        headers: { 'content-type': 'application/json' },
      });
    };
    // Need to mock Response.body for pipe-through
    global.Response = class Response {
      constructor (body, init = {}) {
        this.body   = body;
        this.status = init.status || 200;
        const h     = new Map();
        Object.entries(init.headers || {}).forEach(([k, v]) => h.set(k.toLowerCase(), v));
        this.headers = { forEach: (fn) => h.forEach((v, k) => fn(v, k)), get: (k) => h.get(k.toLowerCase()) };
        this.ok     = this.status >= 200 && this.status < 300;
        this._text  = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
      }
      async json () { return JSON.parse(this._text); }
      async text () { return this._text; }
    };

    const ctx = makeCtx({ method: 'GET', url: 'http://app/relay/models', params: { '*': 'models' } });
    const res = await handler(ctx);
    assert(res instanceof Response || (res && typeof res.status === 'number'), 'returns a Response');
    assert(capturedUrl && capturedUrl.includes('models'), 'forwards to correct upstream path');
  }

  // 3.3 app_id allowlist — allowed
  {
    let status;
    _mockFetchResponse = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    const allowedHandler = createRelayRouteHandler({
      relayUrl:      'http://relay.test',
      allowedAppIds: ['app-1'],
    });
    const ctx = makeCtx({ headers: { 'x-app-id': 'app-1' }, params: { '*': 'relay' } });
    const res = await allowedHandler(ctx);
    assert(res.status !== 403, 'allowed app_id passes through');
  }

  // 3.4 app_id allowlist — blocked
  {
    const blockedHandler = createRelayRouteHandler({
      relayUrl:      'http://relay.test',
      allowedAppIds: ['app-1'],
    });
    const ctx = makeCtx({ headers: { 'x-app-id': 'app-EVIL' }, params: { '*': 'relay' } });
    const res = await blockedHandler(ctx);
    assert(res.status === 403, 'blocked app_id returns 403');
  }

  // 3.5 Timeout → 504
  {
    _mockFetchResponse = () => new Promise((_, reject) => {
      const err = new Error('The operation was aborted.');
      err.name  = 'AbortError';
      setTimeout(() => reject(err), 10);
    });
    const timeoutHandler = createRelayRouteHandler({
      relayUrl:  'http://relay.test',
      timeoutMs: 1, // 1 ms — will abort before mock resolves
    });
    const ctx = makeCtx({ params: { '*': 'relay' }, method: 'POST' });
    const res = await timeoutHandler(ctx);
    assert(res.status === 504, 'timeout returns 504');
  }

  // 3.6 Network error → 502
  {
    _mockFetchResponse = () => Promise.reject(new Error('ECONNREFUSED'));
    const ctx = makeCtx({ params: { '*': 'relay' }, method: 'POST' });
    const res = await handler(ctx);
    assert(res.status === 502, 'network error returns 502');
  }

  // 3.7 POST body forwarded (not null)
  {
    let capturedInit;
    _mockFetchResponse = (url, init) => {
      capturedInit = init;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const ctx = makeCtx({
      method: 'POST',
      url:    'http://app/relay/relay',
      params: { '*': 'relay' },
      body:   { model: 'openai/gpt-4o', messages: [] },
    });
    await handler(ctx);
    assert(capturedInit && capturedInit.body !== undefined, 'POST body forwarded');
    assert(capturedInit.method === 'POST', 'method preserved');
  }

  // 3.8 GET body is undefined (no body on GET)
  {
    let capturedInit;
    _mockFetchResponse = (url, init) => {
      capturedInit = init;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const ctx = makeCtx({ method: 'GET', url: 'http://app/relay/models', params: { '*': 'models' } });
    await handler(ctx);
    assert(capturedInit.body === undefined, 'GET has no body forwarded');
  }

  // Reset mock
  _mockFetchResponse = null;
}

await runHandlerTests();

/* ========================================================================== */
/* 4. ByokRelayClient                                                         */
/* ========================================================================== */

console.log('\n--- 4. ByokRelayClient ---');

async function runClientTests () {
  const client = new ByokRelayClient({ relayUrl: 'http://relay.test', appId: 'test-app' });

  // 4.1 Starts with no token
  assert(client._token === null, 'starts with no token');

  // 4.2 register() stores token
  _mockFetchResponse = () => new Response(JSON.stringify({ token: 'tok-test-123', user_id: 'u1' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const reg = await client.register({ appId: 'test-app' });
  assert(reg.token === 'tok-test-123', 'register returns token');
  assert(client._token === 'tok-test-123', 'token stored on instance');

  // 4.3 ensureToken returns existing token
  _mockFetchResponse = null;
  const tok = await client.ensureToken();
  assert(tok === 'tok-test-123', 'ensureToken returns existing token without re-registering');

  // 4.4 logout clears token
  client.logout();
  assert(client._token === null, 'logout clears token');

  // 4.5 storeKey
  _mockFetchResponse = (url) => {
    assert(url.includes('/keys/openai'), 'storeKey calls /keys/openai');
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  // Need a fresh token first
  client._token = 'tok-test-123';
  await client.storeKey('openai', 'sk-test');

  // 4.6 listKeys
  _mockFetchResponse = (url) => {
    assert(url.includes('/keys'), 'listKeys calls /keys');
    return new Response(JSON.stringify({ keys: ['openai'] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const keys = await client.listKeys();
  assert(Array.isArray(keys.keys), 'listKeys returns keys array');

  // 4.7 deleteKey
  _mockFetchResponse = (url, init) => {
    assert(init.method === 'DELETE', 'deleteKey uses DELETE');
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await client.deleteKey('openai');

  // 4.8 rotateKey
  _mockFetchResponse = (url) => {
    assert(url.includes('/rotate'), 'rotateKey calls /rotate endpoint');
    return new Response(JSON.stringify({ ok: true, rotated: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const rot = await client.rotateKey('openai', 'sk-new');
  assert(rot.rotated === true, 'rotateKey returns rotated:true');

  // 4.9 chat
  _mockFetchResponse = () => new Response(
    JSON.stringify({ choices: [{ message: { content: 'Hello!' } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
  const reply = await client.chat({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'Hi' }] });
  assert(reply === 'Hello!', 'chat returns message content');

  // 4.10 chat with systemPrompt prepends system message
  let capturedBody;
  _mockFetchResponse = (url, init) => {
    capturedBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
  await client.chat({
    model:        'openai/gpt-4o',
    messages:     [{ role: 'user', content: 'Hi' }],
    systemPrompt: 'You are helpful.',
  });
  assert(
    capturedBody.messages[0].role === 'system' && capturedBody.messages[0].content === 'You are helpful.',
    'systemPrompt prepended as system message'
  );

  // 4.11 health
  _mockFetchResponse = (url) => {
    assert(!url.includes('deep'), 'health calls /health without deep by default');
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const h = await client.health();
  assert(h.status === 'ok', 'health returns status:ok');

  // 4.12 health(deep=true)
  _mockFetchResponse = (url) => {
    assert(url.includes('deep=1'), 'health(true) calls /health?deep=1');
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await client.health(true);

  // 4.13 stats
  _mockFetchResponse = (url) => {
    assert(url.includes('/stats'), 'stats calls /stats');
    return new Response(JSON.stringify({ requests: 42 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const s = await client.stats();
  assert(s.requests === 42, 'stats returns data');

  // 4.14 getModels
  _mockFetchResponse = (url) => {
    assert(url.includes('/models'), 'getModels calls /models');
    return new Response(JSON.stringify({ restricted: false, allowed_models: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const m = await client.getModels();
  assert(typeof m.restricted === 'boolean', 'getModels returns models object');

  // 4.15 deleteAccount clears token
  _mockFetchResponse = (url, init) => {
    assert(init.method === 'DELETE', 'deleteAccount uses DELETE');
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  client._token = 'tok-test-123';
  await client.deleteAccount();
  assert(client._token === null, 'deleteAccount clears token');

  // 4.16 custom storage adapter
  const store = {};
  const customStorage = {
    getItem:    (k) => store[k] || null,
    setItem:    (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  const client2 = new ByokRelayClient({
    relayUrl: 'http://relay.test',
    storage:  customStorage,
  });
  _mockFetchResponse = () => new Response(JSON.stringify({ token: 'tok-custom', user_id: 'u2' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  await client2.register({ appId: 'test' });
  assert(store['byok_relay_token'] === 'tok-custom', 'custom storage adapter used for token');

  // 4.17 relayRequest
  let capturedRelayUrl;
  _mockFetchResponse = (url) => {
    capturedRelayUrl = url;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  client2._token = 'tok-custom';
  const rawRes = await client2.relayRequest('/relay', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ model: 'openai/gpt-4o', messages: [] }),
  });
  assert(capturedRelayUrl && capturedRelayUrl.includes('/relay'), 'relayRequest forwards to /relay');

  // 4.18 streamChat — async generator
  {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
      'data: {"choices":[{"delta":{"content":" World"}}]}\n',
      'data: [DONE]\n',
    ];
    let idx = 0;
    const enc = new TextEncoder();
    _mockFetchResponse = () => {
      const stream = new ReadableStream({
        pull (controller) {
          if (idx < chunks.length) {
            controller.enqueue(enc.encode(chunks[idx++]));
          } else {
            controller.close();
          }
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    client2._token = 'tok-custom';
    const collected = [];
    for await (const chunk of client2.streamChat({
      model:    'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      collected.push(chunk);
    }
    assert(collected.join('') === 'Hello World', 'streamChat yields text chunks');
  }

  _mockFetchResponse = null;
}

await runClientTests();

/* ========================================================================== */
/* 5. _resolveRelayUrl priority                                               */
/* ========================================================================== */

console.log('\n--- 5. Relay URL resolution ---');
{
  const client = new ByokRelayClient({});
  assert(
    client._relayUrl === 'https://relay.byokrelay.com',
    'defaults to managed relay when no env or option set'
  );

  const clientOpt = new ByokRelayClient({ relayUrl: 'http://custom.relay' });
  assert(clientOpt._relayUrl === 'http://custom.relay', 'explicit option wins over env');
}

/* ========================================================================== */
/* 6. Hop-by-hop header filtering                                             */
/* ========================================================================== */

console.log('\n--- 6. Header filtering ---');
{
  // Access private helper through a call
  const handler = createRelayRouteHandler({ relayUrl: 'http://relay.test' });
  let capturedHeaders;
  _mockFetchResponse = (url, init) => {
    capturedHeaders = init.headers;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const hopHeaders = new Headers({
    'authorization':    'Bearer tok',
    'content-type':     'application/json',
    'transfer-encoding': 'chunked',   // hop-by-hop — must be stripped
    'connection':        'keep-alive', // hop-by-hop — must be stripped
  });

  const ctx = {
    request: {
      method:        'POST',
      url:           'http://app/relay/relay',
      headers:       hopHeaders,
      arrayBuffer:   async () => Buffer.from(JSON.stringify({ model: 'x', messages: [] })),
    },
    params: { '*': 'relay' },
    query:  {},
  };

  await handler(ctx);
  assert(!('transfer-encoding' in capturedHeaders), 'transfer-encoding stripped');
  assert(!('connection' in capturedHeaders), 'connection stripped');
  assert(capturedHeaders['authorization'] === 'Bearer tok', 'authorization forwarded');

  _mockFetchResponse = null;
}

/* ========================================================================== */
/* Results                                                                     */
/* ========================================================================== */

console.log(`\n========================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`========================================\n`);
process.exit(failed > 0 ? 1 : 0);

})().catch((err) => { console.error(err); process.exit(1); });

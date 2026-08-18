/**
 * @byok-relay/astro — smoke test suite
 *
 * Run: node test/integration.test.js
 *
 * Tests run entirely in Node (no Astro runtime, no DOM).
 * We exercise ByokRelayClient, createByokRelayMiddleware, and createRelayApiRoute
 * directly, mocking fetch and localStorage where needed.
 */

'use strict';

const { createHash, createHmac } = require('crypto');

/* ─── Test framework ─────────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;
const queue = [];

function test (name, fn) {
  queue.push({ name, fn });
}

async function runAll () {
  for (const { name, fn } of queue) {
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
}

function assert (condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}
function assertEqual (a, b) {
  if (a !== b) throw new Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assertIncludes (str, sub) {
  if (!str.includes(sub)) throw new Error(`Expected "${str}" to include "${sub}"`);
}

let nonceCounter = 0;
function signedAppHeaders ({ appId, secret, method = 'GET', path = '/api/relay/users', search = '', timestamp = Date.now(), body = '', nonce = `nonce-${++nonceCounter}` }) {
  const timestampText = String(timestamp);
  const bodyDigest = ['GET', 'HEAD'].includes(method.toUpperCase())
    ? ''
    : createHash('sha256').update(body).digest('hex');
  const payload = [method.toUpperCase(), path, search, timestampText, appId, bodyDigest, nonce].join('\n');
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  return new Headers({
    'x-app-id': appId,
    'x-app-timestamp': timestampText,
    'x-app-nonce': nonce,
    'x-app-signature': `sha256=${signature}`,
  });
}

/* ─── localStorage shim ──────────────────────────────────────────────────── */

const _store = {};
global.window = {
  localStorage: {
    getItem:    (k) => _store[k] ?? null,
    setItem:    (k, v) => { _store[k] = v; },
    removeItem: (k) => { delete _store[k]; },
  },
};

/* ─── fetch mock helpers ─────────────────────────────────────────────────── */

function mockFetch (handler) {
  global.fetch = handler;
}

function simpleFetchOk (body) {
  return () => Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { entries: () => [][Symbol.iterator]() },
    json: () => Promise.resolve(body),
    body: JSON.stringify(body),
  });
}

/* ─── Headers / Response shims (safe for Node 18 which already has them) ─── */

if (typeof global.Headers === 'undefined') {
  global.Headers = class Headers {
    constructor (init) {
      this._map = {};
      if (init && typeof init === 'object' && !Array.isArray(init)) {
        for (const k of Object.keys(init)) this._map[k.toLowerCase()] = init[k];
      }
    }
    set (k, v) { this._map[k.toLowerCase()] = v; }
    get (k) { return this._map[k.toLowerCase()] ?? null; }
    has (k) { return k.toLowerCase() in this._map; }
    entries () { return Object.entries(this._map)[Symbol.iterator](); }
    [Symbol.iterator] () { return this.entries(); }
  };
}

if (typeof global.Response === 'undefined') {
  global.Response = class Response {
    constructor (body, init = {}) {
      this.body = body;
      this.status = init.status || 200;
      this.statusText = init.statusText || 'OK';
      this.headers = init.headers || new Headers();
      this.ok = this.status >= 200 && this.status < 300;
    }
    async json () { return JSON.parse(this.body || '{}'); }
    async text () { return String(this.body || ''); }
  };
}

if (typeof global.Request === 'undefined') {
  global.Request = class Request {
    constructor (url, init = {}) {
      this.url = url;
      this.method = init.method || 'GET';
      this.headers = init.headers instanceof Headers
        ? init.headers
        : new Headers(init.headers || {});
      this.body = init.body || null;
    }
  };
}

/* ─── Load module ────────────────────────────────────────────────────────── */

const {
  createByokRelayMiddleware,
  createRelayApiRoute,
  ByokRelayClient,
  DEFAULT_RELAY_URL,
  DEFAULT_RELAY_PATH_PREFIX,
} = require('../src/index.js');

/* ─── Clear _store between tests ─────────────────────────────────────────── */

function clearStore () {
  for (const k of Object.keys(_store)) delete _store[k];
}

/* ======================================================================== */
/* Tests — all queued; run serially via runAll()                            */
/* ======================================================================== */

console.log('\n@byok-relay/astro smoke tests\n');

/* ─── Exports ─────────────────────────────────────────────────────────────── */

console.log('── Exports ──');

test('createByokRelayMiddleware is a function', () => {
  assert(typeof createByokRelayMiddleware === 'function');
});

test('createRelayApiRoute is a function', () => {
  assert(typeof createRelayApiRoute === 'function');
});

test('ByokRelayClient is a class/function', () => {
  assert(typeof ByokRelayClient === 'function');
});

test('DEFAULT_RELAY_URL is the hosted relay', () => {
  assertEqual(DEFAULT_RELAY_URL, 'https://relay.byokrelay.com');
});

test('DEFAULT_RELAY_PATH_PREFIX is /api/relay', () => {
  assertEqual(DEFAULT_RELAY_PATH_PREFIX, '/api/relay');
});

/* ─── ByokRelayClient construction ─────────────────────────────────────── */

console.log('\n── ByokRelayClient construction ──');

test('constructs with defaults', () => {
  clearStore();
  const c = new ByokRelayClient({});
  assertEqual(c._relayUrl, 'https://relay.byokrelay.com');
  assertEqual(c._appId, 'astro-app');
  assertEqual(c._storageKey, 'byok_relay_token');
  assertEqual(c.token, null);
});

test('constructs with custom relayUrl (strips trailing slash)', () => {
  const c = new ByokRelayClient({ relayUrl: 'http://localhost:3000/', appId: 'test' });
  assertEqual(c._relayUrl, 'http://localhost:3000');
});

test('constructs with server proxy path (/api/relay)', () => {
  const c = new ByokRelayClient({ relayUrl: '/api/relay', appId: 'proxy-app' });
  assertEqual(c._relayUrl, '/api/relay');
});

test('restores token from localStorage if present', () => {
  clearStore();
  _store['byok_relay_token'] = 'tok_existing';
  const c = new ByokRelayClient({});
  assertEqual(c.token, 'tok_existing');
  clearStore();
});

/* ─── ByokRelayClient register ─────────────────────────────────────────── */

console.log('\n── ByokRelayClient.register ──');

test('register posts to /users and stores token', async () => {
  clearStore();
  const c = new ByokRelayClient({ relayUrl: 'http://relay', appId: 'a1' });
  let capturedUrl, capturedBody;
  mockFetch((url, init) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body);
    return Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      json: () => Promise.resolve({ token: 'tok_abc' }),
    });
  });
  const token = await c.register();
  assertEqual(token, 'tok_abc');
  assertEqual(capturedUrl, 'http://relay/users');
  assertEqual(capturedBody.app_id, 'a1');
  assertEqual(_store['byok_relay_token'], 'tok_abc');
});

test('register throws on failure', async () => {
  clearStore();
  const c = new ByokRelayClient({ relayUrl: 'http://relay', appId: 'a2' });
  mockFetch(() => Promise.resolve({
    ok: false, status: 401, statusText: 'Unauthorized',
    json: () => Promise.resolve({ error: 'Invalid app_id' }),
  }));
  let threw = false;
  try { await c.register(); } catch (e) {
    threw = true;
    assertIncludes(e.message, 'Invalid app_id');
  }
  assert(threw, 'should have thrown');
});

/* ─── ByokRelayClient ensureToken ───────────────────────────────────────── */

console.log('\n── ByokRelayClient.ensureToken ──');

test('ensureToken returns existing token without re-registering', async () => {
  clearStore();
  const c = new ByokRelayClient({});
  c._token = 'tok_existing_2';
  let called = false;
  mockFetch(() => { called = true; return Promise.resolve({ ok: true, json: () => ({}) }); });
  const tok = await c.ensureToken();
  assertEqual(tok, 'tok_existing_2');
  assert(!called, 'should not call fetch');
});

test('ensureToken registers if no token', async () => {
  clearStore();
  const c = new ByokRelayClient({ relayUrl: 'http://relay', appId: 'ensure-test' });
  c._token = null;
  mockFetch(() => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ token: 'tok_new' }),
  }));
  const tok = await c.ensureToken();
  assertEqual(tok, 'tok_new');
});

/* ─── ByokRelayClient logout ────────────────────────────────────────────── */

console.log('\n── ByokRelayClient.logout ──');

test('logout clears token and localStorage', () => {
  clearStore();
  const c = new ByokRelayClient({ storageKey: 'byok_test_logout' });
  c._token = 'tok_to_clear';
  _store['byok_test_logout'] = 'tok_to_clear';
  c.logout();
  assert(c.token === null, 'token should be null');
  assert(!_store['byok_test_logout'], 'localStorage should be cleared');
});

/* ─── ByokRelayClient storeKey ──────────────────────────────────────────── */

console.log('\n── ByokRelayClient.storeKey ──');

test('storeKey posts to /keys/:provider', async () => {
  clearStore();
  const c = new ByokRelayClient({ relayUrl: 'http://relay', appId: 'sk-test' });
  c._token = 'tok_sk';
  let capturedUrl;
  mockFetch((url) => {
    capturedUrl = url;
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ ok: true }),
    });
  });
  await c.storeKey('openai', 'sk-abc123');
  assertEqual(capturedUrl, 'http://relay/keys/openai');
});

/* ─── ByokRelayClient chat ──────────────────────────────────────────────── */

console.log('\n── ByokRelayClient.chat ──');

test('chat posts to /relay/:provider/chat/completions', async () => {
  clearStore();
  const c = new ByokRelayClient({ relayUrl: 'http://relay', appId: 'chat-test' });
  c._token = 'tok_chat';
  let capturedUrl;
  mockFetch((url) => {
    capturedUrl = url;
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'Hello from GPT' } }],
      }),
    });
  });
  const reply = await c.chat({
    provider: 'openai',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assertEqual(reply, 'Hello from GPT');
  assertEqual(capturedUrl, 'http://relay/relay/openai/chat/completions');
});

test('chat handles Anthropic response format', async () => {
  clearStore();
  const c = new ByokRelayClient({ relayUrl: 'http://relay', appId: 'chat-anthropic' });
  c._token = 'tok_ant';
  mockFetch(() => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({
      content: [{ text: 'Hello from Claude' }],
    }),
  }));
  const reply = await c.chat({
    provider: 'anthropic',
    model: 'claude-3-5-haiku-20241022',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assertEqual(reply, 'Hello from Claude');
});

test('chat injects systemPrompt', async () => {
  clearStore();
  const c = new ByokRelayClient({ relayUrl: 'http://relay', appId: 'sp-test' });
  c._token = 'tok_sp';
  let capturedBody;
  mockFetch((url, init) => {
    capturedBody = JSON.parse(init.body);
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] }),
    });
  });
  await c.chat({
    provider: 'openai',
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'test' }],
    systemPrompt: 'You are a helper.',
  });
  assertEqual(capturedBody.messages[0].role, 'system');
  assertEqual(capturedBody.messages[0].content, 'You are a helper.');
});

test('chat throws on error response', async () => {
  clearStore();
  const c = new ByokRelayClient({ relayUrl: 'http://relay', appId: 'err-test' });
  c._token = 'tok_err';
  mockFetch(() => Promise.resolve({
    ok: false, status: 401,
    json: () => Promise.resolve({ error: 'Unauthorized' }),
  }));
  let threw = false;
  try {
    await c.chat({ provider: 'openai', model: 'gpt-4o', messages: [] });
  } catch (e) {
    threw = true;
    assertIncludes(e.message, 'Unauthorized');
  }
  assert(threw, 'should have thrown');
});

/* ─── ByokRelayClient health ────────────────────────────────────────────── */

console.log('\n── ByokRelayClient.health ──');

test('health fetches /health', async () => {
  const c = new ByokRelayClient({ relayUrl: 'http://relay' });
  let capturedUrl;
  mockFetch((url) => {
    capturedUrl = url;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ status: 'ok' }),
    });
  });
  const h = await c.health();
  assertEqual(capturedUrl, 'http://relay/health');
  assertEqual(h.status, 'ok');
});

test('health with deep=true fetches /health?deep=1', async () => {
  const c = new ByokRelayClient({ relayUrl: 'http://relay' });
  let capturedUrl;
  mockFetch((url) => {
    capturedUrl = url;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ status: 'ok' }),
    });
  });
  await c.health(true);
  assertEqual(capturedUrl, 'http://relay/health?deep=1');
});

/* ─── ByokRelayClient getModels ─────────────────────────────────────────── */

console.log('\n── ByokRelayClient.getModels ──');

test('getModels fetches /models', async () => {
  const c = new ByokRelayClient({ relayUrl: 'http://relay' });
  let capturedUrl;
  mockFetch((url) => {
    capturedUrl = url;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ models: ['openai', 'anthropic'] }),
    });
  });
  const m = await c.getModels();
  assertEqual(capturedUrl, 'http://relay/models');
  assert(Array.isArray(m.models));
});

/* ─── createByokRelayMiddleware ─────────────────────────────────────────── */

console.log('\n── createByokRelayMiddleware ──');

test('middleware calls next() for non-matching paths', async () => {
  const mw = createByokRelayMiddleware({ relayUrl: 'http://relay' });
  let nextCalled = false;
  const context = {
    request: new Request('http://localhost:4321/about'),
  };
  await mw(context, () => { nextCalled = true; return new Response('ok'); });
  assert(nextCalled, 'next() should be called for /about');
});

test('middleware proxies matching path prefix', async () => {
  const mw = createByokRelayMiddleware({
    relayUrl: 'http://relay',
    pathPrefix: '/api/relay',
  });
  let capturedUpstreamUrl;
  mockFetch((url) => {
    capturedUpstreamUrl = url;
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ status: 'ok' }),
    });
  });
  const context = {
    request: new Request('http://localhost:4321/api/relay/health'),
  };
  const resp = await mw(context, () => { throw new Error('should not call next'); });
  assertEqual(resp.status, 200);
  assertEqual(capturedUpstreamUrl, 'http://relay/health');
});

test('middleware cancels proxy timeout after upstream headers arrive', async () => {
  const mw = createByokRelayMiddleware({
    relayUrl: 'http://relay',
    pathPrefix: '/api/relay',
    timeoutMs: 10,
  });
  let capturedSignal;
  mockFetch((url, init) => {
    capturedSignal = init.signal;
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({}),
      body: '{}',
    });
  });
  const context = { request: new Request('http://localhost:4321/api/relay/stream') };
  await mw(context, () => { throw new Error('should not call next'); });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert(capturedSignal && capturedSignal.aborted === false, 'timeout should be canceled after fetch returns headers');
});

test('middleware strips prefix correctly for sub-paths', async () => {
  const mw = createByokRelayMiddleware({ relayUrl: 'http://relay', pathPrefix: '/api/relay' });
  let capturedUrl;
  mockFetch((url) => {
    capturedUrl = url;
    return Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers({}),
      body: '{}',
    });
  });
  const context = { request: new Request('http://localhost:4321/api/relay/keys/openai') };
  await mw(context, () => {});
  assertEqual(capturedUrl, 'http://relay/keys/openai');
});

test('middleware blocks unsigned app_id', async () => {
  const mw = createByokRelayMiddleware({
    relayUrl: 'http://relay',
    pathPrefix: '/api/relay',
    allowedApps: ['allowed-app'],
    appSecrets: { 'allowed-app': 'server-secret' },
  });
  const context = {
    request: new Request('http://localhost:4321/api/relay/users', {
      headers: new Headers({ 'x-app-id': 'allowed-app' }),
    }),
  };
  const resp = await mw(context, () => {});
  assertEqual(resp.status, 403);
});

test('middleware rejects allowedApps without server verification', async () => {
  const mw = createByokRelayMiddleware({
    relayUrl: 'http://relay',
    pathPrefix: '/api/relay',
    allowedApps: ['good-app'],
  });
  const context = {
    request: new Request('http://localhost:4321/api/relay/users', {
      headers: new Headers({ 'x-app-id': 'good-app' }),
    }),
  };
  const resp = await mw(context, () => {});
  assertEqual(resp.status, 500);
});

test('middleware allows listed app_id with valid signature', async () => {
  const mw = createByokRelayMiddleware({
    relayUrl: 'http://relay',
    pathPrefix: '/api/relay',
    allowedApps: ['good-app'],
    appSecrets: { 'good-app': 'server-secret' },
  });
  let called = false;
  mockFetch(() => {
    called = true;
    return Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers({}),
      body: '{}',
    });
  });
  const context = {
    request: new Request('http://localhost:4321/api/relay/users', {
      headers: signedAppHeaders({ appId: 'good-app', secret: 'server-secret' }),
    }),
  };
  const resp = await mw(context, () => {});
  assertEqual(resp.status, 200);
  assert(called, 'fetch should have been called');
});

test('middleware accepts Set allowedApps and rejects replayed nonces', async () => {
  const mw = createByokRelayMiddleware({
    relayUrl: 'http://relay',
    pathPrefix: '/api/relay',
    allowedApps: new Set(['good-app']),
    appSecrets: { 'good-app': 'server-secret' },
  });
  mockFetch(() => Promise.resolve({
    ok: true, status: 200, statusText: 'OK',
    headers: new Headers({}),
    body: '{}',
  }));
  const headers = signedAppHeaders({ appId: 'good-app', secret: 'server-secret', nonce: 'replay-me' });
  let resp = await mw({ request: new Request('http://localhost:4321/api/relay/users', { headers }) }, () => {});
  assertEqual(resp.status, 200);
  resp = await mw({ request: new Request('http://localhost:4321/api/relay/users', { headers }) }, () => {});
  assertEqual(resp.status, 403);
});

test('middleware verifies appSecrets even when allowedApps is omitted', async () => {
  const mw = createByokRelayMiddleware({
    relayUrl: 'http://relay',
    pathPrefix: '/api/relay',
    appSecrets: { 'good-app': 'server-secret' },
  });
  let called = false;
  mockFetch(() => {
    called = true;
    return Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers({}),
      body: '{}',
    });
  });
  const resp = await mw({
    request: new Request('http://localhost:4321/api/relay/users', {
      headers: signedAppHeaders({ appId: 'good-app', secret: 'server-secret' }),
    }),
  }, () => {});
  assertEqual(resp.status, 200);
  assert(called, 'fetch should have been called');
});

test('middleware catches verifyApp failures', async () => {
  const mw = createByokRelayMiddleware({
    relayUrl: 'http://relay',
    pathPrefix: '/api/relay',
    verifyApp: () => { throw new Error('database down'); },
  });
  const resp = await mw({
    request: new Request('http://localhost:4321/api/relay/users', {
      headers: new Headers({ 'x-app-id': 'good-app' }),
    }),
  }, () => {});
  assertEqual(resp.status, 500);
});

test('middleware falls back to default tolerance for invalid values', async () => {
  const oldNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const mw = createByokRelayMiddleware({
      relayUrl: 'http://relay',
      pathPrefix: '/api/relay',
      allowedApps: ['good-app'],
      appSecrets: { 'good-app': 'server-secret' },
      appSignatureToleranceMs: '5m',
    });
    mockFetch(() => Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers({}),
      body: '{}',
    }));
    const resp = await mw({
      request: new Request('http://localhost:4321/api/relay/users', {
        headers: signedAppHeaders({ appId: 'good-app', secret: 'server-secret', timestamp: Date.now() - (10 * 60 * 1000) }),
      }),
    }, () => {});
    assertEqual(resp.status, 403);
  } finally {
    Date.now = oldNow;
  }
});

/* ─── createRelayApiRoute ───────────────────────────────────────────────── */

console.log('\n── createRelayApiRoute ──');

test('returns GET, POST, DELETE, PUT, PATCH, OPTIONS handlers', () => {
  const route = createRelayApiRoute({ relayUrl: 'http://relay' });
  assert(typeof route.GET === 'function');
  assert(typeof route.POST === 'function');
  assert(typeof route.DELETE === 'function');
  assert(typeof route.PUT === 'function');
  assert(typeof route.PATCH === 'function');
  assert(typeof route.OPTIONS === 'function');
});

test('GET handler proxies to relay with correct sub-path', async () => {
  const route = createRelayApiRoute({ relayUrl: 'http://relay' });
  let capturedUrl;
  mockFetch((url) => {
    capturedUrl = url;
    return Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: '{"status":"ok"}',
    });
  });
  const req = new Request('http://localhost:4321/api/relay/health');
  const resp = await route.GET({ request: req, params: { path: 'health' } });
  assertEqual(capturedUrl, 'http://relay/health');
  assertEqual(resp.status, 200);
});

test('route cancels proxy timeout after upstream headers arrive', async () => {
  const route = createRelayApiRoute({ relayUrl: 'http://relay', timeoutMs: 10 });
  let capturedSignal;
  mockFetch((url, init) => {
    capturedSignal = init.signal;
    return Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers({}),
      body: '{}',
    });
  });
  const req = new Request('http://localhost:4321/api/relay/stream');
  await route.GET({ request: req, params: { path: 'stream' } });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert(capturedSignal && capturedSignal.aborted === false, 'timeout should be canceled after fetch returns headers');
});

test('POST handler proxies with correct method', async () => {
  const route = createRelayApiRoute({ relayUrl: 'http://relay' });
  let capturedMethod;
  mockFetch((url, init) => {
    capturedMethod = init.method;
    return Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers({}),
      body: '{"token":"tok_123"}',
    });
  });
  const req = new Request('http://localhost:4321/api/relay/users', {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ app_id: 'test' }),
  });
  const resp = await route.POST({ request: req, params: { path: 'users' } });
  assertEqual(capturedMethod, 'POST');
});

test('route handles missing path param (root)', async () => {
  const route = createRelayApiRoute({ relayUrl: 'http://relay' });
  let capturedUrl;
  mockFetch((url) => {
    capturedUrl = url;
    return Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers({}),
      body: '{}',
    });
  });
  const req = new Request('http://localhost:4321/api/relay/');
  await route.GET({ request: req, params: {} }); // no path param
  assertEqual(capturedUrl, 'http://relay/');
});

test('route handler blocks disallowed app_id', async () => {
  const route = createRelayApiRoute({
    relayUrl: 'http://relay',
    allowedApps: ['good-app'],
    appSecrets: { 'good-app': 'server-secret' },
  });
  const req = new Request('http://localhost:4321/api/relay/users', {
    headers: new Headers({ 'x-app-id': 'bad-app' }),
  });
  const resp = await route.POST({ request: req, params: { path: 'users' } });
  assertEqual(resp.status, 403);
});

test('route handler allows listed app_id with valid body signature', async () => {
  const route = createRelayApiRoute({
    relayUrl: 'http://relay',
    allowedApps: ['good-app'],
    appSecrets: { 'good-app': 'server-secret' },
  });
  let called = false;
  mockFetch(() => {
    called = true;
    return Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers({}),
      body: '{}',
    });
  });
  const body = JSON.stringify({ app_id: 'good-app', model: 'gpt-4o' });
  const req = new Request('http://localhost:4321/api/relay/users', {
    method: 'POST',
    headers: signedAppHeaders({ appId: 'good-app', secret: 'server-secret', method: 'POST', body }),
    body,
  });
  const resp = await route.POST({ request: req, params: { path: 'users' } });
  assertEqual(resp.status, 200);
  assert(called, 'fetch should have been called');
});

test('route handler rejects a signature for a different body', async () => {
  const route = createRelayApiRoute({
    relayUrl: 'http://relay',
    allowedApps: ['good-app'],
    appSecrets: { 'good-app': 'server-secret' },
  });
  const req = new Request('http://localhost:4321/api/relay/users', {
    method: 'POST',
    headers: signedAppHeaders({ appId: 'good-app', secret: 'server-secret', method: 'POST', body: JSON.stringify({ app_id: 'good-app' }) }),
    body: JSON.stringify({ app_id: 'good-app', model: 'tampered' }),
  });
  const resp = await route.POST({ request: req, params: { path: 'users' } });
  assertEqual(resp.status, 403);
});

test('route returns 502 on upstream fetch error', async () => {
  const route = createRelayApiRoute({ relayUrl: 'http://relay' });
  mockFetch(() => Promise.reject(new Error('Network error')));
  const req = new Request('http://localhost:4321/api/relay/health');
  const resp = await route.GET({ request: req, params: { path: 'health' } });
  assertEqual(resp.status, 502);
});

/* ─── Run all tests ─────────────────────────────────────────────────────── */

runAll().then(() => {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});

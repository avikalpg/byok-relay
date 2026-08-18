/**
 * @byok-relay/next — smoke tests
 * Run with: node test/next.test.js
 * No external dependencies required.
 */

'use strict';

const assert = require('assert');

// ── Polyfills for Node < 18 ──────────────────────────────────────────────────
if (typeof globalThis.fetch === 'undefined') {
  globalThis.fetch = async (url, opts) => ({
    ok: true, status: 200,
    json: async () => ({ token: 'test-token', status: 'ok', providers: [] }),
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: new Map([['content-type', 'application/json']]),
    body: null,
    text: async () => '{}',
  });
}
if (typeof globalThis.AbortController === 'undefined') {
  globalThis.AbortController = class {
    constructor () { this.signal = { aborted: false }; }
    abort () { this.signal.aborted = true; }
  };
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class {
    decode (v, _) { return v ? v.toString('utf8') : ''; }
  };
}
if (typeof globalThis.Request === 'undefined') {
  class MockRequest {
    constructor (url, opts = {}) {
      this.url = url;
      this.method = opts.method || 'GET';
      this.headers = new Map(Object.entries(opts.headers || {}));
      this._body = opts.body;
    }
    get (key) { return this.headers.get(key); }
    async arrayBuffer () {
      if (!this._body) return new ArrayBuffer(0);
      if (this._body instanceof ArrayBuffer) return this._body;
      const buf = Buffer.from(JSON.stringify(this._body));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
  }
  // Give headers a proper entries() method
  MockRequest.prototype._fixHeaders = function () {
    const h = this.headers;
    if (!h.entries) {
      h.entries = () => Array.from(h).values
        ? Array.from(h)[Symbol.iterator]
        : [][Symbol.iterator]();
    }
  };
  globalThis.Request = MockRequest;
}
if (typeof globalThis.Response === 'undefined') {
  globalThis.Response = class {
    constructor (body, init = {}) {
      this.body = body;
      this.status = init.status || 200;
      this.headers = new Map(Object.entries(init.headers || {}));
    }
    async json () { return JSON.parse(this.body || '{}'); }
    async text () { return this.body ? this.body.toString() : ''; }
  };
}

const {
  createRelayRouteHandler,
  createRelayMiddleware,
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

/* ── createRelayRouteHandler ────────────────────────────────────────────────── */
console.log('\ncreateRelayRouteHandler');

test('returns all HTTP verb handlers', () => {
  const handlers = createRelayRouteHandler({ relayUrl: 'http://localhost:3000' });
  assert.strictEqual(typeof handlers.GET, 'function');
  assert.strictEqual(typeof handlers.POST, 'function');
  assert.strictEqual(typeof handlers.PUT, 'function');
  assert.strictEqual(typeof handlers.PATCH, 'function');
  assert.strictEqual(typeof handlers.DELETE, 'function');
  assert.strictEqual(typeof handlers.OPTIONS, 'function');
});

test('defaults relayUrl to managed relay when env var absent', () => {
  const origEnv = process.env.RELAY_URL;
  delete process.env.RELAY_URL;
  const handlers = createRelayRouteHandler();
  assert.strictEqual(typeof handlers.GET, 'function');
  process.env.RELAY_URL = origEnv;
});

test('OPTIONS returns 204 with CORS headers', async () => {
  const { OPTIONS } = createRelayRouteHandler({ relayUrl: 'http://localhost:3000' });
  const resp = await OPTIONS();
  assert.strictEqual(resp.status, 204);
});

/* ── createRelayMiddleware ──────────────────────────────────────────────────── */
console.log('\ncreateRelayMiddleware');

test('returns a function', () => {
  const mw = createRelayMiddleware({ relayUrl: 'http://localhost:3000' });
  assert.strictEqual(typeof mw, 'function');
});

test('returns undefined for non-matching paths (pass-through)', async () => {
  const mw = createRelayMiddleware({
    relayUrl: 'http://localhost:3000',
    pathPrefix: '/relay',
  });
  const req = { url: 'http://localhost:3001/other', method: 'GET', headers: new Map() };
  req.headers.get = (k) => null;
  const result = await mw(req);
  assert.strictEqual(result, undefined);
});

/* ── React hooks (exported, no-op without React) ─────────────────────────────── */
console.log('\nReact hooks (no-op stubs without React installed)');

test('useByokRelay returns expected shape', () => {
  const result = useByokRelay({ relayUrl: '/api/relay', appId: 'test' });
  assert.ok('token' in result);
  assert.ok('registerUser' in result);
  assert.ok('storeKey' in result);
  assert.ok('listKeys' in result);
  assert.ok('deleteKey' in result);
  assert.ok('rotateKey' in result);
  assert.ok('logout' in result);
});

test('useChat returns expected shape', () => {
  const result = useChat({ relayUrl: '/api/relay', token: 'tok', model: 'openai/gpt-4o' });
  assert.ok('messages' in result);
  assert.ok('sendMessage' in result);
  assert.ok('clearMessages' in result);
  assert.ok('loading' in result);
  assert.ok('error' in result);
});

test('useStreamingChat returns expected shape', () => {
  const result = useStreamingChat({ relayUrl: '/api/relay', token: 'tok' });
  assert.ok('messages' in result);
  assert.ok('streamingContent' in result);
  assert.ok('sendMessage' in result);
  assert.ok('stopStreaming' in result);
  assert.ok('clearMessages' in result);
  assert.ok('loading' in result);
  assert.ok('error' in result);
});

test('useRelayHealth returns expected shape', () => {
  const result = useRelayHealth({ relayUrl: '/api/relay', intervalMs: 0 });
  assert.ok('status' in result);
  assert.ok('latencyMs' in result);
  assert.ok('warnings' in result);
  assert.ok('loading' in result);
  assert.ok('error' in result);
  assert.ok('refetch' in result);
  assert.ok('check' in result);
});

/* ── ByokRelayClient ────────────────────────────────────────────────────────── */
console.log('\nByokRelayClient');

test('instantiates with default relayUrl', () => {
  const client = new ByokRelayClient();
  assert.ok(client);
});

test('instantiates with custom relayUrl', () => {
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  assert.strictEqual(client._base, 'http://localhost:3000');
});

test('accepts custom storage adapter', () => {
  const store = {};
  const storage = {
    getItem: (k) => store[k] || null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000', storage });
  client._storage.setItem('key', 'value');
  assert.strictEqual(client._storage.getItem('key'), 'value');
  client._storage.removeItem('key');
  assert.strictEqual(client._storage.getItem('key'), null);
});

const asyncTests = [];

asyncTests.push(asyncTest('register() calls /users and stores token', async () => {
  let capturedUrl, capturedBody;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      json: async () => ({ token: 'tok-abc123', expires_at: null }),
    };
  };
  const store = {};
  const storage = {
    getItem: (k) => store[k] || null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  const client = new ByokRelayClient({ relayUrl: 'http://relay', storage });
  const token = await client.register('my-app');
  assert.strictEqual(token, 'tok-abc123');
  assert.ok(capturedUrl.endsWith('/users'));
  assert.strictEqual(capturedBody.app_id, 'my-app');
  assert.strictEqual(storage.getItem('byok_token_my-app'), 'tok-abc123');
}));

asyncTests.push(asyncTest('ensureToken() returns stored token without fetch', async () => {
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return {}; };
  const store = { 'byok_token_test-app': 'existing-token' };
  const storage = {
    getItem: (k) => store[k] || null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  const client = new ByokRelayClient({ relayUrl: 'http://relay', storage });
  const token = await client.ensureToken('test-app');
  assert.strictEqual(token, 'existing-token');
  assert.strictEqual(fetchCalled, false);
}));

asyncTests.push(asyncTest('storeKey() calls /keys/:provider with auth header', async () => {
  let capturedUrl, capturedHeaders;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const client = new ByokRelayClient({ relayUrl: 'http://relay' });
  client._token = 'my-token';
  await client.storeKey('openai', 'sk-test-key');
  assert.ok(capturedUrl.endsWith('/keys/openai'));
  assert.strictEqual(capturedHeaders['authorization'], 'Bearer my-token');
}));

asyncTests.push(asyncTest('listKeys() returns providers array', async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ providers: ['openai', 'anthropic'] }),
  });
  const client = new ByokRelayClient({ relayUrl: 'http://relay' });
  client._token = 'tok';
  const keys = await client.listKeys();
  assert.deepStrictEqual(keys, ['openai', 'anthropic']);
}));

asyncTests.push(asyncTest('deleteKey() calls DELETE /keys/:provider', async () => {
  let capturedUrl, capturedMethod;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedMethod = opts.method;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const client = new ByokRelayClient({ relayUrl: 'http://relay' });
  client._token = 'tok';
  await client.deleteKey('anthropic');
  assert.ok(capturedUrl.endsWith('/keys/anthropic'));
  assert.strictEqual(capturedMethod, 'DELETE');
}));

asyncTests.push(asyncTest('rotateKey() calls POST /keys/:provider/rotate', async () => {
  let capturedUrl, capturedBody;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ ok: true, rotated: true }) };
  };
  const client = new ByokRelayClient({ relayUrl: 'http://relay' });
  client._token = 'tok';
  const result = await client.rotateKey('openai', 'sk-new-key');
  assert.ok(capturedUrl.endsWith('/keys/openai/rotate'));
  assert.strictEqual(capturedBody.api_key, 'sk-new-key');
  assert.ok(result.rotated);
}));

asyncTests.push(asyncTest('chat() calls /relay and returns assistant content', async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: 'Hello from AI' } }],
    }),
  });
  const client = new ByokRelayClient({ relayUrl: 'http://relay' });
  client._token = 'tok';
  const reply = await client.chat({
    model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  assert.strictEqual(reply, 'Hello from AI');
}));

asyncTests.push(asyncTest('health() calls /health and returns data', async () => {
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    json: async () => ({ status: 'ok', uptime: 1234, warnings: [] }),
  });
  const client = new ByokRelayClient({ relayUrl: 'http://relay' });
  const result = await client.health();
  assert.strictEqual(result.status, 'ok');
}));

asyncTests.push(asyncTest('getModels() calls /models', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return {
      ok: true, status: 200,
      json: async () => ({ restricted: true, allowed_models: ['gpt-4o', 'claude-3-5-sonnet-20241022'] }),
    };
  };
  const client = new ByokRelayClient({ relayUrl: 'http://relay' });
  const result = await client.getModels();
  assert.ok(capturedUrl.endsWith('/models'));
  assert.ok(Array.isArray(result.allowed_models));
}));

asyncTests.push(asyncTest('stats() calls /stats with auth', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => ({ requests: 42, errors: 0 }) };
  };
  const client = new ByokRelayClient({ relayUrl: 'http://relay' });
  client._token = 'tok';
  await client.stats();
  assert.ok(capturedUrl.endsWith('/stats'));
}));

asyncTests.push(asyncTest('logout() clears token from storage and memory', async () => {
  const store = { 'byok_token_app': 'tok-xyz' };
  const storage = {
    getItem: (k) => store[k] || null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  const client = new ByokRelayClient({ relayUrl: 'http://relay', storage });
  client._token = 'tok-xyz';
  client.logout('app');
  assert.strictEqual(client._token, null);
  assert.strictEqual(storage.getItem('byok_token_app'), null);
}));

asyncTests.push(asyncTest('streamChat() yields text deltas from SSE stream', async () => {
  const sseLines = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    'data: {"choices":[{"delta":{"content":" world"}}]}',
    'data: [DONE]',
  ].join('\n');

  const encoder = typeof TextEncoder !== 'undefined'
    ? new TextEncoder()
    : { encode: (s) => Buffer.from(s) };
  const encoded = encoder.encode(sseLines);

  globalThis.fetch = async () => ({
    ok: true, status: 200,
    body: {
      getReader () {
        let done = false;
        return {
          async read () {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: encoded };
          },
          releaseLock () {},
        };
      },
    },
  });

  const client = new ByokRelayClient({ relayUrl: 'http://relay' });
  client._token = 'tok';
  const deltas = [];
  for await (const delta of client.streamChat({
    model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: 'Hi' }],
  })) {
    deltas.push(delta);
  }
  assert.deepStrictEqual(deltas, ['Hello', ' world']);
}));

asyncTests.push(asyncTest('streamChat() preserves SSE lines split across chunks', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hel',
    'lo"}}]}\ndata: {"choices":[{"delta":{"content":" world"}}]}',
    '\ndata: [DONE]',
  ];

  const encoder = typeof TextEncoder !== 'undefined'
    ? new TextEncoder()
    : { encode: (s) => Buffer.from(s) };

  globalThis.fetch = async () => ({
    ok: true, status: 200,
    body: {
      getReader () {
        let i = 0;
        return {
          async read () {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(chunks[i++]) };
          },
          releaseLock () {},
        };
      },
    },
  });

  const client = new ByokRelayClient({ relayUrl: 'http://relay' });
  client._token = 'tok';
  const deltas = [];
  for await (const delta of client.streamChat({
    model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: 'Hi' }],
  })) {
    deltas.push(delta);
  }
  assert.deepStrictEqual(deltas, ['Hello', ' world']);
}));

/* ── Route handler allowedApps gate ─────────────────────────────────────────── */
asyncTests.push(asyncTest('createRelayRouteHandler enforces allowedApps', async () => {
  const { POST } = createRelayRouteHandler({
    relayUrl: 'http://relay',
    allowedApps: ['allowed-app'],
  });

  // Simulate a request with wrong app_id
  const mockReq = {
    url: 'http://localhost/api/relay/health',
    method: 'POST',
    headers: {
      get: (k) => k === 'x-app-id' ? 'wrong-app' : null,
      entries: () => [][Symbol.iterator](),
    },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
  const resp = await POST(mockReq, { params: { path: ['health'] } });
  assert.strictEqual(resp.status, 403);
}));

/* ── Run all async tests ─────────────────────────────────────────────────────── */
Promise.all(asyncTests).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});

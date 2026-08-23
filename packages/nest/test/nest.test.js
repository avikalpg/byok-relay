/**
 * Smoke tests for @byok-relay/nest
 * Run with: node test/nest.test.js
 * No external dependencies — uses a mock upstream relay server and raw http.
 */

'use strict';

const http   = require('http');
const assert = require('assert');
const {
  ByokRelayModule,
  ByokRelayMiddleware,
  ByokRelayService,
  ByokRelayClient,
  createRelayHandler,
  BYOK_RELAY_CONFIG,
} = require('../src/index.js');

(async () => { // wrap for top-level await compat in CJS

/* ========================================================================== */
/* Test harness                                                                */
/* ========================================================================== */

let passed = 0;
let failed = 0;

async function test (label, fn) {
  try {
    await fn();
    console.log(`  ✅ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${label}`);
    console.error(`     ${err.message}`);
    if (process.env.VERBOSE) console.error(err.stack);
    failed++;
  }
}

/** Create a minimal mock upstream relay server. */
function createMockRelay (handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

/** Send a raw HTTP request and collect the response. */
function httpRequest (opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status:  res.statusCode,
        headers: res.headers,
        body:    Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Start a plain http.Server using the given requestListener. */
function startServer (listener) {
  const server = http.createServer(listener);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

/* ========================================================================== */
/* Exports shape                                                               */
/* ========================================================================== */

console.log('\n@byok-relay/nest — smoke tests\n');
console.log('── Exports ──');

await test('ByokRelayModule exported', () => {
  assert.ok(ByokRelayModule, 'ByokRelayModule missing');
  assert.ok(typeof ByokRelayModule.forRoot === 'function', 'forRoot missing');
  assert.ok(typeof ByokRelayModule.forRootAsync === 'function', 'forRootAsync missing');
});

await test('ByokRelayMiddleware exported', () => {
  assert.ok(ByokRelayMiddleware, 'ByokRelayMiddleware missing');
  assert.ok(typeof ByokRelayMiddleware.prototype.use === 'function', 'use() missing');
  assert.ok(typeof ByokRelayMiddleware.configure === 'function', 'configure() missing');
});

await test('ByokRelayService exported', () => {
  assert.ok(ByokRelayService, 'ByokRelayService missing');
  const svc = new ByokRelayService({ relayUrl: 'http://localhost:9999' });
  assert.ok(typeof svc.register    === 'function', 'register missing');
  assert.ok(typeof svc.storeKey    === 'function', 'storeKey missing');
  assert.ok(typeof svc.chat        === 'function', 'chat missing');
  assert.ok(typeof svc.streamChat  === 'function', 'streamChat missing');
  assert.ok(typeof svc.health      === 'function', 'health missing');
  assert.ok(typeof svc.stats       === 'function', 'stats missing');
  assert.ok(typeof svc.getModels   === 'function', 'getModels missing');
  assert.ok(typeof svc.deleteAccount === 'function', 'deleteAccount missing');
  assert.ok(svc.client instanceof ByokRelayClient, 'client accessor missing');
});

await test('ByokRelayClient exported', () => {
  assert.ok(ByokRelayClient, 'ByokRelayClient missing');
  const c = new ByokRelayClient({ relayUrl: 'http://localhost:9999' });
  assert.ok(typeof c.register      === 'function');
  assert.ok(typeof c.ensureToken   === 'function');
  assert.ok(typeof c.logout        === 'function');
  assert.ok(typeof c.storeKey      === 'function');
  assert.ok(typeof c.listKeys      === 'function');
  assert.ok(typeof c.deleteKey     === 'function');
  assert.ok(typeof c.rotateKey     === 'function');
  assert.ok(typeof c.relayRequest  === 'function');
  assert.ok(typeof c.chat          === 'function');
  assert.ok(typeof c.streamChat    === 'function');
  assert.ok(typeof c.health        === 'function');
  assert.ok(typeof c.stats         === 'function');
  assert.ok(typeof c.getModels     === 'function');
  assert.ok(typeof c.deleteAccount === 'function');
});

await test('createRelayHandler exported', () => {
  assert.ok(typeof createRelayHandler === 'function', 'createRelayHandler missing');
  const h = createRelayHandler({ relayUrl: 'http://localhost:9999' });
  assert.ok(typeof h === 'function', 'handler should be a function');
});

await test('BYOK_RELAY_CONFIG token exported', () => {
  assert.ok(typeof BYOK_RELAY_CONFIG === 'string', 'BYOK_RELAY_CONFIG should be a string');
  assert.strictEqual(BYOK_RELAY_CONFIG, 'BYOK_RELAY_CONFIG');
});

/* ========================================================================== */
/* ByokRelayModule.forRoot                                                     */
/* ========================================================================== */

console.log('\n── ByokRelayModule.forRoot ──');

await test('forRoot returns valid DynamicModule shape', () => {
  const mod = ByokRelayModule.forRoot({ relayUrl: 'http://localhost:9999' });
  assert.strictEqual(mod.module, ByokRelayModule, 'module property wrong');
  assert.ok(Array.isArray(mod.providers), 'providers should be array');
  assert.ok(Array.isArray(mod.exports),   'exports should be array');
  // Should provide the config token
  const hasConfig = mod.providers.some(p => p && p.provide === BYOK_RELAY_CONFIG);
  assert.ok(hasConfig, 'BYOK_RELAY_CONFIG provider missing');
  // Should provide ByokRelayService
  const hasService = mod.providers.some(p => p === ByokRelayService || (p && p.provide === ByokRelayService));
  assert.ok(hasService, 'ByokRelayService provider missing');
  // Should export ByokRelayService
  const exportsService = mod.exports.includes(ByokRelayService);
  assert.ok(exportsService, 'ByokRelayService not exported');
});

await test('forRoot global flag', () => {
  const mod = ByokRelayModule.forRoot({ global: true });
  assert.strictEqual(mod.global, true, 'global flag should be true');
  const mod2 = ByokRelayModule.forRoot({});
  assert.strictEqual(mod2.global, false, 'global should default false');
});

await test('forRootAsync with useFactory returns valid DynamicModule', () => {
  const mod = ByokRelayModule.forRootAsync({
    useFactory: () => ({ relayUrl: 'http://localhost:9999' }),
    inject:     [],
  });
  assert.strictEqual(mod.module, ByokRelayModule);
  assert.ok(Array.isArray(mod.providers));
  const configProvider = mod.providers.find(p => p && p.provide === BYOK_RELAY_CONFIG);
  assert.ok(configProvider, 'async config provider missing');
  assert.ok(typeof configProvider.useFactory === 'function', 'useFactory missing');
});

/* ========================================================================== */
/* ByokRelayMiddleware — proxy tests                                           */
/* ========================================================================== */

console.log('\n── ByokRelayMiddleware proxy ──');

await test('proxies GET request to upstream relay', async () => {
  const mock = await createMockRelay((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });

  const mw = new ByokRelayMiddleware({ relayUrl: mock.url, pathPrefix: '/relay' });

  const { server, port } = await startServer(async (req, res) => {
    let nextCalled = false;
    await mw.use(req, res, () => { nextCalled = true; });
  });

  try {
    const r = await httpRequest({ host: '127.0.0.1', port, path: '/relay/health', method: 'GET' });
    assert.strictEqual(r.status, 200);
    const body = JSON.parse(r.body);
    assert.ok(body.ok);
  } finally {
    server.close();
    mock.server.close();
  }
});

await test('calls next() for non-relay paths', async () => {
  const mw = new ByokRelayMiddleware({ relayUrl: 'http://localhost:9999', pathPrefix: '/relay' });

  let nextCalled = false;
  const req = { url: '/api/other', method: 'GET', headers: {} };
  const res = { writeHead: () => {}, end: () => {} };
  await mw.use(req, res, () => { nextCalled = true; });

  assert.ok(nextCalled, 'next() should be called for non-relay path');
});

await test('calls next() for paths that only share the relay prefix', async () => {
  const mw = new ByokRelayMiddleware({ relayUrl: 'http://localhost:9999', pathPrefix: '/relay' });

  let nextCalled = false;
  const req = { url: '/relayer/health', method: 'GET', headers: {} };
  const res = { writeHead: () => {}, end: () => {} };
  await mw.use(req, res, () => { nextCalled = true; });

  assert.ok(nextCalled, 'next() should be called when the prefix is not a path segment');
});

await test('returns 403 for disallowed app_id', async () => {
  const mw = new ByokRelayMiddleware({
    relayUrl:      'http://localhost:9999',
    pathPrefix:    '/relay',
    allowedAppIds: ['allowed-app'],
  });

  let statusCode = null;
  let responseBody = '';
  const req = {
    url:     '/relay/users',
    method:  'POST',
    headers: { 'x-app-id': 'bad-app' },
  };
  const res = {
    writeHead: (code) => { statusCode = code; },
    end:       (body) => { responseBody = body; },
  };
  await mw.use(req, res, () => {});
  assert.strictEqual(statusCode, 403);
  const parsed = JSON.parse(responseBody);
  assert.ok(parsed.error);
});

await test('returns 403 for a missing app_id when an allowlist is configured', async () => {
  const mw = new ByokRelayMiddleware({
    relayUrl:      'http://localhost:9999',
    pathPrefix:    '/relay',
    allowedAppIds: ['allowed-app'],
  });

  let statusCode = null;
  const req = { url: '/relay/users', method: 'POST', headers: {} };
  const res = { writeHead: (code) => { statusCode = code; }, end: () => {} };
  await mw.use(req, res, () => {});
  assert.strictEqual(statusCode, 403);
});

await test('allows request when app_id is in allowlist', async () => {
  const mock = await createMockRelay((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  const mw = new ByokRelayMiddleware({
    relayUrl:      mock.url,
    pathPrefix:    '/relay',
    allowedAppIds: ['good-app'],
  });

  const { server, port } = await startServer(async (req, res) => {
    await mw.use(req, res, () => {});
  });

  try {
    const r = await httpRequest({
      host: '127.0.0.1', port, path: '/relay/health', method: 'GET',
      headers: { 'x-app-id': 'good-app' },
    });
    assert.strictEqual(r.status, 200);
  } finally {
    server.close();
    mock.server.close();
  }
});

await test('proxies POST with body', async () => {
  let receivedBody = '';
  const mock = await createMockRelay((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      receivedBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    });
  });

  const mw = new ByokRelayMiddleware({ relayUrl: mock.url, pathPrefix: '/relay' });
  const { server, port } = await startServer(async (req, res) => {
    await mw.use(req, res, () => {});
  });

  try {
    const payload = JSON.stringify({ model: 'openai/gpt-4o', messages: [] });
    const r = await httpRequest({
      host:    '127.0.0.1',
      port,
      path:    '/relay/relay',
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, payload);
    assert.strictEqual(r.status, 200);
    assert.ok(receivedBody.includes('gpt-4o'));
  } finally {
    server.close();
    mock.server.close();
  }
});

await test('returns 504 on upstream timeout', async () => {
  // Create a server that never responds
  const slowServer = http.createServer(() => { /* never responds */ });
  await new Promise(r => slowServer.listen(0, '127.0.0.1', r));
  const { port: slowPort } = slowServer.address();

  const mw = new ByokRelayMiddleware({
    relayUrl:  `http://127.0.0.1:${slowPort}`,
    pathPrefix: '/relay',
    timeoutMs:  100, // very short timeout
  });

  const { server, port } = await startServer(async (req, res) => {
    await mw.use(req, res, () => {});
  });

  try {
    const r = await httpRequest({ host: '127.0.0.1', port, path: '/relay/health', method: 'GET' });
    assert.strictEqual(r.status, 504);
  } finally {
    server.close();
    slowServer.close();
  }
});

await test('strips hop-by-hop headers from middleware layer; custom headers pass through', async () => {
  let receivedHeaders = {};
  const mock = await createMockRelay((req, res) => {
    receivedHeaders = req.headers;
    res.writeHead(200);
    res.end('ok');
  });

  const mw = new ByokRelayMiddleware({ relayUrl: mock.url, pathPrefix: '/relay' });
  const { server, port } = await startServer(async (req, res) => {
    await mw.use(req, res, () => {});
  });

  try {
    await httpRequest({
      host:    '127.0.0.1',
      port,
      path:    '/relay/health',
      method:  'GET',
      headers: { 'x-custom': 'pass-through', 'te': 'trailers' },
    });
    // 'te' is a hop-by-hop header — should be stripped by _filterHeaders
    assert.ok(!receivedHeaders['te'], 'te (hop-by-hop) should be stripped');
    // Regular custom headers should pass through
    assert.strictEqual(receivedHeaders['x-custom'], 'pass-through');
    // Note: Node.js native fetch re-adds 'connection: keep-alive' automatically;
    // _filterHeaders strips it from our forwarded set, but the fetch layer re-injects it.
    // This is expected browser/Node.js HTTP/1.1 behaviour — not a bug in our filter.
  } finally {
    server.close();
    mock.server.close();
  }
});

/* ========================================================================== */
/* createRelayHandler                                                          */
/* ========================================================================== */

console.log('\n── createRelayHandler ──');

await test('proxies via standalone handler', async () => {
  const mock = await createMockRelay((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ standalone: true }));
  });

  const handler = createRelayHandler({ relayUrl: mock.url, pathPrefix: '/relay' });
  const { server, port } = await startServer(handler);

  try {
    const r = await httpRequest({ host: '127.0.0.1', port, path: '/relay/health', method: 'GET' });
    assert.strictEqual(r.status, 200);
    const body = JSON.parse(r.body);
    assert.ok(body.standalone);
  } finally {
    server.close();
    mock.server.close();
  }
});

await test('standalone handler returns 403 for disallowed app_id', async () => {
  const handler = createRelayHandler({
    relayUrl:      'http://localhost:9999',
    pathPrefix:    '/relay',
    allowedAppIds: ['ok-app'],
  });

  const { server, port } = await startServer(handler);

  try {
    const r = await httpRequest({
      host:    '127.0.0.1',
      port,
      path:    '/relay/users',
      method:  'POST',
      headers: { 'x-app-id': 'bad-app' },
    });
    assert.strictEqual(r.status, 403);
  } finally {
    server.close();
  }
});

await test('standalone handler returns 403 for a missing app_id when an allowlist is configured', async () => {
  const handler = createRelayHandler({
    relayUrl:      'http://localhost:9999',
    pathPrefix:    '/relay',
    allowedAppIds: ['ok-app'],
  });
  const { server, port } = await startServer(handler);

  try {
    const r = await httpRequest({ host: '127.0.0.1', port, path: '/relay/users', method: 'POST' });
    assert.strictEqual(r.status, 403);
  } finally {
    server.close();
  }
});

/* ========================================================================== */
/* ByokRelayClient — in-memory storage                                        */
/* ========================================================================== */

console.log('\n── ByokRelayClient (in-memory) ──');

await test('register stores token in memory', async () => {
  const mock = await createMockRelay((req, res) => {
    if (req.url === '/users' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ token: 'tok-abc123', user_id: 'u1' }));
    }
    res.writeHead(404);
    res.end();
  });

  const client = new ByokRelayClient({ relayUrl: mock.url });
  const data   = await client.register({ appId: 'test' });

  assert.strictEqual(data.token, 'tok-abc123');
  assert.strictEqual(client._token, 'tok-abc123');
  mock.server.close();
});

await test('ensureToken reuses existing token', async () => {
  let registerCount = 0;
  const mock = await createMockRelay((req, res) => {
    if (req.url === '/users' && req.method === 'POST') {
      registerCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ token: 'tok-xyz', user_id: 'u2' }));
    }
    res.writeHead(404); res.end();
  });

  const client = new ByokRelayClient({ relayUrl: mock.url });
  await client.ensureToken();
  await client.ensureToken(); // second call should NOT register again
  assert.strictEqual(registerCount, 1, 'register should only be called once');
  mock.server.close();
});

await test('logout clears token', async () => {
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:9999' });
  client._token = 'tok-existing';
  client._storage.setItem('byok_relay_token', 'tok-existing');
  client.logout();
  assert.strictEqual(client._token, null);
  assert.strictEqual(client._storage.getItem('byok_relay_token'), null);
});

await test('storeKey sends correct request', async () => {
  let captured = null;
  const mock = await createMockRelay((req, res) => {
    if (req.url === '/users' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ token: 'tok-store', user_id: 'u3' }));
    }
    if (req.url === '/keys/openai' && req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        captured = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  const client = new ByokRelayClient({ relayUrl: mock.url });
  await client.storeKey('openai', 'sk-test-key');
  assert.deepStrictEqual(captured, { api_key: 'sk-test-key' });
  mock.server.close();
});

await test('listKeys returns providers list', async () => {
  const mock = await createMockRelay((req, res) => {
    if (req.url === '/users' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ token: 'tok-list', user_id: 'u4' }));
    }
    if (req.url === '/keys' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ providers: ['openai', 'anthropic'] }));
    }
    res.writeHead(404); res.end();
  });

  const client = new ByokRelayClient({ relayUrl: mock.url });
  const result = await client.listKeys();
  assert.deepStrictEqual(result.providers, ['openai', 'anthropic']);
  mock.server.close();
});

await test('deleteKey sends DELETE request', async () => {
  let deleteCalled = false;
  const mock = await createMockRelay((req, res) => {
    if (req.url === '/users' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ token: 'tok-del', user_id: 'u5' }));
    }
    if (req.url === '/keys/anthropic' && req.method === 'DELETE') {
      deleteCalled = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(404); res.end();
  });

  const client = new ByokRelayClient({ relayUrl: mock.url });
  await client.deleteKey('anthropic');
  assert.ok(deleteCalled, 'DELETE /keys/anthropic should be called');
  mock.server.close();
});

await test('rotateKey hits /rotate endpoint', async () => {
  let rotatePath = null;
  const mock = await createMockRelay((req, res) => {
    if (req.url === '/users' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ token: 'tok-rot', user_id: 'u6' }));
    }
    if (req.url.startsWith('/keys/') && req.url.endsWith('/rotate')) {
      rotatePath = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, rotated: true }));
    }
    res.writeHead(404); res.end();
  });

  const client = new ByokRelayClient({ relayUrl: mock.url });
  await client.rotateKey('openai', 'sk-new-key');
  assert.strictEqual(rotatePath, '/keys/openai/rotate');
  mock.server.close();
});

await test('health() hits /health', async () => {
  const mock = await createMockRelay((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    res.writeHead(404); res.end();
  });

  const client = new ByokRelayClient({ relayUrl: mock.url });
  const h = await client.health();
  assert.strictEqual(h.status, 'ok');
  mock.server.close();
});

await test('health(deep=true) adds ?deep=1', async () => {
  let receivedUrl = null;
  const mock = await createMockRelay((req, res) => {
    receivedUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });

  const client = new ByokRelayClient({ relayUrl: mock.url });
  await client.health(true);
  assert.ok(receivedUrl && receivedUrl.includes('deep=1'), 'should include deep=1');
  mock.server.close();
});

await test('getModels() hits /models', async () => {
  const mock = await createMockRelay((req, res) => {
    if (req.url === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ restricted: false, allowed_models: ['*'] }));
    }
    res.writeHead(404); res.end();
  });

  const client = new ByokRelayClient({ relayUrl: mock.url });
  const models = await client.getModels();
  assert.strictEqual(models.restricted, false);
  mock.server.close();
});

await test('deleteAccount sends DELETE /users + clears token', async () => {
  let deleteCalled = false;
  const mock = await createMockRelay((req, res) => {
    if (req.url === '/users' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ token: 'tok-da', user_id: 'u7' }));
    }
    if (req.url === '/users' && req.method === 'DELETE') {
      deleteCalled = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(404); res.end();
  });

  const client = new ByokRelayClient({ relayUrl: mock.url });
  await client.register();
  await client.deleteAccount();
  assert.ok(deleteCalled, 'DELETE /users should be called');
  assert.strictEqual(client._token, null, 'token should be cleared after delete');
  mock.server.close();
});

/* ========================================================================== */
/* ByokRelayService delegates to ByokRelayClient                              */
/* ========================================================================== */

console.log('\n── ByokRelayService ──');

await test('ByokRelayService.client returns ByokRelayClient instance', () => {
  const svc = new ByokRelayService({ relayUrl: 'http://localhost:9999' });
  assert.ok(svc.client instanceof ByokRelayClient);
});

await test('ByokRelayService delegates register to client', async () => {
  const mock = await createMockRelay((req, res) => {
    if (req.url === '/users' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ token: 'svc-tok', user_id: 'svc-1' }));
    }
    res.writeHead(404); res.end();
  });

  const svc = new ByokRelayService({ relayUrl: mock.url });
  const data = await svc.register({ appId: 'svc-test' });
  assert.strictEqual(data.token, 'svc-tok');
  mock.server.close();
});

await test('ByokRelayService.logout clears underlying client token', async () => {
  const svc = new ByokRelayService({ relayUrl: 'http://localhost:9999' });
  svc.client._token = 'tok-preset';
  svc.logout();
  assert.strictEqual(svc.client._token, null);
});

/* ========================================================================== */
/* ByokRelayMiddleware.configure (static)                                     */
/* ========================================================================== */

console.log('\n── ByokRelayMiddleware.configure ──');

await test('static configure sets _staticConfig', () => {
  ByokRelayMiddleware.configure({ relayUrl: 'http://custom-relay.example.com', timeoutMs: 5000 });
  assert.strictEqual(ByokRelayMiddleware._staticConfig.relayUrl, 'http://custom-relay.example.com');
  assert.strictEqual(ByokRelayMiddleware._staticConfig.timeoutMs, 5000);
  // reset
  ByokRelayMiddleware.configure(null);
});

await test('middleware uses static config when no DI config provided', () => {
  const previousRelayUrl = process.env.RELAY_URL;
  delete process.env.RELAY_URL;
  try {
    ByokRelayMiddleware.configure({ relayUrl: 'http://static-relay.example.com' });
    const mw = new ByokRelayMiddleware(); // no DI config
    assert.strictEqual(mw._relayUrl, 'http://static-relay.example.com');
  } finally {
    ByokRelayMiddleware.configure(null);
    if (previousRelayUrl === undefined) delete process.env.RELAY_URL;
    else process.env.RELAY_URL = previousRelayUrl;
  }
});

/* ========================================================================== */
/* SSE streaming (ByokRelayClient.streamChat)                                 */
/* ========================================================================== */

console.log('\n── streamChat (SSE) ──');

await test('streamChat yields text chunks from SSE stream', async () => {
  const sseChunks = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: [DONE]\n\n',
  ];

  const mock = await createMockRelay((req, res) => {
    if (req.url === '/users' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ token: 'tok-stream', user_id: 'us1' }));
    }
    if (req.url === '/relay' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let i = 0;
      const interval = setInterval(() => {
        if (i < sseChunks.length) {
          res.write(sseChunks[i++]);
        } else {
          clearInterval(interval);
          res.end();
        }
      }, 10);
      return;
    }
    res.writeHead(404); res.end();
  });

  const client = new ByokRelayClient({ relayUrl: mock.url });
  const chunks  = [];
  for await (const chunk of client.streamChat({
    model:    'openai/gpt-4o',
    messages: [{ role: 'user', content: 'Hi' }],
  })) {
    chunks.push(chunk);
  }
  assert.deepStrictEqual(chunks, ['Hello', ' world']);
  mock.server.close();
});

/* ========================================================================== */
/* Custom storage adapter                                                      */
/* ========================================================================== */

console.log('\n── Custom storage adapter ──');

await test('client uses custom storage adapter', () => {
  const store = new Map();
  const storage = {
    getItem:    (k) => store.get(k) || null,
    setItem:    (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };

  const client = new ByokRelayClient({ relayUrl: 'http://localhost:9999', storage });
  client._token = 'custom-tok';
  client._storage.setItem('byok_relay_token', 'custom-tok');

  assert.strictEqual(store.get('byok_relay_token'), 'custom-tok');
  client.logout();
  assert.strictEqual(store.get('byok_relay_token'), undefined);
});

/* ========================================================================== */
/* Summary                                                                     */
/* ========================================================================== */

console.log(`\n── Results ──`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log('');

if (failed > 0) {
  process.exit(1);
}
})(); // end async IIFE

/**
 * Smoke tests for @byok-relay/fastify
 * Run with: node test/fastify.test.js
 * No external dependencies — uses a mock upstream relay server.
 */

'use strict';

const http = require('http');
const assert = require('assert');
const { byokRelayPlugin, createRelayRouteHandler, ByokRelayClient } = require('../src/index.js');

/* ========================================================================== */
/* Helpers                                                                     */
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
    failed++;
  }
}

/** Create a minimal mock upstream relay. */
function createMockRelay (handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * Create a minimal Fastify-like server shim without requiring Fastify to be installed.
 * Tests the plugin logic end-to-end via raw HTTP.
 */
function createMinimalFastifyLike () {
  // We use the real http module and simulate Fastify's request/reply surface.
  // For unit-testing the proxy logic we test _proxy indirectly via fetch calls
  // against a real HTTP server that calls our handler.
  const routes = [];
  const contentParsers = [];
  const removedContentParsers = [];

  function buildReply (res) {
    const reply = {
      _code: 200,
      _headers: {},
      code (c) { this._code = c; return this; },
      header (k, v) { this._headers[k] = v; return this; },
      send (body) {
        res.writeHead(this._code, this._headers);
        if (body && typeof body.pipe === 'function') {
          body.pipe(res);
        } else if (body && typeof body.getReader === 'function') {
          // ReadableStream (WHATWG)
          (async () => {
            const reader = body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
            res.end();
          })().catch(() => res.end());
        } else {
          const out = typeof body === 'object' ? JSON.stringify(body) : (body || '');
          res.end(out);
        }
      },
    };
    return reply;
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);

    const url = new URL(req.url, 'http://localhost');
    const query = {};
    for (const [k, v] of url.searchParams.entries()) query[k] = v;

    // Match route — handles Fastify wildcard patterns like '/relay/*'
    let matchedHandler = null;
    let params = {};
    for (const { prefix, handler } of routes) {
      // Strip trailing '/*' wildcard for prefix-based matching
      const basePrefix = prefix.replace(/\/\*$/, '');
      const trimmed = url.pathname;
      if (trimmed === basePrefix || trimmed.startsWith(basePrefix + '/')) {
        const wild = trimmed.slice(basePrefix.length).replace(/^\//, '');
        params = { '*': wild };
        matchedHandler = handler;
        break;
      }
    }

    if (!matchedHandler) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const request = {
      method: req.method,
      headers: req.headers,
      raw: { url: req.url },
      query,
      params,
      body: rawBody.length ? rawBody : null,
    };
    const reply = buildReply(res);
    await matchedHandler(request, reply);
  });

  const fastify = {
    _decorations: {},
    decorate (key, value) {
      if (!this._decorations[key]) this._decorations[key] = value;
    },
    addContentTypeParser (pattern, opts, fn) {
      // Stored for reference; our shim handles raw bodies natively.
      contentParsers.push({ pattern, opts, fn });
    },
    removeContentTypeParser (contentType) {
      // The real Fastify instance starts with built-in JSON/text parsers. The
      // shim stores raw buffers already, so record the requested removals.
      removedContentParsers.push(contentType);
    },
    all (prefix, optsOrHandler, maybeHandler) {
      const handler = typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler;
      routes.push({ prefix, handler });
    },
    listen () {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address();
          resolve({ port, url: `http://127.0.0.1:${port}` });
        });
      });
    },
    close () {
      return new Promise((resolve) => server.close(resolve));
    },
  };

  fastify._contentParsers = contentParsers;
  fastify._removedContentParsers = removedContentParsers;
  return fastify;
}

/* ========================================================================== */
/* Tests                                                                       */
/* ========================================================================== */

async function runTests () {
  console.log('\n@byok-relay/fastify — smoke tests\n');

  // ---- ByokRelayClient unit tests ----------------------------------------

  console.log('ByokRelayClient');

  await test('instantiates with defaults', () => {
    const client = new ByokRelayClient();
    assert.ok(client);
    assert.strictEqual(typeof client.register, 'function');
    assert.strictEqual(typeof client.chat, 'function');
    assert.strictEqual(typeof client.streamChat, 'function');
  });

  await test('resolves relayUrl from opts', () => {
    const client = new ByokRelayClient({ relayUrl: 'http://localhost:9999' });
    assert.strictEqual(client._relayUrl, 'http://localhost:9999');
  });

  await test('resolves relayUrl from process.env.RELAY_URL', () => {
    const orig = process.env.RELAY_URL;
    process.env.RELAY_URL = 'http://env-relay.test';
    const client = new ByokRelayClient();
    assert.strictEqual(client._relayUrl, 'http://env-relay.test');
    if (orig) process.env.RELAY_URL = orig; else delete process.env.RELAY_URL;
  });

  await test('accepts custom storage adapter', () => {
    const store = new Map();
    const adapter = {
      getItem    : (k) => store.get(k) || null,
      setItem    : (k, v) => store.set(k, v),
      removeItem : (k) => store.delete(k),
    };
    const client = new ByokRelayClient({ storage: adapter });
    assert.strictEqual(client._storage, adapter);
  });

  await test('migrates a legacy token into the current scoped key', () => {
    const store = new Map([['byok_relay_token', 'legacy-token']]);
    const adapter = {
      getItem    : (k) => store.get(k) || null,
      setItem    : (k, v) => store.set(k, v),
      removeItem : (k) => store.delete(k),
    };
    const client = new ByokRelayClient({
      relayUrl: 'http://relay.test',
      appId: 'migrated-app',
      storage: adapter,
    });
    assert.strictEqual(client._token, 'legacy-token');
    assert.strictEqual(store.get(client._tokenStorageKey), 'legacy-token');
    assert.strictEqual(store.has('byok_relay_token'), false);
  });

  await test('register clears a remaining legacy token after persisting the scoped token', async () => {
    const store = new Map();
    const adapter = {
      getItem    : (k) => store.get(k) || null,
      setItem    : (k, v) => store.set(k, v),
      removeItem : (k) => store.delete(k),
    };
    const client = new ByokRelayClient({ storage: adapter });
    store.set('byok_relay_token', 'legacy-token');
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ token: 'fresh-token' }) });
    try {
      await client.register();
      assert.strictEqual(store.get(client._tokenStorageKey), 'fresh-token');
      assert.strictEqual(store.has('byok_relay_token'), false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('logout clears token', () => {
    const store = new Map();
    const adapter = {
      getItem    : (k) => store.get(k) || null,
      setItem    : (k, v) => store.set(k, v),
      removeItem : (k) => store.delete(k),
    };
    const client = new ByokRelayClient({ storage: adapter });
    client._token = 'test-tok';
    store.set(client._tokenStorageKey, 'test-tok');
    store.set('byok_relay_token', 'legacy-token');
    client.logout();
    assert.strictEqual(client._token, null);
    assert.strictEqual(store.has(client._tokenStorageKey), false);
    assert.strictEqual(store.has('byok_relay_token'), false);
  });

  // ---- ByokRelayClient integration (against mock relay) -------------------

  console.log('\nByokRelayClient integration');

  const { server: relayServer, url: relayUrl } = await createMockRelay((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      if (req.url === '/users' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: 'tok-abc123' }));
      } else if (req.url === '/keys/openai' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else if (req.url === '/keys' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: ['openai'] }));
      } else if (req.url === '/keys/openai' && req.method === 'DELETE') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else if (req.url === '/keys/openai/rotate' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, rotated: true }));
      } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else if (req.url === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: ['openai/gpt-4o'] }));
      } else if (req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ total: 10 }));
      } else if (req.url === '/users' && req.method === 'DELETE') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else if (req.url === '/relay' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: 'Hello from mock!' } }],
        }));
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
  });

  await test('register stores token', async () => {
    const client = new ByokRelayClient({ relayUrl });
    const data = await client.register({ appId: 'test-app' });
    assert.strictEqual(data.token, 'tok-abc123');
    assert.strictEqual(client._token, 'tok-abc123');
  });

  await test('ensureToken skips register if token exists', async () => {
    const client = new ByokRelayClient({ relayUrl });
    client._token = 'existing-tok';
    const tok = await client.ensureToken();
    assert.strictEqual(tok, 'existing-tok');
  });

  await test('storeKey succeeds', async () => {
    const client = new ByokRelayClient({ relayUrl });
    client._token = 'tok-abc123';
    const res = await client.storeKey('openai', 'sk-test');
    assert.strictEqual(res.ok, true);
  });

  await test('listKeys returns keys array', async () => {
    const client = new ByokRelayClient({ relayUrl });
    client._token = 'tok-abc123';
    const res = await client.listKeys();
    assert.ok(Array.isArray(res.keys));
    assert.ok(res.keys.includes('openai'));
  });

  await test('deleteKey succeeds', async () => {
    const client = new ByokRelayClient({ relayUrl });
    client._token = 'tok-abc123';
    const res = await client.deleteKey('openai');
    assert.strictEqual(res.ok, true);
  });

  await test('rotateKey succeeds', async () => {
    const client = new ByokRelayClient({ relayUrl });
    client._token = 'tok-abc123';
    const res = await client.rotateKey('openai', 'sk-newkey');
    assert.strictEqual(res.rotated, true);
  });

  await test('health() returns status ok', async () => {
    const client = new ByokRelayClient({ relayUrl });
    const res = await client.health();
    assert.strictEqual(res.status, 'ok');
  });

  await test('getModels() returns models list', async () => {
    const client = new ByokRelayClient({ relayUrl });
    const res = await client.getModels();
    assert.ok(Array.isArray(res.models));
  });

  await test('stats() returns usage data', async () => {
    const client = new ByokRelayClient({ relayUrl });
    client._token = 'tok-abc123';
    const res = await client.stats();
    assert.ok(typeof res.total === 'number');
  });

  await test('chat() returns content string', async () => {
    const client = new ByokRelayClient({ relayUrl });
    client._token = 'tok-abc123';
    const content = await client.chat({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    assert.strictEqual(content, 'Hello from mock!');
  });

  await test('deleteAccount() clears token', async () => {
    const client = new ByokRelayClient({ relayUrl });
    client._token = 'tok-abc123';
    await client.deleteAccount();
    assert.strictEqual(client._token, null);
  });

  relayServer.close();

  // ---- byokRelayPlugin + createRelayRouteHandler integration -------------

  console.log('\nbyokRelayPlugin + createRelayRouteHandler');

  const { server: upstreamServer, url: upstreamUrl } = await createMockRelay((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      // Plugin strips the '/relay' prefix before forwarding, so upstream sees bare paths
      if (req.url === '/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ proxied: true, method: req.method }));
      } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else if (req.url.startsWith('/stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"chunk1"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
  });

  // --- byokRelayPlugin tests ---

  await test('byokRelayPlugin registers and proxies GET', async () => {
    const fastify = createMinimalFastifyLike();
    await byokRelayPlugin(fastify, { relayUrl: upstreamUrl });
    const { url: serverUrl } = await fastify.listen();

    const res = await fetch(`${serverUrl}/relay/health`);
    const json = await res.json();
    assert.strictEqual(json.status, 'ok');
    await fastify.close();
  });

  await test('byokRelayPlugin proxies POST with body', async () => {
    const fastify = createMinimalFastifyLike();
    await byokRelayPlugin(fastify, { relayUrl: upstreamUrl });
    const { url: serverUrl } = await fastify.listen();

    const res = await fetch(`${serverUrl}/relay/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    const json = await res.json();
    assert.strictEqual(json.proxied, true);
    assert.strictEqual(json.method, 'POST');
    await fastify.close();
  });

  await test('byokRelayPlugin decorates fastify instance with byokRelayClient', async () => {
    const fastify = createMinimalFastifyLike();
    await byokRelayPlugin(fastify, { relayUrl: upstreamUrl });
    assert.ok(fastify._decorations.byokRelayClient);
    assert.ok(fastify._decorations.byokRelayClient instanceof ByokRelayClient);
  });

  await test('byokRelayPlugin replaces JSON and text parsers with 50 MB raw-body parsers', async () => {
    const fastify = createMinimalFastifyLike();
    await byokRelayPlugin(fastify, { relayUrl: upstreamUrl });
    assert.deepStrictEqual(fastify._removedContentParsers, ['application/json', 'text/plain']);
    const exactParsers = fastify._contentParsers.filter(({ pattern }) => typeof pattern === 'string');
    assert.deepStrictEqual(exactParsers.map(({ pattern }) => pattern), ['application/json', 'text/plain']);
    assert.ok(exactParsers.every(({ opts }) => opts.parseAs === 'buffer' && opts.bodyLimit === 52_428_800));
  });

  await test('byokRelayPlugin respects allowedAppIds — blocks unknown app', async () => {
    const fastify = createMinimalFastifyLike();
    await byokRelayPlugin(fastify, {
      relayUrl: upstreamUrl,
      allowedAppIds: ['allowed-app'],
    });
    const { url: serverUrl } = await fastify.listen();

    const res = await fetch(`${serverUrl}/relay/health`, {
      headers: { 'x-app-id': 'unknown-app' },
    });
    assert.strictEqual(res.status, 403);
    await fastify.close();
  });

  await test('byokRelayPlugin blocks requests with no app_id header when allowlist set', async () => {
    const fastify = createMinimalFastifyLike();
    await byokRelayPlugin(fastify, {
      relayUrl: upstreamUrl,
      allowedAppIds: ['allowed-app'],
    });
    const { url: serverUrl } = await fastify.listen();

    // No x-app-id header — allowlisted routes require an explicit permitted ID.
    const res = await fetch(`${serverUrl}/relay/health`);
    assert.strictEqual(res.status, 403);
    await fastify.close();
  });

  await test('byokRelayPlugin returns 504 when upstream times out', async () => {
    const { server: slowServer, url: slowUrl } = await createMockRelay((req, res) => {
      // Never respond — simulate timeout
      req.on('data', () => {});
    });

    const fastify = createMinimalFastifyLike();
    await byokRelayPlugin(fastify, { relayUrl: slowUrl, timeoutMs: 100 });
    const { url: serverUrl } = await fastify.listen();

    const res = await fetch(`${serverUrl}/relay/health`);
    assert.strictEqual(res.status, 504);
    await fastify.close();
    slowServer.close();
  });

  // --- createRelayRouteHandler tests ---

  await test('createRelayRouteHandler proxies request', async () => {
    const handler = createRelayRouteHandler({ relayUrl: upstreamUrl });

    const fastify = createMinimalFastifyLike();
    fastify.all('/relay/*', handler);
    const { url: serverUrl } = await fastify.listen();

    const res = await fetch(`${serverUrl}/relay/health`);
    const json = await res.json();
    assert.strictEqual(json.status, 'ok');
    await fastify.close();
  });

  await test('createRelayRouteHandler respects allowedAppIds', async () => {
    const handler = createRelayRouteHandler({
      relayUrl: upstreamUrl,
      allowedAppIds: ['only-this'],
    });

    const fastify = createMinimalFastifyLike();
    fastify.all('/relay/*', handler);
    const { url: serverUrl } = await fastify.listen();

    const res = await fetch(`${serverUrl}/relay/health`, {
      headers: { 'x-app-id': 'other-app' },
    });
    assert.strictEqual(res.status, 403);
    await fastify.close();
  });

  await test('createRelayRouteHandler removes stale request and response encoding headers', async () => {
    const originalFetch = global.fetch;
    const handler = createRelayRouteHandler({ relayUrl: 'http://relay.test' });
    let forwardedHeaders;
    global.fetch = async (_url, init) => {
      forwardedHeaders = init.headers;
      return new Response('ok', {
        headers: {
          'content-encoding': 'gzip',
          'content-length': '999',
          'x-upstream': 'kept',
        },
      });
    };
    const reply = {
      headers: {},
      status: null,
      header (key, value) { this.headers[key] = value; return this; },
      code (status) { this.status = status; return this; },
      send () { return this; },
    };
    try {
      await handler({
        headers: {
          'content-length': '1',
          cookie: 'session=secret',
          host: 'app.example.test',
          'x-client': 'kept',
        },
        raw: { url: '/relay/chat' },
        method: 'POST',
        params: { '*': 'chat' },
        body: { message: 'hello' },
      }, reply);
      assert.strictEqual(forwardedHeaders['content-length'], undefined);
      assert.strictEqual(forwardedHeaders.cookie, undefined);
      assert.strictEqual(forwardedHeaders.host, undefined);
      assert.strictEqual(forwardedHeaders['x-client'], 'kept');
      assert.strictEqual(reply.headers['content-encoding'], undefined);
      assert.strictEqual(reply.headers['content-length'], undefined);
      assert.strictEqual(reply.headers['x-upstream'], 'kept');
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('timeoutMs: 0 is preserved instead of using the default timeout', async () => {
    const originalFetch = global.fetch;
    const handler = createRelayRouteHandler({ relayUrl: 'http://relay.test', timeoutMs: 0 });
    const reply = {
      status: null,
      code (status) { this.status = status; return this; },
      send () { return this; },
    };
    global.fetch = async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
    try {
      await handler({
        headers: {},
        raw: { url: '/relay/chat' },
        method: 'GET',
        params: { '*': 'chat' },
      }, reply);
      assert.strictEqual(reply.status, 504);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('createRelayRouteHandler forwards streaming response', async () => {
    const handler = createRelayRouteHandler({ relayUrl: upstreamUrl });
    const fastify = createMinimalFastifyLike();
    fastify.all('/relay/*', handler);
    const { url: serverUrl } = await fastify.listen();

    const res = await fetch(`${serverUrl}/relay/stream`);
    const text = await res.text();
    assert.ok(text.includes('chunk1'));
    await fastify.close();
  });

  await test('byokRelayPlugin exports are correct', () => {
    const mod = require('../src/index.js');
    assert.strictEqual(typeof mod.byokRelayPlugin, 'function');
    assert.strictEqual(typeof mod.createRelayRouteHandler, 'function');
    assert.strictEqual(typeof mod.ByokRelayClient, 'function');
  });

  upstreamServer.close();

  // ---- Summary -------------------------------------------------------------

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Total: ${passed + failed} | ✅ ${passed} passed | ❌ ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Unexpected test runner error:', err);
  process.exit(1);
});

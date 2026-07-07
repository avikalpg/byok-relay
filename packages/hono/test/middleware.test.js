/**
 * Smoke tests for @byok-relay/hono
 *
 * These tests run without a live relay or Hono peer dep.
 * They verify the module exports and the ByokRelayClient API surface.
 */

'use strict';

const assert = require('assert');

const {
  createByokRelayMiddleware,
  createRelayRoute,
  ByokRelayClient,
} = require('../src/index.js');

let passed = 0;
let failed = 0;

function test (name, fn) {
  try {
    fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌  ${name}`);
    console.error(`      ${err.message}`);
    failed++;
  }
}

async function testAsync (name, fn) {
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

async function main () {

console.log('\n@byok-relay/hono — smoke tests\n');

/* ------------------------------------------------------------------ */
/* Exports                                                              */
/* ------------------------------------------------------------------ */

test('exports createByokRelayMiddleware function', () => {
  assert.strictEqual(typeof createByokRelayMiddleware, 'function');
});

test('exports createRelayRoute function', () => {
  assert.strictEqual(typeof createRelayRoute, 'function');
});

test('exports ByokRelayClient class', () => {
  assert.strictEqual(typeof ByokRelayClient, 'function');
});

/* ------------------------------------------------------------------ */
/* createByokRelayMiddleware                                            */
/* ------------------------------------------------------------------ */

test('createByokRelayMiddleware() returns a function', () => {
  const mw = createByokRelayMiddleware();
  assert.strictEqual(typeof mw, 'function');
});

test('createByokRelayMiddleware({ pathPrefix }) returns a function', () => {
  const mw = createByokRelayMiddleware({ pathPrefix: '/api/relay', relayUrl: 'http://localhost:3000' });
  assert.strictEqual(typeof mw, 'function');
});

await testAsync('middleware calls next() for non-matching paths', async () => {
  const mw = createByokRelayMiddleware({ pathPrefix: '/relay' });
  let nextCalled = false;
  const fakeCtx = {
    req: {
      url: 'http://localhost/other/path',
      method: 'GET',
      raw: { headers: { entries: () => [].entries() } },
      header: () => null,
    },
    env: {},
    json: (data, status) => ({ data, status }),
  };
  await mw(fakeCtx, async () => { nextCalled = true; });
  assert.ok(nextCalled, 'next() should be called for non-relay paths');
});

await testAsync('middleware blocks request with disallowed app_id', async () => {
  const mw = createByokRelayMiddleware({
    pathPrefix: '/relay',
    allowedAppIds: ['allowed-app'],
    relayUrl: 'http://localhost:3000',
  });
  let respondedWith403 = false;
  const fakeCtx = {
    req: {
      url: 'http://localhost/relay/health',
      method: 'GET',
      raw: { headers: { entries: () => [].entries() } },
      header: (name) => {
        if (name === 'authorization') return 'Bearer sometoken';
        if (name === 'x-app-id') return 'evil-app';
        return null;
      },
    },
    env: {},
    json: (data, status) => {
      if (status === 403) respondedWith403 = true;
      return { data, status };
    },
  };
  await mw(fakeCtx, async () => {});
  assert.ok(respondedWith403, 'should return 403 for disallowed app_id');
});

/* ------------------------------------------------------------------ */
/* createRelayRoute                                                     */
/* ------------------------------------------------------------------ */

test('createRelayRoute() returns a function', () => {
  const handler = createRelayRoute();
  assert.strictEqual(typeof handler, 'function');
});

test('createRelayRoute({ relayUrl }) returns a function', () => {
  const handler = createRelayRoute({ relayUrl: 'http://localhost:3000' });
  assert.strictEqual(typeof handler, 'function');
});

await testAsync('createRelayRoute blocks disallowed app_id', async () => {
  const handler = createRelayRoute({ allowedAppIds: ['app1'] });
  let got403 = false;
  const fakeCtx = {
    req: {
      url: 'http://localhost/relay/health',
      method: 'GET',
      raw: { headers: { entries: () => [].entries() } },
      header: (name) => {
        if (name === 'x-app-id') return 'not-allowed';
        return null;
      },
      param: () => 'health',
    },
    env: {},
    json: (data, status) => {
      if (status === 403) got403 = true;
      return { data, status };
    },
  };
  await handler(fakeCtx);
  assert.ok(got403, 'should return 403 for disallowed app_id');
});

/* ------------------------------------------------------------------ */
/* ByokRelayClient — construction                                      */
/* ------------------------------------------------------------------ */

test('ByokRelayClient constructs with default relayUrl', () => {
  const client = new ByokRelayClient();
  assert.ok(client._relayUrl.startsWith('https://'));
});

test('ByokRelayClient constructs with custom relayUrl', () => {
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  assert.strictEqual(client._relayUrl, 'http://localhost:3000');
});

test('ByokRelayClient strips trailing slash from relayUrl', () => {
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000/' });
  assert.strictEqual(client._relayUrl, 'http://localhost:3000');
});

test('ByokRelayClient uses custom appId for storage key', () => {
  const client = new ByokRelayClient({ appId: 'myapp' });
  assert.ok(client._storageKey.includes('myapp'));
});

test('ByokRelayClient uses custom storage adapter', () => {
  const store = {};
  const storage = {
    get: (k) => store[k] || null,
    set: (k, v) => { store[k] = v; },
    remove: (k) => { delete store[k]; },
  };
  const client = new ByokRelayClient({ storage });
  assert.strictEqual(client._storage, storage);
});

test('ByokRelayClient falls back to in-memory storage (edge env)', () => {
  const client = new ByokRelayClient({ appId: 'edge-test' });
  assert.strictEqual(client._token, null);
  client._storage.set('foo', 'bar');
  assert.strictEqual(client._storage.get('foo'), 'bar');
  client._storage.remove('foo');
  assert.strictEqual(client._storage.get('foo'), null);
});

/* ------------------------------------------------------------------ */
/* ByokRelayClient — logout                                            */
/* ------------------------------------------------------------------ */

test('logout() clears token and storage', () => {
  const store = {};
  const client = new ByokRelayClient({
    storage: {
      get: (k) => store[k] || null,
      set: (k, v) => { store[k] = v; },
      remove: (k) => { delete store[k]; },
    },
  });
  client._token = 'test-token-abc';
  store[client._storageKey] = 'test-token-abc';
  client.logout();
  assert.strictEqual(client._token, null);
  assert.strictEqual(store[client._storageKey], undefined);
});

/* ------------------------------------------------------------------ */
/* ByokRelayClient — ensureToken                                       */
/* ------------------------------------------------------------------ */

await testAsync('ensureToken() returns existing token without fetching', async () => {
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  client._token = 'existing-token';
  const token = await client.ensureToken();
  assert.strictEqual(token, 'existing-token');
});

/* ------------------------------------------------------------------ */
/* ByokRelayClient — streamChat is an async generator                  */
/* ------------------------------------------------------------------ */

test('streamChat() returns an async iterable', () => {
  const client = new ByokRelayClient();
  const gen = client.streamChat('gpt-4o', []);
  assert.ok(
    typeof gen[Symbol.asyncIterator] === 'function',
    'streamChat should return an async iterable',
  );
});

/* ------------------------------------------------------------------ */
/* ByokRelayClient — register force=true                               */
/* ------------------------------------------------------------------ */

await testAsync('register(appId, force=true) calls fetch even when token exists', async () => {
  let fetchCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, _opts) => {
    fetchCalled = true;
    return {
      ok: true,
      json: async () => ({ token: 'new-token', expires_at: '2027-01-01T00:00:00Z' }),
    };
  };
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  client._token = 'old-token';
  await client.register('myapp', true);
  globalThis.fetch = origFetch;
  assert.ok(fetchCalled, 'fetch should be called when force=true');
  assert.strictEqual(client._token, 'new-token');
});

/* ------------------------------------------------------------------ */
/* ByokRelayClient — chat calls /relay endpoint                        */
/* ------------------------------------------------------------------ */

await testAsync('chat() calls the /relay endpoint with model + messages', async () => {
  let requestedUrl = null;
  let requestedBody = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    requestedUrl = url;
    requestedBody = opts && opts.body ? JSON.parse(opts.body) : null;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Hi!' } }] }),
    };
  };
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  client._token = 'tok';
  const result = await client.chat('gpt-4o', [{ role: 'user', content: 'Hello' }]);
  globalThis.fetch = origFetch;
  assert.ok(requestedUrl.includes('/relay'), 'should call /relay endpoint');
  assert.strictEqual(requestedBody.model, 'gpt-4o');
  assert.strictEqual(requestedBody.messages.length, 1);
  assert.ok(result.choices, 'should return response data');
});

/* ------------------------------------------------------------------ */
/* ByokRelayClient — storeKey                                          */
/* ------------------------------------------------------------------ */

await testAsync('storeKey() calls /keys/:provider with Authorization', async () => {
  let requestedUrl = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, _opts) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  client._token = 'tok';
  await client.storeKey('openai', 'sk-test-123');
  globalThis.fetch = origFetch;
  assert.ok(requestedUrl.includes('/keys/openai'), 'should call /keys/openai');
});

/* ------------------------------------------------------------------ */
/* ByokRelayClient — health                                            */
/* ------------------------------------------------------------------ */

await testAsync('health() calls /health and returns JSON', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, _opts) => ({
    ok: true,
    json: async () => ({ status: 'ok', uptime: 1234 }),
  });
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  const result = await client.health();
  globalThis.fetch = origFetch;
  assert.strictEqual(result.status, 'ok');
});

await testAsync('health(true) calls /health?deep=1', async () => {
  let calledUrl = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, _opts) => {
    calledUrl = url;
    return { ok: true, json: async () => ({ status: 'ok' }) };
  };
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  await client.health(true);
  globalThis.fetch = origFetch;
  assert.ok(calledUrl.includes('deep=1'), 'deep=true should add ?deep=1 to URL');
});

/* ------------------------------------------------------------------ */
/* Final summary                                                        */
/* ------------------------------------------------------------------ */

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

} // end main

main().catch((err) => { console.error(err); process.exit(1); });

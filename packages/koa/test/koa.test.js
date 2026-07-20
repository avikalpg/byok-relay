/**
 * Smoke tests for @byok-relay/koa
 *
 * These tests run without a live relay or Koa peer dep.
 * They verify the module exports and the ByokRelayClient API surface.
 */

'use strict';

const assert = require('assert');

const {
  createByokRelayMiddleware,
  createRelayRouter,
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

console.log('\n@byok-relay/koa — smoke tests\n');

/* ------------------------------------------------------------------ */
/* Exports                                                              */
/* ------------------------------------------------------------------ */

test('exports createByokRelayMiddleware function', () => {
  assert.strictEqual(typeof createByokRelayMiddleware, 'function');
});

test('exports createRelayRouter function', () => {
  assert.strictEqual(typeof createRelayRouter, 'function');
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

test('createByokRelayMiddleware({ pathPrefix, relayUrl }) returns a function', () => {
  const mw = createByokRelayMiddleware({ pathPrefix: '/api/relay', relayUrl: 'http://localhost:3000' });
  assert.strictEqual(typeof mw, 'function');
});

test('middleware has arity 2 (ctx, next)', () => {
  const mw = createByokRelayMiddleware();
  assert.strictEqual(mw.length, 2);
});

test('middleware is async', () => {
  const mw = createByokRelayMiddleware();
  assert.strictEqual(mw.constructor.name, 'AsyncFunction');
});

await testAsync('middleware calls next() when path does not match prefix', async () => {
  const mw = createByokRelayMiddleware({ pathPrefix: '/relay' });
  let nextCalled = false;
  const ctx = { path: '/other', headers: {}, query: {} };
  await mw(ctx, () => { nextCalled = true; });
  assert.ok(nextCalled, 'next() should be called for non-relay paths');
});

await testAsync('middleware returns 403 for disallowed app_id', async () => {
  const mw = createByokRelayMiddleware({
    pathPrefix: '/relay',
    allowedAppIds: ['allowed-app'],
  });
  const ctx = {
    path: '/relay/openai/chat/completions',
    headers: { 'x-app-id': 'forbidden-app' },
    query: {},
    set: () => {},
  };
  await mw(ctx, () => {});
  assert.strictEqual(ctx.status, 403);
  assert.ok(ctx.body.error);
});

await testAsync('middleware passes through when app_id is in allowedAppIds', async () => {
  // Should attempt upstream fetch (will fail with network error — that is expected)
  const mw = createByokRelayMiddleware({
    pathPrefix: '/relay',
    relayUrl: 'http://127.0.0.1:1', // guaranteed to fail
    allowedAppIds: ['good-app'],
    timeoutMs: 500,
  });
  const ctx = {
    path: '/relay/openai/chat/completions',
    headers: { 'x-app-id': 'good-app' },
    query: {},
    method: 'GET',
    querystring: '',
    set: () => {},
  };
  await mw(ctx, () => {});
  // Should get a 502 or 504 (network error / timeout), not 403
  assert.ok(ctx.status === 502 || ctx.status === 504, `expected 502/504, got ${ctx.status}`);
});

/* ------------------------------------------------------------------ */
/* createRelayRouter — no peer dep smoke tests                         */
/* ------------------------------------------------------------------ */

test('createRelayRouter without @koa/router throws a helpful error', () => {
  // This should throw since @koa/router is not installed in this workspace
  // UNLESS @koa/router happens to be installed — in which case it returns a Router
  try {
    const router = createRelayRouter({ relayUrl: 'http://localhost:3000' });
    // If we reach here, @koa/router IS installed — verify it looks like a router
    assert.ok(typeof router.routes === 'function', 'router.routes should be a function');
    assert.ok(typeof router.allowedMethods === 'function', 'router.allowedMethods should be a function');
  } catch (err) {
    assert.ok(
      err.message.includes('@koa/router') || err.message.includes('koa-router'),
      `Expected helpful error about @koa/router, got: ${err.message}`
    );
  }
});

/* ------------------------------------------------------------------ */
/* ByokRelayClient                                                     */
/* ------------------------------------------------------------------ */

test('ByokRelayClient instantiates with no args', () => {
  const client = new ByokRelayClient();
  assert.ok(client instanceof ByokRelayClient);
});

test('ByokRelayClient accepts relayUrl option', () => {
  const client = new ByokRelayClient({ relayUrl: 'https://my-relay.example.com' });
  assert.strictEqual(client._relayUrl, 'https://my-relay.example.com');
});

test('ByokRelayClient accepts appId option', () => {
  const client = new ByokRelayClient({ appId: 'my-koa-app' });
  assert.strictEqual(client._appId, 'my-koa-app');
});

test('ByokRelayClient has register method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.register, 'function');
});

test('ByokRelayClient has ensureToken method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.ensureToken, 'function');
});

test('ByokRelayClient has logout method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.logout, 'function');
});

test('ByokRelayClient has storeKey method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.storeKey, 'function');
});

test('ByokRelayClient has listKeys method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.listKeys, 'function');
});

test('ByokRelayClient has deleteKey method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.deleteKey, 'function');
});

test('ByokRelayClient has rotateKey method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.rotateKey, 'function');
});

test('ByokRelayClient has relayRequest method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.relayRequest, 'function');
});

test('ByokRelayClient has chat method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.chat, 'function');
});

test('ByokRelayClient has streamChat method (async generator)', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.streamChat, 'function');
  // Async generators return object with Symbol.asyncIterator
  const gen = client.streamChat({ model: 'gpt-4o', messages: [] });
  assert.ok(typeof gen[Symbol.asyncIterator] === 'function', 'streamChat should return an async iterable');
  // Clean up (don't await — we don't have a real relay)
  gen.return();
});

test('ByokRelayClient has health method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.health, 'function');
});

test('ByokRelayClient has stats method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.stats, 'function');
});

test('ByokRelayClient has getModels method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.getModels, 'function');
});

test('ByokRelayClient has deleteAccount method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.deleteAccount, 'function');
});

/* ------------------------------------------------------------------ */
/* ByokRelayClient storage                                              */
/* ------------------------------------------------------------------ */

test('ByokRelayClient stores and retrieves token via in-memory store', () => {
  const client = new ByokRelayClient({ appId: 'test-app' });
  client._set(client._tokenKey, 'tok_test123');
  assert.strictEqual(client._get(client._tokenKey), 'tok_test123');
});

test('ByokRelayClient logout removes token from store', () => {
  const client = new ByokRelayClient({ appId: 'test-logout' });
  client._set(client._tokenKey, 'tok_to_remove');
  client.logout();
  assert.strictEqual(client._get(client._tokenKey), null);
});

test('ByokRelayClient accepts custom storage adapter', () => {
  const store = {};
  const client = new ByokRelayClient({
    appId: 'custom-storage',
    storage: {
      get: k => store[k] || null,
      set: (k, v) => { store[k] = v; },
      remove: k => { delete store[k]; },
    },
  });
  client._set('test-key', 'test-value');
  assert.strictEqual(store['test-key'], 'test-value');
  assert.strictEqual(client._get('test-key'), 'test-value');
  client._remove('test-key');
  assert.strictEqual(client._get('test-key'), null);
});

test('ByokRelayClient _tokenKey includes appId', () => {
  const client = new ByokRelayClient({ appId: 'my-unique-app' });
  assert.ok(client._tokenKey.includes('my-unique-app'));
});

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

}

main().catch(err => { console.error(err); process.exit(1); });

/**
 * Smoke tests for @byok-relay/express
 *
 * These tests run without a live relay or Express peer dep.
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

console.log('\n@byok-relay/express — smoke tests\n');

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

test('middleware has arity 3 (req, res, next)', () => {
  const mw = createByokRelayMiddleware();
  assert.strictEqual(mw.length, 3);
});

await testAsync('middleware calls next() for non-matching paths', async () => {
  const mw = createByokRelayMiddleware({ pathPrefix: '/relay' });
  let nextCalled = false;
  const req = { path: '/health', headers: {}, url: '/health', method: 'GET', query: {} };
  const res = {};
  await mw(req, res, () => { nextCalled = true; });
  assert.ok(nextCalled, 'next() should be called for non-relay paths');
});

await testAsync('middleware calls next() for root path when prefix not matched', async () => {
  const mw = createByokRelayMiddleware({ pathPrefix: '/api/ai' });
  let nextCalled = false;
  const req = { path: '/', headers: {}, url: '/', method: 'GET', query: {} };
  await mw(req, {}, () => { nextCalled = true; });
  assert.ok(nextCalled);
});

test('createByokRelayMiddleware({ allowedAppIds }) accepts array', () => {
  const mw = createByokRelayMiddleware({ allowedAppIds: ['app1', 'app2'] });
  assert.strictEqual(typeof mw, 'function');
});

test('createByokRelayMiddleware({ timeoutMs: 5000 }) respects custom timeout', () => {
  const mw = createByokRelayMiddleware({ timeoutMs: 5000 });
  assert.strictEqual(typeof mw, 'function');
});

/* ------------------------------------------------------------------ */
/* createRelayRouter                                                    */
/* ------------------------------------------------------------------ */

test('createRelayRouter() returns an object', () => {
  const router = createRelayRouter();
  assert.ok(router !== null && typeof router === 'object');
});

test('createRelayRouter({ relayUrl }) accepts relayUrl option', () => {
  const router = createRelayRouter({ relayUrl: 'http://localhost:3000' });
  assert.ok(router !== null);
});

test('createRelayRouter({ allowedAppIds }) accepts allowlist', () => {
  const router = createRelayRouter({ allowedAppIds: ['app1'] });
  assert.ok(router !== null);
});

test('createRelayRouter({ timeoutMs: 10000 }) accepts timeout', () => {
  const router = createRelayRouter({ timeoutMs: 10_000 });
  assert.ok(router !== null);
});

/* ------------------------------------------------------------------ */
/* ByokRelayClient — constructor                                        */
/* ------------------------------------------------------------------ */

test('ByokRelayClient constructor with no args', () => {
  const client = new ByokRelayClient();
  assert.ok(client instanceof ByokRelayClient);
});

test('ByokRelayClient constructor with relayUrl', () => {
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  assert.strictEqual(client._relayUrl, 'http://localhost:3000');
});

test('ByokRelayClient constructor with appId', () => {
  const client = new ByokRelayClient({ appId: 'my-express-app' });
  assert.strictEqual(client._appId, 'my-express-app');
});

test('ByokRelayClient constructor with custom storage adapter', () => {
  const store = new Map();
  const adapter = {
    getItem    : (k) => store.get(k) || null,
    setItem    : (k, v) => store.set(k, v),
    removeItem : (k) => store.delete(k),
  };
  const client = new ByokRelayClient({ storage: adapter });
  assert.strictEqual(client._storage, adapter);
});

test('ByokRelayClient defaults appId to "default"', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(client._appId, 'default');
});

/* ------------------------------------------------------------------ */
/* ByokRelayClient — storage                                           */
/* ------------------------------------------------------------------ */

test('ByokRelayClient.logout() clears token', () => {
  const store = new Map();
  store.set('byok_relay_token', 'tok_abc');
  const adapter = {
    getItem    : (k) => store.get(k) || null,
    setItem    : (k, v) => store.set(k, v),
    removeItem : (k) => store.delete(k),
  };
  const client = new ByokRelayClient({ storage: adapter });
  assert.strictEqual(client._token, 'tok_abc');
  client.logout();
  assert.strictEqual(client._token, null);
  assert.strictEqual(store.has('byok_relay_token'), false);
});

/* ------------------------------------------------------------------ */
/* ByokRelayClient — method API surface                                */
/* ------------------------------------------------------------------ */

test('ByokRelayClient exposes register method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.register, 'function');
});

test('ByokRelayClient exposes ensureToken method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.ensureToken, 'function');
});

test('ByokRelayClient exposes logout method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.logout, 'function');
});

test('ByokRelayClient exposes storeKey method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.storeKey, 'function');
});

test('ByokRelayClient exposes listKeys method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.listKeys, 'function');
});

test('ByokRelayClient exposes deleteKey method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.deleteKey, 'function');
});

test('ByokRelayClient exposes rotateKey method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.rotateKey, 'function');
});

test('ByokRelayClient exposes relayRequest method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.relayRequest, 'function');
});

test('ByokRelayClient exposes chat method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.chat, 'function');
});

test('ByokRelayClient exposes streamChat async generator', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.streamChat, 'function');
});

test('ByokRelayClient exposes health method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.health, 'function');
});

test('ByokRelayClient exposes stats method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.stats, 'function');
});

test('ByokRelayClient exposes getModels method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.getModels, 'function');
});

test('ByokRelayClient exposes deleteAccount method', () => {
  const client = new ByokRelayClient();
  assert.strictEqual(typeof client.deleteAccount, 'function');
});

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

} // main

main().catch((err) => { console.error(err); process.exit(1); });

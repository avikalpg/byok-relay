/**
 * @byok-relay/trpc — smoke tests
 * Run: node test/trpc.test.js
 * No external dependencies required.
 */

'use strict';

const {
  ByokRelayClient,
  createByokRelayContext,
  createByokRelayRouter,
  createRelayProcedure,
  createByokRelayFetchHandler,
} = require('../src/index.js');

/* ========================================================================== */
/* Minimal test harness                                                        */
/* ========================================================================== */

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ ${msg}`);
    failed++;
  }
}

function assertThrows(fn, msg) {
  try {
    fn();
    console.error(`  ❌ ${msg} (expected throw, got none)`);
    failed++;
  } catch (_) {
    console.log(`  ✅ ${msg}`);
    passed++;
  }
}

async function assertThrowsAsync(fn, msg) {
  try {
    await fn();
    console.error(`  ❌ ${msg} (expected throw, got none)`);
    failed++;
  } catch (_) {
    console.log(`  ✅ ${msg}`);
    passed++;
  }
}

function section(name) {
  console.log(`\n📋 ${name}`);
}

/* ========================================================================== */
/* ByokRelayClient — unit tests                                                */
/* ========================================================================== */

section('ByokRelayClient — construction');

{
  const client = new ByokRelayClient();
  assert(client._relayUrl === 'https://relay.byokrelay.com', 'defaults to managed relay');
  assert(client._appId === 'byok-relay-trpc-client', 'default appId');
}

{
  const client = new ByokRelayClient({
    relayUrl: 'https://my-relay.example.com/',
    appId: 'my-app',
  });
  assert(client._relayUrl === 'https://my-relay.example.com', 'strips trailing slash');
  assert(client._appId === 'my-app', 'custom appId');
}

section('ByokRelayClient — in-memory storage');

{
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  client._store('test_key', 'test_value');
  assert(client._load('test_key') === 'test_value', 'store and load from memory');
  client._drop('test_key');
  assert(client._load('test_key') === null, 'drop removes from memory');
}

section('ByokRelayClient — custom storage adapter');

{
  const store = {};
  const client = new ByokRelayClient({
    relayUrl: 'http://localhost:3000',
    storage: {
      get:    (k) => store[k] || null,
      set:    (k, v) => { store[k] = v; },
      remove: (k) => { delete store[k]; },
    },
  });
  client._store('foo', 'bar');
  assert(store['foo'] === 'bar', 'custom storage.set called');
  assert(client._load('foo') === 'bar', 'custom storage.get called via load');
  client._drop('foo');
  assert(store['foo'] === undefined, 'custom storage.remove called');
}

section('ByokRelayClient — logout clears token');

{
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  client._store('byok_relay_token', 'tok_abc123');
  client.logout();
  assert(client._load('byok_relay_token') === null, 'logout clears cached token');
}

section('ByokRelayClient — ensureToken returns cached token');

{
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  client._store('byok_relay_token', 'tok_existing');
  let called = false;
  const origRegister = client.register.bind(client);
  client.register = async () => { called = true; return 'tok_new'; };
  client.ensureToken().then((tok) => {
    assert(tok === 'tok_existing', 'ensureToken returns cached token');
    assert(!called, 'ensureToken does not call register when cached');
  });
}

/* ========================================================================== */
/* createByokRelayContext                                                      */
/* ========================================================================== */

section('createByokRelayContext — factory');

{
  const factory = createByokRelayContext({ relayUrl: 'https://test.relay.com', appId: 'ctx-test' });
  assert(typeof factory === 'function', 'returns a function');
  const ctx = factory({});
  assert(ctx.relay instanceof ByokRelayClient, 'ctx.relay is ByokRelayClient');
  assert(ctx.relayUrl === 'https://test.relay.com', 'ctx.relayUrl set');
  assert(ctx.relay._relayUrl === 'https://test.relay.com', 'client uses correct relayUrl');
  assert(ctx.relay._appId === 'ctx-test', 'client uses correct appId');
}

{
  const origEnv = process.env.RELAY_URL;
  process.env.RELAY_URL = 'https://env-relay.example.com';
  const factory = createByokRelayContext();
  const ctx = factory({});
  assert(ctx.relay._relayUrl === 'https://env-relay.example.com', 'falls back to process.env.RELAY_URL');
  process.env.RELAY_URL = origEnv;
}

{
  delete process.env.RELAY_URL;
  const factory = createByokRelayContext();
  const ctx = factory({});
  assert(ctx.relay._relayUrl === 'https://relay.byokrelay.com', 'falls back to managed relay when env unset');
}

/* ========================================================================== */
/* createByokRelayRouter — input validation                                   */
/* ========================================================================== */

section('createByokRelayRouter — requires valid t');

{
  assertThrows(
    () => createByokRelayRouter(null),
    'throws on null t'
  );
  assertThrows(
    () => createByokRelayRouter({}),
    'throws on empty object t (missing router/procedure)'
  );
  assertThrows(
    () => createByokRelayRouter({ router: 'not-a-fn', procedure: {} }),
    'throws when t.router is not a function'
  );
}

section('createByokRelayRouter — builds router with valid t shim');

{
  // Minimal tRPC t shim for testing without @trpc/server installed
  const procedures = {};
  const fakeT = {
    router: (routes) => ({ _routes: routes }),
    procedure: {
      input: (validator) => ({
        _validator: validator,
        query:    (handler) => ({ _type: 'query',    _handler: handler }),
        mutation: (handler) => ({ _type: 'mutation', _handler: handler }),
      }),
      query:    (handler) => ({ _type: 'query',    _handler: handler }),
      mutation: (handler) => ({ _type: 'mutation', _handler: handler }),
      use: (mw) => ({
        input: (v) => ({ _validator: v, query: (h) => ({_type:'query',_handler:h}), mutation: (h) => ({_type:'mutation',_handler:h}) }),
        query: (h) => ({ _type: 'query', _handler: h }),
        mutation: (h) => ({ _type: 'mutation', _handler: h }),
      }),
    },
  };

  const relayRouter = createByokRelayRouter(fakeT, { relayUrl: 'http://localhost:3000' });
  assert(relayRouter && typeof relayRouter._routes === 'object', 'returns router object');
  assert('health' in relayRouter._routes, 'has health procedure');
  assert('register' in relayRouter._routes, 'has register procedure');
  assert('storeKey' in relayRouter._routes, 'has storeKey procedure');
  assert('listKeys' in relayRouter._routes, 'has listKeys procedure');
  assert('deleteKey' in relayRouter._routes, 'has deleteKey procedure');
  assert('rotateKey' in relayRouter._routes, 'has rotateKey procedure');
  assert('chat' in relayRouter._routes, 'has chat procedure');
  assert('stats' in relayRouter._routes, 'has stats procedure');
  assert('models' in relayRouter._routes, 'has models procedure');
}

/* ========================================================================== */
/* createRelayProcedure — middleware factory                                  */
/* ========================================================================== */

section('createRelayProcedure — requires tRPC procedure');

{
  assertThrows(
    () => createRelayProcedure(null),
    'throws on null baseProcedure'
  );
  assertThrows(
    () => createRelayProcedure({}),
    'throws when baseProcedure.use is not a function'
  );
}

section('createRelayProcedure — injects relay into ctx');

{
  let capturedCtx = null;
  let capturedNext = null;

  const fakeProcedure = {
    use: (middleware) => {
      // Simulate tRPC calling the middleware
      const ctx = { existingField: 'value' };
      const next = ({ ctx: newCtx }) => { capturedCtx = newCtx; return Promise.resolve('result'); };
      middleware({ ctx, next });
      return fakeProcedure;
    },
  };

  const enhanced = createRelayProcedure(fakeProcedure, { relayUrl: 'http://test.relay.com', appId: 'test' });
  assert(enhanced === fakeProcedure, 'returns the procedure (use returns self in shim)');
  // capturedCtx is set when use() is called
  assert(capturedCtx !== null, 'middleware was called');
  assert(capturedCtx.existingField === 'value', 'preserves existing context fields');
  assert(capturedCtx.relay instanceof ByokRelayClient, 'injects relay into ctx');
  assert(capturedCtx.relay._relayUrl === 'http://test.relay.com', 'relay uses correct URL');
}

/* ========================================================================== */
/* createByokRelayFetchHandler — validation                                   */
/* ========================================================================== */

section('createByokRelayFetchHandler — returns handler function');

{
  const handler = createByokRelayFetchHandler({
    router: {},
    relayUrl: 'https://test.relay.com',
  });
  assert(typeof handler === 'function', 'returns async handler function');
}

section('createByokRelayFetchHandler — throws when @trpc/server not installed (expected in CI)');

{
  const handler = createByokRelayFetchHandler({
    router: {},
    relayUrl: 'https://test.relay.com',
  });
  // This will throw because @trpc/server is not installed in the test env.
  // That is the correct behavior — the error message tells the user what to install.
  assertThrowsAsync(
    () => handler(new Request('https://example.com/api/trpc/health')),
    'throws with install instructions when @trpc/server missing'
  );
}

/* ========================================================================== */
/* Procedure input validators                                                  */
/* ========================================================================== */

section('Procedure input validators — storeKey');

{
  // Access via router shim
  const fakeT = {
    router: (routes) => ({ _routes: routes }),
    procedure: {
      input: (validator) => ({
        _validator: validator,
        query:    (handler) => ({ _type: 'query',    _handler: handler, _validator: validator }),
        mutation: (handler) => ({ _type: 'mutation', _handler: handler, _validator: validator }),
      }),
      query:    (handler) => ({ _type: 'query',    _handler: handler }),
      mutation: (handler) => ({ _type: 'mutation', _handler: handler }),
      use: () => fakeT.procedure,
    },
  };

  const relayRouter = createByokRelayRouter(fakeT, { relayUrl: 'http://localhost:3000' });

  // storeKey validator
  const storeKeyValidator = relayRouter._routes.storeKey._validator;
  assertThrows(
    () => storeKeyValidator({ provider: 'openai' }), // missing apiKey
    'storeKey validator throws on missing apiKey'
  );
  assertThrows(
    () => storeKeyValidator({ apiKey: 'sk-abc' }), // missing provider
    'storeKey validator throws on missing provider'
  );
  const valid = storeKeyValidator({ provider: 'openai', apiKey: 'sk-abc' });
  assert(valid.provider === 'openai' && valid.apiKey === 'sk-abc', 'storeKey validator passes valid input');
}

section('Procedure input validators — chat');

{
  const fakeT = {
    router: (routes) => ({ _routes: routes }),
    procedure: {
      input: (validator) => ({
        _validator: validator,
        mutation: (handler) => ({ _type: 'mutation', _handler: handler, _validator: validator }),
        query:    (handler) => ({ _type: 'query',    _handler: handler, _validator: validator }),
      }),
      query:    (handler) => ({ _type: 'query',    _handler: handler }),
      mutation: (handler) => ({ _type: 'mutation', _handler: handler }),
      use: () => fakeT.procedure,
    },
  };

  const relayRouter = createByokRelayRouter(fakeT, { relayUrl: 'http://localhost:3000' });
  const chatValidator = relayRouter._routes.chat._validator;

  assertThrows(
    () => chatValidator({ model: 'openai/gpt-4o' }), // missing messages
    'chat validator throws on missing messages'
  );
  assertThrows(
    () => chatValidator({ messages: [] }), // missing model
    'chat validator throws on missing model'
  );
  const valid = chatValidator({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
  assert(valid.model === 'openai/gpt-4o', 'chat validator passes valid model');
  assert(Array.isArray(valid.messages), 'chat validator passes messages array');
  assert(typeof valid.extra === 'object', 'chat validator defaults extra to {}');
}

/* ========================================================================== */
/* Results                                                                     */
/* ========================================================================== */

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error('\n❌ Some tests failed.');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed.');
  process.exit(0);
}

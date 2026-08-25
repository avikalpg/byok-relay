/**
 * Smoke tests for @byok-relay/sveltekit
 *
 * These tests run without a live relay or @sveltejs/kit peer dep.
 * They verify the module exports, API surface, and core proxy logic.
 */

'use strict';

const assert = require('assert');

const {
  createByokRelayHandle,
  createRelayRouteHandlers,
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

console.log('\n@byok-relay/sveltekit — smoke tests\n');

/* ------------------------------------------------------------------ */
/* Exports                                                              */
/* ------------------------------------------------------------------ */

test('exports createByokRelayHandle function', () => {
  assert.strictEqual(typeof createByokRelayHandle, 'function');
});

test('exports createRelayRouteHandlers function', () => {
  assert.strictEqual(typeof createRelayRouteHandlers, 'function');
});

test('exports ByokRelayClient class', () => {
  assert.strictEqual(typeof ByokRelayClient, 'function');
});

/* ------------------------------------------------------------------ */
/* createByokRelayHandle                                                */
/* ------------------------------------------------------------------ */

test('createByokRelayHandle() returns a function', () => {
  const handle = createByokRelayHandle();
  assert.strictEqual(typeof handle, 'function');
});

test('createByokRelayHandle({ pathPrefix, relayUrl }) returns a function', () => {
  const handle = createByokRelayHandle({ pathPrefix: '/api/relay', relayUrl: 'http://localhost:3000' });
  assert.strictEqual(typeof handle, 'function');
});

test('handle has arity 1 ({ event, resolve })', () => {
  const handle = createByokRelayHandle();
  assert.strictEqual(handle.length, 1);
});

test('handle is async (returns a Promise)', () => {
  const handle = createByokRelayHandle({ relayUrl: 'http://localhost:3000' });
  // Pass a non-matching path — should call resolve and return its value
  let resolveCalled = false;
  const mockEvent = {
    url: new URL('http://localhost:5173/about'),
    request: new Request('http://localhost:5173/about'),
  };
  const mockResolve = async (event) => {
    resolveCalled = true;
    return new Response('ok');
  };
  const result = handle({ event: mockEvent, resolve: mockResolve });
  assert.ok(result instanceof Promise, 'handle should return a Promise');
});

await testAsync('handle passes non-matching paths to resolve()', async () => {
  const handle = createByokRelayHandle({ pathPrefix: '/relay', relayUrl: 'http://localhost:3000' });
  let resolveCalled = false;
  const mockEvent = {
    url: new URL('http://localhost:5173/about'),
    request: new Request('http://localhost:5173/about'),
  };
  const mockResolve = async (event) => {
    resolveCalled = true;
    return new Response('ok');
  };
  await handle({ event: mockEvent, resolve: mockResolve });
  assert.ok(resolveCalled, 'resolve should be called for non-relay paths');
});

await testAsync('handle passes sibling paths to resolve()', async () => {
  const handle = createByokRelayHandle({ pathPrefix: '/relay', relayUrl: 'http://localhost:3000' });
  let resolveCalled = false;
  const mockEvent = {
    url: new URL('http://localhost:5173/relayed-notes'),
    request: new Request('http://localhost:5173/relayed-notes'),
  };
  await handle({ event: mockEvent, resolve: async () => {
    resolveCalled = true;
    return new Response('ok');
  } });
  assert.ok(resolveCalled, 'resolve should be called for sibling paths');
});

await testAsync('handle does NOT call resolve() for matching path prefix', async () => {
  // We can't make a real upstream call; instead verify resolve isn't called
  // by mocking fetch to return a valid response
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const handle = createByokRelayHandle({ pathPrefix: '/relay', relayUrl: 'http://localhost:3000' });
  let resolveCalled = false;
  const mockEvent = {
    url: new URL('http://localhost:5173/relay/openai/chat/completions'),
    request: new Request('http://localhost:5173/relay/openai/chat/completions', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }),
  };
  const mockResolve = async () => {
    resolveCalled = true;
    return new Response('ok');
  };

  const response = await handle({ event: mockEvent, resolve: mockResolve });
  assert.ok(!resolveCalled, 'resolve should NOT be called for matching relay path');
  assert.ok(response instanceof Response, 'handle should return a Response');

  global.fetch = originalFetch;
});

await testAsync('handle returns 403 for disallowed app_id', async () => {
  const handle = createByokRelayHandle({
    pathPrefix: '/relay',
    relayUrl: 'http://localhost:3000',
    allowedAppIds: ['allowed-app'],
  });
  const mockEvent = {
    url: new URL('http://localhost:5173/relay/openai/chat/completions'),
    request: new Request('http://localhost:5173/relay/openai/chat/completions', {
      method: 'POST',
      headers: { 'x-app-id': 'forbidden-app', 'Content-Type': 'application/json' },
      body: '{}',
    }),
  };
  const response = await handle({ event: mockEvent, resolve: async () => new Response('ok') });
  assert.strictEqual(response.status, 403);
});

await testAsync('handle returns 403 when an allowlist is configured without app_id', async () => {
  const handle = createByokRelayHandle({
    pathPrefix: '/relay',
    relayUrl: 'http://localhost:3000',
    allowedAppIds: ['allowed-app'],
  });
  const mockEvent = {
    url: new URL('http://localhost:5173/relay/openai/chat/completions'),
    request: new Request('http://localhost:5173/relay/openai/chat/completions', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' },
    }),
  };
  const response = await handle({ event: mockEvent, resolve: async () => new Response('ok') });
  assert.strictEqual(response.status, 403);
});

await testAsync('handle drops stale encoding and length response headers', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('decoded', {
    status: 200,
    headers: { 'content-encoding': 'gzip', 'content-length': '999', 'x-request-id': 'abc' },
  });
  const handle = createByokRelayHandle({ relayUrl: 'http://localhost:3000' });
  const mockEvent = {
    url: new URL('http://localhost:5173/relay/health'),
    request: new Request('http://localhost:5173/relay/health'),
  };
  const response = await handle({ event: mockEvent, resolve: async () => new Response('ok') });
  assert.strictEqual(response.headers.get('content-encoding'), null);
  assert.strictEqual(response.headers.get('content-length'), null);
  assert.strictEqual(response.headers.get('x-request-id'), 'abc');
  global.fetch = originalFetch;
});

await testAsync('handle returns 504 when upstream times out', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    // Simulate AbortError
    await new Promise((_, reject) =>
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      })
    );
  };

  const handle = createByokRelayHandle({
    pathPrefix: '/relay',
    relayUrl: 'http://localhost:3000',
    timeoutMs: 10,
  });
  const mockEvent = {
    url: new URL('http://localhost:5173/relay/openai/chat'),
    request: new Request('http://localhost:5173/relay/openai/chat', {
      method: 'GET',
      headers: {},
    }),
  };
  const response = await handle({ event: mockEvent, resolve: async () => new Response('ok') });
  assert.strictEqual(response.status, 504);

  global.fetch = originalFetch;
});

/* ------------------------------------------------------------------ */
/* createRelayRouteHandlers                                             */
/* ------------------------------------------------------------------ */

test('createRelayRouteHandlers() returns an object', () => {
  const handlers = createRelayRouteHandlers();
  assert.strictEqual(typeof handlers, 'object');
});

test('createRelayRouteHandlers() returns GET, POST, PUT, PATCH, DELETE, OPTIONS', () => {
  const handlers = createRelayRouteHandlers();
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.strictEqual(typeof handlers[method], 'function', `${method} should be a function`);
  }
});

await testAsync('route handler proxies to upstream relay', async () => {
  const originalFetch = global.fetch;
  let capturedUrl = null;
  global.fetch = async (url) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ choices: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const { POST } = createRelayRouteHandlers({ relayUrl: 'http://localhost:3000' });
  const mockEvent = {
    params: { path: 'openai/chat/completions' },
    url: new URL('http://localhost:5173/relay/openai/chat/completions'),
    request: new Request('http://localhost:5173/relay/openai/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
      headers: { 'Content-Type': 'application/json' },
    }),
  };

  const response = await POST(mockEvent);
  assert.ok(response instanceof Response, 'handler should return a Response');
  assert.ok(capturedUrl.includes('openai/chat/completions'), 'upstream URL should include sub-path');

  global.fetch = originalFetch;
});

await testAsync('route handler returns 403 for disallowed app_id', async () => {
  const { POST } = createRelayRouteHandlers({
    relayUrl: 'http://localhost:3000',
    allowedAppIds: ['good-app'],
  });
  const mockEvent = {
    params: { path: 'openai/chat/completions' },
    url: new URL('http://localhost:5173/relay/openai/chat/completions'),
    request: new Request('http://localhost:5173/relay/openai/chat/completions', {
      method: 'POST',
      body: '{}',
      headers: { 'x-app-id': 'bad-app', 'Content-Type': 'application/json' },
    }),
  };
  const response = await POST(mockEvent);
  assert.strictEqual(response.status, 403);
});

await testAsync('route handler handles missing params.path gracefully', async () => {
  const originalFetch = global.fetch;
  let capturedUrl = null;
  global.fetch = async (url) => {
    capturedUrl = url;
    return new Response('{}', { status: 200 });
  };

  const { GET } = createRelayRouteHandlers({ relayUrl: 'http://localhost:3000' });
  const mockEvent = {
    params: {},  // no path param (e.g. relay/+server.js with no catch-all)
    url: new URL('http://localhost:5173/relay'),
    request: new Request('http://localhost:5173/relay', { method: 'GET' }),
  };
  const response = await GET(mockEvent);
  assert.ok(response instanceof Response, 'should still return a Response');
  assert.ok(capturedUrl.endsWith('/'), 'upstream URL should default to /');

  global.fetch = originalFetch;
});

/* ------------------------------------------------------------------ */
/* ByokRelayClient                                                      */
/* ------------------------------------------------------------------ */

test('ByokRelayClient instantiates with defaults', () => {
  const client = new ByokRelayClient();
  assert.ok(client instanceof ByokRelayClient);
  assert.strictEqual(typeof client._relayUrl, 'string');
  assert.strictEqual(typeof client._appId, 'string');
});

test('ByokRelayClient respects relayUrl option', () => {
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:4321' });
  assert.strictEqual(client._relayUrl, 'http://localhost:4321');
});

test('ByokRelayClient respects appId option', () => {
  const client = new ByokRelayClient({ appId: 'my-sveltekit-app' });
  assert.strictEqual(client._appId, 'my-sveltekit-app');
});

test('ByokRelayClient _tokenKey uses appId', () => {
  const client = new ByokRelayClient({ appId: 'test-app' });
  assert.strictEqual(client._tokenKey, 'byok_relay_token_test-app');
});

test('ByokRelayClient in-memory storage get/set/remove', () => {
  const client = new ByokRelayClient({ storage: null });
  client._set('foo', 'bar');
  assert.strictEqual(client._get('foo'), 'bar');
  client._remove('foo');
  assert.strictEqual(client._get('foo'), null);
});

test('ByokRelayClient custom storage adapter', () => {
  const store = {};
  const client = new ByokRelayClient({
    storage: {
      get:    (k) => store[k] ?? null,
      set:    (k, v) => { store[k] = v; },
      remove: (k) => { delete store[k]; },
    },
  });
  client._set('hello', 'world');
  assert.strictEqual(store['hello'], 'world');
  assert.strictEqual(client._get('hello'), 'world');
  client._remove('hello');
  assert.strictEqual(store['hello'], undefined);
});

test('ByokRelayClient cookie storage adapter pattern', () => {
  // Simulate SvelteKit cookies API
  const cookieStore = {};
  const mockCookies = {
    get:    (k) => cookieStore[k] ?? null,
    set:    (k, v) => { cookieStore[k] = v; },
    delete: (k) => { delete cookieStore[k]; },
  };
  const client = new ByokRelayClient({
    appId: 'sk-app',
    storage: {
      get:    (k) => mockCookies.get(k),
      set:    (k, v) => mockCookies.set(k, v),
      remove: (k) => mockCookies.delete(k),
    },
  });
  client._set(client._tokenKey, 'tok_test123');
  assert.strictEqual(cookieStore[client._tokenKey], 'tok_test123');
  assert.strictEqual(client._get(client._tokenKey), 'tok_test123');
});

test('ByokRelayClient.logout() removes token', () => {
  const client = new ByokRelayClient({ appId: 'logout-test' });
  client._set(client._tokenKey, 'some-token');
  assert.strictEqual(client._get(client._tokenKey), 'some-token');
  client.logout();
  assert.strictEqual(client._get(client._tokenKey), null);
});

await testAsync('ByokRelayClient.register() calls POST /users and stores token', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    assert.ok(url.includes('/users'));
    assert.strictEqual(opts.method, 'POST');
    return new Response(JSON.stringify({ token: 'relay_tok_abc123' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  const token = await client.register('my-app');
  assert.strictEqual(token, 'relay_tok_abc123');
  assert.strictEqual(client._get(client._tokenKey), 'relay_tok_abc123');
  global.fetch = originalFetch;
});

await testAsync('ByokRelayClient.ensureToken() uses cached token', async () => {
  let fetchCount = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCount++;
    return new Response(JSON.stringify({ token: 'tok_fresh' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  client._set(client._tokenKey, 'tok_cached');
  const t1 = await client.ensureToken();
  const t2 = await client.ensureToken();
  assert.strictEqual(t1, 'tok_cached');
  assert.strictEqual(t2, 'tok_cached');
  assert.strictEqual(fetchCount, 0, 'fetch should not be called when token cached');
  global.fetch = originalFetch;
});

await testAsync('ByokRelayClient.storeKey() calls POST /keys/:provider', async () => {
  const originalFetch = global.fetch;
  let calledUrl = null;
  global.fetch = async (url, opts) => {
    if (url.includes('/users')) return new Response(JSON.stringify({ token: 'tok' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    calledUrl = url;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  await client.storeKey('openai', 'sk-test-123');
  assert.ok(calledUrl.includes('/keys/openai'));
  global.fetch = originalFetch;
});

await testAsync('ByokRelayClient.chat() sends to /relay', async () => {
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, opts) => {
    if (url.includes('/users')) return new Response(JSON.stringify({ token: 'tok' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    capturedBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  await client.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(capturedBody.model, 'gpt-4o');
  global.fetch = originalFetch;
});

await testAsync('ByokRelayClient.streamChat() yields text chunks', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (url.includes('/users')) return new Response(JSON.stringify({ token: 'tok' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      'data: [DONE]',
    ].join('\n');
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start (controller) {
        controller.enqueue(encoder.encode(sseBody));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  const chunks = [];
  for await (const chunk of client.streamChat({ model: 'gpt-4o', messages: [] })) {
    chunks.push(chunk);
  }
  assert.deepStrictEqual(chunks, ['Hello', ' world']);
  global.fetch = originalFetch;
});

await testAsync('ByokRelayClient.streamChat() cancels the reader on early exit', async () => {
  const originalFetch = global.fetch;
  let cancelled = false;
  global.fetch = async (url) => {
    if (url.includes('/users')) return new Response(JSON.stringify({ token: 'tok' }), { status: 201 });
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: new TextEncoder().encode('data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n') }),
          cancel: async () => { cancelled = true; },
        }),
      },
    };
  };
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  for await (const chunk of client.streamChat({ model: 'gpt-4o', messages: [] })) {
    assert.strictEqual(chunk, 'Hello');
    break;
  }
  assert.ok(cancelled, 'reader should be cancelled when the consumer exits early');
  global.fetch = originalFetch;
});

await testAsync('ByokRelayClient.streamChat() rejects an empty successful body', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/users')) return new Response(JSON.stringify({ token: 'tok' }), { status: 201 });
    return { ok: true, body: null };
  };
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  await assert.rejects(
    async () => { for await (const _ of client.streamChat({ model: 'gpt-4o', messages: [] })) {} },
    /empty response body/
  );
  global.fetch = originalFetch;
});

await testAsync('ByokRelayClient.health() calls /health', async () => {
  const originalFetch = global.fetch;
  let capturedUrl = null;
  global.fetch = async (url) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  };
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  await client.health();
  assert.ok(capturedUrl.includes('/health'));
  assert.ok(!capturedUrl.includes('deep'));
  global.fetch = originalFetch;
});

await testAsync('ByokRelayClient.health(true) calls /health?deep=1', async () => {
  const originalFetch = global.fetch;
  let capturedUrl = null;
  global.fetch = async (url) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  };
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  await client.health(true);
  assert.ok(capturedUrl.includes('deep=1'));
  global.fetch = originalFetch;
});

await testAsync('ByokRelayClient.getModels() calls /models', async () => {
  const originalFetch = global.fetch;
  let capturedUrl = null;
  global.fetch = async (url) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ models: [] }), { status: 200 });
  };
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  await client.getModels();
  assert.ok(capturedUrl.includes('/models'));
  global.fetch = originalFetch;
});

await testAsync('ByokRelayClient.deleteAccount() calls DELETE /users and logs out', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (url.includes('/users') && opts.method === 'DELETE') {
      return new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ token: 'tok' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new ByokRelayClient({ relayUrl: 'http://localhost:3000' });
  client._set(client._tokenKey, 'tok_to_delete');
  await client.deleteAccount();
  assert.strictEqual(client._get(client._tokenKey), null, 'token should be cleared after deleteAccount');
  global.fetch = originalFetch;
});

/* ------------------------------------------------------------------ */
/* Edge runtime compatibility                                           */
/* ------------------------------------------------------------------ */

test('module exports do not require process.env at import time', () => {
  // If RELAY_URL is undefined, factory functions should still work
  const saved = process.env.RELAY_URL;
  delete process.env.RELAY_URL;
  try {
    const handle = createByokRelayHandle();
    const handlers = createRelayRouteHandlers();
    const client = new ByokRelayClient();
    assert.ok(handle);
    assert.ok(handlers.GET);
    assert.ok(client._relayUrl.includes('byokrelay.com'));
  } finally {
    if (saved !== undefined) process.env.RELAY_URL = saved;
  }
});

test('createByokRelayHandle uses process.env.RELAY_URL when no option provided', () => {
  const saved = process.env.RELAY_URL;
  process.env.RELAY_URL = 'http://my-relay.example.com';
  try {
    const client = new ByokRelayClient();
    assert.strictEqual(client._relayUrl, 'http://my-relay.example.com');
  } finally {
    if (saved !== undefined) process.env.RELAY_URL = saved;
    else delete process.env.RELAY_URL;
  }
});

/* ------------------------------------------------------------------ */
/* Results                                                              */
/* ------------------------------------------------------------------ */

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

} // end main

main().catch(err => { console.error(err); process.exit(1); });

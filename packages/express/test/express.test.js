/**
 * Behavioral tests for @byok-relay/express.
 * These run without a live relay and stub only the upstream fetch boundary.
 */

'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const {
  createByokRelayMiddleware,
  createRelayRouter,
  ByokRelayClient,
} = require('../src/index.js');

let passed = 0;
let failed = 0;

function test (name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✅  ${name}`);
      passed++;
    })
    .catch((err) => {
      console.error(`  ❌  ${name}`);
      console.error(`      ${err.stack || err.message}`);
      failed++;
    });
}

async function withFetch (stub, fn) {
  const original = global.fetch;
  global.fetch = stub;
  try { return await fn(); } finally { global.fetch = original; }
}

class FakeResponse extends EventEmitter {
  constructor (opts = {}) {
    super();
    this.headers = {};
    this.chunks = [];
    this.headersSent = false;
    this.writableEnded = false;
    this.writeResult = opts.writeResult ?? true;
    this.onWrite = opts.onWrite;
  }

  status (code) { this.statusCode = code; return this; }
  setHeader (name, value) { this.headers[name.toLowerCase()] = value; }
  write (chunk) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    if (this.onWrite) this.onWrite();
    return this.writeResult;
  }
  end () { this.headersSent = true; this.writableEnded = true; }
  json (body) { this.body = body; this.end(); return this; }
}

function request (opts = {}) {
  const req = opts.rawBody === undefined ? {} : Readable.from([opts.rawBody]);
  Object.assign(req, {
    path: opts.path || '/relay',
    url: opts.url || opts.path || '/relay',
    method: opts.method || 'GET',
    headers: opts.headers || {},
    query: opts.query || {},
    originalUrl: opts.url || opts.path || '/relay',
    baseUrl: '',
  });
  return req;
}

async function main () {
  console.log('\n@byok-relay/express — behavioral tests\n');

  await test('exports the Express middleware, Router factory, and client', () => {
    assert.strictEqual(typeof createByokRelayMiddleware, 'function');
    assert.strictEqual(typeof createRelayRouter, 'function');
    assert.strictEqual(typeof ByokRelayClient, 'function');
  });

  await test('only intercepts an exact prefix or a prefix path boundary', async () => {
    const middleware = createByokRelayMiddleware({ pathPrefix: '/relay' });
    for (const path of ['/relay-admin', '/relayfoo', '/other']) {
      let nextCalled = false;
      await middleware(request({ path }), new FakeResponse(), () => { nextCalled = true; });
      assert.ok(nextCalled, `${path} should pass through`);
    }
  });

  await test('rejects missing and disallowed app IDs when a middleware allowlist is enabled', async () => {
    const middleware = createByokRelayMiddleware({
      relayUrl: 'https://upstream.test',
      allowedAppIds: ['allowed'],
    });
    for (const headers of [{}, { 'x-app-id': 'blocked' }]) {
      const res = new FakeResponse();
      await middleware(request({ path: '/relay/chat', headers }), res, () => {});
      assert.strictEqual(res.statusCode, 403);
      assert.deepStrictEqual(res.body, { error: 'app_id not allowed' });
    }
  });

  await test('proxies an unparsed request stream and keeps its valid content length', async () => {
    let upstreamInit;
    let forwardedBody;
    await withFetch(async (_url, init) => {
      upstreamInit = init;
      const chunks = [];
      for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
      forwardedBody = Buffer.concat(chunks).toString();
      return new Response('ok', { status: 200 });
    }, async () => {
      const middleware = createByokRelayMiddleware({ relayUrl: 'https://upstream.test' });
      const res = new FakeResponse();
      await middleware(request({
        path: '/relay/chat', method: 'POST', rawBody: 'raw body',
        headers: { host: 'app.test', 'content-length': '8', 'content-type': 'text/plain' },
      }), res, () => {});
      assert.strictEqual(Buffer.concat(res.chunks).toString(), 'ok');
    });
    assert.strictEqual(upstreamInit.body.constructor.name, 'Readable');
    assert.strictEqual(forwardedBody, 'raw body');
    assert.strictEqual(upstreamInit.duplex, 'half');
    assert.strictEqual(upstreamInit.headers.host, undefined);
    assert.strictEqual(upstreamInit.headers['content-length'], '8');
  });

  await test('re-serializes parsed bodies without stale request or response transport headers', async () => {
    let upstreamInit;
    let res;
    await withFetch(async (_url, init) => {
      upstreamInit = init;
      return new Response(null, {
        status: 204,
        headers: { 'content-encoding': 'gzip', 'content-length': '999', 'x-request-id': 'request-id' },
      });
    }, async () => {
      const middleware = createByokRelayMiddleware({ relayUrl: 'https://upstream.test' });
      const req = request({
        path: '/relay/chat', method: 'POST',
        headers: { host: 'app.test', 'content-length': '999', 'content-type': 'application/json' },
      });
      req.body = { prompt: 'hello' };
      res = new FakeResponse();
      await middleware(req, res, () => {});
      assert.ok(res.writableEnded, '204 responses should end without a body reader');
    });
    assert.strictEqual(upstreamInit.body, JSON.stringify({ prompt: 'hello' }));
    assert.strictEqual(upstreamInit.headers.host, undefined);
    assert.strictEqual(upstreamInit.headers['content-length'], undefined);
    assert.strictEqual(res.headers['content-encoding'], undefined);
    assert.strictEqual(res.headers['content-length'], undefined);
    assert.strictEqual(res.headers['x-request-id'], 'request-id');
  });

  await test('handles a HEAD response with no upstream body', async () => {
    let upstreamInit;
    await withFetch(async (_url, init) => {
      upstreamInit = init;
      return new Response(null, { status: 200 });
    }, async () => {
      const middleware = createByokRelayMiddleware({ relayUrl: 'https://upstream.test' });
      const res = new FakeResponse();
      await middleware(request({ path: '/relay/models', method: 'HEAD' }), res, () => {});
      assert.ok(res.writableEnded);
    });
    assert.strictEqual(upstreamInit.body, undefined);
  });

  await test('waits for downstream drain before continuing a streamed response', async () => {
    await withFetch(async () => ({
      status: 200,
      headers: new Headers(),
      body: new ReadableStream({
        start (controller) {
          controller.enqueue(Buffer.from('first'));
          controller.enqueue(Buffer.from('second'));
          controller.close();
        },
      }),
    }), async () => {
      const middleware = createByokRelayMiddleware({ relayUrl: 'https://upstream.test' });
      const res = new FakeResponse({
        writeResult: false,
        onWrite: () => setTimeout(() => res.emit('drain'), 0),
      });
      await middleware(request({ path: '/relay/chat' }), res, () => {});
      assert.strictEqual(Buffer.concat(res.chunks).toString(), 'firstsecond');
      assert.ok(res.writableEnded);
    });
  });

  await test('returns a 504 when the upstream request times out', async () => {
    await withFetch((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }), async () => {
      const middleware = createByokRelayMiddleware({ relayUrl: 'https://upstream.test', timeoutMs: 5 });
      const res = new FakeResponse();
      await middleware(request({ path: '/relay/chat' }), res, () => {});
      assert.strictEqual(res.statusCode, 504);
      assert.deepStrictEqual(res.body, { error: 'Upstream relay timed out' });
    });
  });

  await test('does not report a timeout when a downstream disconnect aborts a pending read', async () => {
    let cancelRead;
    let cancelled = false;
    const res = new FakeResponse();
    await withFetch(async () => ({
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: () => new Promise((_resolve, reject) => { cancelRead = reject; }),
          cancel: async () => { cancelled = true; },
        }),
      },
    }), async () => {
      const middleware = createByokRelayMiddleware({ relayUrl: 'https://upstream.test' });
      const pending = middleware(request({ path: '/relay/chat' }), res, () => {});
      await new Promise((resolve) => setImmediate(resolve));
      res.emit('close');
      cancelRead(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      await pending;
    });
    assert.ok(cancelled, 'reader.cancel() should run after a downstream close');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, undefined);
    assert.strictEqual(res.writableEnded, false);
  });

  await test('cancels the upstream reader when the downstream client disconnects', async () => {
    let cancelled = false;
    let read = false;
    await withFetch(async () => ({
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            if (read) return { done: true };
            read = true;
            return { done: false, value: Buffer.from('chunk') };
          },
          cancel: async () => { cancelled = true; },
        }),
      },
    }), async () => {
      const middleware = createByokRelayMiddleware({ relayUrl: 'https://upstream.test' });
      const res = new FakeResponse({ onWrite: () => res.emit('close') });
      await middleware(request({ path: '/relay/chat' }), res, () => {});
    });
    assert.ok(cancelled, 'reader.cancel() should run after a downstream close');
  });

  await test('createRelayRouter returns callable middleware and enforces its allowlist', async () => {
    const router = createRelayRouter({ relayUrl: 'https://upstream.test', allowedAppIds: ['allowed'] });
    assert.strictEqual(typeof router, 'function');
    const res = new FakeResponse();
    await router(request({ path: '/chat', url: '/chat' }), res, () => {});
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, { error: 'app_id not allowed' });
  });

  await test('namespaces tokens by relay and app ID, with an explicit storage key override', () => {
    const values = new Map();
    const storage = {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
    const first = new ByokRelayClient({ relayUrl: 'https://one.test', appId: 'one', storage });
    const second = new ByokRelayClient({ relayUrl: 'https://one.test', appId: 'two', storage });
    values.set(first._storageKey, 'token-one');
    values.set(second._storageKey, 'token-two');
    assert.strictEqual(new ByokRelayClient({ relayUrl: 'https://one.test', appId: 'one', storage })._token, 'token-one');
    assert.strictEqual(new ByokRelayClient({ relayUrl: 'https://one.test', appId: 'two', storage })._token, 'token-two');
    const custom = new ByokRelayClient({ storage, storageKey: 'session-token' });
    assert.strictEqual(custom._storageKey, 'session-token');
  });

  await test('shares concurrent token registration and sends client requests with its token', async () => {
    let registrations = 0;
    let keyRequest;
    const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    await withFetch(async (url, init = {}) => {
      if (url.endsWith('/users')) {
        registrations++;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return new Response(JSON.stringify({ token: 'token-123' }), { status: 200 });
      }
      keyRequest = { url, init };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }, async () => {
      const client = new ByokRelayClient({ relayUrl: 'https://upstream.test', appId: 'app', storage });
      const tokens = await Promise.all([client.ensureToken(), client.ensureToken()]);
      assert.deepStrictEqual(tokens, ['token-123', 'token-123']);
      await client.storeKey('openai', 'sk-test');
    });
    assert.strictEqual(registrations, 1);
    assert.strictEqual(keyRequest.url, 'https://upstream.test/keys/openai');
    assert.strictEqual(keyRequest.init.headers.Authorization, 'Bearer token-123');
    assert.strictEqual(keyRequest.init.headers['x-app-id'], 'app');
  });

  await test('keeps the configured app ID immutable across registration and relay requests', async () => {
    let request;
    const storage = { getItem: () => 'token-123', setItem: () => {}, removeItem: () => {} };
    await withFetch(async (url, init = {}) => {
      request = { url, init };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }, async () => {
      const client = new ByokRelayClient({ relayUrl: 'https://upstream.test', appId: 'configured', storage });
      await assert.rejects(() => client.register({ appId: 'other' }), /must match the client appId/);
      await client.relayRequest('/models', { headers: { 'x-app-id': 'other' } });
    });
    assert.strictEqual(request.url, 'https://upstream.test/models');
    assert.strictEqual(request.init.headers['x-app-id'], 'configured');
  });

  await test('constructs a client without process being available in a browser bundle', () => {
    const original = global.process;
    try {
      global.process = undefined;
      const client = new ByokRelayClient({ relayUrl: undefined });
      assert.strictEqual(client._relayUrl, 'https://relay.byokrelay.com');
    } finally {
      global.process = original;
    }
  });

  await test('cancels and releases an SSE reader when iteration ends early', async () => {
    let cancelled = false;
    let released = false;
    const body = {
      getReader: () => ({
        read: async () => ({
          done: false,
          value: Buffer.from('data: {"choices":[{"delta":{"content":"hi"}}]}\n'),
        }),
        cancel: async () => { cancelled = true; },
        releaseLock: () => { released = true; },
      }),
    };
    const client = new ByokRelayClient({ storage: { getItem: () => 'token', setItem: () => {}, removeItem: () => {} } });
    await withFetch(async () => ({ ok: true, body }), async () => {
      for await (const chunk of client.streamChat({ model: 'openai/gpt-4o', messages: [] })) {
        assert.strictEqual(chunk, 'hi');
        break;
      }
    });
    assert.ok(cancelled);
    assert.ok(released);
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });

/**
 * relay.test.js — byok-relay end-to-end test suite
 *
 * This file simulates a complete "example product" flow:
 *   1. A frontend app registers a new user session       (POST /users)
 *   2. The user enters their API key                     (POST /keys/:provider)
 *   3. The app makes AI calls through the relay          (POST /relay/:provider/*)
 *   4. The relay forwards to the AI provider with the    (→ mock provider)
 *      stored key — never the key the user typed
 *
 * A mock AI provider (no real keys needed) is started on a random port.
 * The relay server is spawned as a child process against a temp SQLite DB.
 * Everything is cleaned up after the suite finishes.
 *
 * Run:  npm test
 *       node --test test/e2e/relay.test.js
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const os     = require('node:os');
const path   = require('node:path');
const fs     = require('node:fs');
const Database = require('better-sqlite3');
const crypto = require('node:crypto');

const { createMockProvider } = require('./mock-provider');

it('startup migration preserves keys belonging to legacy-token users', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-relay-migration-'));
  const dbPath = path.join(tmpDir, 'legacy.db');
  const legacyDb = new Database(dbPath);

  legacyDb.pragma('foreign_keys = ON');
  legacyDb.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      app_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, provider)
    );
    INSERT INTO users VALUES ('legacy-user', 'legacy-token', 'legacy-app', 1);
    INSERT INTO keys VALUES (
      'legacy-key', 'legacy-user', 'openai', 'ciphertext', 'iv', 'tag', 2
    );
  `);
  legacyDb.close();

  const migrated = spawnSync(process.execPath, ['-e', "require('./src/db')"], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      DB_PATH: dbPath,
      ENCRYPTION_SECRET: 'migration-test-secret-at-least-32-characters',
    },
    encoding: 'utf8',
  });
  assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);

  const verifyDb = new Database(dbPath, { readonly: true });
  assert.deepEqual(
    verifyDb.prepare('SELECT id, user_id, provider FROM keys').all(),
    [{ id: 'legacy-key', user_id: 'legacy-user', provider: 'openai' }],
  );
  assert.equal(
    verifyDb.prepare('SELECT token_hash FROM users WHERE id = ?').get('legacy-user').token_hash.length,
    64,
  );
  assert.deepEqual(verifyDb.pragma('foreign_key_check'), []);
  verifyDb.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

it('dedicated HMAC key accepts legacy tokens and upgrades their stored hashes', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-relay-hmac-rotation-'));
  const dbPath = path.join(tmpDir, 'relay.db');
  const legacySecret = 'legacy-encryption-secret-at-least-32-characters';
  const currentSecret = 'dedicated-token-secret-at-least-32-characters';
  const token = 'existing-user-plaintext-relay-token';
  const legacyHash = crypto.createHmac('sha256', legacySecret).update(token).digest('hex');
  const currentHash = crypto.createHmac('sha256', currentSecret).update(token).digest('hex');
  const seedDb = new Database(dbPath);

  seedDb.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      app_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  seedDb.prepare('INSERT INTO users VALUES (?, ?, ?, ?)')
    .run('existing-user', legacyHash, 'existing-app', 1);
  seedDb.close();

  const lookup = spawnSync(process.execPath, ['-e', `
    const { getUserByToken } = require('./src/db');
    process.stdout.write(JSON.stringify(getUserByToken(${JSON.stringify(token)})));
  `], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      DB_PATH: dbPath,
      ENCRYPTION_SECRET: legacySecret,
      TOKEN_HMAC_SECRET: currentSecret,
    },
    encoding: 'utf8',
  });
  assert.equal(lookup.status, 0, lookup.stderr || lookup.stdout);
  assert.deepEqual(JSON.parse(lookup.stdout), {
    id: 'existing-user',
    app_id: 'existing-app',
    created_at: 1,
  });

  const verifyDb = new Database(dbPath, { readonly: true });
  assert.equal(
    verifyDb.prepare('SELECT token_hash FROM users WHERE id = ?').get('existing-user').token_hash,
    currentHash,
  );
  assert.equal(
    verifyDb.prepare('SELECT token_hmac_version FROM users WHERE id = ?').get('existing-user').token_hmac_version,
    2,
  );
  verifyDb.close();

  // After the lazy upgrade, the dedicated key works without legacy fallback.
  const currentOnlyLookup = spawnSync(process.execPath, ['-e', `
    const { getUserByToken } = require('./src/db');
    process.stdout.write(JSON.stringify(getUserByToken(${JSON.stringify(token)})));
  `], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      DB_PATH: dbPath,
      ENCRYPTION_SECRET: currentSecret,
      TOKEN_HMAC_SECRET: currentSecret,
    },
    encoding: 'utf8',
  });
  assert.equal(currentOnlyLookup.status, 0, currentOnlyLookup.stderr || currentOnlyLookup.stdout);
  assert.equal(JSON.parse(currentOnlyLookup.stdout).id, 'existing-user');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

it('HMAC migration progress reports conservative legacy and current counts', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-relay-hmac-progress-'));
  const dbPath = path.join(tmpDir, 'relay.db');
  const seedDb = new Database(dbPath);
  seedDb.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      token_hmac_version INTEGER NOT NULL DEFAULT 1,
      app_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO users VALUES ('legacy', 'legacy-hash', 1, 'app', 1);
    INSERT INTO users VALUES ('current', 'current-hash', 2, 'app', 2);
  `);
  seedDb.close();

  const status = spawnSync(process.execPath, ['-e', `
    const { getTokenHmacMigrationProgress } = require('./src/db');
    process.stdout.write(JSON.stringify(getTokenHmacMigrationProgress()));
  `], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      DB_PATH: dbPath,
      ENCRYPTION_SECRET: 'progress-test-secret-at-least-32-characters',
      TOKEN_HMAC_SECRET: 'progress-token-secret-at-least-32-characters',
    },
    encoding: 'utf8',
  });
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.deepEqual(JSON.parse(status.stdout), { total: 2, current: 1, legacy: 1, percent: 50 });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createSelfSignedCert(tmpDir) {
  const keyPath = path.join(tmpDir, 'key.pem');
  const certPath = path.join(tmpDir, 'cert.pem');
  const openssl = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-subj', '/CN=localtest.me',
    '-addext', 'subjectAltName=DNS:localtest.me,DNS:*.localtest.me',
    '-keyout', keyPath,
    '-out', certPath,
  ], { encoding: 'utf8' });

  if (openssl.status !== 0) {
    throw new Error(`openssl failed to create E2E TLS certificate: ${openssl.stderr || openssl.stdout}`);
  }

  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Make an HTTP request, return { status, body, headers }.
 * body is parsed as JSON if possible, otherwise returned as a string.
 */
function request(port, method, pathname, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload != null ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

/**
 * Like request(), but returns the raw response body as a string.
 * Used for SSE streaming assertions.
 */
function requestRaw(port, method, pathname, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload != null ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

/**
 * Pick a free TCP port by briefly binding to :0 and then releasing it.
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * Poll GET /health until the server responds 200 or the deadline passes.
 */
async function waitForHealth(port, maxMs = 8000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await request(port, 'GET', '/health');
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Relay server on port ${port} did not start within ${maxMs}ms`);
}

async function waitForCondition(predicate, maxMs = 2000, message = 'condition was not met') {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(message);
}

async function stopChildProcess(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;

  await new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 5000);
    const done = () => {
      clearTimeout(killTimer);
      resolve();
    };
    child.once('exit', done);
    if (!child.kill('SIGTERM')) done();
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Test suite
// ──────────────────────────────────────────────────────────────────────────────

describe('byok-relay — example product end-to-end', () => {
  // Shared infrastructure
  let mock;           // mock AI provider
  let mockPort;
  let relayProc;      // relay child process
  let relayPort;
  let tmpDb;          // path to ephemeral SQLite file
  let tmpCertDir;     // path to ephemeral TLS cert directory
  let mockBaseUrl;    // HTTPS URL used by the relay to reach the mock provider

  const SAFE_E2E_BASE_URL = 'https://example.com';
  const E2E_BASE_URL_OVERRIDE_TOKEN = `e2e-${process.pid}-${Date.now()}`;

  function e2eRelayHeaders() {
    return {
      'x-relay-base-url': SAFE_E2E_BASE_URL,
      'x-relay-e2e-base-url-token': E2E_BASE_URL_OVERRIDE_TOKEN,
    };
  }

  async function ensureProviderKey(provider) {
    const r = await request(
      relayPort, 'POST', `/keys/${provider}`,
      { key: FAKE_API_KEY },
      { 'x-relay-token': relayToken },
    );
    assert.equal(r.status, 200, `Expected to store test key for ${provider}, got ${r.status}`);
  }

  async function createRelayTokenWithKey(provider = 'openai-compatible') {
    const created = await request(relayPort, 'POST', '/users', {
      app_id: `e2e-extra-${provider}-${Date.now()}-${Math.random()}`,
    });
    assert.equal(created.status, 200, `Expected to create extra relay token, got ${created.status}`);

    const token = created.body.token;
    const stored = await request(
      relayPort, 'POST', `/keys/${provider}`,
      { key: FAKE_API_KEY },
      { 'x-relay-token': token },
    );
    assert.equal(stored.status, 200, `Expected to store test key for extra ${provider}, got ${stored.status}`);
    return token;
  }

  // Shared session state — persists across tests within this suite,
  // exactly as a frontend app would persist state in localStorage
  let relayToken;
  const APP_ID       = 'e2e-test-app';
  const FAKE_API_KEY = 'sk-test-fake-key-123456789012345'; // ≥10 chars

  // ── Lifecycle ───────────────────────────────────────────────────────────

  before(async () => {
    // 1. Start the mock AI provider on a random port.
    // The relay requires HTTPS openai-compatible base URLs. Use a self-signed
    // localtest.me endpoint so the test stays local while still exercising the
    // HTTPS path.
    tmpCertDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-relay-e2e-cert-'));
    mock = createMockProvider({
      tls: createSelfSignedCert(tmpCertDir),
      host: '::',
    });
    mockPort = await mock.start();
    mockBaseUrl = `https://localtest.me:${mockPort}`;

    // 2. Reserve a free port for the relay
    relayPort = await getFreePort();

    // 3. Temp DB so tests never touch the real relay.db
    tmpDb = path.join(os.tmpdir(), `byok-relay-e2e-${Date.now()}.db`);

    // 4. Spawn the relay server as a real child process (closest to production)
    relayProc = spawn(
      process.execPath,
      [path.resolve(__dirname, '../../src/index.js')],
      {
        env: {
          ...process.env,
          PORT:              String(relayPort),
          ENCRYPTION_SECRET: 'e2e-test-secret-at-least-32-characters-long',
          DB_PATH:           tmpDb,
          ALLOWED_ORIGINS:   '*',
          REQUEST_BODY_LIMIT_BYTES: '4096',
          NODE_ENV:          'test',
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
          E2E_OPENAI_COMPATIBLE_BASE_URL: mockBaseUrl,
          E2E_OPENAI_COMPATIBLE_BASE_URL_TOKEN: E2E_BASE_URL_OVERRIDE_TOKEN,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    relayProc.stdout.on('data', (d) => process.stdout.write(`[relay] ${d}`));
    relayProc.stderr.on('data', (d) => process.stderr.write(`[relay] ${d}`));

    // 5. Wait until relay is accepting requests
    await waitForHealth(relayPort);
  });

  after(async () => {
    // Guard against already-exited process: register the listener BEFORE kill
    // so we never miss the exit event, and skip the whole thing if the process
    // already terminated (exitCode / signalCode are set once it has).
    if (relayProc && relayProc.exitCode == null && relayProc.signalCode == null) {
      const exited = new Promise((r) => relayProc.once('exit', r));
      relayProc.kill('SIGTERM');
      await exited;
    }

    await mock.stop();

    // Clean up temp DB files (SQLite WAL mode creates -wal and -shm sidecar files)
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* ok if already gone */ }
    }
    if (tmpCertDir) fs.rmSync(tmpCertDir, { recursive: true, force: true });
  });

  // ── 1. Health check ─────────────────────────────────────────────────────

  it('GET /health — returns ok + provider list', async () => {
    const r = await request(relayPort, 'GET', '/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(Array.isArray(r.body.providers), 'providers should be an array');
    assert.ok(r.body.providers.includes('openai'),     'should list openai');
    assert.ok(r.body.providers.includes('anthropic'),  'should list anthropic');
    assert.ok(r.body.providers.includes('openai-compatible'), 'should list openai-compatible');
  });

  // ── 2. User registration ─────────────────────────────────────────────────
  // Example product: called once per visitor (no token in localStorage)

  it('POST /users — registers a new user and returns a relay token', async () => {
    const r = await request(relayPort, 'POST', '/users', { app_id: APP_ID });
    assert.equal(r.status, 200);
    assert.ok(typeof r.body.token === 'string', 'token should be a string');
    assert.ok(r.body.token.length >= 32, 'token should be ≥32 chars');

    // Save for subsequent tests — this is what a real app would store in localStorage
    relayToken = r.body.token;
  });

  it('POST /users — rejects missing app_id', async () => {
    const r = await request(relayPort, 'POST', '/users', {});
    assert.equal(r.status, 400);
    assert.ok(r.body.error, 'should return an error message');
  });

  // ── 3. Key storage ───────────────────────────────────────────────────────
  // Example product: user enters their API key into the app's settings page

  it('POST /keys/openai-compatible — stores the user API key server-side', async () => {
    const r = await request(
      relayPort, 'POST', '/keys/openai-compatible',
      { key: FAKE_API_KEY },
      { 'x-relay-token': relayToken },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.provider, 'openai-compatible');
  });

  it('GET /keys — lists stored providers without revealing key values', async () => {
    const r = await request(relayPort, 'GET', '/keys', undefined, { 'x-relay-token': relayToken });
    assert.equal(r.status, 200);
    assert.ok(r.body.providers.includes('openai-compatible'), 'should list stored provider');
    // Confirm the response never contains the key itself
    assert.ok(!JSON.stringify(r.body).includes(FAKE_API_KEY), 'key value must never be returned');
  });

  it('POST /keys/:provider — rejects unsupported provider', async () => {
    const r = await request(
      relayPort, 'POST', '/keys/not-a-real-provider',
      { key: FAKE_API_KEY },
      { 'x-relay-token': relayToken },
    );
    assert.equal(r.status, 400);
  });

  it('POST /keys/:provider — rejects suspiciously short key', async () => {
    const r = await request(
      relayPort, 'POST', '/keys/openai',
      { key: 'short' },
      { 'x-relay-token': relayToken },
    );
    assert.equal(r.status, 400);
  });

  // ── 4. Auth guard ────────────────────────────────────────────────────────

  it('protected routes require x-relay-token', async () => {
    const r = await request(relayPort, 'GET', '/keys');
    assert.equal(r.status, 401);
  });

  it('invalid relay token is rejected', async () => {
    const r = await request(relayPort, 'GET', '/keys', undefined, {
      'x-relay-token': 'definitely-not-a-valid-token',
    });
    assert.equal(r.status, 401);
  });

  // ── 5. Relay — non-streaming ─────────────────────────────────────────────
  // Example product: user sends a chat message; app calls relay

  it('POST /relay/openai-compatible — forwards to AI provider with the stored key', async () => {
    mock.clearRequests();

    const chatBody = {
      model:    'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Hello from the E2E test!' }],
    };

    const r = await request(
      relayPort, 'POST', '/relay/openai-compatible/v1/chat/completions',
      chatBody,
      {
        'x-relay-token':    relayToken,
        ...e2eRelayHeaders(),
      },
    );

    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.choices, 'response should contain choices');
    assert.equal(r.body.choices[0].message.content, 'Hello from mock!');

    // Critical: relay must have forwarded the STORED key, not any user-supplied header
    assert.equal(mock.requests.length, 1, 'mock provider should receive exactly 1 request');
    assert.equal(
      mock.requests[0].authorization,
      `Bearer ${FAKE_API_KEY}`,
      'relay must forward the stored API key — not a value the client supplied directly',
    );
  });

  it('POST /relay — ignores hostile client-supplied Authorization header', async () => {
    // A malicious (or confused) client that sends their own Authorization header
    // must not be able to override the key the relay forwards to the AI provider.
    mock.clearRequests();

    const HOSTILE_KEY = 'Bearer sk-hostile-attacker-key-9999999999';

    const r = await request(
      relayPort, 'POST', '/relay/openai-compatible/v1/chat/completions',
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hostile test' }] },
      {
        'x-relay-token':    relayToken,
        ...e2eRelayHeaders(),
        'Authorization':    HOSTILE_KEY,   // ← attacker-supplied, must be ignored
      },
    );

    assert.equal(r.status, 200);
    assert.equal(mock.requests.length, 1);
    assert.notEqual(
      mock.requests[0].authorization,
      HOSTILE_KEY,
      'relay must never forward a client-supplied Authorization header to the AI provider',
    );
    assert.equal(
      mock.requests[0].authorization,
      `Bearer ${FAKE_API_KEY}`,
      'relay must use the stored key regardless of what Authorization header the client sends',
    );
  });

  // ── 6. Relay — streaming ─────────────────────────────────────────────────

  it('POST /relay/openai-compatible — SSE streaming works end-to-end', async () => {
    mock.clearRequests();

    const chatBody = {
      model:    'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Stream test' }],
      stream:   true,
    };

    const r = await requestRaw(
      relayPort, 'POST', '/relay/openai-compatible/v1/chat/completions',
      chatBody,
      {
        'x-relay-token':    relayToken,
        ...e2eRelayHeaders(),
      },
    );

    assert.equal(r.status, 200);
    assert.ok(
      r.headers['content-type']?.includes('text/event-stream'),
      'Content-Type should be text/event-stream',
    );
    assert.ok(r.body.includes('data:'),   'SSE body must contain data: lines');
    assert.ok(r.body.includes('[DONE]'),  'SSE body must contain the [DONE] sentinel');
  });

  it('POST /relay/openai-compatible — JSON upstream errors stay JSON even when stream is requested', async () => {
    mock.clearRequests();

    const r = await request(
      relayPort, 'POST', '/relay/openai-compatible/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Stream error test' }],
        stream: true,
        forceJsonError: true,
      },
      {
        'x-relay-token': relayToken,
        ...e2eRelayHeaders(),
      },
    );

    assert.equal(r.status, 429);
    assert.ok(
      r.headers['content-type']?.includes('application/json'),
      'Content-Type should stay application/json',
    );
    assert.ok(
      !r.headers['content-type']?.includes('text/event-stream'),
      'JSON upstream errors must not be mislabeled as SSE',
    );
    assert.equal(r.body.error, 'mock rate limited');
  });

  it('POST /relay/openai-compatible — JSON 200 responses stay JSON even when stream is requested', async () => {
    mock.clearRequests();
    const extraRelayToken = await createRelayTokenWithKey();

    const r = await request(
      relayPort, 'POST', '/relay/openai-compatible/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Stream fallback test' }],
        stream: true,
        forceJsonDespiteStream: true,
      },
      {
        'x-relay-token': extraRelayToken,
        ...e2eRelayHeaders(),
      },
    );

    assert.equal(r.status, 200);
    assert.ok(
      r.headers['content-type']?.includes('application/json'),
      'Content-Type should stay application/json when upstream declares JSON',
    );
    assert.ok(
      !r.headers['content-type']?.includes('text/event-stream'),
      'JSON upstream success must not be mislabeled as SSE',
    );
    assert.equal(r.body.ok, true);
  });

  it('POST /relay/openai-compatible — no-content upstream success is preserved', async () => {
    mock.clearRequests();
    const extraRelayToken = await createRelayTokenWithKey();

    const r = await requestRaw(
      relayPort, 'POST', '/relay/openai-compatible/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'No content test' }],
        forceNoContent: true,
      },
      {
        'x-relay-token': extraRelayToken,
        ...e2eRelayHeaders(),
      },
    );

    assert.equal(r.status, 204);
    assert.equal(r.body, '');
  });

  it('POST /relay/openai-compatible — upstream SSE errors are reported as SSE error events', async () => {
    mock.clearRequests();
    const extraRelayToken = await createRelayTokenWithKey();

    const r = await requestRaw(
      relayPort, 'POST', '/relay/openai-compatible/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'SSE failure test' }],
        stream: true,
        forceSseStreamError: true,
      },
      {
        'x-relay-token': extraRelayToken,
        ...e2eRelayHeaders(),
      },
    );

    assert.equal(r.status, 200);
    assert.ok(r.body.includes('event: error'), 'SSE error event should be sent before ending');
    assert.ok(r.body.includes('Stream interrupted by provider'));
  });

  it('POST /relay/openai-compatible — upstream binary errors abort established responses', async () => {
    mock.clearRequests();
    const extraRelayToken = await createRelayTokenWithKey();
    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Binary failure test' }],
      forceBinaryStreamError: true,
    });

    const r = await new Promise((resolve, reject) => {
      const chunks = [];
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: relayPort,
          path: '/relay/openai-compatible/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'x-relay-token': extraRelayToken,
            ...e2eRelayHeaders(),
          },
        },
        (res) => {
          const finish = (aborted) => resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString(),
            aborted,
          });
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => finish(false));
          res.on('aborted', () => finish(true));
          res.on('error', (err) => {
            if (err.code === 'ECONNRESET') finish(true);
            else reject(err);
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(2000, () => reject(new Error('timed out waiting for relay binary failure')));
      req.write(payload);
      req.end();
    });

    assert.equal(r.status, 200);
    assert.equal(r.body, 'partial');
    assert.equal(r.aborted, true, 'binary upstream failure should not end a truncated 200 cleanly');
  });

  it('POST /relay/openai-compatible — client disconnect destroys the upstream binary body', async () => {
    mock.clearRequests();
    mock.streamEvents.length = 0;
    const extraRelayToken = await createRelayTokenWithKey();
    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Binary disconnect cleanup test' }],
      forceSlowBinaryUntilClientClose: true,
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: relayPort,
          path: '/relay/openai-compatible/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'x-relay-token': extraRelayToken,
            ...e2eRelayHeaders(),
          },
        },
        (res) => {
          res.once('data', () => {
            req.destroy();
            res.destroy();
            done();
          });
        },
      );
      req.on('error', (err) => {
        if (settled || err.code === 'ECONNRESET') return;
        reject(err);
      });
      req.setTimeout(2000, () => reject(new Error('timed out waiting for relay binary data')));
      req.write(payload);
      req.end();
    });

    await waitForCondition(
      () => mock.streamEvents.includes('slow-binary-response-closed'),
      2000,
      'relay did not destroy the upstream binary response after client disconnect',
    );
  });

  it('POST /relay/openai-compatible — client disconnect destroys the upstream SSE body', async () => {
    mock.clearRequests();
    mock.streamEvents.length = 0;
    const extraRelayToken = await createRelayTokenWithKey();
    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Disconnect cleanup test' }],
      stream: true,
      forceSlowSseUntilClientClose: true,
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: relayPort,
          path: '/relay/openai-compatible/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'x-relay-token': extraRelayToken,
            ...e2eRelayHeaders(),
          },
        },
        (res) => {
          res.once('data', () => {
            req.destroy();
            res.destroy();
            done();
          });
        },
      );
      req.on('error', (err) => {
        if (settled || err.code === 'ECONNRESET') return;
        reject(err);
      });
      req.setTimeout(2000, () => reject(new Error('timed out waiting for relay stream data')));
      req.write(payload);
      req.end();
    });

    await waitForCondition(
      () => mock.streamEvents.includes('slow-sse-response-closed'),
      2000,
      'relay did not destroy the upstream SSE response after client disconnect',
    );
  });

  it('REQUEST_BODY_LIMIT_BYTES ignores malformed values instead of truncating them', async () => {
    const malformedLimitPort = await getFreePort();
    const malformedLimitDb = path.join(os.tmpdir(), `byok-relay-e2e-malformed-limit-${Date.now()}.db`);
    const malformedLimitProc = spawn(
      process.execPath,
      [path.resolve(__dirname, '../../src/index.js')],
      {
        env: {
          ...process.env,
          PORT: String(malformedLimitPort),
          ENCRYPTION_SECRET: 'malformed-limit-test-secret-at-least-32-characters',
          DB_PATH: malformedLimitDb,
          ALLOWED_ORIGINS: '*',
          REQUEST_BODY_LIMIT_BYTES: '10mb',
          NODE_ENV: 'test',
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );

    try {
      await waitForHealth(malformedLimitPort);
      const r = await requestRaw(
        malformedLimitPort, 'POST', '/relay/openai-compatible/v1/chat/completions',
        'x'.repeat(5000),
        { 'Content-Type': 'application/octet-stream' },
      );

      assert.equal(r.status, 401);
      assert.ok(
        r.body.includes('x-relay-token header required'),
        'large body should reach auth instead of being rejected by a partially parsed 10-byte limit',
      );
    } finally {
      if (malformedLimitProc.exitCode == null && malformedLimitProc.signalCode == null) {
        await new Promise((resolve) => {
          const killTimer = setTimeout(() => {
            malformedLimitProc.kill('SIGKILL');
          }, 5000);
          const done = () => {
            clearTimeout(killTimer);
            resolve();
          };
          malformedLimitProc.once('exit', done);
          if (!malformedLimitProc.kill('SIGTERM')) done();
        });
      }
      fs.rmSync(malformedLimitDb, { force: true });
    }
  });

  it('POST /relay/:provider/* — rejects raw bodies above the configured limit', async () => {
    const r = await requestRaw(
      relayPort, 'POST', '/relay/openai-compatible/v1/chat/completions',
      'x'.repeat(5000),
      {
        'Content-Type': 'application/octet-stream',
        'x-relay-token': relayToken,
        ...e2eRelayHeaders(),
      },
    );

    assert.equal(r.status, 413);
    assert.ok(r.body.includes('Request body too large'));
  });

  it('ALLOWED_MODELS — wildcard exact matches and Google path models are enforced', async () => {
    const restrictedPort = await getFreePort();
    const restrictedDb = path.join(os.tmpdir(), `byok-relay-restricted-${Date.now()}.db`);
    const restrictedProc = spawn(
      process.execPath,
      [path.resolve(__dirname, '../../src/index.js')],
      {
        env: {
          ...process.env,
          PORT: String(restrictedPort),
          ENCRYPTION_SECRET: 'restricted-model-test-secret-at-least-32-chars',
          DB_PATH: restrictedDb,
          ALLOWED_ORIGINS: '*',
          ALLOWED_MODELS: 'gpt-4o*,google/gemini-2.0-flash',
          NODE_ENV: 'test',
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
          E2E_OPENAI_COMPATIBLE_BASE_URL: mockBaseUrl,
          E2E_OPENAI_COMPATIBLE_BASE_URL_TOKEN: E2E_BASE_URL_OVERRIDE_TOKEN,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );

    try {
      await waitForHealth(restrictedPort);

      const created = await request(restrictedPort, 'POST', '/users', {
        app_id: `restricted-models-${Date.now()}`,
      });
      assert.equal(created.status, 200, `Expected user creation to succeed, got ${created.status}`);
      const token = created.body.token;

      const allowedBare = await request(
        restrictedPort, 'POST', '/relay',
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
        { 'x-relay-token': token },
      );
      assert.equal(
        allowedBare.status,
        400,
        `Expected exact wildcard match gpt-4o* to pass allowlist and fail only on missing key, got ${allowedBare.status}`,
      );
      assert.ok(allowedBare.body.error?.toLowerCase().includes('no api key'));

      const storedGoogle = await request(
        restrictedPort, 'POST', '/keys/google',
        { key: FAKE_API_KEY },
        { 'x-relay-token': token },
      );
      assert.equal(storedGoogle.status, 200, `Expected to store google key, got ${storedGoogle.status}`);

      const blockedPathModel = await request(
        restrictedPort, 'POST', '/relay/google/v1beta/models/gemini-2.0-pro:generateContent',
        { contents: [{ parts: [{ text: 'hi' }] }] },
        { 'x-relay-token': token },
      );
      assert.equal(blockedPathModel.status, 403);
      assert.equal(blockedPathModel.body.error, 'Model "gemini-2.0-pro" is not permitted on this relay.');
      assert.deepEqual(blockedPathModel.body.allowed_models, ['gpt-4o*', 'google/gemini-2.0-flash']);

      mock.clearRequests();
      const allowedGooglePathModel = await request(
        restrictedPort, 'POST', '/relay/google/v1beta/models/gemini-2.0-flash:generateContent',
        { contents: [{ parts: [{ text: 'hi' }] }] },
        { 'x-relay-token': token, ...e2eRelayHeaders() },
      );
      assert.notEqual(
        allowedGooglePathModel.status,
        403,
        `Expected provider-qualified Google allowlist match to avoid local 403, got ${JSON.stringify(allowedGooglePathModel.body)}`,
      );
      assert.equal(mock.requests.length, 1, 'allowed Google model path should be forwarded to the mock provider');
      assert.ok(mock.requests[0].url.startsWith('/v1beta/models/gemini-2.0-flash:generateContent'));
    } finally {
      await stopChildProcess(restrictedProc);
      fs.rmSync(restrictedDb, { force: true });
    }
  });

  // ── 7. Relay — error paths ───────────────────────────────────────────────

  it('POST /relay — 400 when no key stored for requested provider', async () => {
    // User hasn't stored an OpenAI key, only openai-compatible
    const r = await request(
      relayPort, 'POST', '/relay/openai/v1/chat/completions',
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      { 'x-relay-token': relayToken },
    );
    assert.equal(r.status, 400);
    assert.ok(r.body.error?.toLowerCase().includes('no api key'), `Expected 'no api key' error, got: ${r.body.error}`);
  });

  // ── 8. Key deletion ──────────────────────────────────────────────────────

  it('DELETE /keys/:provider — removes the stored key', async () => {
    // Store a key for openai first
    await request(
      relayPort, 'POST', '/keys/openai',
      { key: 'sk-fake-openai-key-for-deletion-test123' },
      { 'x-relay-token': relayToken },
    );

    const before = await request(relayPort, 'GET', '/keys', undefined, { 'x-relay-token': relayToken });
    assert.ok(before.body.providers.includes('openai'), 'openai key should be stored');

    const del = await request(relayPort, 'DELETE', '/keys/openai', undefined, { 'x-relay-token': relayToken });
    assert.equal(del.status, 200);

    const after = await request(relayPort, 'GET', '/keys', undefined, { 'x-relay-token': relayToken });
    assert.ok(!after.body.providers.includes('openai'), 'openai key should be gone after delete');
  });

  // ── 9. SSRF protection ───────────────────────────────────────────────────
  // These tests verify the security fix from PR #18.
  // They will fail on code without validateAndNormaliseBaseUrl() in providers.js.

  const SSRF_CASES = [
    ['loopback (127.0.0.1)',          'http://127.0.0.1:9999/v1/chat'],
    ['AWS/GCP IMDS (169.254.x.x)',    'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
    ['RFC-1918 class A (10.x.x.x)',   'http://10.0.0.1/v1/chat'],
    ['RFC-1918 class B (172.16.x.x)', 'http://172.16.0.1/v1/chat'],
    ['RFC-1918 class C (192.168.x.x)','http://192.168.1.1/v1/chat'],
    ['Alibaba Cloud IMDS',            'http://100.100.100.200/latest/meta-data'],
    ['localhost by hostname',         'http://localhost:9999/v1/chat'],
    ['DNS hostname resolving to loopback', 'https://localtest.me:9999/v1/chat'],
    ['non-HTTPS external URL',        'http://api.openai.com/v1/chat'],
    ['embedded credentials in URL',   'https://user:pass@api.openai.com/v1/chat'],
  ];

  for (const [label, url] of SSRF_CASES) {
    it(`SSRF blocked — ${label}`, async () => {
      const r = await request(
        relayPort, 'POST', '/relay/openai-compatible/v1/chat/completions',
        { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'test' }] },
        {
          'x-relay-token':    relayToken,
          'x-relay-base-url': url,
        },
      );
      assert.equal(
        r.status, 400,
        `Expected 400 for SSRF target "${label}" (${url}), got ${r.status}. Relay may be missing SSRF validation — see PR #18.`,
      );
    });
  }

  // ── 10. Path traversal allowlist ─────────────────────────────────────────
  // Non-inference paths must be blocked even with a valid relay token. A
  // stolen token must not be usable to reach fine-tuning, file upload,
  // billing, or model-management endpoints.

  const PATH_TRAVERSAL_CASES = [
    // OpenAI non-inference paths
    ['openai', '/v1/fine-tuning/jobs',                    403],
    ['openai', '/v1/files',                               403],
    ['openai', '/v1/billing/usage',                       403],
    ['openai', '/v1/models/gpt-4/delete',                 403],
    ['openai', '/v1/organization/members',                403],
    // OpenAI allowed inference paths
    ['openai', '/v1/chat/completions',                    null], // null = any non-403; provider may still fail without a real upstream key
    ['openai', '/v1/embeddings',                          null],
    // Anthropic non-inference paths
    ['anthropic', '/v1/models',                           403],
    ['anthropic', '/v1/organizations',                    403],
    // Anthropic allowed
    ['anthropic', '/v1/messages',                         null],
    // Groq non-inference
    ['groq', '/openai/v1/models/delete',                  403],
    ['groq', '/openai/v1/organizations',                  403],
    // Groq allowed
    ['groq', '/openai/v1/chat/completions',               null],
  ];

  for (const [provider, relayPath, expectedStatus] of PATH_TRAVERSAL_CASES) {
    if (expectedStatus === 403) {
      it(`Path traversal blocked — ${provider} ${relayPath}`, async () => {
        const r = await request(
          relayPort, 'POST', `/relay/${provider}${relayPath}`,
          { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'test' }] },
          { 'x-relay-token': relayToken },
        );
        assert.equal(
          r.status,
          403,
          `Expected 403 for path "${relayPath}" on provider "${provider}", got ${r.status}. Path allowlist may be missing.`,
        );
      });
    } else {
      it(`Path traversal allowed — ${provider} ${relayPath} is routed through the mock provider`, async () => {
        await ensureProviderKey(provider);
        mock.clearRequests();

        const r = await request(
          relayPort, 'POST', `/relay/${provider}${relayPath}`,
          { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'test' }] },
          { 'x-relay-token': relayToken, ...e2eRelayHeaders() },
        );
        assert.notEqual(
          r.status,
          403,
          `Expected non-403 for allowed path "${relayPath}" on provider "${provider}", got 403.`,
        );
        assert.equal(
          mock.requests.length,
          1,
          `Allowed ${provider} path should be routed to the mock provider, not a real vendor API`,
        );
        assert.equal(mock.requests[0].url, relayPath);
      });
    }
  }
});

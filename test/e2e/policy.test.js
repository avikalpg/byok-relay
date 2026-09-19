/**
 * policy.test.js — Tests for app-level and user-level provider/model policies (issue #99 slice 1)
 *
 * Covers:
 *   - DB: setAppPolicy / getAppPolicy / checkAppPolicy / deleteAppPolicy
 *   - DB: setUserPolicy / getUserPolicy / checkUserPolicy / deleteUserPolicy
 *   - DB: _evalPolicy logic (allow/deny lists, precedence)
 *   - E2E: GET/PUT/DELETE /admin/apps/:app_id/policy
 *   - E2E: GET/PUT/DELETE /users/policy
 *   - E2E: POST /relay returns 403 when app policy denies provider
 *   - E2E: POST /relay returns 403 when app policy denies model
 *   - E2E: POST /relay returns 403 when user policy denies provider
 *   - E2E: POST /relay/:provider/* policy enforcement
 *   - E2E: POST /relay/v1/chat/completions policy enforcement
 *   - Policy cascading: app policy blocks even when user policy allows
 *
 * Run: node --test test/e2e/policy.test.js
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const { spawn } = require('node:child_process');
const os     = require('node:os');
const path   = require('node:path');
const fs     = require('node:fs');
const crypto = require('node:crypto');

const { createMockProvider } = require('./mock-provider');

function randomTestSecret(label) {
  return `${label}-${crypto.randomBytes(24).toString('hex')}`;
}

// ── Helper: run a code snippet in a fresh DB process ─────────────────────────

function makeDbRunner(dbPath, encSecret) {
  return function runInDb(code) {
    const result = require('child_process').spawnSync(
      process.execPath,
      ['-e', code],
      {
        cwd: path.resolve(__dirname, '../..'),
        env: { ...process.env, DB_PATH: dbPath, ENCRYPTION_SECRET: encSecret },
        encoding: 'utf8',
      },
    );
    if (result.stderr) {
      const err = result.stderr.trim();
      if (err && !err.includes('ExperimentalWarning')) {
        throw new Error(`DB script error: ${err}`);
      }
    }
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
}

// ── Unit tests: DB policy functions ──────────────────────────────────────────

describe('DB — app policy CRUD', () => {
  let tmpDir, dbPath, runInDb;
  const encSecret = randomTestSecret('policy-app-unit');

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-relay-policy-app-'));
    dbPath = path.join(tmpDir, 'relay.db');
    runInDb = makeDbRunner(dbPath, encSecret);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getAppPolicy returns null for unknown app', () => {
    const result = runInDb(`
      const { getAppPolicy } = require('./src/db');
      process.stdout.write(JSON.stringify(getAppPolicy('unknown-app')));
    `);
    assert.equal(result, null);
  });

  it('setAppPolicy creates a policy row', () => {
    const result = runInDb(`
      const { setAppPolicy, getAppPolicy } = require('./src/db');
      setAppPolicy('app1', { allowed_providers: ['openai', 'anthropic'] });
      process.stdout.write(JSON.stringify(getAppPolicy('app1')));
    `);
    assert.deepEqual(result.allowed_providers, ['openai', 'anthropic']);
    assert.equal(result.denied_providers, null);
    assert.equal(result.allowed_models, null);
    assert.equal(result.denied_models, null);
    assert.ok(result.updated_at > 0);
  });

  it('setAppPolicy overwrites existing policy on upsert', () => {
    const result = runInDb(`
      const { setAppPolicy, getAppPolicy } = require('./src/db');
      setAppPolicy('app2', { allowed_providers: ['openai'] });
      setAppPolicy('app2', { denied_providers: ['groq'], allowed_models: ['gpt-4o'] });
      process.stdout.write(JSON.stringify(getAppPolicy('app2')));
    `);
    assert.equal(result.allowed_providers, null);
    assert.deepEqual(result.denied_providers, ['groq']);
    assert.deepEqual(result.allowed_models, ['gpt-4o']);
  });

  it('setAppPolicy with null fields clears restrictions', () => {
    const result = runInDb(`
      const { setAppPolicy, getAppPolicy } = require('./src/db');
      setAppPolicy('app3', { allowed_providers: ['openai'] });
      setAppPolicy('app3', { allowed_providers: null });
      process.stdout.write(JSON.stringify(getAppPolicy('app3')));
    `);
    assert.equal(result.allowed_providers, null);
  });

  it('deleteAppPolicy removes the policy row', () => {
    const result = runInDb(`
      const { setAppPolicy, deleteAppPolicy, getAppPolicy } = require('./src/db');
      setAppPolicy('app4', { denied_providers: ['groq'] });
      deleteAppPolicy('app4');
      process.stdout.write(JSON.stringify(getAppPolicy('app4')));
    `);
    assert.equal(result, null);
  });

  it('setAppPolicy rejects non-array list fields', () => {
    assert.throws(() => {
      runInDb(`
        const { setAppPolicy } = require('./src/db');
        setAppPolicy('app5', { allowed_providers: 'openai' });
      `);
    });
  });
});

describe('DB — user policy CRUD', () => {
  let tmpDir, dbPath, runInDb;
  const encSecret = randomTestSecret('policy-user-unit');

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-relay-policy-user-'));
    dbPath = path.join(tmpDir, 'relay.db');
    runInDb = makeDbRunner(dbPath, encSecret);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getUserPolicy returns null when none set', () => {
    const result = runInDb(`
      const { createUser, getUserPolicy } = require('./src/db');
      const { id } = createUser('app1');
      process.stdout.write(JSON.stringify(getUserPolicy(id)));
    `);
    assert.equal(result, null);
  });

  it('setUserPolicy persists policy for user', () => {
    const result = runInDb(`
      const { createUser, setUserPolicy, getUserPolicy } = require('./src/db');
      const { id } = createUser('app1');
      setUserPolicy(id, { denied_providers: ['groq'], denied_models: ['claude-3-haiku'] });
      process.stdout.write(JSON.stringify(getUserPolicy(id)));
    `);
    assert.deepEqual(result.denied_providers, ['groq']);
    assert.deepEqual(result.denied_models, ['claude-3-haiku']);
  });

  it('deleteUserPolicy removes the policy', () => {
    const result = runInDb(`
      const { createUser, setUserPolicy, deleteUserPolicy, getUserPolicy } = require('./src/db');
      const { id } = createUser('app1');
      setUserPolicy(id, { denied_providers: ['groq'] });
      deleteUserPolicy(id);
      process.stdout.write(JSON.stringify(getUserPolicy(id)));
    `);
    assert.equal(result, null);
  });
});

describe('DB — checkAppPolicy / checkUserPolicy logic', () => {
  let tmpDir, dbPath, runInDb;
  const encSecret = randomTestSecret('policy-check-unit');

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-relay-policy-check-'));
    dbPath = path.join(tmpDir, 'relay.db');
    runInDb = makeDbRunner(dbPath, encSecret);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no policy → ok:true', () => {
    const result = runInDb(`
      const { checkAppPolicy } = require('./src/db');
      process.stdout.write(JSON.stringify(checkAppPolicy('no-policy-app', 'openai', 'gpt-4o')));
    `);
    assert.equal(result.ok, true);
  });

  it('allowed_providers set — permitted provider → ok:true', () => {
    const result = runInDb(`
      const { setAppPolicy, checkAppPolicy } = require('./src/db');
      setAppPolicy('app-allow', { allowed_providers: ['openai', 'anthropic'] });
      process.stdout.write(JSON.stringify(checkAppPolicy('app-allow', 'openai', 'gpt-4o')));
    `);
    assert.equal(result.ok, true);
  });

  it('allowed_providers set — unlisted provider → ok:false, reason_code:policy_denied_provider', () => {
    const result = runInDb(`
      const { setAppPolicy, checkAppPolicy } = require('./src/db');
      setAppPolicy('app-allow2', { allowed_providers: ['openai'] });
      process.stdout.write(JSON.stringify(checkAppPolicy('app-allow2', 'groq', 'llama3-8b')));
    `);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'policy_denied_provider');
  });

  it('denied_providers set — blocked provider → ok:false', () => {
    const result = runInDb(`
      const { setAppPolicy, checkAppPolicy } = require('./src/db');
      setAppPolicy('app-deny-prov', { denied_providers: ['groq'] });
      process.stdout.write(JSON.stringify(checkAppPolicy('app-deny-prov', 'groq', 'llama3-8b')));
    `);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'policy_denied_provider');
  });

  it('denied_providers set — non-blocked provider → ok:true', () => {
    const result = runInDb(`
      const { setAppPolicy, checkAppPolicy } = require('./src/db');
      setAppPolicy('app-deny-prov2', { denied_providers: ['groq'] });
      process.stdout.write(JSON.stringify(checkAppPolicy('app-deny-prov2', 'openai', 'gpt-4o')));
    `);
    assert.equal(result.ok, true);
  });

  it('denied_models set — blocked model → ok:false', () => {
    const result = runInDb(`
      const { setAppPolicy, checkAppPolicy } = require('./src/db');
      setAppPolicy('app-deny-mod', { denied_models: ['gpt-4o'] });
      process.stdout.write(JSON.stringify(checkAppPolicy('app-deny-mod', 'openai', 'gpt-4o')));
    `);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'policy_denied_model');
  });

  it('allowed_models set — unlisted model → ok:false', () => {
    const result = runInDb(`
      const { setAppPolicy, checkAppPolicy } = require('./src/db');
      setAppPolicy('app-allow-mod', { allowed_models: ['gpt-4o'] });
      process.stdout.write(JSON.stringify(checkAppPolicy('app-allow-mod', 'openai', 'gpt-3.5-turbo')));
    `);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'policy_denied_model');
  });

  it('denied takes precedence — provider in both denied and allowed → ok:false', () => {
    const result = runInDb(`
      const { setAppPolicy, checkAppPolicy } = require('./src/db');
      setAppPolicy('app-precedence', { allowed_providers: ['openai', 'groq'], denied_providers: ['openai'] });
      process.stdout.write(JSON.stringify(checkAppPolicy('app-precedence', 'openai', 'gpt-4o')));
    `);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'policy_denied_provider');
  });

  it('checkUserPolicy works the same way as checkAppPolicy', () => {
    const result = runInDb(`
      const { createUser, setUserPolicy, checkUserPolicy } = require('./src/db');
      const { id } = createUser('app1');
      setUserPolicy(id, { denied_providers: ['groq'] });
      process.stdout.write(JSON.stringify(checkUserPolicy(id, 'groq', 'llama3-8b')));
    `);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'policy_denied_provider');
  });
});

// ── E2E tests: policy API endpoints and relay enforcement ─────────────────────

/** Get a free port by transiently listening on 0. */
function getFreePort() {
  return new Promise((resolve) => {
    const srv = require('node:net').createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** Poll /health until 200 OK or timeout. */
function waitForRelay(port, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const probe = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        if (res.statusCode === 200) return resolve();
        if (Date.now() >= deadline) return reject(new Error('relay startup timeout'));
        res.resume();
        setTimeout(check, 200);
      });
      probe.on('error', () => {
        if (Date.now() >= deadline) return reject(new Error('relay startup timeout (ECONNREFUSED)'));
        setTimeout(check, 200);
      });
    };
    check();
  });
}

function startServer(env) {
  return getFreePort().then(async (port) => {
    const proc = spawn(process.execPath, ['src/index.js'], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, PORT: String(port), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stderr.on('data', () => {}); // suppress noise
    await waitForRelay(port);
    return { proc, port };
  });
}

function req(port, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    };
    const r = http.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: raw, headers: res.headers }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

describe('E2E — policy API + relay enforcement', () => {
  let mockProv, server, port, appSecret, encSecret, tmpDir, dbPath;
  let userToken, userId, appId;

  before(async () => {
    tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-relay-policy-e2e-'));
    dbPath   = path.join(tmpDir, 'relay.db');
    appSecret = randomTestSecret('APP_SECRET');
    encSecret = randomTestSecret('ENC');
    appId     = 'test-policy-app';

    mockProv = await createMockProvider();

    const result = await startServer({
      APP_SECRET:        appSecret,
      ENCRYPTION_SECRET: encSecret,
      DB_PATH:           dbPath,
      ALLOWED_ORIGINS:   '*',
      RELAY_OPENAI_BASE: `http://127.0.0.1:${mockProv.port}`,
      RELAY_ANTHROPIC_BASE: `http://127.0.0.1:${mockProv.port}`,
    });
    server = result.proc;
    port   = result.port;

    // Register a user
    const reg = await req(port, 'POST', '/users', { app_id: appId }, { Authorization: `Bearer ${appSecret}` });
    assert.ok(reg.status === 200 || reg.status === 201, `POST /users expected 200/201, got ${reg.status}`);
    userToken = reg.body.token;
    // userId is captured from the first GET /users/policy call (user_id in response)

    // Store a dummy OpenAI key
    await req(port, 'POST', '/keys/openai', { key: 'sk-testkey12345678901234567890123456789012345678901234' }, { 'x-relay-token': userToken });
    // Store a dummy Anthropic key
    await req(port, 'POST', '/keys/anthropic', { key: 'sk-ant-testkey1234567890123456789012345678901234567890123456789012345678901234567890' }, { 'x-relay-token': userToken });
  });

  after(() => {
    if (server) server.kill();
    if (mockProv) mockProv.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── App policy CRUD ────────────────────────────────────────────────────────

  it('GET /admin/apps/:app_id/policy returns null when no policy set', async () => {
    const r = await req(port, 'GET', `/admin/apps/${appId}/policy`, null, { Authorization: `Bearer ${appSecret}` });
    assert.equal(r.status, 200);
    assert.equal(r.body.app_id, appId);
    assert.equal(r.body.policy, null);
  });

  it('PUT /admin/apps/:app_id/policy sets policy', async () => {
    const r = await req(port, 'PUT', `/admin/apps/${appId}/policy`,
      { allowed_providers: ['openai', 'anthropic'] },
      { Authorization: `Bearer ${appSecret}` });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.policy.allowed_providers, ['openai', 'anthropic']);
    assert.equal(r.body.policy.denied_providers, null);
  });

  it('GET /admin/apps/:app_id/policy returns saved policy', async () => {
    const r = await req(port, 'GET', `/admin/apps/${appId}/policy`, null, { Authorization: `Bearer ${appSecret}` });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.policy.allowed_providers, ['openai', 'anthropic']);
  });

  it('DELETE /admin/apps/:app_id/policy clears policy', async () => {
    const r = await req(port, 'DELETE', `/admin/apps/${appId}/policy`, null, { Authorization: `Bearer ${appSecret}` });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const r2 = await req(port, 'GET', `/admin/apps/${appId}/policy`, null, { Authorization: `Bearer ${appSecret}` });
    assert.equal(r2.body.policy, null);
  });

  it('PUT /admin/apps/:app_id/policy returns 400 for invalid input', async () => {
    const r = await req(port, 'PUT', `/admin/apps/${appId}/policy`,
      { allowed_providers: 'openai' },
      { Authorization: `Bearer ${appSecret}` });
    assert.equal(r.status, 400);
    assert.ok(r.body.error);
  });

  it('PUT /admin/apps/:app_id/policy requires APP_SECRET', async () => {
    const r = await req(port, 'PUT', `/admin/apps/${appId}/policy`,
      { denied_providers: ['groq'] },
      { Authorization: 'Bearer wrong-secret' });
    // requireAppSecret returns 401 for invalid/missing auth (HTTP 401 Unauthorized is correct here)
    assert.equal(r.status, 401);
  });

  // ── User policy CRUD ───────────────────────────────────────────────────────

  it('GET /users/policy returns null when no policy set', async () => {
    const r = await req(port, 'GET', '/users/policy', null, { 'x-relay-token': userToken });
    assert.equal(r.status, 200);
    assert.ok(r.body.user_id, 'user_id should be present in response');
    userId = r.body.user_id; // capture for subsequent tests
    assert.equal(r.body.policy, null);
  });

  it('PUT /users/policy sets user policy', async () => {
    const r = await req(port, 'PUT', '/users/policy',
      { denied_models: ['gpt-3.5-turbo'] },
      { 'x-relay-token': userToken });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.policy.denied_models, ['gpt-3.5-turbo']);
    assert.equal(r.body.policy.denied_providers, null);
  });

  it('GET /users/policy returns saved policy', async () => {
    const r = await req(port, 'GET', '/users/policy', null, { 'x-relay-token': userToken });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.policy.denied_models, ['gpt-3.5-turbo']);
  });

  it('DELETE /users/policy clears user policy', async () => {
    const r = await req(port, 'DELETE', '/users/policy', null, { 'x-relay-token': userToken });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const r2 = await req(port, 'GET', '/users/policy', null, { 'x-relay-token': userToken });
    assert.equal(r2.body.policy, null);
  });

  it('PUT /users/policy requires relay token', async () => {
    const r = await req(port, 'PUT', '/users/policy', { denied_providers: ['groq'] }, {});
    assert.equal(r.status, 401);
  });

  // ── Relay enforcement — app policy ────────────────────────────────────────

  it('POST /relay returns 403 when app policy denies provider', async () => {
    // Set app policy: only openai allowed
    await req(port, 'PUT', `/admin/apps/${appId}/policy`,
      { allowed_providers: ['openai'] },
      { Authorization: `Bearer ${appSecret}` });

    const r = await req(port, 'POST', '/relay',
      { model: 'anthropic/claude-3-haiku-20240307', messages: [{ role: 'user', content: 'hi' }] },
      { 'x-relay-token': userToken });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason_code, 'policy_denied_provider');
    assert.ok(r.body.error.includes('anthropic') || r.body.error.includes('not in the allowed'));

    // Cleanup
    await req(port, 'DELETE', `/admin/apps/${appId}/policy`, null, { Authorization: `Bearer ${appSecret}` });
  });

  it('POST /relay returns 403 when app policy denies model', async () => {
    await req(port, 'PUT', `/admin/apps/${appId}/policy`,
      { denied_models: ['gpt-4o'] },
      { Authorization: `Bearer ${appSecret}` });

    const r = await req(port, 'POST', '/relay',
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      { 'x-relay-token': userToken });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason_code, 'policy_denied_model');

    await req(port, 'DELETE', `/admin/apps/${appId}/policy`, null, { Authorization: `Bearer ${appSecret}` });
  });

  it('POST /relay succeeds when provider is in allowed_providers', async () => {
    await req(port, 'PUT', `/admin/apps/${appId}/policy`,
      { allowed_providers: ['openai'] },
      { Authorization: `Bearer ${appSecret}` });

    const r = await req(port, 'POST', '/relay',
      { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      { 'x-relay-token': userToken });
    // 200 or any non-policy error (mock provider responds 200)
    assert.notEqual(r.status, 403);

    await req(port, 'DELETE', `/admin/apps/${appId}/policy`, null, { Authorization: `Bearer ${appSecret}` });
  });

  // ── Relay enforcement — user policy ───────────────────────────────────────

  it('POST /relay returns 403 when user policy denies provider', async () => {
    await req(port, 'PUT', '/users/policy',
      { denied_providers: ['anthropic'] },
      { 'x-relay-token': userToken });

    const r = await req(port, 'POST', '/relay',
      { model: 'anthropic/claude-3-haiku-20240307', messages: [{ role: 'user', content: 'hi' }] },
      { 'x-relay-token': userToken });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason_code, 'policy_denied_provider');

    await req(port, 'DELETE', '/users/policy', null, { 'x-relay-token': userToken });
  });

  it('POST /relay returns 403 when user policy denies model', async () => {
    await req(port, 'PUT', '/users/policy',
      { denied_models: ['gpt-4o'] },
      { 'x-relay-token': userToken });

    const r = await req(port, 'POST', '/relay',
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      { 'x-relay-token': userToken });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason_code, 'policy_denied_model');

    await req(port, 'DELETE', '/users/policy', null, { 'x-relay-token': userToken });
  });

  // ── Relay enforcement — /relay/:provider/* ────────────────────────────────

  it('POST /relay/:provider/* returns 403 when app policy denies provider', async () => {
    await req(port, 'PUT', `/admin/apps/${appId}/policy`,
      { allowed_providers: ['anthropic'] },
      { Authorization: `Bearer ${appSecret}` });

    const r = await req(port, 'POST', '/relay/openai/v1/chat/completions',
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      { 'x-relay-token': userToken });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason_code, 'policy_denied_provider');

    await req(port, 'DELETE', `/admin/apps/${appId}/policy`, null, { Authorization: `Bearer ${appSecret}` });
  });

  // ── Relay enforcement — /relay/v1/chat/completions ───────────────────────

  it('POST /relay/v1/chat/completions returns 403 when app policy denies provider', async () => {
    await req(port, 'PUT', `/admin/apps/${appId}/policy`,
      { denied_providers: ['openai'] },
      { Authorization: `Bearer ${appSecret}` });

    const r = await req(port, 'POST', '/relay/v1/chat/completions',
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      { 'x-relay-token': userToken });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason_code, 'policy_denied_provider');

    await req(port, 'DELETE', `/admin/apps/${appId}/policy`, null, { Authorization: `Bearer ${appSecret}` });
  });

  // ── App policy blocks even when user policy is clear ─────────────────────

  it('app policy takes precedence: denied app provider → 403 even with no user policy', async () => {
    await req(port, 'DELETE', '/users/policy', null, { 'x-relay-token': userToken }); // ensure clear
    await req(port, 'PUT', `/admin/apps/${appId}/policy`,
      { denied_providers: ['openai'] },
      { Authorization: `Bearer ${appSecret}` });

    const r = await req(port, 'POST', '/relay',
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      { 'x-relay-token': userToken });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason_code, 'policy_denied_provider');

    await req(port, 'DELETE', `/admin/apps/${appId}/policy`, null, { Authorization: `Bearer ${appSecret}` });
  });
});

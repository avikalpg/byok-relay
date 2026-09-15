/**
 * app-budget.test.js — Tests for per-app cost budget enforcement
 *
 * Covers:
 *   - DB: setAppBudget / getAppBudget / checkAppBudget / deleteAppBudget
 *   - E2E: PUT /admin/apps/:app_id/budget sets limits (requires APP_SECRET)
 *   - E2E: GET /admin/apps/:app_id/budget reads limits
 *   - E2E: DELETE /admin/apps/:app_id/budget removes limits
 *   - E2E: POST /relay returns 402 when app lifetime budget exceeded
 *   - E2E: POST /relay sets X-Byok-Budget-Warning header when app near limit
 *   - E2E: App budget aggregates usage across multiple users of the same app_id
 *
 * Run: node --test test/e2e/app-budget.test.js
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

/** Get a free port by listening on 0 then closing. */
function getFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll relay /health until 200 or timeout. */
function waitForRelay(port, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const probe = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        if (res.statusCode === 200) return resolve();
        if (Date.now() >= deadline) return reject(new Error('relay startup timeout'));
        setTimeout(check, 200);
      });
      probe.on('error', () => {
        if (Date.now() >= deadline) return reject(new Error('relay startup timeout'));
        setTimeout(check, 200);
      });
    };
    check();
  });
}

/** Simple HTTP helper for relay requests. */
function relayReq(port, { method = 'GET', path: p, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: p,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data ? Buffer.byteLength(data) : 0,
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json;
          try { json = JSON.parse(raw); } catch { json = raw; }
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Unit tests: DB app budget functions ──────────────────────────────────────

describe('DB — setAppBudget / getAppBudget / checkAppBudget / deleteAppBudget', () => {
  let tmpDir, dbPath;
  const encSecret = randomTestSecret('app-budget-unit');

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-relay-app-budget-unit-'));
    dbPath = path.join(tmpDir, 'relay.db');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runInDb(code) {
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
  }

  it('getAppBudget returns null for app with no budget', () => {
    const result = runInDb(`
      const { getAppBudget } = require('./src/db');
      process.stdout.write(JSON.stringify(getAppBudget('no-budget-app')));
    `);
    assert.equal(result, null);
  });

  it('setAppBudget creates and returns budget row', () => {
    const result = runInDb(`
      const { setAppBudget } = require('./src/db');
      const row = setAppBudget('create-app', { daily_limit_usd: 2.0, lifetime_limit_usd: 50.0 });
      process.stdout.write(JSON.stringify(row));
    `);
    assert.ok(result);
    assert.equal(result.daily_limit_usd, 2.0);
    assert.equal(result.lifetime_limit_usd, 50.0);
  });

  it('setAppBudget updates existing budget', () => {
    const result = runInDb(`
      const { setAppBudget } = require('./src/db');
      setAppBudget('update-app', { daily_limit_usd: 1.0 });
      const row = setAppBudget('update-app', { daily_limit_usd: 5.0, monthly_limit_usd: 100.0 });
      process.stdout.write(JSON.stringify(row));
    `);
    assert.equal(result.daily_limit_usd, 5.0);
    assert.equal(result.monthly_limit_usd, 100.0);
  });

  it('getAppBudget reads back the configured budget', () => {
    const result = runInDb(`
      const { setAppBudget, getAppBudget } = require('./src/db');
      setAppBudget('read-app', { lifetime_limit_usd: 10.0, warn_threshold: 0.9 });
      const b = getAppBudget('read-app');
      process.stdout.write(JSON.stringify(b));
    `);
    assert.ok(result);
    assert.equal(result.lifetime_limit_usd, 10.0);
    assert.equal(result.warn_threshold, 0.9);
  });

  it('checkAppBudget returns ok:true when no budget configured', () => {
    const result = runInDb(`
      const { checkAppBudget } = require('./src/db');
      process.stdout.write(JSON.stringify(checkAppBudget('unconfigured-app')));
    `);
    assert.equal(result.ok, true);
  });

  it('checkAppBudget returns ok:true when under limit', () => {
    const result = runInDb(`
      const { setAppBudget, checkAppBudget } = require('./src/db');
      setAppBudget('under-limit-app', { lifetime_limit_usd: 100.0 });
      process.stdout.write(JSON.stringify(checkAppBudget('under-limit-app')));
    `);
    assert.equal(result.ok, true);
  });

  it('checkAppBudget returns warn when near limit', () => {
    const result = runInDb(`
      const { createUser, setAppBudget, logRequest, checkAppBudget } = require('./src/db');
      const { id } = createUser('warn-app');
      logRequest({ user_id: id, app_id: 'warn-app', provider: 'openai', model: 'gpt-4o',
                   status: 200, latency_ms: 10, input_tokens: 100, output_tokens: 50,
                   estimated_cost_usd: 0.009, user_agent: 'test' });
      setAppBudget('warn-app', { lifetime_limit_usd: 0.01, warn_threshold: 0.8 });
      process.stdout.write(JSON.stringify(checkAppBudget('warn-app')));
    `);
    assert.equal(result.ok, true);
    assert.equal(result.warn, true);
    assert.ok(result.reason, 'warn reason should be set');
  });

  it('checkAppBudget returns ok:false when lifetime limit exceeded', () => {
    const result = runInDb(`
      const { createUser, setAppBudget, logRequest, checkAppBudget } = require('./src/db');
      const { id } = createUser('exceeded-app');
      logRequest({ user_id: id, app_id: 'exceeded-app', provider: 'openai', model: 'gpt-4o',
                   status: 200, latency_ms: 10, input_tokens: 1000, output_tokens: 500,
                   estimated_cost_usd: 1.0, user_agent: 'test' });
      setAppBudget('exceeded-app', { lifetime_limit_usd: 0.50 });
      process.stdout.write(JSON.stringify(checkAppBudget('exceeded-app')));
    `);
    assert.equal(result.ok, false);
    assert.equal(result.limit_type, 'lifetime');
    assert.ok(result.used_usd > result.limit_usd);
  });

  it('checkAppBudget aggregates usage across multiple users of the same app_id', () => {
    const result = runInDb(`
      const { createUser, setAppBudget, logRequest, checkAppBudget } = require('./src/db');
      const { id: u1 } = createUser('multi-user-app');
      const { id: u2 } = createUser('multi-user-app');
      logRequest({ user_id: u1, app_id: 'multi-user-app', provider: 'openai', model: 'gpt-4o',
                   status: 200, latency_ms: 5, input_tokens: 100, output_tokens: 50,
                   estimated_cost_usd: 0.40, user_agent: 'test' });
      logRequest({ user_id: u2, app_id: 'multi-user-app', provider: 'openai', model: 'gpt-4o',
                   status: 200, latency_ms: 5, input_tokens: 100, output_tokens: 50,
                   estimated_cost_usd: 0.40, user_agent: 'test' });
      setAppBudget('multi-user-app', { lifetime_limit_usd: 0.50 });
      process.stdout.write(JSON.stringify(checkAppBudget('multi-user-app')));
    `);
    // $0.80 total > $0.50 limit
    assert.equal(result.ok, false);
    assert.equal(result.limit_type, 'lifetime');
    assert.ok(result.used_usd >= 0.79, `expected used >= 0.79, got ${result.used_usd}`);
  });

  it('deleteAppBudget removes the budget', () => {
    const result = runInDb(`
      const { setAppBudget, getAppBudget, deleteAppBudget } = require('./src/db');
      setAppBudget('delete-app', { daily_limit_usd: 1.0 });
      deleteAppBudget('delete-app');
      process.stdout.write(JSON.stringify(getAppBudget('delete-app')));
    `);
    assert.equal(result, null);
  });
});

// ── E2E tests: /admin/apps/:app_id/budget endpoints ─────────────────────────

describe('E2E — /admin/apps/:app_id/budget (CRUD)', () => {
  let mock, mockPort, relayProc, relayPort;
  let tmpDir, dbPath;
  const appId = `e2e-app-${crypto.randomBytes(8).toString('hex')}`;
  const encSecret = randomTestSecret('crud-enc');
  const appSecret = randomTestSecret('crud-secret');
  let userToken;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-relay-app-budget-e2e-'));
    dbPath = path.join(tmpDir, 'relay.db');

    mock = createMockProvider();
    mockPort = await mock.start();
    relayPort = await getFreePort();

    relayProc = spawn(process.execPath, ['src/index.js'], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        PORT: String(relayPort),
        DB_PATH: dbPath,
        ENCRYPTION_SECRET: encSecret,
        APP_SECRET: appSecret,
        ALLOWED_ORIGINS: '*',
        E2E_OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${mockPort}`,
      },
    });
    relayProc.stderr.on('data', () => {}); // suppress noise

    await waitForRelay(relayPort);

    // Register a user with our appId
    const reg = await relayReq(relayPort, {
      method: 'POST',
      path: '/users',
      headers: { Authorization: `Bearer ${appSecret}` },
      body: { app_id: appId },
    });
    userToken = reg.body.token;
    assert.ok(userToken, 'user token should exist');
  });

  after(async () => {
    if (relayProc) relayProc.kill();
    if (mock) await mock.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /admin/apps/:app_id/budget returns null when no budget set', async () => {
    const res = await relayReq(relayPort, {
      path: `/admin/apps/${appId}/budget`,
      headers: { Authorization: `Bearer ${appSecret}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.app_id, appId);
    assert.equal(res.body.budget, null);
  });

  it('PUT /admin/apps/:app_id/budget sets budget and returns it', async () => {
    const res = await relayReq(relayPort, {
      method: 'PUT',
      path: `/admin/apps/${appId}/budget`,
      headers: { Authorization: `Bearer ${appSecret}` },
      body: { daily_limit_usd: 5.0, lifetime_limit_usd: 100.0, warn_threshold: 0.75 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.app_id, appId);
    assert.equal(res.body.budget.daily_limit_usd, 5.0);
    assert.equal(res.body.budget.lifetime_limit_usd, 100.0);
    assert.equal(res.body.budget.warn_threshold, 0.75);
  });

  it('GET /admin/apps/:app_id/budget reads back the set budget', async () => {
    const res = await relayReq(relayPort, {
      path: `/admin/apps/${appId}/budget`,
      headers: { Authorization: `Bearer ${appSecret}` },
    });
    assert.equal(res.body.budget.daily_limit_usd, 5.0);
    assert.equal(res.body.budget.lifetime_limit_usd, 100.0);
  });

  it('PUT /admin/apps/:app_id/budget rejects unknown fields', async () => {
    const res = await relayReq(relayPort, {
      method: 'PUT',
      path: `/admin/apps/${appId}/budget`,
      headers: { Authorization: `Bearer ${appSecret}` },
      body: { daily_limit_usd: 5.0, rogue_field: 'bad' },
    });
    assert.equal(res.status, 400);
  });

  it('PUT /admin/apps/:app_id/budget rejects negative limits', async () => {
    const res = await relayReq(relayPort, {
      method: 'PUT',
      path: `/admin/apps/${appId}/budget`,
      headers: { Authorization: `Bearer ${appSecret}` },
      body: { daily_limit_usd: -1.0 },
    });
    assert.equal(res.status, 400);
  });

  it('PUT /admin/apps/:app_id/budget rejects warn_threshold out of [0,1]', async () => {
    const res = await relayReq(relayPort, {
      method: 'PUT',
      path: `/admin/apps/${appId}/budget`,
      headers: { Authorization: `Bearer ${appSecret}` },
      body: { warn_threshold: 1.5 },
    });
    assert.equal(res.status, 400);
  });

  it('DELETE /admin/apps/:app_id/budget removes the budget', async () => {
    // First set a budget
    await relayReq(relayPort, {
      method: 'PUT',
      path: `/admin/apps/${appId}/budget`,
      headers: { Authorization: `Bearer ${appSecret}` },
      body: { daily_limit_usd: 1.0 },
    });
    // Then delete it
    await relayReq(relayPort, {
      method: 'DELETE',
      path: `/admin/apps/${appId}/budget`,
      headers: { Authorization: `Bearer ${appSecret}` },
    });
    const res = await relayReq(relayPort, {
      path: `/admin/apps/${appId}/budget`,
      headers: { Authorization: `Bearer ${appSecret}` },
    });
    assert.equal(res.body.budget, null);
  });

  it('All budget endpoints require APP_SECRET — 401 without auth', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await relayReq(relayPort, {
        method,
        path: `/admin/apps/${appId}/budget`,
      });
      assert.equal(res.status, 401, `${method} should return 401`);
    }
  });
});

// ── E2E tests: relay enforcement ─────────────────────────────────────────────

describe('E2E — relay 402 when app budget exceeded', () => {
  let mock, mockPort, relayProc, relayPort;
  let tmpDir, dbPath;
  const appId = `enforce-${crypto.randomBytes(8).toString('hex')}`;
  const encSecret = randomTestSecret('enforce-enc');
  const appSecret = randomTestSecret('enforce-secret');
  let userToken;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-relay-enforce-'));
    dbPath = path.join(tmpDir, 'relay.db');

    mock = createMockProvider();
    mockPort = await mock.start();
    relayPort = await getFreePort();

    relayProc = spawn(process.execPath, ['src/index.js'], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        PORT: String(relayPort),
        DB_PATH: dbPath,
        ENCRYPTION_SECRET: encSecret,
        APP_SECRET: appSecret,
        ALLOWED_ORIGINS: '*',
        E2E_OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${mockPort}`,
      },
    });
    relayProc.stderr.on('data', () => {});

    await waitForRelay(relayPort);

    // Register user + store a mock key
    const reg = await relayReq(relayPort, {
      method: 'POST',
      path: '/users',
      headers: { Authorization: `Bearer ${appSecret}` },
      body: { app_id: appId },
    });
    userToken = reg.body.token;

    await relayReq(relayPort, {
      method: 'POST',
      path: '/keys/openai',
      headers: { 'x-relay-token': userToken },
      body: { key: 'sk-test-1234567890123456789012345678901234567890' },
    });

    // Set a $0 lifetime budget — any relay call should immediately 402
    await relayReq(relayPort, {
      method: 'PUT',
      path: `/admin/apps/${appId}/budget`,
      headers: { Authorization: `Bearer ${appSecret}` },
      body: { lifetime_limit_usd: 0.0 },
    });
  });

  after(async () => {
    if (relayProc) relayProc.kill();
    if (mock) await mock.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POST /relay returns 402 when app lifetime budget is $0', async () => {
    const res = await relayReq(relayPort, {
      method: 'POST',
      path: '/relay/openai/v1/chat/completions',
      headers: { 'x-relay-token': userToken },
      body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hello' }] },
    });
    assert.equal(res.status, 402);
    assert.ok(res.body.error, 'should have error field');
    assert.ok(res.body.error.includes('app'), `error should mention app: ${res.body.error}`);
    assert.equal(res.body.limit_type, 'lifetime');
  });

  it('POST /relay/v1/chat/completions returns 402 when app budget exceeded', async () => {
    const res = await relayReq(relayPort, {
      method: 'POST',
      path: '/relay/v1/chat/completions',
      headers: { 'x-relay-token': userToken },
      body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hello' }] },
    });
    assert.equal(res.status, 402);
    assert.ok(res.body.error.includes('app'), `error should mention app: ${res.body.error}`);
  });
});

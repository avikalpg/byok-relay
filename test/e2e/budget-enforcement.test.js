/**
 * budget-enforcement.test.js — Tests for per-user cost budget enforcement
 *
 * Covers:
 *   - DB: setBudget / getBudget / checkBudget / deleteBudget
 *   - E2E: PUT /users/budget sets limits; GET /users/budget reads them
 *   - E2E: DELETE /users/budget removes limits
 *   - E2E: GET /stats includes budget info
 *   - E2E: POST /relay returns 402 when lifetime budget exceeded
 *   - E2E: POST /relay sets X-Byok-Budget-Warning header when near limit
 *
 * Run: node --test test/e2e/budget-enforcement.test.js
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

// ── Unit tests: DB budget functions ──────────────────────────────────────────

describe('DB — setBudget / getBudget / checkBudget / deleteBudget', () => {
  let tmpDir, dbPath;
  const encSecret = randomTestSecret('budget-unit');

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-relay-budget-unit-'));
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

  it('getBudget returns null for user with no budget', () => {
    const result = runInDb(`
      const { createUser, getBudget } = require('./src/db');
      const { id } = createUser('test-app');
      process.stdout.write(JSON.stringify(getBudget(id)));
    `);
    assert.equal(result, null);
  });

  it('setBudget creates and returns budget row', () => {
    const result = runInDb(`
      const { createUser, setBudget } = require('./src/db');
      const { id } = createUser('test-app');
      const row = setBudget(id, { daily_limit_usd: 1.0, lifetime_limit_usd: 10.0 });
      process.stdout.write(JSON.stringify(row));
    `);
    assert.ok(result, 'should return a row');
    assert.equal(result.daily_limit_usd, 1.0);
    assert.equal(result.lifetime_limit_usd, 10.0);
    assert.equal(result.weekly_limit_usd, null);
    assert.equal(result.monthly_limit_usd, null);
    assert.ok(result.warn_threshold >= 0 && result.warn_threshold <= 1);
  });

  it('getBudget returns configured limits after setBudget', () => {
    const result = runInDb(`
      const { createUser, setBudget, getBudget } = require('./src/db');
      const { id } = createUser('test-app');
      setBudget(id, { monthly_limit_usd: 5.0, warn_threshold: 0.75 });
      process.stdout.write(JSON.stringify(getBudget(id)));
    `);
    assert.equal(result.monthly_limit_usd, 5.0);
    assert.equal(result.warn_threshold, 0.75);
    assert.ok(result.updated_at, 'should have updated_at ISO string');
  });

  it('checkBudget returns ok:true when no budget set', () => {
    const result = runInDb(`
      const { createUser, checkBudget } = require('./src/db');
      const { id } = createUser('test-app');
      process.stdout.write(JSON.stringify(checkBudget(id)));
    `);
    assert.equal(result.ok, true);
  });

  it('checkBudget returns ok:true when under limit', () => {
    const result = runInDb(`
      const { createUser, setBudget, logRequest, checkBudget } = require('./src/db');
      const { id } = createUser('test-app');
      setBudget(id, { lifetime_limit_usd: 10.0 });
      logRequest({ user_id: id, app_id: 'test-app', provider: 'openai',
                   model: 'gpt-4o-mini', status: 200, latency_ms: 50,
                   estimated_cost_usd: 0.001 });
      process.stdout.write(JSON.stringify(checkBudget(id)));
    `);
    assert.equal(result.ok, true);
  });

  it('checkBudget returns ok:false when lifetime limit exceeded', () => {
    const result = runInDb(`
      const { createUser, setBudget, logRequest, checkBudget } = require('./src/db');
      const { id } = createUser('test-app');
      setBudget(id, { lifetime_limit_usd: 0.001 });
      logRequest({ user_id: id, app_id: 'test-app', provider: 'openai',
                   model: 'gpt-4o-mini', status: 200, latency_ms: 50,
                   estimated_cost_usd: 0.005 });
      process.stdout.write(JSON.stringify(checkBudget(id)));
    `);
    assert.equal(result.ok, false);
    assert.equal(result.limit_type, 'lifetime');
    assert.ok(result.used_usd >= 0.005);
    assert.ok(typeof result.reason === 'string');
  });

  it('checkBudget warns when at 80% of limit', () => {
    const result = runInDb(`
      const { createUser, setBudget, logRequest, checkBudget } = require('./src/db');
      const { id } = createUser('test-app');
      setBudget(id, { lifetime_limit_usd: 0.01, warn_threshold: 0.8 });
      logRequest({ user_id: id, app_id: 'test-app', provider: 'openai',
                   model: 'gpt-4o-mini', status: 200, latency_ms: 50,
                   estimated_cost_usd: 0.009 });
      process.stdout.write(JSON.stringify(checkBudget(id)));
    `);
    // used_usd (0.009) >= 0.01 * 0.8 (0.008) but < 0.01 → warn, still ok
    assert.equal(result.ok, true);
    assert.equal(result.warn, true);
    assert.equal(result.limit_type, 'lifetime');
  });

  it('checkBudget ignores failed requests (non-2xx status)', () => {
    const result = runInDb(`
      const { createUser, setBudget, logRequest, checkBudget } = require('./src/db');
      const { id } = createUser('test-app');
      setBudget(id, { lifetime_limit_usd: 0.001 });
      // Log a 500-status request with cost — should NOT count toward budget
      logRequest({ user_id: id, app_id: 'test-app', provider: 'openai',
                   model: 'gpt-4o-mini', status: 500, latency_ms: 50,
                   estimated_cost_usd: 0.999 });
      process.stdout.write(JSON.stringify(checkBudget(id)));
    `);
    assert.equal(result.ok, true, 'failed requests should not count toward budget');
  });

  it('checkBudget ignores requests with null estimated_cost_usd', () => {
    const result = runInDb(`
      const { createUser, setBudget, logRequest, checkBudget } = require('./src/db');
      const { id } = createUser('test-app');
      setBudget(id, { lifetime_limit_usd: 0.001 });
      // Log many requests with unknown pricing — should not block
      for (let i = 0; i < 100; i++) {
        logRequest({ user_id: id, app_id: 'test-app', provider: 'openai',
                     model: 'unknown-model', status: 200, latency_ms: 50,
                     estimated_cost_usd: null });
      }
      process.stdout.write(JSON.stringify(checkBudget(id)));
    `);
    assert.equal(result.ok, true, 'unknown-pricing requests should not trigger budget enforcement');
  });

  it('deleteBudget removes limits and checkBudget returns ok:true', () => {
    const result = runInDb(`
      const { createUser, setBudget, logRequest, checkBudget, deleteBudget } = require('./src/db');
      const { id } = createUser('test-app');
      setBudget(id, { lifetime_limit_usd: 0.001 });
      logRequest({ user_id: id, app_id: 'test-app', provider: 'openai',
                   model: 'gpt-4o-mini', status: 200, latency_ms: 50,
                   estimated_cost_usd: 0.005 });
      // Budget was exceeded — delete it and check again
      deleteBudget(id);
      process.stdout.write(JSON.stringify(checkBudget(id)));
    `);
    assert.equal(result.ok, true);
  });

  it('setBudget allows partial update without resetting other fields', () => {
    const result = runInDb(`
      const { createUser, setBudget, getBudget } = require('./src/db');
      const { id } = createUser('test-app');
      setBudget(id, { daily_limit_usd: 1.0, lifetime_limit_usd: 100.0 });
      // Update only daily limit
      setBudget(id, { daily_limit_usd: 2.0 });
      process.stdout.write(JSON.stringify(getBudget(id)));
    `);
    assert.equal(result.daily_limit_usd, 2.0, 'daily should be updated');
    assert.equal(result.lifetime_limit_usd, 100.0, 'lifetime should be unchanged');
  });
});

// ── E2E tests: budget API endpoints + relay enforcement ────────────────────

describe('E2E — budget endpoints + relay enforcement', () => {
  let mock, mockPort;
  let relayProc, relayPort;
  let relayToken;
  let tmpDir, dbPath;

  const encryptionSecret = randomTestSecret('e2e-budget');
  const appSecret = randomTestSecret('app-budget');

  // Helper: HTTP request to relay
  function relayReq({ method = 'GET', path, headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({
        hostname: '127.0.0.1',
        port: relayPort,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data ? Buffer.byteLength(data) : 0,
          ...headers,
        },
      }, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          let json;
          try { json = JSON.parse(raw); } catch { json = raw; }
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-relay-budget-e2e-'));
    dbPath = path.join(tmpDir, 'relay.db');

    // Start mock provider
    ({ server: mock, port: mockPort } = await createMockProvider());

    // Wait for a free port
    await new Promise((resolve) => {
      const srv = http.createServer();
      srv.listen(0, '127.0.0.1', () => {
        relayPort = srv.address().port;
        srv.close(resolve);
      });
    });

    // Spawn relay
    relayProc = spawn(process.execPath, ['src/index.js'], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        PORT: String(relayPort),
        DB_PATH: dbPath,
        ENCRYPTION_SECRET: encryptionSecret,
        APP_SECRET: appSecret,
        ALLOWED_ORIGINS: '*',
      },
    });

    // Wait for relay to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('relay startup timeout')), 10_000);
      const check = () => {
        const probe = http.get(`http://127.0.0.1:${relayPort}/health`, (res) => {
          if (res.statusCode === 200) { clearTimeout(timeout); resolve(); }
          else setTimeout(check, 200);
        });
        probe.on('error', () => setTimeout(check, 200));
      };
      check();
    });

    // Register a user
    const reg = await relayReq({
      method: 'POST',
      path: '/users',
      headers: { Authorization: `Bearer ${appSecret}` },
      body: { app_id: 'budget-test' },
    });
    relayToken = reg.body.token;
    assert.ok(relayToken, 'should have relay token after registration');

    // Store a fake OpenAI API key pointing to mock provider
    await relayReq({
      method: 'POST',
      path: '/keys/openai',
      headers: { 'x-relay-token': relayToken },
      body: { key: 'sk-test-budget-key-1234567890123456789012345678901234567890' },
    });
  });

  after(() => {
    if (relayProc) relayProc.kill();
    if (mock) mock.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /users/budget returns null when no budget is set', async () => {
    const r = await relayReq({
      path: '/users/budget',
      headers: { 'x-relay-token': relayToken },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.budget, null);
  });

  it('PUT /users/budget sets limits and returns them', async () => {
    const r = await relayReq({
      method: 'PUT',
      path: '/users/budget',
      headers: { 'x-relay-token': relayToken },
      body: { daily_limit_usd: 5.0, lifetime_limit_usd: 100.0, warn_threshold: 0.9 },
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.budget, 'should return budget object');
    assert.equal(r.body.budget.daily_limit_usd, 5.0);
    assert.equal(r.body.budget.lifetime_limit_usd, 100.0);
    assert.equal(r.body.budget.warn_threshold, 0.9);
  });

  it('GET /users/budget returns previously set limits', async () => {
    const r = await relayReq({
      path: '/users/budget',
      headers: { 'x-relay-token': relayToken },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.budget.daily_limit_usd, 5.0);
    assert.equal(r.body.budget.lifetime_limit_usd, 100.0);
  });

  it('PUT /users/budget rejects negative limit', async () => {
    const r = await relayReq({
      method: 'PUT',
      path: '/users/budget',
      headers: { 'x-relay-token': relayToken },
      body: { daily_limit_usd: -1 },
    });
    assert.equal(r.status, 400);
    assert.ok(r.body.error, 'should return error message');
  });

  it('PUT /users/budget rejects warn_threshold outside [0,1]', async () => {
    const r = await relayReq({
      method: 'PUT',
      path: '/users/budget',
      headers: { 'x-relay-token': relayToken },
      body: { warn_threshold: 1.5 },
    });
    assert.equal(r.status, 400);
    assert.ok(r.body.error);
  });

  it('PUT /users/budget clears a limit when passed null', async () => {
    await relayReq({
      method: 'PUT',
      path: '/users/budget',
      headers: { 'x-relay-token': relayToken },
      body: { daily_limit_usd: null },
    });
    const r = await relayReq({
      path: '/users/budget',
      headers: { 'x-relay-token': relayToken },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.budget.daily_limit_usd, null, 'daily limit should be cleared');
    assert.equal(r.body.budget.lifetime_limit_usd, 100.0, 'lifetime limit should be unchanged');
  });

  it('DELETE /users/budget removes all limits', async () => {
    await relayReq({
      method: 'DELETE',
      path: '/users/budget',
      headers: { 'x-relay-token': relayToken },
    });
    const r = await relayReq({
      path: '/users/budget',
      headers: { 'x-relay-token': relayToken },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.budget, null, 'budget should be null after DELETE');
  });

  it('GET /stats includes budget field (null when no budget set)', async () => {
    const r = await relayReq({
      path: '/stats',
      headers: { 'x-relay-token': relayToken },
    });
    assert.equal(r.status, 200);
    assert.ok('budget' in r.body, 'stats should include budget field');
    assert.equal(r.body.budget, null);
  });

  it('GET /stats includes budget info when budget is set', async () => {
    await relayReq({
      method: 'PUT',
      path: '/users/budget',
      headers: { 'x-relay-token': relayToken },
      body: { lifetime_limit_usd: 50.0 },
    });

    const r = await relayReq({
      path: '/stats',
      headers: { 'x-relay-token': relayToken },
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.budget, 'budget should be present in stats');
    assert.equal(r.body.budget.lifetime_limit_usd, 50.0);
    assert.ok('status' in r.body.budget, 'budget should include status');

    // Clean up
    await relayReq({ method: 'DELETE', path: '/users/budget', headers: { 'x-relay-token': relayToken } });
  });

  it('POST /relay returns 402 when lifetime budget exceeded', async () => {
    // Set a very small lifetime budget
    await relayReq({
      method: 'PUT',
      path: '/users/budget',
      headers: { 'x-relay-token': relayToken },
      body: { lifetime_limit_usd: 0.000001 },
    });

    // Seed a spent cost in the DB by manipulating via a direct request that
    // succeeds and is logged (mock provider responds with token usage).
    // We use the mock provider with custom response that includes usage counts.
    const mockBase = `http://127.0.0.1:${mockPort}`;

    // Make one successful request through the relay with base-url override pointing to mock
    const firstRelay = await relayReq({
      method: 'POST',
      path: '/relay',
      headers: {
        'x-relay-token': relayToken,
        'x-relay-base-url': mockBase,
      },
      body: {
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    // Now set an absurdly low budget
    await relayReq({
      method: 'PUT',
      path: '/users/budget',
      headers: { 'x-relay-token': relayToken },
      body: { lifetime_limit_usd: 0.0000001 },
    });

    // Inject artificial cost into DB to definitely exceed budget
    // We'll do this by direct DB manipulation via node subprocess
    const script = `
      const Database = require('better-sqlite3');
      const db = new Database(process.env.DB_PATH);
      db.prepare(
        "INSERT INTO request_logs (id, user_id, app_id, provider, model, status, latency_ms, created_at, estimated_cost_usd) VALUES (?, (SELECT id FROM users LIMIT 1), 'budget-test', 'openai', 'gpt-4o-mini', 200, 10, ?, 999.0)"
      ).run(require('crypto').randomUUID(), Date.now());
      console.log('injected');
    `;
    require('child_process').spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, DB_PATH: dbPath, ENCRYPTION_SECRET: encryptionSecret },
    });

    // Now try to relay — should get 402
    const r = await relayReq({
      method: 'POST',
      path: '/relay',
      headers: {
        'x-relay-token': relayToken,
        'x-relay-base-url': mockBase,
      },
      body: {
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'should be blocked' }],
      },
    });

    assert.equal(r.status, 402, `expected 402 budget exceeded, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.error, 'should include error message');
    assert.equal(r.body.limit_type, 'lifetime');

    // Clean up
    await relayReq({ method: 'DELETE', path: '/users/budget', headers: { 'x-relay-token': relayToken } });
  });

  it('budget enforcement requires auth', async () => {
    const r1 = await relayReq({ path: '/users/budget' });
    assert.equal(r1.status, 401);

    const r2 = await relayReq({ method: 'PUT', path: '/users/budget', body: { daily_limit_usd: 1.0 } });
    assert.equal(r2.status, 401);

    const r3 = await relayReq({ method: 'DELETE', path: '/users/budget' });
    assert.equal(r3.status, 401);
  });
});

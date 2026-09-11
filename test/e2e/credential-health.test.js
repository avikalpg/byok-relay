/**
 * credential-health.test.js — end-to-end tests for GET /health/credentials
 * and GET /admin/credential-health (issue #101).
 *
 * Tests:
 *   1. Unauthenticated request → 401
 *   2. User with no stored keys → empty credentials array
 *   3. Key stored, no relay activity → status 'unknown'
 *   4. Successful relay call → status 'healthy', timestamps populated
 *   5. Relay failure (provider rejects key) → consecutive_failures increments
 *   6. 3 consecutive failures → status 'degraded'
 *   7. Success after failures resets consecutive_failures → 'healthy'
 *   8. GET /admin/credential-health without APP_SECRET → 503
 *   9. GET /admin/credential-health requires APP_SECRET
 *  10. GET /admin/credential-health with valid APP_SECRET returns aggregate data
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

function randomSecret(label) {
  return `${label}-${crypto.randomBytes(24).toString('hex')}`;
}

async function req(method, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10),
      path: parsed.pathname + parsed.search,
      method,
      headers: opts.headers || {},
    };
    const r = http.request(options, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let parsed_body;
        try { parsed_body = JSON.parse(body); } catch { parsed_body = body; }
        resolve({ status: res.statusCode, body: parsed_body });
      });
    });
    r.on('error', reject);
    if (opts.body) r.write(JSON.stringify(opts.body));
    r.end();
  });
}

describe('GET /health/credentials', () => {
  let mockProviderUrl;
  let relayPort;
  let relayBase;
  let relayProc;
  let tmpDir;
  let encSecret;
  let appSecret;
  let token;
  let mockProvider;
  // E2E token that lets the relay route built-in providers to the local mock
  // server without hitting the SSRF loopback block. Same pattern as relay.test.js.
  let e2eToken;

  before(async () => {
    // Start mock provider
    mockProvider = createMockProvider();
    const mockPort = await mockProvider.start();
    mockProviderUrl = `http://127.0.0.1:${mockPort}`;
    e2eToken = `e2e-cred-health-${process.pid}-${Date.now()}`;

    // Temp DB
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-cred-health-'));
    encSecret = randomSecret('enc');
    appSecret = randomSecret('app');

    // Spawn relay
    relayPort = 3000 + Math.floor(Math.random() * 1000) + 200;
    relayBase = `http://127.0.0.1:${relayPort}`;

    relayProc = spawn('node', ['src/index.js'], {
      cwd: path.join(__dirname, '../..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(relayPort),
        ENCRYPTION_SECRET: encSecret,
        APP_SECRET: appSecret,
        DB_PATH: path.join(tmpDir, 'relay.db'),
        LOG_LEVEL: 'silent',
        // Route all provider calls to the mock server during E2E tests
        E2E_OPENAI_COMPATIBLE_BASE_URL: mockProviderUrl,
        E2E_OPENAI_COMPATIBLE_BASE_URL_TOKEN: e2eToken,
      },
    });

    // Wait for relay to be ready
    await new Promise((resolve) => {
      const check = setInterval(async () => {
        try {
          const r = await req('GET', `${relayBase}/health`);
          if (r.status === 200) { clearInterval(check); resolve(); }
        } catch {}
      }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, 8000);
    });

    // Register a user
    const regRes = await req('POST', `${relayBase}/users`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${appSecret}`,
      },
      body: { app_id: 'test-app' },
    });
    token = regRes.body.token;
  });

  after(async () => {
    relayProc.kill('SIGTERM');
    await new Promise((r) => relayProc.on('close', r));
    mockProvider.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 401 when no token provided', async () => {
    const res = await req('GET', `${relayBase}/health/credentials`);
    assert.equal(res.status, 401);
  });

  it('returns empty credentials array when user has no stored keys', async () => {
    const res = await req('GET', `${relayBase}/health/credentials`, {
      headers: { 'x-relay-token': token },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.credentials));
    assert.equal(res.body.credentials.length, 0);
  });

  it('returns status unknown after key stored but no relay activity', async () => {
    // Store a fake openai key
    await req('POST', `${relayBase}/keys/openai`, {
      headers: {
        'Content-Type': 'application/json',
        'x-relay-token': token,
      },
      body: { key: 'sk-' + 'a'.repeat(48) },
    });

    const res = await req('GET', `${relayBase}/health/credentials`, {
      headers: { 'x-relay-token': token },
    });
    assert.equal(res.status, 200);
    const creds = res.body.credentials;
    assert.equal(creds.length, 1);
    assert.equal(creds[0].provider, 'openai');
    assert.equal(creds[0].status, 'unknown');
    assert.equal(creds[0].total_requests, 0);
    assert.equal(creds[0].total_failures, 0);
    assert.equal(creds[0].consecutive_failures, 0);
    assert.equal(creds[0].last_success_at, null);
    assert.equal(creds[0].last_failure_at, null);
  });

  it('records health after successful relay call', async () => {
    // Store openai key pointing to mock provider
    await req('POST', `${relayBase}/keys/openai`, {
      headers: {
        'Content-Type': 'application/json',
        'x-relay-token': token,
      },
      body: { key: 'sk-' + 'b'.repeat(48) },
    });

    // Make a relay call
    await req('POST', `${relayBase}/relay/openai/v1/chat/completions`, {
      headers: {
        'Content-Type': 'application/json',
        'x-relay-token': token,
        'x-relay-base-url': 'https://example.com',
        'x-relay-e2e-base-url-token': e2eToken,
      },
      body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    });

    const res = await req('GET', `${relayBase}/health/credentials`, {
      headers: { 'x-relay-token': token },
    });
    assert.equal(res.status, 200);
    const creds = res.body.credentials;
    const openai = creds.find(c => c.provider === 'openai');
    assert.ok(openai, 'openai credential should be present');
    assert.equal(openai.status, 'healthy', 'status should be healthy after a successful call');
    assert.equal(openai.total_failures, 0, 'should have 0 failures after a successful call');
    assert.ok(openai.last_success_at !== null, 'last_success_at should be populated after a successful call');
    assert.equal(openai.last_failure_at, null, 'last_failure_at should be null after a successful call');
  });

  it('increments consecutive_failures on repeated failures', async () => {
    // Register a fresh user to get clean state
    const regRes = await req('POST', `${relayBase}/users`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${appSecret}`,
      },
      body: { app_id: 'test-app-failures' },
    });
    const freshToken = regRes.body.token;

    // Store a bad openai key (will cause failures)
    await req('POST', `${relayBase}/keys/openai`, {
      headers: {
        'Content-Type': 'application/json',
        'x-relay-token': freshToken,
      },
      body: { key: 'sk-' + 'z'.repeat(48) },
    });

    // Make 3 relay calls that fail via forceJsonError (mock returns 429)
    for (let i = 0; i < 3; i++) {
      await req('POST', `${relayBase}/relay/openai/v1/chat/completions`, {
        headers: {
          'Content-Type': 'application/json',
          'x-relay-token': freshToken,
          'x-relay-base-url': 'https://example.com',
          'x-relay-e2e-base-url-token': e2eToken,
        },
        body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], forceJsonError: true },
      });
    }

    const res = await req('GET', `${relayBase}/health/credentials`, {
      headers: { 'x-relay-token': freshToken },
    });
    assert.equal(res.status, 200);
    const creds = res.body.credentials;
    const openai = creds.find(c => c.provider === 'openai');
    assert.ok(openai, 'openai should be present');
    assert.equal(openai.total_requests, 3, 'should have 3 total requests');
    assert.equal(openai.total_failures, 3, 'should have 3 total failures');
    assert.equal(openai.consecutive_failures, 3, 'should have 3 consecutive failures');
    assert.equal(openai.status, 'degraded', 'status should be degraded after 3 consecutive failures');
    assert.ok(openai.last_failure_at !== null, 'last_failure_at should be populated after failures');

    // One successful call resets consecutive_failures
    await req('POST', `${relayBase}/relay/openai/v1/chat/completions`, {
      headers: {
        'Content-Type': 'application/json',
        'x-relay-token': freshToken,
        'x-relay-base-url': 'https://example.com',
        'x-relay-e2e-base-url-token': e2eToken,
      },
      body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    });
    const afterSuccessRes = await req('GET', `${relayBase}/health/credentials`, {
      headers: { 'x-relay-token': freshToken },
    });
    const afterCreds = afterSuccessRes.body.credentials;
    const afterOpenai = afterCreds.find(c => c.provider === 'openai');
    assert.equal(afterOpenai.consecutive_failures, 0, 'consecutive_failures resets to 0 after success');
    assert.equal(afterOpenai.status, 'healthy', 'status returns to healthy after success');
  });

  it('returns 400 when app_id missing from /admin/credential-health', async () => {
    const res = await req('GET', `${relayBase}/admin/credential-health`, {
      headers: { Authorization: `Bearer ${appSecret}` },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('returns 401 on /admin/credential-health without APP_SECRET header', async () => {
    const res = await req('GET', `${relayBase}/admin/credential-health?app_id=test-app`);
    assert.equal(res.status, 401);
  });

  it('returns aggregate credential health for an app', async () => {
    const res = await req('GET', `${relayBase}/admin/credential-health?app_id=test-app`, {
      headers: { Authorization: `Bearer ${appSecret}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.app_id, 'test-app');
    assert.ok(Array.isArray(res.body.credentials));
    // openai should appear since at least one user stored an openai key
    const openaiEntry = res.body.credentials.find(c => c.provider === 'openai');
    assert.ok(openaiEntry, 'openai should appear in admin health');
    // test-app has exactly one user who made one successful relay call in the 'records health' test.
    // The failure tests use app_id 'test-app-failures', so they don't affect this aggregate.
    assert.equal(openaiEntry.user_count, 1, 'one user in test-app has an openai key');
    assert.equal(openaiEntry.users_with_activity, 1, 'one user has made relay calls');
    assert.equal(openaiEntry.total_requests, 1, 'one total openai relay request for test-app');
    assert.equal(openaiEntry.total_failures, 0, 'no failures for test-app openai');
    assert.equal(openaiEntry.error_rate, 0, 'error rate is 0 with no failures');
    assert.equal(openaiEntry.users_degraded, 0, 'no degraded users in test-app');
  });
});

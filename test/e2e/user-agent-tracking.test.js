/**
 * user-agent-tracking.test.js — end-to-end tests for User-Agent logging
 * and GET /stats top_user_agents field (issue #5).
 *
 * Tests:
 *   1. Relay call with User-Agent header — stats reflect the UA
 *   2. Relay call without User-Agent header — stats have no entry for null UA
 *   3. Two calls with different User-Agents — stats rank by frequency
 *   4. User-Agent longer than 512 chars is truncated in the DB
 *   5. GET /stats returns top_user_agents array
 *   6. GET /stats/:app_id returns top_user_agents array
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
    if (opts.body) r.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    r.end();
  });
}

describe('User-Agent tracking in request_logs and GET /stats', () => {
  let mockProviderUrl;
  let relayPort;
  let relayBase;
  let relayProc;
  let tmpDir;
  let encSecret;
  let appSecret;
  let token;
  let mockProvider;
  let e2eToken;

  before(async () => {
    mockProvider = createMockProvider();
    const mockPort = await mockProvider.start();
    mockProviderUrl = `http://127.0.0.1:${mockPort}`;
    e2eToken = `e2e-ua-${process.pid}-${Date.now()}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-ua-'));
    encSecret = randomSecret('enc');
    appSecret = randomSecret('app');

    relayPort = 3000 + Math.floor(Math.random() * 1000) + 400;
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
        E2E_OPENAI_COMPATIBLE_BASE_URL: mockProviderUrl,
        E2E_OPENAI_COMPATIBLE_BASE_URL_TOKEN: e2eToken,
      },
    });

    await new Promise((resolve) => {
      const check = setInterval(async () => {
        try {
          const r = await req('GET', `${relayBase}/health`);
          if (r.status === 200) { clearInterval(check); resolve(); }
        } catch {}
      }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, 8000);
    });

    // Register user and store key
    const regRes = await req('POST', `${relayBase}/users`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${appSecret}` },
      body: { app_id: 'ua-test-app' },
    });
    assert.ok(regRes.status === 200 || regRes.status === 201, `registration status ${regRes.status}`);
    token = regRes.body.token;

    await req('POST', `${relayBase}/keys/openai`, {
      headers: {
        'Content-Type': 'application/json',
        'x-relay-token': token,
      },
      body: { key: 'sk-' + 'a'.repeat(48) },
    });
  });

  after(async () => {
    relayProc.kill('SIGTERM');
    await mockProvider.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function relayCall(ua) {
    const headers = {
      'Content-Type': 'application/json',
      'x-relay-token': token,
      'x-relay-base-url': 'https://example.com',
      'x-relay-e2e-base-url-token': e2eToken,
    };
    if (ua != null) headers['User-Agent'] = ua;
    return req('POST', `${relayBase}/relay/openai/v1/chat/completions`, {
      headers,
      body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    });
  }

  it('relay call with a User-Agent header — appears in GET /stats top_user_agents', async () => {
    const ua = 'TestApp/1.0 byok-relay-client';
    const r = await relayCall(ua);
    assert.ok(r.status >= 200 && r.status < 300, `relay call failed with ${r.status}`);

    const statsRes = await req('GET', `${relayBase}/stats`, {
      headers: { 'x-relay-token': token },
    });
    assert.equal(statsRes.status, 200);
    const { top_user_agents } = statsRes.body;
    assert.ok(Array.isArray(top_user_agents), 'top_user_agents should be an array');
    const found = top_user_agents.find(e => e.user_agent === ua);
    assert.ok(found, `expected UA "${ua}" in top_user_agents`);
    assert.ok(found.total >= 1, 'count should be at least 1');
  });

  it('relay call without User-Agent — null entries do not appear in top_user_agents', async () => {
    const r = await relayCall(null);
    assert.ok(r.status >= 200 && r.status < 300);

    const statsRes = await req('GET', `${relayBase}/stats`, {
      headers: { 'x-relay-token': token },
    });
    assert.equal(statsRes.status, 200);
    const { top_user_agents } = statsRes.body;
    const nullEntry = top_user_agents.find(e => e.user_agent == null);
    assert.equal(nullEntry, undefined, 'null UA entries must not appear in top_user_agents');
  });

  it('two calls with same UA increments count; different UA ranked separately', async () => {
    const ua1 = 'AgentA/1.0 byok-relay-client';
    const ua2 = 'AgentB/2.0 byok-relay-client';
    await relayCall(ua1);
    await relayCall(ua1);
    await relayCall(ua2);

    const statsRes = await req('GET', `${relayBase}/stats`, {
      headers: { 'x-relay-token': token },
    });
    assert.equal(statsRes.status, 200);
    const { top_user_agents } = statsRes.body;

    const e1 = top_user_agents.find(e => e.user_agent === ua1);
    const e2 = top_user_agents.find(e => e.user_agent === ua2);
    assert.ok(e1, `${ua1} not found in stats`);
    assert.ok(e2, `${ua2} not found in stats`);
    assert.ok(e1.total >= 2, `${ua1} should have >=2 calls`);
    assert.ok(e2.total >= 1, `${ua2} should have >=1 call`);
  });

  it('User-Agent longer than 512 chars is truncated in stats (not stored beyond 512)', async () => {
    const longUA = 'X'.repeat(600) + ' byok-relay-client';
    await relayCall(longUA);

    const statsRes = await req('GET', `${relayBase}/stats`, {
      headers: { 'x-relay-token': token },
    });
    assert.equal(statsRes.status, 200);
    const { top_user_agents } = statsRes.body;
    // The stored entry should be max 512 chars
    for (const e of top_user_agents) {
      assert.ok(e.user_agent.length <= 512, `UA stored at ${e.user_agent.length} chars exceeds 512`);
    }
  });

  it('GET /stats response always includes top_user_agents array', async () => {
    const statsRes = await req('GET', `${relayBase}/stats`, {
      headers: { 'x-relay-token': token },
    });
    assert.equal(statsRes.status, 200);
    assert.ok(Array.isArray(statsRes.body.top_user_agents), 'top_user_agents must be an array');
  });

  it('GET /stats/:app_id returns top_user_agents with APP_SECRET', async () => {
    const statsRes = await req('GET', `${relayBase}/stats/ua-test-app`, {
      headers: { Authorization: `Bearer ${appSecret}` },
    });
    assert.equal(statsRes.status, 200);
    assert.ok(Array.isArray(statsRes.body.top_user_agents), 'app stats top_user_agents must be an array');
  });
});

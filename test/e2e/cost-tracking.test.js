/**
 * cost-tracking.test.js — Tests for token recording and cost estimation
 *
 * Covers:
 *   - price-catalog: lookupCost, extractTokenCounts
 *   - DB: logRequest stores input_tokens / output_tokens / estimated_cost_usd
 *   - DB: getStatsForUser and getStatsForApp include cost aggregates
 *   - E2E: POST /relay records usage from mock provider JSON response
 *   - E2E: GET /stats returns estimated_cost_usd for the user
 *
 * Run: node --test test/e2e/cost-tracking.test.js
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

const { lookupCost, extractTokenCounts, CATALOG } = require('../../src/price-catalog');
const { createMockProvider } = require('./mock-provider');

function randomTestSecret(label) {
  return `${label}-${crypto.randomBytes(24).toString('hex')}`;
}

// ── Unit tests: price-catalog ─────────────────────────────────────────────

describe('price-catalog — lookupCost', () => {
  it('returns known cost for openai/gpt-4o-mini', () => {
    const { estimated_cost_usd, pricing_known } = lookupCost('openai', 'gpt-4o-mini', 1000, 500);
    assert.equal(pricing_known, true);
    // (1000 * 0.15 + 500 * 0.60) / 1_000_000 = (150 + 300) / 1_000_000 = 0.00000045
    assert.ok(estimated_cost_usd > 0, 'cost should be positive');
    assert.ok(typeof estimated_cost_usd === 'number', 'cost should be a number');
  });

  it('returns known cost for anthropic/claude-3-5-haiku-20241022', () => {
    const { estimated_cost_usd, pricing_known } = lookupCost('anthropic', 'claude-3-5-haiku-20241022', 2000, 800);
    assert.equal(pricing_known, true);
    assert.ok(estimated_cost_usd > 0);
  });

  it('returns null for unknown model — never silently zero', () => {
    const { estimated_cost_usd, pricing_known } = lookupCost('openai', 'totally-unknown-model-xyz', 1000, 500);
    assert.equal(pricing_known, false);
    assert.equal(estimated_cost_usd, null, 'unknown model must return null, not 0');
  });

  it('returns null when no token counts provided', () => {
    const { estimated_cost_usd } = lookupCost('openai', 'gpt-4o', null, null);
    assert.equal(estimated_cost_usd, null);
  });

  it('handles zero token counts', () => {
    const { estimated_cost_usd, pricing_known } = lookupCost('openai', 'gpt-4o-mini', 0, 0);
    assert.equal(pricing_known, true);
    assert.equal(estimated_cost_usd, 0);
  });

  it('falls back to bare model name when provider/model not found', () => {
    // 'gpt-4o-mini' exists under openai; query with same bare name via different provider prefix
    // should still resolve via bare-name fallback
    const { pricing_known } = lookupCost('openai-compatible', 'gpt-4o-mini', 100, 50);
    assert.equal(pricing_known, true);
  });

  it('handles model string that already has provider prefix', () => {
    const { pricing_known } = lookupCost('openai', 'openai/gpt-4o-mini', 100, 50);
    assert.equal(pricing_known, true);
  });

  it('all CATALOG entries have positive per-token values (no silent negatives)', () => {
    for (const [key, p] of Object.entries(CATALOG)) {
      assert.ok(p.input_per_mtok  >= 0, `${key}: input_per_mtok must be >= 0`);
      assert.ok(p.output_per_mtok >= 0, `${key}: output_per_mtok must be >= 0`);
    }
  });
});

describe('price-catalog — extractTokenCounts', () => {
  it('extracts OpenAI chat completion usage', () => {
    const body = {
      id: 'chatcmpl-abc',
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };
    const { input_tokens, output_tokens } = extractTokenCounts(body);
    assert.equal(input_tokens,  10);
    assert.equal(output_tokens, 20);
  });

  it('extracts Anthropic messages API usage', () => {
    const body = {
      id: 'msg-abc',
      usage: { input_tokens: 15, output_tokens: 25 },
    };
    const { input_tokens, output_tokens } = extractTokenCounts(body);
    assert.equal(input_tokens,  15);
    assert.equal(output_tokens, 25);
  });

  it('returns nulls when body has no usage field', () => {
    const body = { id: 'stream-abc', object: 'chat.completion.chunk' };
    const { input_tokens, output_tokens } = extractTokenCounts(body);
    assert.equal(input_tokens,  null);
    assert.equal(output_tokens, null);
  });

  it('returns nulls for non-object body', () => {
    const { input_tokens, output_tokens } = extractTokenCounts(null);
    assert.equal(input_tokens,  null);
    assert.equal(output_tokens, null);
  });
});

// ── Unit tests: DB logRequest + getStatsForUser ───────────────────────────

describe('DB — cost columns in request_logs', () => {
  let tmpDir, dbPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-relay-cost-'));
    dbPath = path.join(tmpDir, 'relay.db');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logRequest stores input_tokens / output_tokens / estimated_cost_usd', () => {
    const result = JSON.parse(
      require('child_process').spawnSync(
        process.execPath,
        ['-e', `
          const { createUser, logRequest, getStatsForUser } = require('./src/db');
          const { id, token } = createUser('test-app');
          logRequest({ user_id: id, app_id: 'test-app', provider: 'openai',
                       model: 'gpt-4o-mini', status: 200, latency_ms: 50,
                       input_tokens: 100, output_tokens: 40,
                       estimated_cost_usd: 0.0000390 });
          const stats = getStatsForUser(id);
          process.stdout.write(JSON.stringify(stats));
        `],
        {
          cwd: path.resolve(__dirname, '../..'),
          env: {
            ...process.env,
            DB_PATH:           dbPath,
            ENCRYPTION_SECRET: randomTestSecret('cost-db'),
          },
          encoding: 'utf8',
        },
      ).stdout,
    );

    assert.equal(result.total_input_tokens,  100);
    assert.equal(result.total_output_tokens,  40);
    assert.ok(result.estimated_cost_usd > 0, 'estimated_cost_usd should be positive in stats');
  });

  it('getStatsForUser returns null estimated_cost_usd when all rows have unknown pricing', () => {
    const result = JSON.parse(
      require('child_process').spawnSync(
        process.execPath,
        ['-e', `
          const { createUser, logRequest, getStatsForUser } = require('./src/db');
          const { id } = createUser('test-app-2');
          logRequest({ user_id: id, app_id: 'test-app-2', provider: 'openai',
                       model: 'unknown-model', status: 200, latency_ms: 30,
                       input_tokens: null, output_tokens: null,
                       estimated_cost_usd: null });
          const stats = getStatsForUser(id);
          process.stdout.write(JSON.stringify(stats));
        `],
        {
          cwd: path.resolve(__dirname, '../..'),
          env: {
            ...process.env,
            DB_PATH:           dbPath,
            ENCRYPTION_SECRET: randomTestSecret('cost-db'),
          },
          encoding: 'utf8',
        },
      ).stdout,
    );

    assert.equal(result.estimated_cost_usd, null,
      'estimated_cost_usd must be null (not 0) when pricing is unknown');
    assert.equal(result.total_input_tokens,  0);
    assert.equal(result.total_output_tokens, 0);
  });
});

// ── E2E tests: relay records usage + GET /stats returns cost ──────────────

describe('E2E — token recording + cost in GET /stats', () => {
  let mock, mockPort;
  let relayProc, relayPort;
  let relayToken, relayE2eToken;
  let tmpDir, dbPath;

  const encryptionSecret = randomTestSecret('e2e-cost');

  before(async () => {
    tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-relay-cost-e2e-'));
    dbPath  = path.join(tmpDir, 'relay.db');

    // Start mock provider
    mock = createMockProvider();
    mockPort = await mock.start();

    // Pick a free port for the relay
    relayPort = await getFreePort();

    const e2eToken = randomTestSecret('e2e-tok');
    const mockBaseUrl = `http://127.0.0.1:${mockPort}`;

    // Start relay
    {
      const env = {
        ...process.env,
        PORT:              String(relayPort),
        DB_PATH:           dbPath,
        ENCRYPTION_SECRET: encryptionSecret,
        LOG_LEVEL:         'silent',
        NODE_ENV:          'test',
        E2E_OPENAI_COMPATIBLE_BASE_URL:       mockBaseUrl,
        E2E_OPENAI_COMPATIBLE_BASE_URL_TOKEN: e2eToken,
      };
      relayProc = spawn(process.execPath, [path.resolve(__dirname, '../../src/index.js')], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      relayProc.on('error', (e) => { throw e; });
    }
    // expose e2eToken so tests can use it via closure
    relayE2eToken = e2eToken;

    // Wait until relay is accepting requests
    await waitForHealth(relayPort);

    // Register user
    const userRes = await req(relayPort, 'POST', '/users', { app_id: 'cost-e2e' });
    assert.equal(userRes.status, 200, `POST /users failed: ${JSON.stringify(userRes.body)}`);
    relayToken = userRes.body.token;

    // Store a known key (openai) pointing at the mock provider
    const keyRes = await req(relayPort, 'POST', '/keys/openai', { key: 'sk-test1234567890' },
                             { 'x-relay-token': relayToken });
    assert.equal(keyRes.status, 200, `POST /keys/openai failed: ${JSON.stringify(keyRes.body)}`);
  });

  after(async () => {
    if (relayProc) relayProc.kill('SIGTERM');
    if (mock?.stop) await mock.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /stats returns 0 estimated_cost_usd before any relay calls', async () => {
    const r = await req(relayPort, 'GET', '/stats', undefined, { 'x-relay-token': relayToken });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 0);
    // No requests yet — cost aggregate may be null or 0
    assert.ok(r.body.estimated_cost_usd == null || r.body.estimated_cost_usd === 0);
  });

  it('POST /relay records usage and GET /stats returns estimated_cost_usd', async () => {
    // Make a relay call via the mock provider (mock returns usage: {prompt_tokens:5, completion_tokens:5})
    const relayRes = await req(
      relayPort,
      'POST',
      '/relay/openai/v1/chat/completions',
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'test' }] },
      {
        'x-relay-token':              relayToken,
        'x-relay-e2e-base-url-token': relayE2eToken,
      },
    );
    assert.equal(relayRes.status, 200, `relay call failed: ${JSON.stringify(relayRes.body)}`);

    // The mock returns usage: { prompt_tokens: 5, completion_tokens: 5 }
    // gpt-4o-mini pricing: 0.15/mtok input, 0.60/mtok output
    // Cost = (5 * 0.15 + 5 * 0.60) / 1_000_000 = 3.75 / 1_000_000 = 0.00000375
    const statsRes = await req(relayPort, 'GET', '/stats', undefined, { 'x-relay-token': relayToken });
    assert.equal(statsRes.status, 200);
    assert.equal(statsRes.body.total, 1);
    assert.equal(statsRes.body.total_input_tokens,  5);
    assert.equal(statsRes.body.total_output_tokens, 5);
    assert.ok(statsRes.body.estimated_cost_usd > 0,
      `expected positive estimated_cost_usd, got ${statsRes.body.estimated_cost_usd}`);
    assert.ok(statsRes.body.estimated_cost_usd < 0.001,
      'cost for 5+5 tokens should be tiny (< $0.001)');
  });

  it('top_models in GET /stats includes per-model token and cost aggregates', async () => {
    const r = await req(relayPort, 'GET', '/stats', undefined, { 'x-relay-token': relayToken });
    assert.equal(r.status, 200);
    const topModels = r.body.top_models;
    assert.ok(Array.isArray(topModels) && topModels.length >= 1);
    const gpt4oEntry = topModels.find(m => m.model === 'gpt-4o-mini');
    assert.ok(gpt4oEntry, 'gpt-4o-mini should appear in top_models');
    assert.equal(gpt4oEntry.input_tokens,  5);
    assert.equal(gpt4oEntry.output_tokens, 5);
    assert.ok(gpt4oEntry.estimated_cost_usd > 0);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = require('node:net').createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForHealth(port, maxMs = 10000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await req(port, 'GET', '/health');
      if (r.status === 200) return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`relay on port ${port} did not become healthy within ${maxMs}ms`);
}

function req(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options = {
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    };
    const r = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

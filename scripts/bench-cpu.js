#!/usr/bin/env node
/**
 * byok-relay CPU overhead benchmark.
 *
 * Isolates the relay's internal processing overhead:
 *   - SQLite user lookup by HMAC token hash
 *   - AES-256-GCM key decryption
 *   - Request body re-serialization
 *
 * This is the "pure relay overhead" - independent of any network hop.
 * The real-world overhead = this CPU cost + relay-to-provider network distance.
 */

const Database = require('better-sqlite3');
const crypto = require('crypto');

// ── Setup ──────────────────────────────────────────────────────────────────

const ENCRYPTION_SECRET = 'benchmarkbenchmarkbenchmarkbenchmark32x';
const RUNS = 10000;
const WARMUP = 500;

// Derive encryption key (this is cached at startup in prod; shown here for completeness)
const ENCRYPTION_KEY = crypto.scryptSync(ENCRYPTION_SECRET, 'byok-relay-salt', 32);

// ── DB setup ───────────────────────────────────────────────────────────────

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
    app_id TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS keys (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL, encrypted_key TEXT NOT NULL,
    iv TEXT NOT NULL, auth_tag TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(user_id, provider)
  );
  CREATE INDEX IF NOT EXISTS idx_users_token_hash ON users(token_hash);
  CREATE INDEX IF NOT EXISTS idx_keys_user_provider ON keys(user_id, provider);
`);

// ── Helpers ────────────────────────────────────────────────────────────────

function encryptKey(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { encrypted: encrypted.toString('hex'), iv: iv.toString('hex'), authTag: authTag.toString('hex') };
}

function decryptKey(encryptedHex, ivHex, authTagHex) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]).toString('utf8');
}

function hashToken(token) {
  return crypto.createHmac('sha256', ENCRYPTION_SECRET).update(token).digest('hex');
}

// ── Seed data ──────────────────────────────────────────────────────────────

const rawToken = crypto.randomBytes(32).toString('hex');
const tokenHash = hashToken(rawToken);
const userId = crypto.randomUUID();
const { encrypted, iv, authTag } = encryptKey('sk-ant-api03-a1b2c3d4e5f6g7h8i9j0-real-api-key');

db.prepare('INSERT INTO users (id, token_hash, app_id, created_at) VALUES (?, ?, ?, ?)').run(
  userId, tokenHash, 'bench-app', Date.now()
);
db.prepare('INSERT INTO keys (id, user_id, provider, encrypted_key, iv, auth_tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
  crypto.randomUUID(), userId, 'anthropic', encrypted, iv, authTag, Date.now()
);

// ── Prepared statements ────────────────────────────────────────────────────

const stmtUser = db.prepare('SELECT id FROM users WHERE token_hash = ?');
const stmtKey  = db.prepare('SELECT encrypted_key, iv, auth_tag FROM keys WHERE user_id = ? AND provider = ?');
const requestBody = {
  model: 'claude-3-haiku-20240307',
  messages: [{ role: 'user', content: 'Hello' }],
};

// ── Benchmark ──────────────────────────────────────────────────────────────

function tick() { return process.hrtime.bigint(); }
function toMs(n) { return Number(n) / 1e6; }

function oneRequest() {
  // Step 1: Hash the incoming relay token
  const incomingHash = hashToken(rawToken);

  // Step 2: SQLite user lookup
  const user = stmtUser.get(incomingHash);

  // Step 3: SQLite key lookup + AES-256-GCM decryption
  const keyRow = stmtKey.get(user.id, 'anthropic');
  const apiKey = decryptKey(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);

  // Step 4: Body re-serialization (what the relay does before forwarding)
  const serialized = JSON.stringify(requestBody);

  return apiKey.length + serialized.length; // prevent optimization
}

// Warmup
for (let i = 0; i < WARMUP; i++) oneRequest();

// Measure
const times = [];
for (let i = 0; i < RUNS; i++) {
  const t0 = tick();
  oneRequest();
  const t1 = tick();
  times.push(toMs(t1 - t0));
}

// ── Stats ──────────────────────────────────────────────────────────────────

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

const mean = times.reduce((a, b) => a + b, 0) / times.length;
const p50 = percentile(times, 50);
const p90 = percentile(times, 90);
const p99 = percentile(times, 99);
const p999 = percentile(times, 99.9);
console.log('\n=== byok-relay CPU overhead benchmark ===');
console.log(`Platform: ${process.platform} ${process.arch}, Node ${process.version}`);
console.log(`Runs: ${WARMUP} warmup + ${RUNS} measured\n`);
console.log('Operations per request:');
console.log('  1. HMAC-SHA256 token hash');
console.log('  2. SQLite indexed user lookup');
console.log('  3. SQLite indexed key lookup');
console.log('  4. AES-256-GCM key decryption');
console.log('  5. JSON body re-serialization\n');
console.log('Results:');
console.log(`  min:  ${Math.min(...times).toFixed(3)} ms`);
console.log(`  p50:  ${p50.toFixed(3)} ms`);
console.log(`  p90:  ${p90.toFixed(3)} ms`);
console.log(`  p99:  ${p99.toFixed(3)} ms`);
console.log(`  p999: ${p999.toFixed(3)} ms`);
console.log(`  max:  ${Math.max(...times).toFixed(3)} ms`);
console.log(`  mean: ${mean.toFixed(3)} ms`);
console.log(`\nConclusion: measured relay CPU overhead at p99 is ${p99.toFixed(3)} ms (excluding network).`);
console.log('Real-world total overhead = CPU time above + relay→provider network distance.');
console.log('Total latency also depends on the network path and is not measured here.');

// Output JSON for embedding in page
const result = {
  platform: `${process.platform} ${process.arch} Node ${process.version}`,
  runs: RUNS,
  warmup: WARMUP,
  ms: {
    min: +Math.min(...times).toFixed(3),
    p50: +p50.toFixed(3),
    p90: +p90.toFixed(3),
    p99: +p99.toFixed(3),
    p999: +p999.toFixed(3),
    max: +Math.max(...times).toFixed(3),
    mean: +mean.toFixed(3),
  }
};
console.log('\nJSON:', JSON.stringify(result));

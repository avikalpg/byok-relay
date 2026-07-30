/**
 * SQLite database layer.
 * Schema:
 *   users(id TEXT PK, token_hash TEXT UNIQUE, token_hmac_version INTEGER,
 *         app_id TEXT, created_at INTEGER)
 *   keys(id TEXT PK, user_id TEXT FK, provider TEXT, encrypted_key TEXT, created_at INTEGER)
 *
 * Keys are encrypted with AES-256-GCM using ENCRYPTION_SECRET from env.
 *
 * Relay tokens are NEVER stored in plaintext.  A raw random token is returned
 * to the caller once at registration time; only its HMAC-SHA256 digest is
 * persisted.  Lookup hashes the incoming token before querying.
 */
const Database = require('better-sqlite3');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'relay.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema (with migration from legacy `token` column) ─────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    token_hash TEXT UNIQUE NOT NULL,
    token_hmac_version INTEGER NOT NULL DEFAULT 2,
    app_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    encrypted_key TEXT NOT NULL,
    iv TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, provider)
  );

  CREATE INDEX IF NOT EXISTS idx_keys_user_provider ON keys(user_id, provider);

  CREATE TABLE IF NOT EXISTS request_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    app_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    status INTEGER NOT NULL,
    latency_ms REAL NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_request_logs_user ON request_logs(user_id);
  CREATE INDEX IF NOT EXISTS idx_request_logs_app ON request_logs(app_id);
  CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at);
`);
// NOTE: idx_users_token_hash is created AFTER _migrateTokenColumn() runs.
// On a legacy DB the users table still has 'token', not 'token_hash', so
// creating the index here would throw "no such column: token_hash".

// ── Migration: rename legacy `token` column → `token_hash` and hash values ─
//
// SQLite supports RENAME COLUMN since 3.25.0.  We also need to backfill the
// existing plaintext tokens with their HMAC hashes so existing users are not
// logged out (they still present the same plaintext token; we hash it on
// lookup, which will now match the stored hash).
//
// The migration is idempotent: it checks for the old column name before
// acting, and only runs once.

function _migrateTokenColumn() {
  const cols = db.pragma('table_info(users)').map(c => c.name);
  if (!cols.includes('token')) return; // no legacy column — already migrated

  // Idempotent: if a previous run crashed after ALTER TABLE but before the
  // table rebuild, token_hash already exists. Skip the ALTER in that case.
  const alreadyHasTokenHash = cols.includes('token_hash');

  // Dropping a referenced table applies ON DELETE actions when foreign-key
  // enforcement is enabled. Disable it outside the transaction so rebuilding
  // users cannot cascade-delete existing provider keys.
  db.pragma('foreign_keys = OFF');

  // Wrap everything (DDL + DML + rebuild) in a single transaction so that a
  // crash mid-migration leaves the DB unchanged and the next startup retries.
  const migrate = db.transaction(() => {
    // 1. Add the new column (skip if it was added by a prior interrupted run)
    if (!alreadyHasTokenHash) {
      db.exec('ALTER TABLE users ADD COLUMN token_hash TEXT');
    }

    // 2. Backfill hash values into the new column. Only rows whose token_hash
    //    is still NULL need updating, which keeps the migration idempotent.
    const hmacKey = _getHmacKey();
    const rows = db.prepare('SELECT id, token FROM users WHERE token_hash IS NULL').all();
    const update = db.prepare('UPDATE users SET token_hash = ? WHERE id = ?');
    for (const row of rows) {
      update.run(_hmac(row.token, hmacKey), row.id);
    }

    // 3. Rebuild the table without the old `token` column
    //    (SQLite does not support DROP COLUMN before 3.35.0)
    //    All statements run atomically — no window where `users` is absent.
    db.exec(`
      CREATE TABLE users_new (
        id TEXT PRIMARY KEY,
        token_hash TEXT UNIQUE NOT NULL,
        token_hmac_version INTEGER NOT NULL DEFAULT 1,
        app_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO users_new (id, token_hash, token_hmac_version, app_id, created_at)
        SELECT id, token_hash, 1, app_id, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
  });

  try {
    migrate();
    const violations = db.pragma('foreign_key_check');
    if (violations.length > 0) {
      throw new Error('Legacy token migration left invalid foreign-key references');
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

_migrateTokenColumn();

// Existing token_hash rows predate key-version tracking and are conservatively
// marked legacy/unconfirmed. A successful authentication confirms and updates
// them to version 2. Fresh databases already include this column above.
function _ensureTokenHmacVersionColumn() {
  const cols = db.pragma('table_info(users)').map(c => c.name);
  if (!cols.includes('token_hmac_version')) {
    db.exec('ALTER TABLE users ADD COLUMN token_hmac_version INTEGER NOT NULL DEFAULT 1');
  }
}

_ensureTokenHmacVersionColumn();

// Create the token_hash index AFTER migration so it works on both
// fresh installs (table was just created with token_hash) and legacy
// installs (migration just renamed the column).
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_token_hash ON users(token_hash);');

// ── Encryption helpers ──────────────────────────────────────────────────────

// Derived key is computed once at startup to avoid scrypt DoS on every call.
let _encryptionKey = null;
function getEncryptionKey() {
  if (_encryptionKey) return _encryptionKey;
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error('ENCRYPTION_SECRET env var is required');
  const salt = process.env.ENCRYPTION_SALT || 'byok-relay-salt';
  _encryptionKey = crypto.scryptSync(secret, salt, 32);
  return _encryptionKey;
}

// Warm the cache eagerly at module load (dotenv is guaranteed to have run
// before this module is imported — see src/index.js).
getEncryptionKey();

function encryptApiKey(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted_key: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    auth_tag: authTag.toString('hex'),
  };
}

function decryptApiKey(encryptedHex, ivHex, authTagHex) {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

// ── Token helpers ───────────────────────────────────────────────────────────

/**
 * Returns the HMAC key used to hash relay tokens.
 * Uses TOKEN_HMAC_SECRET if set; otherwise falls back to ENCRYPTION_SECRET.
 * Both are acceptable; a dedicated secret is preferred.
 */
function _getHmacKey() {
  const secret = process.env.TOKEN_HMAC_SECRET || process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error('TOKEN_HMAC_SECRET (or ENCRYPTION_SECRET) env var is required');
  return secret;
}

/**
 * Returns the HMAC-SHA256 hex digest of `token` using `key`.
 */
function _hmac(token, key) {
  return crypto.createHmac('sha256', key).update(token).digest('hex');
}

/**
 * Hash a plaintext relay token for safe storage.
 */
function hashToken(token) {
  return _hmac(token, _getHmacKey());
}

/**
 * Return the previous HMAC key when production is moving from the historical
 * ENCRYPTION_SECRET fallback to a dedicated TOKEN_HMAC_SECRET.
 *
 * Once every stored token has been upgraded, ENCRYPTION_SECRET remains
 * available for API-key decryption but is no longer used for new token hashes.
 */
function _getLegacyHmacKey() {
  const current = process.env.TOKEN_HMAC_SECRET;
  const legacy = process.env.ENCRYPTION_SECRET;
  return current && legacy && current !== legacy ? legacy : null;
}

// ── User helpers ────────────────────────────────────────────────────────────

/**
 * Create a new user.
 *
 * @returns {{ id: string, token: string }}
 *   `token` is the **plaintext** random token — returned to the caller ONCE,
 *   never stored.  Only `token_hash` (HMAC-SHA256) is persisted in the DB.
 */
function createUser(appId) {
  const id = uuidv4();
  const token = crypto.randomBytes(32).toString('hex');
  const token_hash = hashToken(token);
  const now = Date.now();
  db.prepare(
    'INSERT INTO users (id, token_hash, token_hmac_version, app_id, created_at) VALUES (?, ?, 2, ?, ?)'
  ).run(id, token_hash, appId, now);
  // Return plaintext token to caller — this is the only time it leaves memory.
  return { id, token };
}

/**
 * Look up a user by their plaintext relay token.
 * Hashes the token before querying so plaintext is never compared in SQL.
 */
function getUserByToken(token) {
  const token_hash = hashToken(token);
  const selectUser = db
    .prepare('SELECT id, app_id, created_at, token_hmac_version FROM users WHERE token_hash = ?');
  let user = selectUser.get(token_hash);
  if (user) {
    if (user.token_hmac_version !== 2) {
      db.prepare('UPDATE users SET token_hmac_version = 2 WHERE id = ?').run(user.id);
    }
    const { token_hmac_version: _version, ...publicUser } = user;
    return publicUser;
  }

  // Existing installations historically used ENCRYPTION_SECRET as the token
  // HMAC key. During key separation, accept that digest once and atomically
  // replace it with the dedicated-key digest. The plaintext token is still
  // never persisted.
  const legacyKey = _getLegacyHmacKey();
  if (!legacyKey) return undefined;

  const legacyHash = _hmac(token, legacyKey);
  user = selectUser.get(legacyHash);
  if (!user) return undefined;

  db.prepare('UPDATE users SET token_hash = ?, token_hmac_version = 2 WHERE id = ? AND token_hash = ?')
    .run(token_hash, user.id, legacyHash);
  const { token_hmac_version: _version, ...publicUser } = user;
  return publicUser;
}

/**
 * Return conservative HMAC migration progress without exposing user records.
 * "current" means confirmed by a successful authentication or created after
 * tracking was introduced; "legacy" includes all still-unconfirmed rows.
 */
function getTokenHmacMigrationProgress() {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN token_hmac_version = 2 THEN 1 ELSE 0 END) AS current,
      SUM(CASE WHEN token_hmac_version = 2 THEN 0 ELSE 1 END) AS legacy
    FROM users
  `).get();
  const total = Number(row.total || 0);
  const current = Number(row.current || 0);
  const legacy = Number(row.legacy || 0);
  return {
    total,
    current,
    legacy,
    percent: total === 0 ? 100 : Number(((current / total) * 100).toFixed(1)),
  };
}

// ── Key helpers ─────────────────────────────────────────────────────────────

function upsertKey(userId, provider, plaintextKey) {
  const { encrypted_key, iv, auth_tag } = encryptApiKey(plaintextKey);
  const now = Date.now();
  db.prepare(`
    INSERT INTO keys (id, user_id, provider, encrypted_key, iv, auth_tag, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      encrypted_key = excluded.encrypted_key,
      iv = excluded.iv,
      auth_tag = excluded.auth_tag
  `).run(uuidv4(), userId, provider, encrypted_key, iv, auth_tag, now);
}

function getDecryptedKey(userId, provider) {
  const row = db.prepare('SELECT * FROM keys WHERE user_id = ? AND provider = ?').get(userId, provider);
  if (!row) return null;
  return decryptApiKey(row.encrypted_key, row.iv, row.auth_tag);
}

function deleteKey(userId, provider) {
  db.prepare('DELETE FROM keys WHERE user_id = ? AND provider = ?').run(userId, provider);
}

function listProviders(userId) {
  return db
    .prepare('SELECT provider FROM keys WHERE user_id = ?')
    .all(userId)
    .map(r => r.provider);
}

// ── Request log helpers ─────────────────────────────────────────────────────

/**
 * Append one relay request to the request_logs table.
 * Called from the relay route handlers after the upstream response completes.
 *
 * @param {object} entry
 * @param {string}  entry.user_id
 * @param {string}  entry.app_id
 * @param {string}  entry.provider
 * @param {string}  [entry.model]
 * @param {number}  entry.status     - HTTP status returned to client
 * @param {number}  entry.latency_ms - wall-clock ms for the upstream request
 */
function logRequest({ user_id, app_id, provider, model, status, latency_ms }) {
  db.prepare(
    'INSERT INTO request_logs (id, user_id, app_id, provider, model, status, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(uuidv4(), user_id, app_id, provider, model || null, status, latency_ms, Date.now());
}

/**
 * Return aggregate stats for a single user (identified by user_id).
 *
 * Returns:
 *   total          - all-time request count
 *   last_7d        - requests in the last 7 days
 *   last_30d       - requests in the last 30 days
 *   providers      - per-provider breakdown: { [provider]: { total, errors } }
 *   models         - top 10 models by request count
 *   error_count    - total non-2xx responses (all time)
 *   error_rate     - error_count / total (0 when total === 0)
 *   last_request   - ISO timestamp of most-recent request, or null
 */
function getStatsForUser(userId) {
  const now = Date.now();
  const ms7d  = 7  * 24 * 60 * 60 * 1000;
  const ms30d = 30 * 24 * 60 * 60 * 1000;

  const total   = db.prepare('SELECT COUNT(*) AS n FROM request_logs WHERE user_id = ?').get(userId).n;
  const last7d  = db.prepare('SELECT COUNT(*) AS n FROM request_logs WHERE user_id = ? AND created_at >= ?').get(userId, now - ms7d).n;
  const last30d = db.prepare('SELECT COUNT(*) AS n FROM request_logs WHERE user_id = ? AND created_at >= ?').get(userId, now - ms30d).n;
  const errCount = db.prepare('SELECT COUNT(*) AS n FROM request_logs WHERE user_id = ? AND (status < 200 OR status >= 300)').get(userId).n;

  const provRows = db.prepare(
    `SELECT provider,
            COUNT(*) AS total,
            SUM(CASE WHEN status < 200 OR status >= 300 THEN 1 ELSE 0 END) AS errors
     FROM request_logs WHERE user_id = ? GROUP BY provider ORDER BY total DESC`
  ).all(userId);

  const providers = {};
  for (const r of provRows) {
    providers[r.provider] = { total: r.total, errors: r.errors };
  }

  const topModels = db.prepare(
    `SELECT model, COUNT(*) AS total FROM request_logs
     WHERE user_id = ? AND model IS NOT NULL
     GROUP BY model ORDER BY total DESC LIMIT 10`
  ).all(userId).map(r => ({ model: r.model, total: r.total }));

  const lastRow = db.prepare('SELECT created_at FROM request_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId);

  return {
    total,
    last_7d:    last7d,
    last_30d:   last30d,
    error_count: errCount,
    error_rate: total > 0 ? +(errCount / total).toFixed(4) : 0,
    providers,
    top_models: topModels,
    last_request: lastRow ? new Date(lastRow.created_at).toISOString() : null,
  };
}

/**
 * Return aggregate stats for all users belonging to a given app_id.
 * Used by an operator-level /stats/:app_id endpoint (guarded by APP_SECRET).
 */
function getStatsForApp(appId) {
  const now = Date.now();
  const ms7d  = 7  * 24 * 60 * 60 * 1000;
  const ms30d = 30 * 24 * 60 * 60 * 1000;

  const total    = db.prepare('SELECT COUNT(*) AS n FROM request_logs WHERE app_id = ?').get(appId).n;
  const last7d   = db.prepare('SELECT COUNT(*) AS n FROM request_logs WHERE app_id = ? AND created_at >= ?').get(appId, now - ms7d).n;
  const last30d  = db.prepare('SELECT COUNT(*) AS n FROM request_logs WHERE app_id = ? AND created_at >= ?').get(appId, now - ms30d).n;
  const errCount = db.prepare('SELECT COUNT(*) AS n FROM request_logs WHERE app_id = ? AND (status < 200 OR status >= 300)').get(appId).n;
  const userCount = db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM request_logs WHERE app_id = ?').get(appId).n;

  const provRows = db.prepare(
    `SELECT provider,
            COUNT(*) AS total,
            SUM(CASE WHEN status < 200 OR status >= 300 THEN 1 ELSE 0 END) AS errors
     FROM request_logs WHERE app_id = ? GROUP BY provider ORDER BY total DESC`
  ).all(appId);

  const providers = {};
  for (const r of provRows) {
    providers[r.provider] = { total: r.total, errors: r.errors };
  }

  const topModels = db.prepare(
    `SELECT model, COUNT(*) AS total FROM request_logs
     WHERE app_id = ? AND model IS NOT NULL
     GROUP BY model ORDER BY total DESC LIMIT 10`
  ).all(appId).map(r => ({ model: r.model, total: r.total }));

  return {
    app_id: appId,
    user_count: userCount,
    total,
    last_7d:    last7d,
    last_30d:   last30d,
    error_count: errCount,
    error_rate: total > 0 ? +(errCount / total).toFixed(4) : 0,
    providers,
    top_models: topModels,
  };
}

module.exports = {
  createUser,
  getUserByToken,
  getTokenHmacMigrationProgress,
  upsertKey,
  getDecryptedKey,
  deleteKey,
  listProviders,
  logRequest,
  getStatsForUser,
  getStatsForApp,
};


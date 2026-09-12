/**
 * SQLite database layer.
 * Schema:
 *   users(id TEXT PK, token_hash TEXT UNIQUE, token_hmac_version INTEGER,
 *         app_id TEXT, created_at INTEGER, expires_at INTEGER)
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
    created_at INTEGER NOT NULL,
    expires_at INTEGER
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

  CREATE TABLE IF NOT EXISTS credential_health (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    last_success_at INTEGER,
    last_failure_at INTEGER,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    total_requests INTEGER NOT NULL DEFAULT 0,
    total_failures INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, provider)
  );

  CREATE INDEX IF NOT EXISTS idx_credential_health_user ON credential_health(user_id);
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
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      );
      INSERT INTO users_new (id, token_hash, token_hmac_version, app_id, created_at, expires_at)
        SELECT id, token_hash, 1, app_id, created_at, NULL FROM users;
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

// Existing rows get expires_at = NULL, meaning "no expiry" (backward-compatible).
// New rows get an explicit expires_at timestamp unless TOKEN_EXPIRY_DAYS=0.
function _migrateAddExpiresAt() {
  const cols = db.pragma('table_info(users)').map(c => c.name);
  if (!cols.includes('expires_at')) {
    db.exec('ALTER TABLE users ADD COLUMN expires_at INTEGER');
  }
}

_migrateAddExpiresAt();

// Create the token_hash index AFTER migration so it works on both
// fresh installs (table was just created with token_hash) and legacy
// installs (migration just renamed the column).
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_token_hash ON users(token_hash);');

// ── Token TTL ───────────────────────────────────────────────────────────────

/**
 * Default token lifetime: 90 days. Override with TOKEN_EXPIRY_DAYS.
 * Set TOKEN_EXPIRY_DAYS=0 to disable expiry entirely.
 */
const TOKEN_EXPIRY_DAYS = parseInt(process.env.TOKEN_EXPIRY_DAYS, 10);
const TOKEN_EXPIRY_MS =
  (!Number.isNaN(TOKEN_EXPIRY_DAYS) && TOKEN_EXPIRY_DAYS === 0)
    ? null
    : (!Number.isNaN(TOKEN_EXPIRY_DAYS) && TOKEN_EXPIRY_DAYS > 0)
      ? TOKEN_EXPIRY_DAYS * 86400 * 1000
      : 90 * 86400 * 1000;

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
  const expires_at = TOKEN_EXPIRY_MS === null ? null : now + TOKEN_EXPIRY_MS;
  db.prepare(
    'INSERT INTO users (id, token_hash, token_hmac_version, app_id, created_at, expires_at) VALUES (?, ?, 2, ?, ?, ?)'
  ).run(id, token_hash, appId, now, expires_at);
  // Return plaintext token to caller — this is the only time it leaves memory.
  return { id, token, expires_at };
}

/**
 * Look up a user by their plaintext relay token.
 * Hashes the token before querying so plaintext is never compared in SQL.
 */
function _isExpiredUser(user) {
  return user.expires_at !== null && user.expires_at < Date.now();
}

function _toPublicUser(user) {
  const { token_hmac_version: _version, expires_at: _expiresAt, ...publicUser } = user;
  return publicUser;
}

function getUserByToken(token) {
  const token_hash = hashToken(token);
  const selectUser = db
    .prepare('SELECT id, app_id, created_at, expires_at, token_hmac_version FROM users WHERE token_hash = ?');
  let user = selectUser.get(token_hash);
  if (user) {
    if (_isExpiredUser(user)) return null;
    if (user.token_hmac_version !== 2) {
      db.prepare('UPDATE users SET token_hmac_version = 2 WHERE id = ?').run(user.id);
    }
    return _toPublicUser(user);
  }

  // Existing installations historically used ENCRYPTION_SECRET as the token
  // HMAC key. During key separation, accept that digest once and atomically
  // replace it with the dedicated-key digest. The plaintext token is still
  // never persisted.
  const legacyKey = _getLegacyHmacKey();
  if (!legacyKey) return null;

  const legacyHash = _hmac(token, legacyKey);
  user = selectUser.get(legacyHash);
  if (!user) return null;
  if (_isExpiredUser(user)) return null;

  db.prepare('UPDATE users SET token_hash = ?, token_hmac_version = 2 WHERE id = ? AND token_hash = ?')
    .run(token_hash, user.id, legacyHash);
  return _toPublicUser(user);
}

/**
 * Immediately revoke a relay token by setting its expiry to the past.
 * Stored keys remain in the database but become inaccessible.
 * To delete keys too, call deleteUser().
 */
function revokeToken(userId) {
  db.prepare('UPDATE users SET expires_at = ? WHERE id = ?').run(Date.now() - 1, userId);
}

/**
 * Delete a user account and all their stored keys.
 * Keys are cascade-deleted by the ON DELETE CASCADE foreign-key constraint.
 * Use for GDPR erasure (Art. 17) or full account teardown.
 */
function deleteUser(userId) {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
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


/**
 * Atomically rotate a stored API key for a provider.
 *
 * The caller is expected to have already verified the new key against the
 * provider before calling this function. The operation delegates to the same
 * UPSERT path used by key creation, so the existing key stays intact unless
 * the verified replacement write succeeds.
 *
 * @param {string} userId        - Owner user id
 * @param {string} provider      - Provider name
 * @param {string} newPlaintext  - New plaintext API key (already verified)
 * @returns {{ rotated: boolean }}
 *   `rotated: true`  → an existing key was replaced
 *   `rotated: false` → no prior key existed; new key was stored (first-time set)
 */
function rotateKey(userId, provider, newPlaintext) {
  const hadKey = !!db
    .prepare('SELECT id FROM keys WHERE user_id = ? AND provider = ?')
    .get(userId, provider);
  upsertKey(userId, provider, newPlaintext);
  return { rotated: hadKey };
}

// ── Credential health helpers ──────────────────────────────────────────────

/**
 * Record one relay outcome against a user's credential for a provider.
 * Tracks success/failure timestamps and consecutive failure count.
 * Called after every relay request (success or error).
 *
 * @param {object} params
 * @param {string} params.user_id
 * @param {string} params.provider
 * @param {boolean} params.success  - true for 2xx, false for errors/non-2xx
 */
function updateCredentialHealth({ user_id, provider, success }) {
  const now = Date.now();
  const existing = db
    .prepare('SELECT id, consecutive_failures, total_requests, total_failures FROM credential_health WHERE user_id = ? AND provider = ?')
    .get(user_id, provider);

  if (!existing) {
    db.prepare(`
      INSERT INTO credential_health
        (id, user_id, provider, last_success_at, last_failure_at, consecutive_failures, total_requests, total_failures, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      uuidv4(),
      user_id,
      provider,
      success ? now : null,
      success ? null : now,
      success ? 0 : 1,
      success ? 0 : 1,
      now,
    );
    return;
  }

  if (success) {
    db.prepare(`
      UPDATE credential_health
      SET last_success_at = ?,
          consecutive_failures = 0,
          total_requests = total_requests + 1,
          updated_at = ?
      WHERE user_id = ? AND provider = ?
    `).run(now, now, user_id, provider);
  } else {
    db.prepare(`
      UPDATE credential_health
      SET last_failure_at = ?,
          consecutive_failures = consecutive_failures + 1,
          total_requests = total_requests + 1,
          total_failures = total_failures + 1,
          updated_at = ?
      WHERE user_id = ? AND provider = ?
    `).run(now, now, user_id, provider);
  }
}

/**
 * Return credential health for all providers stored by a user.
 * Joined with the keys table so only providers with a stored key are returned.
 * Providers with no relay activity yet have null timestamps and 0 counts.
 *
 * Each entry includes:
 *   provider              - provider name
 *   status                - 'healthy' | 'degraded' | 'unknown'
 *   last_success_at       - ISO timestamp or null
 *   last_failure_at       - ISO timestamp or null
 *   consecutive_failures  - number of failures since last success
 *   total_requests        - all-time relay requests for this credential
 *   total_failures        - all-time relay failures for this credential
 *   error_rate            - total_failures / total_requests (0 when no requests)
 */
function getCredentialHealthForUser(userId) {
  // Join keys (providers with stored creds) LEFT JOIN health data
  const rows = db.prepare(`
    SELECT
      k.provider,
      h.last_success_at,
      h.last_failure_at,
      h.consecutive_failures,
      h.total_requests,
      h.total_failures
    FROM keys k
    LEFT JOIN credential_health h ON h.user_id = k.user_id AND h.provider = k.provider
    WHERE k.user_id = ?
    ORDER BY k.provider
  `).all(userId);

  return rows.map(r => {
    const totalReqs = r.total_requests || 0;
    const totalFails = r.total_failures || 0;
    const consec = r.consecutive_failures || 0;

    let status;
    if (totalReqs === 0) {
      status = 'unknown'; // no relay activity yet
    } else if (consec >= 3) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    return {
      provider: r.provider,
      status,
      last_success_at: r.last_success_at ? new Date(r.last_success_at).toISOString() : null,
      last_failure_at: r.last_failure_at ? new Date(r.last_failure_at).toISOString() : null,
      consecutive_failures: consec,
      total_requests: totalReqs,
      total_failures: totalFails,
      error_rate: totalReqs > 0 ? +(totalFails / totalReqs).toFixed(4) : 0,
    };
  });
}

/**
 * Return credential health aggregated by provider across all users of an app.
 * Operator-level view: no user_id is exposed; counts are aggregated.
 * Requires APP_SECRET — guarded at the route level.
 *
 * Returns per-provider:
 *   provider              - provider name
 *   user_count            - distinct users with stored keys for this provider
 *   users_with_activity   - users who have at least one relay request
 *   total_requests        - aggregate relay requests across all users
 *   total_failures        - aggregate failures
 *   error_rate            - aggregate error_rate
 *   users_degraded        - count of users with consecutive_failures >= 3
 */
function getCredentialHealthForApp(appId) {
  const rows = db.prepare(`
    SELECT
      k.provider,
      COUNT(DISTINCT k.user_id) AS user_count,
      COUNT(DISTINCT CASE WHEN h.total_requests > 0 THEN k.user_id END) AS users_with_activity,
      COALESCE(SUM(h.total_requests), 0) AS total_requests,
      COALESCE(SUM(h.total_failures), 0) AS total_failures,
      COUNT(DISTINCT CASE WHEN h.consecutive_failures >= 3 THEN k.user_id END) AS users_degraded
    FROM keys k
    JOIN users u ON u.id = k.user_id AND u.app_id = ?
    LEFT JOIN credential_health h ON h.user_id = k.user_id AND h.provider = k.provider
    GROUP BY k.provider
    ORDER BY k.provider
  `).all(appId);

  return rows.map(r => ({
    provider: r.provider,
    user_count: r.user_count,
    users_with_activity: r.users_with_activity,
    total_requests: r.total_requests,
    total_failures: r.total_failures,
    error_rate: r.total_requests > 0 ? +(r.total_failures / r.total_requests).toFixed(4) : 0,
    users_degraded: r.users_degraded,
  }));
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

/**
 * Lightweight DB connectivity probe for the /health endpoint.
 * Runs a fast read-only query against both tables and returns basic counts.
 * Throws if the database is inaccessible or corrupt.
 */
function dbHealthCheck() {
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const keyCount  = db.prepare('SELECT COUNT(*) AS n FROM keys').get().n;
  return { userCount, keyCount };
}

module.exports = {
  createUser,
  getUserByToken,
  revokeToken,
  deleteUser,
  getTokenHmacMigrationProgress,
  upsertKey,
  rotateKey,
  getDecryptedKey,
  deleteKey,
  listProviders,
  logRequest,
  getStatsForUser,
  getStatsForApp,
  updateCredentialHealth,
  getCredentialHealthForUser,
  getCredentialHealthForApp,
  dbHealthCheck,
};

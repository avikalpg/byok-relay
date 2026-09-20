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
    created_at INTEGER NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    estimated_cost_usd REAL,
    user_agent TEXT
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

  CREATE TABLE IF NOT EXISTS user_budgets (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    daily_limit_usd REAL,
    weekly_limit_usd REAL,
    monthly_limit_usd REAL,
    lifetime_limit_usd REAL,
    warn_threshold REAL NOT NULL DEFAULT 0.8,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_budgets (
    app_id TEXT PRIMARY KEY,
    daily_limit_usd REAL,
    weekly_limit_usd REAL,
    monthly_limit_usd REAL,
    lifetime_limit_usd REAL,
    warn_threshold REAL NOT NULL DEFAULT 0.8,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_policies (
    app_id TEXT PRIMARY KEY,
    allowed_providers TEXT,
    denied_providers  TEXT,
    allowed_models    TEXT,
    denied_models     TEXT,
    updated_at        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_policies (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    allowed_providers TEXT,
    denied_providers  TEXT,
    allowed_models    TEXT,
    denied_models     TEXT,
    updated_at        INTEGER NOT NULL
  );
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

// ── Migrations: add request-log metadata columns ─────────────────────────────
function _migrateAddCostTracking() {
  const cols = db.pragma('table_info(request_logs)').map(c => c.name);
  if (!cols.includes('input_tokens')) {
    db.exec('ALTER TABLE request_logs ADD COLUMN input_tokens INTEGER');
  }
  if (!cols.includes('output_tokens')) {
    db.exec('ALTER TABLE request_logs ADD COLUMN output_tokens INTEGER');
  }
  if (!cols.includes('estimated_cost_usd')) {
    db.exec('ALTER TABLE request_logs ADD COLUMN estimated_cost_usd REAL');
  }
}

function _migrateAddUserAgent() {
  const cols = db.pragma('table_info(request_logs)').map(c => c.name);
  if (!cols.includes('user_agent')) {
    db.exec('ALTER TABLE request_logs ADD COLUMN user_agent TEXT');
  }
}

_migrateAddCostTracking();
_migrateAddUserAgent();

// ── Migration: create user_budgets table on existing DBs ─────────────────────
function _migrateAddUserBudgets() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_budgets'").get();
  if (!tables) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_budgets (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        daily_limit_usd REAL,
        weekly_limit_usd REAL,
        monthly_limit_usd REAL,
        lifetime_limit_usd REAL,
        warn_threshold REAL NOT NULL DEFAULT 0.8,
        updated_at INTEGER NOT NULL
      );
    `);
  }
}

_migrateAddUserBudgets();

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
 * @param {number}  entry.status                         - HTTP status returned to client
 * @param {number}  entry.latency_ms                     - wall-clock ms for the upstream request
 * @param {number|null} [entry.input_tokens]             - prompt/input token count from provider
 * @param {number|null} [entry.output_tokens]            - completion/output token count from provider
 * @param {number|null} [entry.estimated_cost_usd]       - estimated USD cost (null when pricing unknown)
 * @param {string}  [entry.user_agent]                   - User-Agent header from the relay client
 */
function logRequest({ user_id, app_id, provider, model, status, latency_ms,
                      input_tokens = null, output_tokens = null, estimated_cost_usd = null,
                      user_agent = null }) {
  // Truncate user_agent to 512 chars to avoid unbounded storage.
  const ua = user_agent ? String(user_agent).slice(0, 512) : null;
  db.prepare(
    'INSERT INTO request_logs (id, user_id, app_id, provider, model, status, latency_ms, created_at, input_tokens, output_tokens, estimated_cost_usd, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(uuidv4(), user_id, app_id, provider, model || null, status, latency_ms, Date.now(),
        input_tokens, output_tokens, estimated_cost_usd, ua);
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
    `SELECT model,
            COUNT(*) AS total,
            SUM(COALESCE(input_tokens, 0))  AS input_tokens,
            SUM(COALESCE(output_tokens, 0)) AS output_tokens,
            SUM(estimated_cost_usd)          AS estimated_cost_usd
     FROM request_logs
     WHERE user_id = ? AND model IS NOT NULL
     GROUP BY model ORDER BY total DESC LIMIT 10`
  ).all(userId).map(r => ({
    model: r.model,
    total: r.total,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    estimated_cost_usd: r.estimated_cost_usd != null ? +r.estimated_cost_usd.toFixed(8) : null,
  }));

  const costRow = db.prepare(
    `SELECT SUM(COALESCE(input_tokens, 0))  AS input_tokens,
            SUM(COALESCE(output_tokens, 0)) AS output_tokens,
            SUM(estimated_cost_usd)          AS estimated_cost_usd
     FROM request_logs WHERE user_id = ?`
  ).get(userId);

  const topUserAgents = db.prepare(
    `SELECT user_agent, COUNT(*) AS total FROM request_logs
     WHERE user_id = ? AND user_agent IS NOT NULL
     GROUP BY user_agent ORDER BY total DESC LIMIT 10`
  ).all(userId).map(r => ({ user_agent: r.user_agent, total: r.total }));

  const lastRow = db.prepare('SELECT created_at FROM request_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId);

  return {
    total,
    last_7d:    last7d,
    last_30d:   last30d,
    error_count: errCount,
    error_rate: total > 0 ? +(errCount / total).toFixed(4) : 0,
    providers,
    top_models: topModels,
    total_input_tokens:  costRow.input_tokens  || 0,
    total_output_tokens: costRow.output_tokens || 0,
    estimated_cost_usd:  costRow.estimated_cost_usd != null ? +costRow.estimated_cost_usd.toFixed(8) : null,
    top_user_agents: topUserAgents,
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
    `SELECT model,
            COUNT(*) AS total,
            SUM(COALESCE(input_tokens, 0))  AS input_tokens,
            SUM(COALESCE(output_tokens, 0)) AS output_tokens,
            SUM(estimated_cost_usd)          AS estimated_cost_usd
     FROM request_logs
     WHERE app_id = ? AND model IS NOT NULL
     GROUP BY model ORDER BY total DESC LIMIT 10`
  ).all(appId).map(r => ({
    model: r.model,
    total: r.total,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    estimated_cost_usd: r.estimated_cost_usd != null ? +r.estimated_cost_usd.toFixed(8) : null,
  }));

  const costRow = db.prepare(
    `SELECT SUM(COALESCE(input_tokens, 0))  AS input_tokens,
            SUM(COALESCE(output_tokens, 0)) AS output_tokens,
            SUM(estimated_cost_usd)          AS estimated_cost_usd
     FROM request_logs WHERE app_id = ?`
  ).get(appId);

  const topUserAgents = db.prepare(
    `SELECT user_agent, COUNT(*) AS total FROM request_logs
     WHERE app_id = ? AND user_agent IS NOT NULL
     GROUP BY user_agent ORDER BY total DESC LIMIT 10`
  ).all(appId).map(r => ({ user_agent: r.user_agent, total: r.total }));

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
    total_input_tokens:  costRow.input_tokens  || 0,
    total_output_tokens: costRow.output_tokens || 0,
    estimated_cost_usd:  costRow.estimated_cost_usd != null ? +costRow.estimated_cost_usd.toFixed(8) : null,
    top_user_agents: topUserAgents,
  };
}

/**
 * Lightweight DB connectivity probe for the /health endpoint.
 * Runs a fast read-only query against both tables and returns basic counts.
 * Throws if the database is inaccessible or corrupt.
 */
// ── Budget management ──────────────────────────────────────────────────────

/**
 * Set or update budget limits for a user.
 * Pass null for any field to clear that limit.
 * @param {string} userId
 * @param {{ daily_limit_usd?, weekly_limit_usd?, monthly_limit_usd?, lifetime_limit_usd?, warn_threshold? }} opts
 */
function setBudget(userId, opts = {}) {
  const now = Date.now();
  const { daily_limit_usd = undefined, weekly_limit_usd = undefined,
          monthly_limit_usd = undefined, lifetime_limit_usd = undefined,
          warn_threshold = undefined } = opts;

  // Upsert: create or replace the row
  const existing = db.prepare('SELECT * FROM user_budgets WHERE user_id = ?').get(userId);
  if (!existing) {
    db.prepare(`
      INSERT INTO user_budgets (user_id, daily_limit_usd, weekly_limit_usd, monthly_limit_usd, lifetime_limit_usd, warn_threshold, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      daily_limit_usd !== undefined ? daily_limit_usd : null,
      weekly_limit_usd !== undefined ? weekly_limit_usd : null,
      monthly_limit_usd !== undefined ? monthly_limit_usd : null,
      lifetime_limit_usd !== undefined ? lifetime_limit_usd : null,
      warn_threshold !== undefined ? warn_threshold : 0.8,
      now,
    );
  } else {
    const updates = {};
    if (daily_limit_usd !== undefined)   updates.daily_limit_usd   = daily_limit_usd;
    if (weekly_limit_usd !== undefined)  updates.weekly_limit_usd  = weekly_limit_usd;
    if (monthly_limit_usd !== undefined) updates.monthly_limit_usd = monthly_limit_usd;
    if (lifetime_limit_usd !== undefined) updates.lifetime_limit_usd = lifetime_limit_usd;
    if (warn_threshold !== undefined)    updates.warn_threshold    = warn_threshold;
    updates.updated_at = now;

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), userId];
    db.prepare(`UPDATE user_budgets SET ${setClauses} WHERE user_id = ?`).run(...values);
  }

  return db.prepare('SELECT * FROM user_budgets WHERE user_id = ?').get(userId);
}

/**
 * Get budget limits for a user. Returns null if no budget is configured.
 * @param {string} userId
 * @returns {{ daily_limit_usd, weekly_limit_usd, monthly_limit_usd, lifetime_limit_usd, warn_threshold } | null}
 */
function getBudget(userId) {
  const row = db.prepare('SELECT * FROM user_budgets WHERE user_id = ?').get(userId);
  if (!row) return null;
  return {
    daily_limit_usd:    row.daily_limit_usd,
    weekly_limit_usd:   row.weekly_limit_usd,
    monthly_limit_usd:  row.monthly_limit_usd,
    lifetime_limit_usd: row.lifetime_limit_usd,
    warn_threshold:     row.warn_threshold,
    updated_at:         new Date(row.updated_at).toISOString(),
  };
}

/**
 * Check whether a user has exceeded any configured cost budget.
 * Returns { ok: true } if no limits are set or none are exceeded.
 * Returns { ok: false, reason, limit_type, limit_usd, used_usd, warn } if over or near limit.
 *
 * Note: only limits for windows where at least some pricing is known are enforced.
 * If estimated_cost_usd is null for every request in a window, that window is skipped.
 *
 * @param {string} userId
 * @returns {{ ok: boolean, reason?: string, limit_type?: string, limit_usd?: number, used_usd?: number, warn?: boolean }}
 */
function checkBudget(userId) {
  const budget = db.prepare('SELECT * FROM user_budgets WHERE user_id = ?').get(userId);
  if (!budget) return { ok: true };

  const now = Date.now();
  const msDay   = 24 * 60 * 60 * 1000;
  const msWeek  = 7  * msDay;
  const msMonth = 30 * msDay;

  const getUsed = (since) => {
    const row = db.prepare(
      `SELECT SUM(estimated_cost_usd) AS total FROM request_logs
       WHERE user_id = ? AND created_at >= ? AND status >= 200 AND status < 300 AND estimated_cost_usd IS NOT NULL`
    ).get(userId, since);
    return row.total || 0;
  };

  const getLifetimeUsed = () => {
    const row = db.prepare(
      `SELECT SUM(estimated_cost_usd) AS total FROM request_logs
       WHERE user_id = ? AND status >= 200 AND status < 300 AND estimated_cost_usd IS NOT NULL`
    ).get(userId);
    return row.total || 0;
  };

  const threshold = budget.warn_threshold != null ? budget.warn_threshold : 0.8;

  const checks = [
    { type: 'daily',    limit: budget.daily_limit_usd,    used: () => getUsed(now - msDay) },
    { type: 'weekly',   limit: budget.weekly_limit_usd,   used: () => getUsed(now - msWeek) },
    { type: 'monthly',  limit: budget.monthly_limit_usd,  used: () => getUsed(now - msMonth) },
    { type: 'lifetime', limit: budget.lifetime_limit_usd, used: () => getLifetimeUsed() },
  ];

  for (const { type, limit, used: getUsedFn } of checks) {
    if (limit == null) continue;
    const usedUsd = getUsedFn();
    if (usedUsd >= limit) {
      return {
        ok: false,
        warn: false,
        limit_type: type,
        limit_usd: limit,
        used_usd: +usedUsd.toFixed(8),
        reason: `${type} cost budget exceeded: $${usedUsd.toFixed(6)} used of $${limit.toFixed(6)} limit`,
      };
    }
    if (threshold > 0 && usedUsd >= limit * threshold) {
      return {
        ok: true,
        warn: true,
        limit_type: type,
        limit_usd: limit,
        used_usd: +usedUsd.toFixed(8),
        reason: `${type} cost budget warning: $${usedUsd.toFixed(6)} used of $${limit.toFixed(6)} limit (${Math.round(threshold * 100)}% threshold)`,
      };
    }
  }

  return { ok: true };
}

/**
 * Delete all budget limits for a user.
 * @param {string} userId
 */
function deleteBudget(userId) {
  db.prepare('DELETE FROM user_budgets WHERE user_id = ?').run(userId);
}

// ── Migration: create app_budgets table on existing DBs ───────────────────────
function _migrateAddAppBudgets() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_budgets'").get();
  if (!tables) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_budgets (
        app_id TEXT PRIMARY KEY,
        daily_limit_usd REAL,
        weekly_limit_usd REAL,
        monthly_limit_usd REAL,
        lifetime_limit_usd REAL,
        warn_threshold REAL NOT NULL DEFAULT 0.8,
        reserved_usd REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
  }
}

_migrateAddAppBudgets();

// ── Migration: add reserved_usd column to existing app_budgets tables ─────────
(function _migrateAppBudgetsReservedUsd() {
  const cols = db.pragma('table_info(app_budgets)').map(c => c.name);
  if (!cols.includes('reserved_usd')) {
    db.exec('ALTER TABLE app_budgets ADD COLUMN reserved_usd REAL NOT NULL DEFAULT 0');
  }
}());

// ── App-level budget management ───────────────────────────────────────────────

/**
 * Set or update budget limits for an app_id (all users sharing that app).
 * @param {string} appId
 * @param {object} opts - { daily_limit_usd, weekly_limit_usd, monthly_limit_usd,
 *                          lifetime_limit_usd, warn_threshold }
 */
function setAppBudget(appId, opts = {}) {
  const now = Date.now();
  const existing = db.prepare('SELECT * FROM app_budgets WHERE app_id = ?').get(appId);
  if (!existing) {
    db.prepare(
      'INSERT INTO app_budgets (app_id, daily_limit_usd, weekly_limit_usd, monthly_limit_usd, lifetime_limit_usd, warn_threshold, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      appId,
      opts.daily_limit_usd   != null ? opts.daily_limit_usd   : null,
      opts.weekly_limit_usd  != null ? opts.weekly_limit_usd  : null,
      opts.monthly_limit_usd != null ? opts.monthly_limit_usd : null,
      opts.lifetime_limit_usd != null ? opts.lifetime_limit_usd : null,
      opts.warn_threshold    != null ? opts.warn_threshold    : 0.8,
      now
    );
  } else {
    const setClauses = [];
    const values = [];
    const fields = ['daily_limit_usd', 'weekly_limit_usd', 'monthly_limit_usd', 'lifetime_limit_usd', 'warn_threshold'];
    for (const f of fields) {
      if (opts[f] !== undefined) {
        setClauses.push(`${f} = ?`);
        values.push(opts[f]);
      }
    }
    if (setClauses.length > 0) {
      setClauses.push('updated_at = ?');
      values.push(now);
      values.push(appId);
      db.prepare(`UPDATE app_budgets SET ${setClauses} WHERE app_id = ?`).run(...values);
    }
  }
  return db.prepare('SELECT * FROM app_budgets WHERE app_id = ?').get(appId);
}

/**
 * Get budget limits for an app_id. Returns null if no budget is configured.
 * @param {string} appId
 */
function getAppBudget(appId) {
  const row = db.prepare('SELECT * FROM app_budgets WHERE app_id = ?').get(appId);
  if (!row) return null;
  return {
    daily_limit_usd:    row.daily_limit_usd,
    weekly_limit_usd:   row.weekly_limit_usd,
    monthly_limit_usd:  row.monthly_limit_usd,
    lifetime_limit_usd: row.lifetime_limit_usd,
    warn_threshold:     row.warn_threshold,
    updated_at:         row.updated_at,
  };
}

/**
 * Check whether an app_id has exceeded any configured cost budget.
 * Aggregates estimated_cost_usd across ALL users for the given app_id.
 * @param {string} appId
 * @returns {{ ok: boolean, warn?: boolean, reason?: string, limit_type?: string, limit_usd?: number, used_usd?: number }}
 */
function checkAppBudget(appId) {
  const budget = db.prepare('SELECT * FROM app_budgets WHERE app_id = ?').get(appId);
  if (!budget) return { ok: true };

  const now = Date.now();
  const msDay   = 86400000;
  const msWeek  = 7 * msDay;
  const msMonth = 30 * msDay;

  function getUsed(sinceMs) {
    const row = db.prepare(
      'SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total FROM request_logs WHERE app_id = ? AND created_at >= ? AND status >= 200 AND status < 300'
    ).get(appId, sinceMs);
    return row ? row.total : 0;
  }
  function getLifetimeUsed() {
    const row = db.prepare(
      'SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total FROM request_logs WHERE app_id = ? AND status >= 200 AND status < 300'
    ).get(appId);
    return row ? row.total : 0;
  }

  const checks = [
    { type: 'daily',    limit: budget.daily_limit_usd,    used: () => getUsed(now - msDay) },
    { type: 'weekly',   limit: budget.weekly_limit_usd,   used: () => getUsed(now - msWeek) },
    { type: 'monthly',  limit: budget.monthly_limit_usd,  used: () => getUsed(now - msMonth) },
    { type: 'lifetime', limit: budget.lifetime_limit_usd, used: () => getLifetimeUsed() },
  ];

  const threshold = budget.warn_threshold != null ? budget.warn_threshold : 0.8;
  let warnResult = null;

  for (const { type, limit, used } of checks) {
    if (limit == null) continue;
    const usedUsd = used();
    if (usedUsd >= limit) {
      return {
        ok: false,
        reason: `app ${type} cost budget exceeded: $${usedUsd.toFixed(6)} used of $${limit.toFixed(6)} limit`,
        limit_type: type,
        limit_usd: limit,
        used_usd: usedUsd,
      };
    }
    if (threshold > 0 && !warnResult && usedUsd >= limit * threshold) {
      warnResult = {
        warn: true,
        reason: `app ${type} cost budget warning: $${usedUsd.toFixed(6)} used of $${limit.toFixed(6)} limit (${Math.round(threshold * 100)}% threshold)`,
        limit_type: type,
        limit_usd: limit,
        used_usd: usedUsd,
      };
    }
  }

  if (warnResult) return { ok: true, ...warnResult };
  return { ok: true };
}

/**
 * Atomically check the app budget (including in-flight reservations) and, if
 * within limits, reserve capacity for one request.
 *
 * Because better-sqlite3 statements are synchronous, the check and the
 * reservation increment execute in the same event-loop tick with no yield
 * point between them.  Concurrent async requests therefore cannot all read
 * the same stale usage total: each one that passes the check increments
 * `reserved_usd` before the next one runs, so the next request sees a higher
 * effective usage and may correctly be rejected.
 *
 * Call `releaseAppBudgetReservation(appId)` exactly once after the upstream
 * response completes (or the request fails) to decrement `reserved_usd`.
 *
 * @param {string} appId
 * @returns {{ ok: boolean, reserved: boolean, warn?: boolean, reason?: string,
 *             limit_type?: string, limit_usd?: number, used_usd?: number }}
 */
const APP_BUDGET_RESERVATION_USD = parseFloat(process.env.APP_BUDGET_RESERVATION_USD || '0.01');

function checkAndReserveAppBudget(appId) {
  const budget = db.prepare('SELECT * FROM app_budgets WHERE app_id = ?').get(appId);
  if (!budget) return { ok: true, reserved: false };

  const now = Date.now();
  const msDay   = 86400000;
  const msWeek  = 7 * msDay;
  const msMonth = 30 * msDay;

  // Include already-reserved in-flight cost so concurrent requests see the
  // most up-to-date effective usage before any of them has been logged.
  const reservedUsd = budget.reserved_usd || 0;

  function getUsed(sinceMs) {
    const row = db.prepare(
      'SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total FROM request_logs WHERE app_id = ? AND created_at >= ? AND status >= 200 AND status < 300'
    ).get(appId, sinceMs);
    return (row ? row.total : 0) + reservedUsd;
  }
  function getLifetimeUsed() {
    const row = db.prepare(
      'SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total FROM request_logs WHERE app_id = ? AND status >= 200 AND status < 300'
    ).get(appId);
    return (row ? row.total : 0) + reservedUsd;
  }

  const checks = [
    { type: 'daily',    limit: budget.daily_limit_usd,    used: () => getUsed(now - msDay) },
    { type: 'weekly',   limit: budget.weekly_limit_usd,   used: () => getUsed(now - msWeek) },
    { type: 'monthly',  limit: budget.monthly_limit_usd,  used: () => getUsed(now - msMonth) },
    { type: 'lifetime', limit: budget.lifetime_limit_usd, used: () => getLifetimeUsed() },
  ];

  const threshold = budget.warn_threshold != null ? budget.warn_threshold : 0.8;
  let warnResult = null;

  for (const { type, limit, used } of checks) {
    if (limit == null) continue;
    const usedUsd = used();
    if (usedUsd >= limit) {
      return {
        ok: false,
        reserved: false,
        reason: `app ${type} cost budget exceeded: $${usedUsd.toFixed(6)} used of $${limit.toFixed(6)} limit`,
        limit_type: type,
        limit_usd: limit,
        used_usd: usedUsd,
      };
    }
    if (threshold > 0 && !warnResult && usedUsd >= limit * threshold) {
      warnResult = {
        warn: true,
        reason: `app ${type} cost budget warning: $${usedUsd.toFixed(6)} used of $${limit.toFixed(6)} limit (${Math.round(threshold * 100)}% threshold)`,
        limit_type: type,
        limit_usd: limit,
        used_usd: usedUsd,
      };
    }
  }

  // Atomically reserve capacity.  This UPDATE executes synchronously (no
  // event-loop yield) so no concurrent request can slip through between the
  // check above and the increment here.
  db.prepare('UPDATE app_budgets SET reserved_usd = reserved_usd + ? WHERE app_id = ?')
    .run(APP_BUDGET_RESERVATION_USD, appId);

  if (warnResult) return { ok: true, reserved: true, ...warnResult };
  return { ok: true, reserved: true };
}

/**
 * Release a reservation previously made by `checkAndReserveAppBudget`.
 * Must be called exactly once per successful reservation, regardless of
 * whether the upstream request succeeded or failed.
 *
 * @param {string} appId
 */
function releaseAppBudgetReservation(appId) {
  if (!appId) return;
  try {
    // MAX(0, ...) guards against floating-point drift producing a negative value.
    db.prepare(
      'UPDATE app_budgets SET reserved_usd = MAX(0, reserved_usd - ?) WHERE app_id = ?'
    ).run(APP_BUDGET_RESERVATION_USD, appId);
  } catch (_err) {
    // Non-fatal: a stale reservation self-corrects via MAX(0, ...) on the next
    // release call, and resets to the DEFAULT 0 if the process restarts.
  }
}

/**
 * Delete all budget limits for an app_id.
 * @param {string} appId
 */
function deleteAppBudget(appId) {
  db.prepare('DELETE FROM app_budgets WHERE app_id = ?').run(appId);
}

// ── Migration: add policy tables to existing DBs ──────────────────────────────
(function _migrateAddPolicyTables() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  if (!tables.includes('app_policies')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_policies (
        app_id TEXT PRIMARY KEY,
        allowed_providers TEXT,
        denied_providers  TEXT,
        allowed_models    TEXT,
        denied_models     TEXT,
        max_completion_tokens INTEGER,
        max_request_bytes     INTEGER,
        updated_at        INTEGER NOT NULL
      );
    `);
  }
  if (!tables.includes('user_policies')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_policies (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        allowed_providers TEXT,
        denied_providers  TEXT,
        allowed_models    TEXT,
        denied_models     TEXT,
        max_completion_tokens INTEGER,
        max_request_bytes     INTEGER,
        updated_at        INTEGER NOT NULL
      );
    `);
  }
}());

// ── Migration: add max_completion_tokens + max_request_bytes to existing policy tables ──
(function _migratePolicyTokenSizeLimits() {
  for (const table of ['app_policies', 'user_policies']) {
    const cols = db.pragma(`table_info(${table})`).map(c => c.name);
    if (!cols.includes('max_completion_tokens')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN max_completion_tokens INTEGER`);
    }
    if (!cols.includes('max_request_bytes')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN max_request_bytes INTEGER`);
    }
  }
}());

// ── Policy management ─────────────────────────────────────────────────────────

/**
 * Parse a JSON array stored as TEXT; returns null if the column is NULL.
 * @param {string|null} raw
 * @returns {string[]|null}
 */
function _parseList(raw) {
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Validate and normalise a list field from user input.
 * Accepts null (clear) or a non-empty string array.
 * Returns { ok, error, value } where value is JSON string or null.
 */
function _validateList(name, input) {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (!Array.isArray(input)) return { ok: false, error: `${name} must be an array of strings or null` };
  for (const item of input) {
    if (typeof item !== 'string' || !item.trim()) {
      return { ok: false, error: `Each entry in ${name} must be a non-empty string` };
    }
  }
  return { ok: true, value: JSON.stringify(input.map(s => s.trim().toLowerCase())) };
}

/**
 * Check whether a (provider, model) pair is permitted by a policy row.
 * A NULL list means "no restriction on that dimension".
 * allowed list: must be in the list (if set)
 * denied list:  must NOT be in the list (if set)
 * Denied takes precedence over allowed.
 *
 * @param {object|null} policy - DB row with provider/model lists and size/token limits
 * @param {string} provider
 * @param {string|null} model - bare model name (no provider prefix)
 * @param {{ requestBytes?: number, requestedMaxTokens?: number }} [ctx] - optional request context
 * @returns {{ ok: boolean, reason?: string, reason_code?: string }}
 */
function _evalPolicy(policy, provider, model, ctx = {}) {
  if (!policy) return { ok: true };

  const prov = (provider || '').toLowerCase();
  const mod  = (model  || '').toLowerCase();

  const deniedProviders  = _parseList(policy.denied_providers);
  const allowedProviders = _parseList(policy.allowed_providers);
  const deniedModels     = _parseList(policy.denied_models);
  const allowedModels    = _parseList(policy.allowed_models);

  if (deniedProviders && deniedProviders.includes(prov)) {
    return { ok: false, reason: `Provider "${provider}" is denied by policy.`, reason_code: 'policy_denied_provider' };
  }
  if (allowedProviders && !allowedProviders.includes(prov)) {
    return { ok: false, reason: `Provider "${provider}" is not in the allowed provider list.`, reason_code: 'policy_denied_provider' };
  }
  const modelMatches = (entry) =>
    mod === entry ||
    mod.endsWith('/' + entry) ||
    `${prov}/${mod}` === entry;

  if (mod && deniedModels && deniedModels.some(modelMatches)) {
    return { ok: false, reason: `Model "${model}" is denied by policy.`, reason_code: 'policy_denied_model' };
  }
  if (mod && allowedModels && !allowedModels.some(modelMatches)) {
    return { ok: false, reason: `Model "${model}" is not in the allowed model list.`, reason_code: 'policy_denied_model' };
  }

  // ── Size / token limits ───────────────────────────────────────────────────
  if (policy.max_request_bytes != null && ctx.requestBytes != null) {
    if (ctx.requestBytes > policy.max_request_bytes) {
      return {
        ok: false,
        reason: `Request body (${ctx.requestBytes} bytes) exceeds the policy limit of ${policy.max_request_bytes} bytes.`,
        reason_code: 'policy_request_too_large',
        limit: policy.max_request_bytes,
        actual: ctx.requestBytes,
      };
    }
  }
  if (policy.max_completion_tokens != null && ctx.requestedMaxTokens != null) {
    if (ctx.requestedMaxTokens > policy.max_completion_tokens) {
      return {
        ok: false,
        reason: `Requested max_tokens (${ctx.requestedMaxTokens}) exceeds the policy limit of ${policy.max_completion_tokens}.`,
        reason_code: 'policy_max_tokens_exceeded',
        limit: policy.max_completion_tokens,
        actual: ctx.requestedMaxTokens,
      };
    }
  }

  return { ok: true };
}

// ── App-level policy ──────────────────────────────────────────────────────────

/**
 * Set or replace the provider/model policy for an app_id.
 * Pass null for any list field to remove that restriction.
 * @param {string} appId
 * @param {{ allowed_providers?, denied_providers?, allowed_models?, denied_models? }} opts
 * @returns {{ app_id, allowed_providers, denied_providers, allowed_models, denied_models, updated_at }|Error}
 */
function setAppPolicy(appId, opts = {}) {
  const listFields = ['allowed_providers', 'denied_providers', 'allowed_models', 'denied_models'];
  const values = {};
  for (const f of listFields) {
    const v = _validateList(f, opts[f]);
    if (!v.ok) throw new Error(v.error);
    values[f] = v.value;
  }
  // Validate integer limit fields.
  for (const f of ['max_completion_tokens', 'max_request_bytes']) {
    const val = opts[f];
    if (val !== undefined && val !== null) {
      if (!Number.isInteger(val) || val <= 0) throw new Error(`${f} must be a positive integer or null`);
      values[f] = val;
    } else {
      values[f] = null;
    }
  }
  const now = Date.now();
  db.prepare(`
    INSERT INTO app_policies (app_id, allowed_providers, denied_providers, allowed_models, denied_models, max_completion_tokens, max_request_bytes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(app_id) DO UPDATE SET
      allowed_providers    = excluded.allowed_providers,
      denied_providers     = excluded.denied_providers,
      allowed_models       = excluded.allowed_models,
      denied_models        = excluded.denied_models,
      max_completion_tokens = excluded.max_completion_tokens,
      max_request_bytes    = excluded.max_request_bytes,
      updated_at           = excluded.updated_at
  `).run(appId, values.allowed_providers, values.denied_providers, values.allowed_models, values.denied_models,
         values.max_completion_tokens, values.max_request_bytes, now);
  return _formatPolicy(db.prepare('SELECT * FROM app_policies WHERE app_id = ?').get(appId));
}

function _formatPolicy(row) {
  if (!row) return null;
  return {
    allowed_providers:    _parseList(row.allowed_providers),
    denied_providers:     _parseList(row.denied_providers),
    allowed_models:       _parseList(row.allowed_models),
    denied_models:        _parseList(row.denied_models),
    max_completion_tokens: row.max_completion_tokens ?? null,
    max_request_bytes:    row.max_request_bytes ?? null,
    updated_at:           row.updated_at,
  };
}

/**
 * Get the policy for an app_id. Returns null if none is set.
 */
function getAppPolicy(appId) {
  return _formatPolicy(db.prepare('SELECT * FROM app_policies WHERE app_id = ?').get(appId));
}

/**
 * Check whether a (provider, model) pair is permitted by the app policy.
 * @param {string} appId
 * @param {string} provider
 * @param {string|null} model
 * @param {{ requestBytes?: number, requestedMaxTokens?: number }} [ctx]
 */
function checkAppPolicy(appId, provider, model, ctx = {}) {
  const policy = db.prepare('SELECT * FROM app_policies WHERE app_id = ?').get(appId);
  return _evalPolicy(policy, provider, model, ctx);
}

/**
 * Delete the policy for an app_id.
 */
function deleteAppPolicy(appId) {
  db.prepare('DELETE FROM app_policies WHERE app_id = ?').run(appId);
}

// ── User-level policy ─────────────────────────────────────────────────────────

/**
 * Set or replace the provider/model policy for a user.
 */
function setUserPolicy(userId, opts = {}) {
  const listFields = ['allowed_providers', 'denied_providers', 'allowed_models', 'denied_models'];
  const values = {};
  for (const f of listFields) {
    const v = _validateList(f, opts[f]);
    if (!v.ok) throw new Error(v.error);
    values[f] = v.value;
  }
  for (const f of ['max_completion_tokens', 'max_request_bytes']) {
    const val = opts[f];
    if (val !== undefined && val !== null) {
      if (!Number.isInteger(val) || val <= 0) throw new Error(`${f} must be a positive integer or null`);
      values[f] = val;
    } else {
      values[f] = null;
    }
  }
  const now = Date.now();
  db.prepare(`
    INSERT INTO user_policies (user_id, allowed_providers, denied_providers, allowed_models, denied_models, max_completion_tokens, max_request_bytes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      allowed_providers    = excluded.allowed_providers,
      denied_providers     = excluded.denied_providers,
      allowed_models       = excluded.allowed_models,
      denied_models        = excluded.denied_models,
      max_completion_tokens = excluded.max_completion_tokens,
      max_request_bytes    = excluded.max_request_bytes,
      updated_at           = excluded.updated_at
  `).run(userId, values.allowed_providers, values.denied_providers, values.allowed_models, values.denied_models,
         values.max_completion_tokens, values.max_request_bytes, now);
  return _formatPolicy(db.prepare('SELECT * FROM user_policies WHERE user_id = ?').get(userId));
}

/**
 * Get the policy for a user. Returns null if none is set.
 */
function getUserPolicy(userId) {
  return _formatPolicy(db.prepare('SELECT * FROM user_policies WHERE user_id = ?').get(userId));
}

/**
 * Check whether a (provider, model) pair is permitted by the user policy.
 * @param {string} userId
 * @param {string} provider
 * @param {string|null} model
 * @param {{ requestBytes?: number, requestedMaxTokens?: number }} [ctx]
 */
function checkUserPolicy(userId, provider, model, ctx = {}) {
  const policy = db.prepare('SELECT * FROM user_policies WHERE user_id = ?').get(userId);
  return _evalPolicy(policy, provider, model, ctx);
}

/**
 * Delete the policy for a user.
 */
function deleteUserPolicy(userId) {
  db.prepare('DELETE FROM user_policies WHERE user_id = ?').run(userId);
}

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
  setBudget,
  getBudget,
  checkBudget,
  deleteBudget,
  setAppBudget,
  getAppBudget,
  checkAppBudget,
  checkAndReserveAppBudget,
  releaseAppBudgetReservation,
  deleteAppBudget,
  setAppPolicy,
  getAppPolicy,
  checkAppPolicy,
  deleteAppPolicy,
  setUserPolicy,
  getUserPolicy,
  checkUserPolicy,
  deleteUserPolicy,
};

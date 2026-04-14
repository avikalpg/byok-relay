/**
 * SQLite database layer.
 * Schema:
 *   users(id TEXT PK, token TEXT UNIQUE, created_at INTEGER)
 *   keys(id TEXT PK, user_id TEXT FK, provider TEXT, encrypted_key TEXT, created_at INTEGER)
 *
 * Keys are encrypted with AES-256-GCM using ENCRYPTION_SECRET from env.
 */
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'relay.db');

// Ensure data directory exists
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
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

  CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);
  CREATE INDEX IF NOT EXISTS idx_keys_user_provider ON keys(user_id, provider);
`);

// ── Encryption helpers ──────────────────────────────────────────────────────

function getEncryptionKey() {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error('ENCRYPTION_SECRET env var is required');
  // Derive a 32-byte key from the secret
  return crypto.scryptSync(secret, 'byok-relay-salt', 32);
}

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

// ── User helpers ────────────────────────────────────────────────────────────

function createUser(appId) {
  const { v4: uuidv4 } = require('uuid');
  const id = uuidv4();
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO users (id, token, app_id, created_at) VALUES (?, ?, ?, ?)').run(id, token, appId, now);
  return { id, token };
}

function getUserByToken(token) {
  return db.prepare('SELECT * FROM users WHERE token = ?').get(token);
}

// ── Key helpers ─────────────────────────────────────────────────────────────

function upsertKey(userId, provider, plaintextKey) {
  const { v4: uuidv4 } = require('uuid');
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
  return db.prepare('SELECT provider, created_at FROM keys WHERE user_id = ?').all(userId).map(r => r.provider);
}

module.exports = { createUser, getUserByToken, upsertKey, getDecryptedKey, deleteKey, listProviders };

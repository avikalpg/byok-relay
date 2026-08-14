'use strict';

/**
 * rate-limit-store.js
 *
 * Returns an express-rate-limit store appropriate for the current environment:
 *   - REDIS_URL set  → Redis-backed (safe across Vercel cold-starts + multi-process)
 *   - REDIS_URL unset → in-memory default (fine for single-process self-hosted)
 *
 * Usage:
 *   const makeStore = require('./rate-limit-store');
 *   rateLimit({ ..., store: makeStore('global') });
 *
 * Each limiter must get its own store instance (different prefix) so window
 * counters don't bleed across limiters.
 */

const Redis = require('ioredis');
const { RedisStore } = require('rate-limit-redis');

let _client = null;

/**
 * Lazily create a single shared ioredis client for the process lifetime.
 * Returns null if REDIS_URL is not configured.
 */
function getRedisClient() {
  if (_client) return _client;
  const url = process.env.REDIS_URL;
  if (!url) return null;

  let client;
  try {
    client = new Redis(url, {
      // Bound connection attempts and command retries while continuing to reconnect.
      enableReadyCheck: true,
      connectTimeout: 2000,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 250, 1000),
      lazyConnect: false,
    });
  } catch (err) {
    const detail = err && (err.stack || err.message) ? (err.stack || err.message) : err;
    console.error('[rate-limit-redis] Redis client creation failed:', detail);
    _client = null;
    return null;
  }

  _client = client;

  _client.on('error', (err) => {
    console.error('[rate-limit-redis] Redis connection error:', err.message);
  });

  _client.on('ready', () => {
    console.log('[rate-limit-redis] Redis connected — rate limits are now multi-process safe.');
  });

  return _client;
}

/**
 * makeStore(prefix)
 *
 * @param {string} prefix - short label, e.g. 'global', 'relay', 'reg'
 * @returns {import('express-rate-limit').Store | undefined}
 *   Returns a RedisStore when REDIS_URL is set, undefined otherwise
 *   (undefined → express-rate-limit uses its default in-memory store).
 */
function makeStore(prefix) {
  const client = getRedisClient();
  if (!client) return undefined; // fall back to in-memory

  return new RedisStore({
    sendCommand: (...args) => client.call(...args),
    prefix: `rl:${prefix}:`,
  });
}

module.exports = { makeStore, getRedisClient };

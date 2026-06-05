require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createUser, getUserByToken, revokeToken, deleteUser, upsertKey, getDecryptedKey, deleteKey, listProviders } = require('./db');
const { forwardRequest, SUPPORTED_PROVIDERS, validateProviderKeyFormat } = require('./providers');

// ── Startup validation ──────────────────────────────────────────────────────
if (!process.env.ENCRYPTION_SECRET) {
  console.error('ERROR: ENCRYPTION_SECRET env var is not set.');
  console.error('Generate one with: openssl rand -hex 32');
  console.error('Then add it to your .env file or environment.');
  process.exit(1);
}
if (process.env.ENCRYPTION_SECRET.length < 32) {
  console.error('ERROR: ENCRYPTION_SECRET must be at least 32 characters.');
  process.exit(1);
}
if (process.env.APP_SECRET && process.env.APP_SECRET.includes(' ')) {
  console.error('ERROR: APP_SECRET must not contain spaces. Generate a safe value with: openssl rand -hex 32');
  process.exit(1);
}
if (!process.env.APP_SECRET) {
  console.warn('WARNING: APP_SECRET is not set. POST /users is open — anyone can register.');
  console.warn('Set APP_SECRET to restrict registration to authorised callers only.');
  console.warn('Generate one with: openssl rand -hex 32');
}
if (process.env.TOKEN_HMAC_SECRET && process.env.TOKEN_HMAC_SECRET.length < 32) {
  console.error('ERROR: TOKEN_HMAC_SECRET must be at least 32 characters.');
  process.exit(1);
}
if (!process.env.TOKEN_HMAC_SECRET) {
  console.warn('WARNING: TOKEN_HMAC_SECRET is not set. Falling back to ENCRYPTION_SECRET for token hashing.');
  console.warn('Set TOKEN_HMAC_SECRET to use a dedicated key per best practice.');
  console.warn('Generate one with: openssl rand -hex 32');
}

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim());

// ── Middleware ──────────────────────────────────────────────────────────────

app.use(cors({
  origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-relay-token', 'anthropic-version', 'x-relay-base-url', 'x-relay-referer', 'x-title', 'http-referer'],
  credentials: false,
}));

app.use(express.json({ limit: '1mb' }));

// Global rate limit: 100 requests per minute per IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use(globalLimiter);

// Relay rate limit: 20 AI requests per minute per token
const relayLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.headers['x-relay-token'] || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI request rate limit exceeded (20/min).' },
});

// Registration rate limit: 10 new users per hour per IP (prevents DB spam)
const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registrations from this IP, please try again later.' },
});

// ── Auth middleware ─────────────────────────────────────────────────────────

/**
 * requireAppSecret — guards POST /users when APP_SECRET is configured.
 * If APP_SECRET env var is set, the caller must supply:
 *   Authorization: Bearer <APP_SECRET>
 * If APP_SECRET is not set, the route is open (dev/single-user mode).
 */
function requireAppSecret(req, res, next) {
  const appSecret = process.env.APP_SECRET;
  if (!appSecret) return next(); // open registration — operator has been warned at startup

  const authHeader = req.headers['authorization'] || '';
  const [scheme, token] = authHeader.split(' ');

  const validScheme = scheme === 'Bearer';
  const validToken =
    token &&
    token.length === appSecret.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(appSecret));

  if (!validScheme || !validToken) {
    return res.status(401).json({
      error: 'Unauthorized: valid Authorization: Bearer <APP_SECRET> header required to register.',
    });
  }
  next();
}

function requireToken(req, res, next) {
  const token = req.headers['x-relay-token'];
  if (!token) return res.status(401).json({ error: 'x-relay-token header required' });
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = user;
  next();
}

// ── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  const { version } = require('../package.json');
  res.json({ ok: true, version, providers: SUPPORTED_PROVIDERS });
});

/**
 * POST /users
 * Register a new user for an app and get back a relay token.
 * Body: { app_id: string }
 * Returns: { token: string }
 *
 * The token is stored in the user's browser (localStorage).
 * It never contains the API key — the API key is stored server-side.
 */
app.post('/users', requireAppSecret, registrationLimiter, (req, res) => {
  const { app_id } = req.body;
  if (!app_id) return res.status(400).json({ error: 'app_id is required' });
  const { token, expires_at } = createUser(app_id);
  res.json({ token, expires_at });
});

/**
 * POST /keys/:provider
 * Store (or update) a user's API key for a provider.
 * Headers: x-relay-token
 * Body: { key: string }
 */
app.post('/keys/:provider', requireToken, (req, res) => {
  const { provider } = req.params;
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `Unsupported provider. Supported: ${SUPPORTED_PROVIDERS.join(', ')}` });
  }
  const { key } = req.body;
  if (!key || typeof key !== 'string' || key.trim().length < 10) {
    return res.status(400).json({ error: 'A valid API key is required (minimum 10 characters)' });
  }
  const trimmedKey = key.trim();
  const formatCheck = validateProviderKeyFormat(provider, trimmedKey);
  if (!formatCheck.valid) {
    return res.status(400).json({
      error: `API key format looks wrong for provider "${provider}". ${formatCheck.hint}. Double-check the key and try again.`,
    });
  }
  upsertKey(req.user.id, provider, trimmedKey);
  res.json({ ok: true, provider });
});

/**
 * POST /tokens/revoke
 * Immediately invalidate the current relay token.
 * All stored keys remain in the database but become inaccessible — the token
 * will return 401 on every subsequent request.  To fully erase the account
 * (keys included), use DELETE /users.
 * Headers: x-relay-token
 */
app.post('/tokens/revoke', requireToken, (req, res) => {
  revokeToken(req.user.id);
  res.json({
    ok: true,
    message: 'Token revoked. Stored keys remain but are no longer accessible. ' +
             'Register a new token (POST /users) to re-enter your keys.',
  });
});

/**
 * DELETE /users
 * Delete the current user account and ALL associated API keys.
 * Satisfies GDPR Art. 17 (right to erasure).  This action is irreversible.
 * Headers: x-relay-token
 */
app.delete('/users', requireToken, (req, res) => {
  deleteUser(req.user.id);
  res.json({ ok: true, message: 'Account and all stored keys deleted.' });
});

/**
 * DELETE /keys/:provider
 * Remove a stored key.
 * Headers: x-relay-token
 */
app.delete('/keys/:provider', requireToken, (req, res) => {
  deleteKey(req.user.id, req.params.provider);
  res.json({ ok: true });
});

/**
 * GET /keys
 * List which providers have a stored key (key values are never returned).
 * Headers: x-relay-token
 */
app.get('/keys', requireToken, (req, res) => {
  const providers = listProviders(req.user.id);
  res.json({ providers });
});

/**
 * POST /relay/:provider/*
 * Forward a request to the AI provider using the user's stored API key.
 * Headers: x-relay-token
 * Body: provider-specific request body (e.g. Anthropic Messages API body)
 *
 * Supports streaming: if the request body has stream: true, the response
 * is piped directly back to the client as SSE.
 */
app.post('/relay/:provider/*', requireToken, relayLimiter, async (req, res) => {
  const { provider } = req.params;
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `Unsupported provider: ${provider}` });
  }

  const apiKey = getDecryptedKey(req.user.id, provider);
  if (!apiKey) {
    return res.status(400).json({
      error: `No API key stored for provider "${provider}". POST /keys/${provider} first.`,
    });
  }

  // Build the path to forward (everything after /relay/:provider)
  const forwardPath = '/' + (req.params[0] || '');

  // Pass through provider-specific and relay headers
  const extraHeaders = {};
  const passthroughHeaders = [
    'anthropic-version', 'x-relay-base-url', 'x-relay-referer', 'x-title',
    'http-referer',
  ];
  for (const h of passthroughHeaders) {
    if (req.headers[h]) extraHeaders[h] = req.headers[h];
  }

  try {
    const providerResponse = await forwardRequest(
      provider,
      forwardPath,
      req.method,
      req.body,
      apiKey,
      extraHeaders,
    );

    // Forward status and relevant headers
    res.status(providerResponse.status);
    const contentType = providerResponse.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);

    const isStream = req.body?.stream === true ||
      (contentType && contentType.includes('text/event-stream'));

    if (isStream) {
      // Pipe the SSE stream directly to the client
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      providerResponse.body.pipe(res);
    } else {
      const data = await providerResponse.json();
      res.json(data);
    }
  } catch (err) {
    // SSRF / input validation errors are client mistakes — return 400.
    // All other relay failures return 502 with a generic message so we don't
    // leak internal hostnames, IPs, or stack traces to the client.
    if (err.code === 'INVALID_RELAY_BASE_URL') {
      return res.status(400).json({ error: err.message });
    }
    console.error('Relay error:', err);
    res.status(502).json({ error: 'Failed to reach AI provider' });
  }
});

// ── Start ───────────────────────────────────────────────────────────────────
// When run directly (node src/index.js or npm start), start the HTTP server.
// When imported by Vercel's @vercel/node runtime, export the app instead.
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`byok-relay listening on port ${PORT}`);
    console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
    console.log(`Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}`);
  });
}

module.exports = app;

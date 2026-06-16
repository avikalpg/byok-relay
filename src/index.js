require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createUser, getUserByToken, upsertKey, getDecryptedKey, deleteKey, listProviders } = require('./db');
const { forwardRequest, SUPPORTED_PROVIDERS } = require('./providers');

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

// ── Model allowlist ─────────────────────────────────────────────────────────
// Parse ALLOWED_MODELS at startup. Supports exact names and glob-style
// wildcards using '*' (e.g. "gpt-4o*" matches "gpt-4o-mini", "gpt-4o-2024-11-20").
// Empty / unset = all models permitted (open relay).

/** @type {string[]} */
const ALLOWED_MODELS_RAW = process.env.ALLOWED_MODELS
  ? process.env.ALLOWED_MODELS.split(',').map(m => m.trim()).filter(Boolean)
  : [];

/**
 * Convert a pattern (may contain '*') into a RegExp.
 * '*' matches any sequence of non-empty characters.
 */
function patternToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.+');
  return new RegExp('^' + escaped + '$', 'i');
}

const ALLOWED_MODEL_REGEXES = ALLOWED_MODELS_RAW.map(patternToRegex);

/**
 * Return true if modelName is permitted under the configured allowlist.
 * If no allowlist is configured (ALLOWED_MODELS_RAW is empty) all models pass.
 * @param {string|undefined} modelName
 */
function isModelAllowed(modelName) {
  if (ALLOWED_MODEL_REGEXES.length === 0) return true; // no restriction
  if (!modelName || typeof modelName !== 'string') return true; // can't inspect → pass through
  return ALLOWED_MODEL_REGEXES.some(re => re.test(modelName));
}

if (ALLOWED_MODELS_RAW.length > 0) {
  console.log(`Model allowlist active: ${ALLOWED_MODELS_RAW.join(', ')}`);
} else {
  console.warn('WARNING: ALLOWED_MODELS is not set. All models are permitted.');
  console.warn('Set ALLOWED_MODELS to restrict which AI models users can request.');
  console.warn('Example: ALLOWED_MODELS=gpt-4o-mini,claude-haiku*,gemini-2.0-flash*');
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
  const payload = { ok: true, version, providers: SUPPORTED_PROVIDERS };
  if (ALLOWED_MODELS_RAW.length > 0) payload.allowed_models = ALLOWED_MODELS_RAW;
  res.json(payload);
});

/**
 * GET /models
 * Returns the list of models permitted on this relay.
 * If ALLOWED_MODELS is not configured, returns { restricted: false }.
 */
app.get('/models', (req, res) => {
  if (ALLOWED_MODELS_RAW.length === 0) {
    return res.json({ restricted: false, message: 'All models are permitted on this relay.' });
  }
  res.json({ restricted: true, allowed_models: ALLOWED_MODELS_RAW });
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
  const { token } = createUser(app_id);
  res.json({ token });
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
    return res.status(400).json({ error: 'A valid API key is required' });
  }
  upsertKey(req.user.id, provider, key.trim());
  res.json({ ok: true, provider });
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

  // ── Model allowlist check ───────────────────────────────────────
  // req.body is the parsed JSON object (express.json middleware).
  // Extract the model name if present; reject early if it is not on the allowlist.
  const requestedModel = req.body && typeof req.body === 'object' ? req.body.model : undefined;
  if (!isModelAllowed(requestedModel)) {
    return res.status(403).json({
      error: `Model "${requestedModel}" is not permitted on this relay.`,
      allowed_models: ALLOWED_MODELS_RAW,
    });
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
    if (ALLOWED_MODELS_RAW.length > 0) {
      console.log(`Model allowlist: ${ALLOWED_MODELS_RAW.join(', ')}`);
    } else {
      console.log('Model allowlist: unrestricted (all models permitted)');
    }
  });
}

module.exports = app;

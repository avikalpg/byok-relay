require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createUser, getUserByToken, upsertKey, getDecryptedKey, deleteKey, listProviders, logRequest, getStatsForUser, getStatsForApp } = require('./db');
const { forwardRequest, getProviderMeta, isPathAllowed, SUPPORTED_PROVIDERS } = require('./providers');
const { logger, httpLogger } = require('./logger');

// ── Startup validation ──────────────────────────────────────────────────────
if (!process.env.ENCRYPTION_SECRET) {
  logger.error('ENCRYPTION_SECRET env var is not set. Generate one with: openssl rand -hex 32');
  process.exit(1);
}
if (process.env.ENCRYPTION_SECRET.length < 32) {
  logger.error('ENCRYPTION_SECRET must be at least 32 characters.');
  process.exit(1);
}
if (process.env.APP_SECRET && process.env.APP_SECRET.includes(' ')) {
  logger.error('APP_SECRET must not contain spaces. Generate a safe value with: openssl rand -hex 32');
  process.exit(1);
}
if (!process.env.APP_SECRET) {
  logger.warn('APP_SECRET is not set — POST /users is open. Set APP_SECRET to restrict registration.');
}
if (process.env.TOKEN_HMAC_SECRET && process.env.TOKEN_HMAC_SECRET.length < 32) {
  logger.error('TOKEN_HMAC_SECRET must be at least 32 characters.');
  process.exit(1);
}
if (!process.env.TOKEN_HMAC_SECRET) {
  logger.warn('TOKEN_HMAC_SECRET is not set — falling back to ENCRYPTION_SECRET for token hashing.');
}

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim());

// ── Middleware ──────────────────────────────────────────────────────────────

app.use(cors({
  origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-relay-token', 'anthropic-version', 'x-relay-base-url', 'x-relay-referer', 'x-title', 'http-referer', 'xi-api-key'],
  credentials: false,
}));

app.use((req, res, next) => {
  // For relay routes targeting providers that accept raw binary bodies (e.g. Deepgram STT),
  // skip JSON parsing when the Content-Type is not application/json so that the raw Buffer
  // is preserved for pass-through. All other routes use express.json as normal.
  const provider = req.params && req.params.provider;
  const ct = req.headers['content-type'] || '';
  if (req.path.startsWith('/relay/') && !ct.includes('application/json')) {
    // Collect raw body as Buffer; will be passed to forwardRequest as-is.
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      req.rawBodyBuffer = chunks.length ? Buffer.concat(chunks) : null;
      next();
    });
    req.on('error', next);
  } else {
    express.json({ limit: '10mb' })(req, res, next);
  }
});

// Structured HTTP request logging (must come after express.json so body is parsed)
app.use(httpLogger);

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
 * GET /stats
 * Return per-user request statistics for the authenticated relay token.
 * Headers: x-relay-token
 *
 * Response:
 *   { total, last_7d, last_30d, error_count, error_rate, providers, top_models, last_request }
 */
app.get('/stats', requireToken, (req, res) => {
  const stats = getStatsForUser(req.user.id);
  res.json(stats);
});

/**
 * GET /stats/:app_id
 * Return aggregate statistics for all users of a given app_id.
 * Requires APP_SECRET — operator-level endpoint.
 *
 * Response:
 *   { app_id, user_count, total, last_7d, last_30d, error_count, error_rate, providers, top_models }
 */
app.get('/stats/:app_id', requireAppSecret, (req, res) => {
  const stats = getStatsForApp(req.params.app_id);
  res.json(stats);
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

  // Build the forwarded path early so we can check it BEFORE key decryption.
  // This prevents a token holder from probing provider account structure via
  // paths that are not in the allowlist (fine-tuning, billing, model deletion, etc.)
  const forwardPath = '/' + (req.params[0] || '');
  if (!isPathAllowed(provider, forwardPath)) {
    return res.status(403).json({
      error: `Path not permitted for provider "${provider}". Only inference endpoints are allowed.`,
    });
  }

  const apiKey = getDecryptedKey(req.user.id, provider);
  if (!apiKey) {
    return res.status(400).json({
      error: `No API key stored for provider "${provider}". POST /keys/${provider} first.`,
    });
  }

  // Pass through provider-specific and relay headers
  const extraHeaders = {};
  const passthroughHeaders = [
    'anthropic-version', 'x-relay-base-url', 'x-relay-referer', 'x-title',
    'http-referer', 'content-type',
  ];
  for (const h of passthroughHeaders) {
    if (req.headers[h]) extraHeaders[h] = req.headers[h];
  }

  // Determine body to forward: raw Buffer for binary-upload providers, else parsed JSON.
  const { rawBody: providerWantsRawBody } = getProviderMeta(provider);
  const relayBody = (providerWantsRawBody && req.rawBodyBuffer)
    ? req.rawBodyBuffer
    : req.body;

  const model = req.body?.model || null;
  const relayStart = Date.now();

  try {
    const providerResponse = await forwardRequest(
      provider,
      forwardPath,
      req.method,
      relayBody,
      apiKey,
      extraHeaders,
    );

    // Forward status and relevant headers
    res.status(providerResponse.status);
    const contentType = providerResponse.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);

    const isStream = req.body?.stream === true ||
      (contentType && contentType.includes('text/event-stream'));

    const latency_ms = Date.now() - relayStart;

    // Structured relay log
    req.log.info({
      event: 'relay_request',
      user_id: req.user.id,
      app_id: req.user.app_id,
      provider,
      model,
      status: providerResponse.status,
      latency_ms,
      streaming: isStream,
    }, 'relay');

    // Persist to request_logs for /stats
    try {
      logRequest({
        user_id: req.user.id,
        app_id: req.user.app_id,
        provider,
        model,
        status: providerResponse.status,
        latency_ms,
      });
    } catch (logErr) {
      // Never let logging failure affect the response
      req.log.warn({ err: logErr }, 'request log write failed');
    }

    // Determine how to return the response body.
    // Binary providers (audio, image) or binary content-type responses are
    // piped through directly. JSON providers are parsed and re-serialised.
    // SSE streams are piped with SSE headers.
    const { binaryResponse: providerIsBinary } = getProviderMeta(provider);
    const isBinary = providerIsBinary ||
      (contentType && (
        contentType.startsWith('audio/') ||
        contentType.startsWith('image/') ||
        contentType.startsWith('video/') ||
        contentType === 'application/octet-stream'
      ));

    if (isStream) {
      // Pipe the SSE stream directly to the client
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      providerResponse.body.pipe(res);
    } else if (isBinary) {
      // Binary response (audio, image, video) — pipe bytes through without parsing.
      // Content-Type is already set above from providerResponse headers.
      const contentLength = providerResponse.headers.get('content-length');
      if (contentLength) res.setHeader('Content-Length', contentLength);
      const contentDisp = providerResponse.headers.get('content-disposition');
      if (contentDisp) res.setHeader('Content-Disposition', contentDisp);
      providerResponse.body.pipe(res);
    } else {
      // JSON response: check Content-Type before calling .json() to avoid
      // throwing on HTML error pages (e.g. Cloudflare 502).
      if (contentType && !contentType.includes('application/json')) {
        const text = await providerResponse.text();
        res.setHeader('Content-Type', contentType);
        res.send(text);
      } else {
        const data = await providerResponse.json();
        res.json(data);
      }
    }
  } catch (err) {
    // SSRF / input validation errors are client mistakes — return 400.
    // All other relay failures return 502 with a generic message so we don't
    // leak internal hostnames, IPs, or stack traces to the client.
    if (err.code === 'INVALID_RELAY_BASE_URL') {
      return res.status(400).json({ error: err.message });
    }
    const latency_ms = Date.now() - relayStart;
    req.log.error({ err, event: 'relay_error', user_id: req.user.id, app_id: req.user.app_id, provider, model, latency_ms }, 'relay error');
    try {
      logRequest({ user_id: req.user.id, app_id: req.user.app_id, provider, model, status: 502, latency_ms });
    } catch (_) {}
    res.status(502).json({ error: 'Failed to reach AI provider' });
  }
});

// ── Start ───────────────────────────────────────────────────────────────────
// When run directly (node src/index.js or npm start), start the HTTP server.
// When imported by Vercel's @vercel/node runtime, export the app instead.
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT, origins: ALLOWED_ORIGINS, providers: SUPPORTED_PROVIDERS }, 'byok-relay started');
  });
}

module.exports = app;

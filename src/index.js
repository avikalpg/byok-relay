require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const {
  createUser,
  getUserByToken,
  upsertKey,
  getDecryptedKey,
  deleteKey,
  listProviders,
  logRequest,
  getStatsForUser,
  getStatsForApp,
} = require('./db');
const { forwardRequest, getProviderMeta, SUPPORTED_PROVIDERS, isPathAllowed, normalizeProviderPath } = require('./providers');
const { resolveModelRoute, MODEL_PATTERNS, PROVIDER_DEFAULT_PATHS } = require('./routing');
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
const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
function parseRequestBodyLimitBytes(rawValue) {
  const value = String(rawValue ?? DEFAULT_REQUEST_BODY_LIMIT_BYTES).trim();
  if (!/^\d+$/.test(value)) return DEFAULT_REQUEST_BODY_LIMIT_BYTES;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_REQUEST_BODY_LIMIT_BYTES;
}

const REQUEST_BODY_LIMIT_BYTES = parseRequestBodyLimitBytes(process.env.REQUEST_BODY_LIMIT_BYTES);

// ── Middleware ──────────────────────────────────────────────────────────────

// Security headers (X-Content-Type-Options, X-Frame-Options, HSTS, etc.)
app.use(helmet());

app.use(cors({
  origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-relay-token',
    'anthropic-version',
    'x-relay-base-url',
    'x-relay-referer',
    'x-title',
    'http-referer',
    'x-relay-e2e-base-url-token',
    'xi-api-key',
  ],
  credentials: false,
}));

app.use((req, res, next) => {
  // Preserve raw binary bodies for direct provider relay routes that support
  // audio/image uploads. Unified /relay still expects JSON because it needs a
  // model field for routing.
  const ct = req.headers['content-type'] || '';
  if (req.path.startsWith('/relay/') && !ct.includes('application/json')) {
    const chunks = [];
    let totalBytes = 0;
    let rejected = false;

    req.on('data', (chunk) => {
      if (rejected) return;
      totalBytes += chunk.length;
      if (totalBytes > REQUEST_BODY_LIMIT_BYTES) {
        rejected = true;
        chunks.length = 0;
        res.status(413).json({ error: 'Request body too large' });
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      req.rawBodyBuffer = chunks.length ? Buffer.concat(chunks, totalBytes) : null;
      next();
    });
    req.on('error', (err) => {
      if (!rejected) next(err);
    });
  } else {
    express.json({ limit: REQUEST_BODY_LIMIT_BYTES })(req, res, next);
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

function logRelayRequest(req, details) {
  const { provider, model, status, latency_ms, streaming } = details;

  req.log.info({
    event: 'relay_request',
    user_id: req.user.id,
    app_id: req.user.app_id,
    provider,
    model,
    status,
    latency_ms,
    streaming,
  }, 'relay');

  try {
    logRequest({
      user_id: req.user.id,
      app_id: req.user.app_id,
      provider,
      model,
      status,
      latency_ms,
    });
  } catch (logErr) {
    // Never let logging failure affect the response
    req.log.warn({ err: logErr }, 'request log write failed');
  }
}

function logRelayError(req, details) {
  const { err, provider, model, latency_ms } = details;
  req.log.error({
    err,
    event: 'relay_error',
    user_id: req.user.id,
    app_id: req.user.app_id,
    provider,
    model,
    latency_ms,
  }, 'relay error');

  try {
    logRequest({
      user_id: req.user.id,
      app_id: req.user.app_id,
      provider,
      model,
      status: 502,
      latency_ms,
    });
  } catch (_) {}
}

function createRelayLogger(req) {
  let relayMetricLogged = false;

  return {
    logRelayRequestOnce(details) {
      if (relayMetricLogged) return;
      relayMetricLogged = true;
      logRelayRequest(req, details);
    },
    logRelayErrorOnce(details) {
      if (relayMetricLogged) return;
      relayMetricLogged = true;
      logRelayError(req, details);
    },
  };
}

async function forwardRelayRequest({
  req,
  res,
  provider,
  forwardPath,
  body,
  apiKey,
  extraHeaders,
  model,
  streamingRequested,
}) {
  const relayStart = Date.now();
  const { logRelayRequestOnce, logRelayErrorOnce } = createRelayLogger(req);
  const upstreamAbortController = new AbortController();
  let providerResponse;

  function abortUpstreamBody() {
    if (providerResponse?.body && !providerResponse.body.destroyed) {
      providerResponse.body.destroy();
    }
    if (!res.writableEnded && !upstreamAbortController.signal.aborted) {
      upstreamAbortController.abort();
    }
  }

  res.on('close', abortUpstreamBody);

  try {
    providerResponse = await forwardRequest(
      provider,
      forwardPath,
      req.method,
      body,
      apiKey,
      extraHeaders,
      { signal: upstreamAbortController.signal },
    );

    res.status(providerResponse.status);
    const contentType = providerResponse.headers.get('content-type');
    const contentTypeLower = contentType ? contentType.toLowerCase() : '';
    if (contentType) res.setHeader('Content-Type', contentType);

    if (providerResponse.status === 204 || providerResponse.status === 304) {
      const latency_ms = Date.now() - relayStart;
      logRelayRequestOnce({
        provider,
        model,
        status: providerResponse.status,
        latency_ms,
        streaming: false,
      });
      return res.end();
    }

    const isStream = contentTypeLower
      ? contentTypeLower.includes('text/event-stream')
      : (streamingRequested && providerResponse.ok);
    const { binaryResponse: providerIsBinary } = getProviderMeta(provider);
    const isBinary = providerIsBinary ||
      (contentTypeLower && (
        contentTypeLower.startsWith('audio/') ||
        contentTypeLower.startsWith('image/') ||
        contentTypeLower.startsWith('video/') ||
        contentTypeLower === 'application/octet-stream'
      ));

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      providerResponse.body.on('error', (streamErr) => {
        if (upstreamAbortController.signal.aborted || res.destroyed) return;
        const latency_ms = Date.now() - relayStart;
        logRelayErrorOnce({ err: streamErr, provider, model, latency_ms });
        if (!res.writableEnded) {
          res.write('event: error\ndata: {"error":"Stream interrupted by provider"}\n\n');
          res.end();
        }
      });
      providerResponse.body.on('end', () => {
        const latency_ms = Date.now() - relayStart;
        logRelayRequestOnce({
          provider,
          model,
          status: providerResponse.status,
          latency_ms,
          streaming: true,
        });
      });
      providerResponse.body.pipe(res);
      return;
    }

    if (isBinary) {
      const contentLength = providerResponse.headers.get('content-length');
      if (contentLength) res.setHeader('Content-Length', contentLength);
      const contentDisposition = providerResponse.headers.get('content-disposition');
      if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);

      providerResponse.body.on('error', (binaryErr) => {
        if (upstreamAbortController.signal.aborted || res.destroyed) return;
        const latency_ms = Date.now() - relayStart;
        logRelayErrorOnce({ err: binaryErr, provider, model, latency_ms });
        if (res.writableEnded) return;
        providerResponse.body.unpipe(res);
        if (!res.headersSent) {
          res.removeHeader('Content-Type');
          res.removeHeader('Content-Length');
          res.removeHeader('Content-Disposition');
          res.status(502).json({ error: 'Failed to reach AI provider' });
        } else {
          res.destroy(binaryErr);
        }
      });
      providerResponse.body.on('end', () => {
        const latency_ms = Date.now() - relayStart;
        logRelayRequestOnce({
          provider,
          model,
          status: providerResponse.status,
          latency_ms,
          streaming: false,
        });
      });
      providerResponse.body.pipe(res);
      return;
    }

    let responseBody;
    if (!contentTypeLower || !contentTypeLower.includes('application/json')) {
      responseBody = await providerResponse.text();
    } else {
      responseBody = await providerResponse.json();
    }
    const latency_ms = Date.now() - relayStart;
    logRelayRequestOnce({
      provider,
      model,
      status: providerResponse.status,
      latency_ms,
      streaming: false,
    });

    if (!contentTypeLower || !contentTypeLower.includes('application/json')) {
      return res.send(responseBody);
    }
    res.json(responseBody);
  } catch (err) {
    if (upstreamAbortController.signal.aborted || res.destroyed) return;

    // SSRF / input validation errors are client mistakes — return 400.
    // All other relay failures return 502 with a generic message so we don't
    // leak internal hostnames, IPs, or stack traces to the client.
    if (err.code === 'INVALID_RELAY_BASE_URL') {
      return res.status(400).json({ error: err.message });
    }
    const latency_ms = Date.now() - relayStart;
    logRelayErrorOnce({ err, provider, model, latency_ms });
    if (!res.headersSent && err.name === 'AbortError') {
      return res.status(504).json({ error: 'AI provider timed out (30 s). Please retry.' });
    }
    if (!res.headersSent) {
      return res.status(502).json({ error: 'Failed to reach AI provider' });
    }
    res.destroy(err);
  }
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
  if (!process.env.APP_SECRET) {
    return res.status(503).json({ error: 'Operator stats require APP_SECRET to be configured.' });
  }
  const stats = getStatsForApp(req.params.app_id);
  res.json(stats);
});

/**
 * GET /models
 * Returns the routing table so clients can discover which model names / prefixes
 * are routable without specifying an explicit provider path.
 */
app.get('/models', (req, res) => {
  res.json({
    providers: SUPPORTED_PROVIDERS,
    providerPrefixes: Object.keys(PROVIDER_DEFAULT_PATHS),
    patterns: MODEL_PATTERNS.map(({ pattern, provider }) => ({
      pattern: pattern.source,
      flags: pattern.flags,
      provider,
    })),
    usage: 'POST /relay with { model: "provider/model-name", ...providerBody }',
    examples: [
      '{ "model": "anthropic/claude-3-5-haiku", "max_tokens": 256, "messages": [{"role":"user","content":"Hello"}] }',
      '{ "model": "gpt-4o", "messages": [{"role":"user","content":"Hello"}] }',
      '{ "model": "google/gemini-2.0-flash", "contents": [{"parts":[{"text":"Hello"}]}] }',
    ],
  });
});

/**
 * POST /relay
 * Unified model routing — resolve provider from the `model` field in the body.
 *
 * The request body is forwarded as-is to the resolved provider endpoint.
 * Use "provider/model-name" for an explicit route, or a bare model name
 * that matches one of the patterns in GET /models.
 *
 * Streaming: pass `stream: true` in the body; SSE is piped back to the client.
 *
 * Per-provider bodies:
 *   anthropic — { model, max_tokens, messages: [{role, content}] }
 *   openai    — { model, messages: [{role, content}] }
 *   google    — { model, contents: [{parts:[{text}]}] }
 *   groq/mistral/openrouter — OpenAI-compatible
 */
app.post('/relay', requireToken, relayLimiter, async (req, res) => {
  const { model } = req.body || {};
  if (!model) {
    return res.status(400).json({
      error: 'model field is required. Use "provider/model-name" (e.g. "anthropic/claude-3-5-haiku") or a recognised model name (e.g. "gpt-4o"). See GET /models for the full routing table.',
    });
  }

  const streaming = req.body?.stream === true;
  const route = resolveModelRoute(model, streaming);
  if (!route) {
    return res.status(400).json({
      error: `Cannot route model "${model}". Use "provider/model-name" format or a recognised model name. Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}. See GET /models for the full routing table.`,
    });
  }

  const { provider, path: forwardPath, modelName } = route;

  const apiKey = getDecryptedKey(req.user.id, provider);
  if (!apiKey) {
    return res.status(400).json({
      error: `No API key stored for provider "${provider}". POST /keys/${provider} first.`,
    });
  }

  // Strip provider prefix from model field before forwarding.
  // "anthropic/claude-3-5-haiku" → "claude-3-5-haiku" for the upstream request.
  const forwardBody = { ...req.body, model: modelName };

  // Pass through provider-specific and relay headers
  const extraHeaders = {};
  const passthroughHeaders = [
    'anthropic-version', 'x-relay-base-url', 'x-relay-referer', 'x-title',
    'http-referer', 'x-relay-e2e-base-url-token', 'content-type',
  ];
  for (const h of passthroughHeaders) {
    if (req.headers[h]) extraHeaders[h] = req.headers[h];
  }

  return forwardRelayRequest({
    req,
    res,
    provider,
    forwardPath,
    body: forwardBody,
    apiKey,
    extraHeaders,
    model,
    streamingRequested: streaming,
  });
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
app.post('/relay/:provider/*', requireToken, (req, res, next) => {
  // ── Path traversal allowlist ────────────────────────────────────────────
  // Checked before rate limiting: rejected paths must not consume quota.
  // A stolen token should not be usable to probe non-inference endpoints.
  const { provider } = req.params;
  if (SUPPORTED_PROVIDERS.includes(provider)) {
    const forwardPath = normalizeProviderPath('/' + (req.params[0] || ''));
    req.forwardPath = forwardPath;
    if (!isPathAllowed(provider, forwardPath)) {
      return res.status(403).json({
        error: `Path "${forwardPath}" is not permitted for provider "${provider}". Only inference endpoints are allowed.`,
      });
    }
  }
  next();
}, relayLimiter, async (req, res) => {
  const { provider } = req.params;
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `Unsupported provider: ${provider}` });
  }

  // Forward exactly the normalized path that passed the allowlist check.
  // Do not reconstruct it from Express params here: validation and use must
  // operate on the same value.
  const forwardPath = req.forwardPath;

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
    'http-referer', 'x-relay-e2e-base-url-token', 'content-type',
  ];
  for (const h of passthroughHeaders) {
    if (req.headers[h]) extraHeaders[h] = req.headers[h];
  }

  const model = req.body?.model || null;
  const { rawBody: providerWantsRawBody } = getProviderMeta(provider);
  const relayBody = providerWantsRawBody && req.rawBodyBuffer
    ? req.rawBodyBuffer
    : req.body;

  return forwardRelayRequest({
    req,
    res,
    provider,
    forwardPath,
    body: relayBody,
    apiKey,
    extraHeaders,
    model,
    streamingRequested: req.body?.stream === true,
  });
});

// ── Start ───────────────────────────────────────────────────────────────────

/**
 * Start the HTTP server and return the server instance.
 * Called by the CLI bin (npx byok-relay) and when run directly.
 * Not called when imported by Vercel's @vercel/node runtime.
 */
function startServer() {
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT, origins: ALLOWED_ORIGINS, providers: SUPPORTED_PROVIDERS }, 'byok-relay started');
  });

  // Graceful shutdown on SIGTERM (Docker stop, systemd, Kubernetes rolling deploy).
  // server.close() stops accepting new connections and waits for in-flight
  // requests to finish. Force-exit after 30 s in case a streaming request
  // never completes.
  process.once('SIGTERM', () => {
    logger.info('SIGTERM received — starting graceful shutdown');
    server.close((err) => {
      if (err) {
        logger.error({ err }, 'error during graceful shutdown');
        process.exit(1);
      }
      logger.info('server closed cleanly');
      process.exit(0);
    });
    const forceExit = setTimeout(() => {
      logger.warn('graceful shutdown timed out after 30 s — forcing exit');
      process.exit(1);
    }, 30_000);
    forceExit.unref();
  });

  return server;
}

// When run directly (node src/index.js or npm start), start immediately.
// When imported (Vercel runtime, CLI bin, tests), let the caller decide.
if (require.main === module) {
  startServer();
}

module.exports = app;
module.exports.startServer = startServer;

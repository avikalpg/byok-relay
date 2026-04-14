require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createUser, getUserByToken, upsertKey, getDecryptedKey, deleteKey, listProviders } = require('./db');
const { forwardRequest, SUPPORTED_PROVIDERS } = require('./providers');

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim());

// ── Middleware ──────────────────────────────────────────────────────────────

app.use(cors({
  origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-relay-token', 'anthropic-version'],
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

// ── Auth middleware ─────────────────────────────────────────────────────────

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
  res.json({ ok: true, version: '1.0.0', providers: SUPPORTED_PROVIDERS });
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
app.post('/users', (req, res) => {
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

  const apiKey = getDecryptedKey(req.user.id, provider);
  if (!apiKey) {
    return res.status(400).json({
      error: `No API key stored for provider "${provider}". POST /keys/${provider} first.`,
    });
  }

  // Build the path to forward (everything after /relay/:provider)
  const forwardPath = '/' + (req.params[0] || '');

  // Pass through anthropic-specific headers
  const extraHeaders = {};
  if (req.headers['anthropic-version']) {
    extraHeaders['anthropic-version'] = req.headers['anthropic-version'];
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
    console.error('Relay error:', err);
    res.status(502).json({ error: 'Failed to reach AI provider', details: err.message });
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`byok-relay listening on port ${PORT}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}`);
});

/**
 * Structured logger using pino.
 *
 * Usage:
 *   const { logger, httpLogger } = require('./logger');
 *   logger.info({ provider, model, latency_ms }, 'relay request');
 *   app.use(httpLogger);   // logs every HTTP request automatically
 */
const pino = require('pino');
const pinoHttp = require('pino-http');
const crypto = require('crypto');

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Pretty-print in dev (TTY), raw JSON in production
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
    },
  }),
});

/**
 * Express middleware: attaches a unique request-id to every request and
 * logs the HTTP request/response via pino-http.
 *
 * Sets `req.id` (a UUID v4) that can be forwarded to upstream providers or
 * included in error responses for correlation.
 */
const httpLogger = pinoHttp({
  logger,
  genReqId(req) {
    // Re-use an incoming request-id header (e.g. from a load balancer) or
    // generate a new one so every request has a stable correlation id.
    return req.headers['x-request-id'] || crypto.randomUUID();
  },
  // Serialise only the fields we care about — avoids logging auth headers.
  serializers: {
    req(req) {
      return {
        id: req.id,
        method: req.method,
        url: req.url,
        // Never log Authorization or x-relay-token values.
        remoteAddress: req.remoteAddress,
      };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
  // Suppress routine health-check noise in production.
  autoLogging: {
    ignore(req) {
      return req.url === '/health';
    },
  },
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
});

module.exports = { logger, httpLogger };

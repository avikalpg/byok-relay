/**
 * mock-provider.js
 *
 * A minimal HTTP server that mimics an OpenAI-compatible AI provider.
 * Used by E2E tests so the relay can be tested without real API keys.
 *
 * Exposes:
 *   createMockProvider() → { start, stop, requests, clearRequests }
 *
 *   start()  → resolves with the port it's listening on
 *   stop()   → closes the server
 *   requests → array of { method, url, authorization, body } recorded per call
 *   clearRequests() → empties the array
 */

'use strict';

const http  = require('node:http');
const https = require('node:https');

/**
 * Create a new mock provider instance.
 * Each call returns a fresh server + request log so tests are isolated.
 */
function createMockProvider(options = {}) {
  const requests = [];

  const handler = (req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }

      requests.push({
        method:        req.method,
        url:           req.url,
        authorization: req.headers['authorization'],
        body,
      });

      // ── Route: POST /v1/chat/completions ─────────────────────────────────
      if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
        if (body.forceJsonError) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'mock rate limited' }));
          return;
        }

        if (body.forceJsonDespiteStream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'chatcmpl-json-despite-stream', ok: true }));
          return;
        }

        if (body.forceNoContent) {
          res.writeHead(204);
          res.end();
          return;
        }

        if (body.stream) {
          // Server-Sent Events stream
          res.writeHead(200, {
            'Content-Type':  'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection':    'keep-alive',
          });
          const chunk = JSON.stringify({
            id:      'chatcmpl-mock-stream',
            object:  'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: 'Hello from mock stream!' }, finish_reason: null }],
          });
          res.write(`data: ${chunk}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          // Standard JSON response
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id:      'chatcmpl-mock',
            object:  'chat.completion',
            choices: [{
              index:         0,
              message:       { role: 'assistant', content: 'Hello from mock!' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }));
        }
        return;
      }

      // ── Fallback: 404 ────────────────────────────────────────────────────
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Mock: no handler for ${req.method} ${req.url}` }));
    });
  };

  const server = options.tls
    ? https.createServer(options.tls, handler)
    : http.createServer(handler);

  return {
    /** The recorded request log. Read directly or call clearRequests(). */
    requests,

    /** Empty the request log between test assertions. */
    clearRequests() {
      requests.splice(0);
    },

    /** Start listening. Returns a Promise that resolves with the port number. */
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        // Port 0 → OS picks a free port
        server.listen(0, options.host || '127.0.0.1', () => resolve(server.address().port));
      });
    },

    /** Stop the server gracefully. */
    stop() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createMockProvider };

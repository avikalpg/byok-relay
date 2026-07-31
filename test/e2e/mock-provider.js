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
  const streamEvents = [];

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

        if (body.forceBinaryStreamError) {
          res.writeHead(200, {
            'Content-Type':        'application/octet-stream',
            'Content-Disposition': 'attachment; filename="mock.bin"',
          });
          res.write(Buffer.from('partial'));
          setImmediate(() => res.destroy(new Error('mock binary stream failure')));
          return;
        }

        if (body.forceSlowBinaryUntilClientClose) {
          res.writeHead(200, {
            'Content-Type':        'application/octet-stream',
            'Content-Disposition': 'attachment; filename="mock.bin"',
          });
          const interval = setInterval(() => {
            if (!res.destroyed) res.write(Buffer.from('more'));
          }, 50);
          res.on('close', () => {
            clearInterval(interval);
            streamEvents.push('slow-binary-response-closed');
          });
          res.write(Buffer.from('first'));
          return;
        }

        if (body.forceSseStreamError) {
          res.writeHead(200, {
            'Content-Type':  'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection':    'keep-alive',
          });
          const chunk = JSON.stringify({
            id:      'chatcmpl-mock-stream-error',
            object:  'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
          });
          res.write(`data: ${chunk}\n\n`);
          setImmediate(() => res.destroy(new Error('mock SSE stream failure')));
          return;
        }

        if (body.forceSlowSseUntilClientClose) {
          res.writeHead(200, {
            'Content-Type':  'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection':    'keep-alive',
          });
          const interval = setInterval(() => {
            if (!res.destroyed) res.write(': keepalive\n\n');
          }, 50);
          res.on('close', () => {
            clearInterval(interval);
            streamEvents.push('slow-sse-response-closed');
          });
          res.write('data: {"delta":"first"}\n\n');
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

    /** Streaming lifecycle events recorded by failure/disconnect tests. */
    streamEvents,

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

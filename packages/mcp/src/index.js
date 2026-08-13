#!/usr/bin/env node
/**
 * @byok-relay/mcp — MCP server for byok-relay
 *
 * Exposes byok-relay operations as MCP tools so Claude Desktop, Claude Code,
 * and any MCP-compatible client can relay AI requests through users' own API keys.
 *
 * Usage (Claude Desktop claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "byok-relay": {
 *         "command": "npx",
 *         "args": ["-y", "@byok-relay/mcp"],
 *         "env": {
 *           "RELAY_URL": "https://relay.byokrelay.com",
 *           "APP_ID": "<your-app-id>"
 *         }
 *       }
 *     }
 *   }
 */

'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const RELAY_URL = (process.env.RELAY_URL || 'https://relay.byokrelay.com').replace(/\/$/, '');
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
const APP_ID = process.env.APP_ID || 'mcp-client';

// ─── helpers ─────────────────────────────────────────────────────────────────

async function relayFetch(path, options = {}) {
  const fetch = globalThis.fetch || (await import('node-fetch')).default;
  const url = `${RELAY_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(RELAY_TOKEN ? { Authorization: `Bearer ${RELAY_TOKEN}` } : {}),
    ...(options.headers || {}),
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  const { timeoutMs, ...fetchOptions } = options;
  let res;
  let text;
  try {
    res = await fetch(url, { ...fetchOptions, headers, signal: controller.signal });
    text = await res.text();
  } finally {
    clearTimeout(timeout);
  }
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, ok: res.ok, body };
}

// ─── tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'byok_relay_health',
    description:
      'Check whether the byok-relay server is healthy and reachable. ' +
      'Returns status, uptime, and any warnings (e.g. missing optional env vars).',
    inputSchema: {
      type: 'object',
      properties: {
        deep: {
          type: 'boolean',
          description: 'When true, also pings the upstream AI provider to check connectivity.',
        },
        provider: {
          type: 'string',
          description: 'Provider to ping when deep=true (e.g. "openai", "anthropic").',
        },
      },
    },
  },
  {
    name: 'byok_relay_register',
    description:
      'Register a new user with the byok-relay and receive a relay token. ' +
      'The token is required for all other relay operations. ' +
      'Store it securely — it is only returned once.',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: {
          type: 'string',
          description: 'Identifier for your application (e.g. "my-app" or "claude-desktop").',
        },
      },
    },
  },
  {
    name: 'byok_relay_store_key',
    description:
      'Store an AI provider API key in the byok-relay under the authenticated user. ' +
      'Keys are encrypted at rest with AES-256-GCM and never returned after storage. ' +
      'Supported providers: openai, anthropic, google, mistral, openai-compatible.',
    inputSchema: {
      type: 'object',
      required: ['provider', 'key'],
      properties: {
        provider: {
          type: 'string',
          enum: ['openai', 'anthropic', 'google', 'mistral', 'openai-compatible'],
          description: 'AI provider name.',
        },
        key: {
          type: 'string',
          description: 'The raw API key for the provider (e.g. sk-... for OpenAI).',
        },
        base_url: {
          type: 'string',
          description: 'Custom base URL — required only for openai-compatible providers.',
        },
      },
    },
  },
  {
    name: 'byok_relay_request',
    description:
      'Forward an AI API request through byok-relay using the stored provider key. ' +
      'The relay decrypts the key server-side and proxies the request to the provider. ' +
      'Use this to make any provider API call without exposing API keys to the client.',
    inputSchema: {
      type: 'object',
      required: ['provider', 'path'],
      properties: {
        provider: {
          type: 'string',
          enum: ['openai', 'anthropic', 'google', 'mistral', 'openai-compatible'],
          description: 'AI provider to route to.',
        },
        path: {
          type: 'string',
          description: 'Provider API path (e.g. "/v1/chat/completions" for OpenAI).',
        },
        body: {
          type: 'object',
          description: 'Request body as a JSON object (will be forwarded verbatim).',
        },
        headers: {
          type: 'object',
          description: 'Additional relay/provider headers to forward (e.g. anthropic-version or x-relay-base-url).',
          additionalProperties: { type: 'string' },
        },
        method: {
          type: 'string',
          enum: ['POST', 'GET', 'DELETE'],
          description: 'HTTP method. Default: POST.',
        },
      },
    },
  },
  {
    name: 'byok_relay_chat',
    description:
      'Send a chat completion request through byok-relay using unified model routing. ' +
      'Use model names like "gpt-4o", "claude-opus-4-5", or "anthropic/claude-haiku-3-5". ' +
      'The relay selects the correct provider automatically from the stored keys.',
    inputSchema: {
      type: 'object',
      required: ['model', 'messages'],
      properties: {
        model: {
          type: 'string',
          description:
            'Model name with optional provider prefix (e.g. "gpt-4o", "anthropic/claude-haiku-3-5").',
        },
        messages: {
          type: 'array',
          description: 'Chat messages in OpenAI format.',
          items: {
            type: 'object',
            required: ['role', 'content'],
            properties: {
              role: { type: 'string', enum: ['system', 'user', 'assistant'] },
              content: { type: 'string' },
            },
          },
        },
        max_tokens: {
          type: 'integer',
          description: 'Maximum tokens to generate.',
        },
        temperature: {
          type: 'number',
          description: 'Sampling temperature (0–2).',
        },
      },
    },
  },
  {
    name: 'byok_relay_stats',
    description:
      'Retrieve usage statistics for the authenticated relay user: ' +
      'request counts, providers used, error rates, and per-app_id breakdowns.',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: {
          type: 'string',
          description: 'Filter stats to a specific app_id (operator-only aggregate view).',
        },
      },
    },
  },
];

// ─── tool handlers ────────────────────────────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {
    case 'byok_relay_health': {
      const qs = args.deep ? `?deep=1${args.provider ? `&provider=${args.provider}` : ''}` : '';
      const { status, body } = await relayFetch(`/health${qs}`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ status, ...body }, null, 2) }],
        isError: status >= 400,
      };
    }

    case 'byok_relay_register': {
      const appId = args.app_id || APP_ID;
      const { status, body } = await relayFetch('/users', {
        method: 'POST',
        body: JSON.stringify({ app_id: appId }),
      });
      const note =
        status === 201
          ? '\n\nIMPORTANT: Save the "token" field — it is shown only once. ' +
            'Set it as RELAY_TOKEN in your environment to authenticate future requests.'
          : '';
      return {
        content: [{ type: 'text', text: JSON.stringify(body, null, 2) + note }],
        isError: status >= 400,
      };
    }

    case 'byok_relay_store_key': {
      if (!RELAY_TOKEN) {
        return {
          content: [{ type: 'text', text: 'Error: RELAY_TOKEN env var is not set. Run byok_relay_register first.' }],
          isError: true,
        };
      }
      const payload = { key: args.key };
      if (args.base_url) payload.base_url = args.base_url;
      const { status, body } = await relayFetch(`/keys/${args.provider}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
        isError: status >= 400,
      };
    }

    case 'byok_relay_request': {
      if (!RELAY_TOKEN) {
        return {
          content: [{ type: 'text', text: 'Error: RELAY_TOKEN env var is not set. Run byok_relay_register first.' }],
          isError: true,
        };
      }
      const method = args.method || 'POST';
      const relayPath = `/relay/${args.provider}${args.path.startsWith('/') ? args.path : '/' + args.path}`;
      const fetchOpts = {
        method,
        ...(args.headers ? { headers: args.headers } : {}),
        ...(method !== 'GET' && args.body != null ? { body: JSON.stringify(args.body) } : {}),
      };
      const { status, body } = await relayFetch(relayPath, fetchOpts);
      return {
        content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body, null, 2) }],
        isError: status >= 400,
      };
    }

    case 'byok_relay_chat': {
      if (!RELAY_TOKEN) {
        return {
          content: [{ type: 'text', text: 'Error: RELAY_TOKEN env var is not set. Run byok_relay_register first.' }],
          isError: true,
        };
      }
      const payload = {
        model: args.model,
        messages: args.messages,
        ...(args.max_tokens != null ? { max_tokens: args.max_tokens } : {}),
        ...(args.temperature != null ? { temperature: args.temperature } : {}),
      };
      const { status, body } = await relayFetch('/relay', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      // Extract assistant message text if present for convenience
      const text =
        body?.choices?.[0]?.message?.content ||
        body?.content?.[0]?.text ||
        (typeof body === 'string' ? body : JSON.stringify(body, null, 2));
      return {
        content: [{ type: 'text', text }],
        isError: status >= 400,
      };
    }

    case 'byok_relay_stats': {
      if (!RELAY_TOKEN) {
        return {
          content: [{ type: 'text', text: 'Error: RELAY_TOKEN env var is not set. Run byok_relay_register first.' }],
          isError: true,
        };
      }
      const path = args.app_id ? `/stats/${args.app_id}` : '/stats';
      const { status, body } = await relayFetch(path);
      return {
        content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
        isError: status >= 400,
      };
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

// ─── server bootstrap ─────────────────────────────────────────────────────────

async function main() {
  const server = new Server(
    { name: '@byok-relay/mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      return await handleTool(name, args);
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Tool error: ${err.message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until process exits; no console.log (would corrupt stdio MCP protocol)
}

main().catch((err) => {
  process.stderr.write(`byok-relay MCP server error: ${err.message}\n`);
  process.exit(1);
});

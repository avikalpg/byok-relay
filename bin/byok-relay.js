#!/usr/bin/env node
/**
 * byok-relay CLI — Start the relay server from npx
 *
 * Usage:
 *   npx byok-relay             # starts on port 3000
 *   npx byok-relay --port 8080
 *   npx byok-relay --help
 */

'use strict';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
byok-relay — BYOK (Bring Your Own Key) relay server for AI APIs

Usage:
  npx byok-relay [options]

Options:
  --port <n>    Port to listen on (default: 3000, or PORT env var)
  --help, -h    Show this help message
  --version     Print version

Environment variables (required):
  ENCRYPTION_SECRET   Random hex string ≥ 32 chars
                      Generate: openssl rand -hex 32

Environment variables (optional):
  PORT                Server port (default: 3000)
  ALLOWED_ORIGINS     Comma-separated allowed origins (default: *)
  DB_PATH             SQLite database file path (default: ./data/relay.db)
  RATE_LIMIT_GLOBAL   Max requests/min per IP (default: 100)
  RATE_LIMIT_RELAY    Max AI requests/min per token (default: 20)

Quick start:
  export ENCRYPTION_SECRET=$(openssl rand -hex 32)
  npx byok-relay

Docs: https://github.com/avikalpg/byok-relay
`);
  process.exit(0);
}

if (args.includes('--version')) {
  const pkg = require('../package.json');
  console.log(pkg.version);
  process.exit(0);
}

// Forward --port flag to PORT env var
const portIdx = args.indexOf('--port');
if (portIdx !== -1) {
  const portVal = args[portIdx + 1];
  const portNum = Number(portVal);
  if (!portVal || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    console.error('Error: --port requires a valid port number between 1 and 65535, e.g. --port 8080');
    process.exit(1);
  }
  process.env.PORT = portVal;
}

// Bootstrap the server
require('../src/index.js');

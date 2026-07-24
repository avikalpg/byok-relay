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
  if (!portVal || isNaN(Number(portVal)) || Number(portVal) <= 0) {
    console.error('Error: --port requires a numeric argument, e.g. --port 8080');
    process.exit(1);
  }
  process.env.PORT = portVal;
}

// Warn on unknown flags so typos don't go unnoticed
const knownFlags = new Set(['--help', '-h', '--version', '--port']);
const unknownArgs = args.filter((a, i) =>
  a.startsWith('-') && !knownFlags.has(a) && args[i - 1] !== '--port'
);
if (unknownArgs.length) {
  console.warn(`Warning: unknown option(s): ${unknownArgs.join(', ')}. Run --help for usage.`);
}

// Bootstrap the server.
// require.main here is bin/byok-relay.js, not src/index.js, so the
// require.main === module guard in src/index.js would not fire on its own.
// We call startServer() explicitly to start listening.
const { startServer } = require('../src/index.js');
startServer();

#!/usr/bin/env node
'use strict';

/**
 * byok-relay CLI
 *
 * Usage:
 *   npx byok-relay              # start server (reads .env)
 *   npx byok-relay --help       # show help
 *   npx byok-relay --version    # print version
 *
 * Environment variables (set in .env or shell):
 *   ENCRYPTION_SECRET   required  32+ char secret for AES-256-GCM key encryption
 *   PORT                optional  default 3000
 *   APP_SECRET          optional  bearer token gate on POST /users
 *   ALLOWED_ORIGINS     optional  comma-separated CORS origins
 */

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  const { version } = require('../package.json');
  console.log(version);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
byok-relay — BYOK AI relay server

Usage:
  npx byok-relay [options]

Options:
  --help, -h        Show this help message
  --version, -v     Print version number

Environment variables (required):
  ENCRYPTION_SECRET   32+ character secret for AES-256-GCM key encryption
                      Generate: openssl rand -hex 32

Environment variables (optional):
  PORT              Port to listen on (default: 3000)
  APP_SECRET        Bearer token required at POST /users (gates user registration)
  ALLOWED_ORIGINS   Comma-separated list of allowed CORS origins
                    (default: * — lock down in production)

Quick start:
  ENCRYPTION_SECRET=$(openssl rand -hex 32) npx byok-relay

Self-hosted with docker:
  docker run -e ENCRYPTION_SECRET=<secret> -p 3000:3000 byok-relay

Documentation:
  https://byokrelay.com
  https://github.com/avikalpg/byok-relay
`);
  process.exit(0);
}

// Start the server
require('../src/index.js');

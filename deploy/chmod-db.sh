#!/usr/bin/env bash
set -euo pipefail

cd /home/ubuntu/byok-relay

if [[ -f .env ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

DB_PATH="${DB_PATH:-/home/ubuntu/byok-relay/data/relay.db}"
chmod 600 "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm" 2>/dev/null || true

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

for _ in {1..20}; do
  if [[ -f "$DB_PATH" ]]; then
    break
  fi
  sleep 0.5
done

if [[ ! -f "$DB_PATH" ]]; then
  printf 'Database not found: %s\n' "$DB_PATH" >&2
  exit 1
fi

chmod 600 -- "$DB_PATH"
for sidecar in "$DB_PATH-wal" "$DB_PATH-shm"; do
  if [[ -e "$sidecar" ]]; then
    chmod 600 -- "$sidecar"
  fi
done

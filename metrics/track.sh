#!/usr/bin/env bash
# track.sh — daily GitHub metrics snapshot for byok-relay
# Usage: bash metrics/track.sh
# Reads GH_PAT from ~/.secrets/github_pat.txt
# Appends a CSV line to metrics/history.csv

set -euo pipefail

GH_PAT="${GH_PAT:-$(cat ~/.secrets/github_pat.txt 2>/dev/null || echo "")}"
REPO="avikalpg/byok-relay"
DATE="$(date -u +%Y-%m-%d)"
OUT_DIR="$(dirname "$0")"
CSV="$OUT_DIR/history.csv"
HEADER="date,stars,forks,watchers,clones_14d,unique_clones_14d,views_14d,unique_views_14d"

if [[ -z "$GH_PAT" ]]; then
  echo "ERROR: GH_PAT not set and ~/.secrets/github_pat.txt not found" >&2
  exit 1
fi

HEADER_FILE="$(mktemp "${TMPDIR:-/tmp}/byok-relay-gh-header.XXXXXX")"
chmod 600 "$HEADER_FILE"
trap 'rm -f -- "$HEADER_FILE"' EXIT
printf 'Authorization: Bearer %s\n' "$GH_PAT" > "$HEADER_FILE"

# github_api — wrapper around curl that injects the shared Authorization header
# and enforces connect/max-time limits for every GitHub API request.
# Usage: github_api <url>
github_api() {
  curl --fail --silent --show-error \
    --connect-timeout 10 \
    --max-time 30 \
    --header "@$HEADER_FILE" \
    "$@"
}

# Fetch repo info
INFO=$(github_api "https://api.github.com/repos/$REPO")
STARS=$(echo "$INFO" | python3 -c "import json,sys; print(json.load(sys.stdin)['stargazers_count'])")
FORKS=$(echo "$INFO" | python3 -c "import json,sys; print(json.load(sys.stdin)['forks_count'])")
WATCHERS=$(echo "$INFO" | python3 -c "import json,sys; print(json.load(sys.stdin)['subscribers_count'])")

# Traffic: clones (14d)
CLONES_JSON=$(github_api "https://api.github.com/repos/$REPO/traffic/clones")
CLONES=$(echo "$CLONES_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('count', 0))")
UNIQUE_CLONES=$(echo "$CLONES_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('uniques', 0))")

# Traffic: views (14d)
VIEWS_JSON=$(github_api "https://api.github.com/repos/$REPO/traffic/views")
VIEWS=$(echo "$VIEWS_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('count', 0))")
UNIQUE_VIEWS=$(echo "$VIEWS_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('uniques', 0))")

# Serialize CSV validation, duplicate detection, and append.
exec 9>>"$CSV"
flock -x 9

# Ensure CSV exists with the expected header.
if [[ ! -s "$CSV" ]]; then
  printf '%s\n' "$HEADER" > "$CSV"
elif [[ "$(head -n1 "$CSV")" != "$HEADER" ]]; then
  echo "ERROR: invalid CSV header in $CSV" >&2
  exit 1
fi

# Append today's row (idempotent: skip if date already exists)
if grep -q "^$DATE," "$CSV" 2>/dev/null; then
  echo "[$DATE] Row already exists in $CSV — skipping duplicate write"
else
  echo "$DATE,$STARS,$FORKS,$WATCHERS,$CLONES,$UNIQUE_CLONES,$VIEWS,$UNIQUE_VIEWS" >> "$CSV"
  echo "[$DATE] Logged: stars=$STARS forks=$FORKS watchers=$WATCHERS clones=$CLONES views=$VIEWS"
fi

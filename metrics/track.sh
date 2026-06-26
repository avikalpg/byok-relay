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

if [[ -z "$GH_PAT" ]]; then
  echo "ERROR: GH_PAT not set and ~/.secrets/github_pat.txt not found" >&2
  exit 1
fi

# Fetch repo info
INFO=$(curl -sf -H "Authorization: token $GH_PAT" "https://api.github.com/repos/$REPO")
STARS=$(echo "$INFO" | python3 -c "import json,sys; print(json.load(sys.stdin)['stargazers_count'])")
FORKS=$(echo "$INFO" | python3 -c "import json,sys; print(json.load(sys.stdin)['forks_count'])")
WATCHERS=$(echo "$INFO" | python3 -c "import json,sys; print(json.load(sys.stdin)['subscribers_count'])")

# Traffic: clones (14d)
CLONES_JSON=$(curl -sf -H "Authorization: token $GH_PAT" "https://api.github.com/repos/$REPO/traffic/clones")
CLONES=$(echo "$CLONES_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('count', 0))")
UNIQUE_CLONES=$(echo "$CLONES_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('uniques', 0))")

# Traffic: views (14d)
VIEWS_JSON=$(curl -sf -H "Authorization: token $GH_PAT" "https://api.github.com/repos/$REPO/traffic/views")
VIEWS=$(echo "$VIEWS_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('count', 0))")
UNIQUE_VIEWS=$(echo "$VIEWS_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('uniques', 0))")

# Ensure CSV exists with header
if [[ ! -f "$CSV" ]]; then
  echo "date,stars,forks,watchers,clones_14d,unique_clones_14d,views_14d,unique_views_14d" > "$CSV"
fi

# Append today's row (idempotent: skip if date already exists)
if grep -q "^$DATE," "$CSV" 2>/dev/null; then
  echo "[$DATE] Row already exists in $CSV — skipping duplicate write"
else
  echo "$DATE,$STARS,$FORKS,$WATCHERS,$CLONES,$UNIQUE_CLONES,$VIEWS,$UNIQUE_VIEWS" >> "$CSV"
  echo "[$DATE] Logged: stars=$STARS forks=$FORKS watchers=$WATCHERS clones=$CLONES views=$VIEWS"
fi

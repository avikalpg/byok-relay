#!/bin/bash
# Daily metrics tracker for byok-relay
# Run via cron: captures GitHub stats and appends to metrics/daily.jsonl

DATE=$(date -u +%Y-%m-%d)
PAT=$(cat ~/.secrets/github_pat.txt)

# GitHub repo stats
REPO=$(curl -s \
  -H "Authorization: token $PAT" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/avikalpg/byok-relay")

STARS=$(echo "$REPO" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stargazers_count',0))")
FORKS=$(echo "$REPO" | python3 -c "import sys,json; print(json.load(sys.stdin).get('forks_count',0))")
WATCHERS=$(echo "$REPO" | python3 -c "import sys,json; print(json.load(sys.stdin).get('subscribers_count',0))")
OPEN_ISSUES=$(echo "$REPO" | python3 -c "import sys,json; print(json.load(sys.stdin).get('open_issues_count',0))")

# GitHub traffic (requires push access or higher)
TRAFFIC=$(curl -s \
  -H "Authorization: token $PAT" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/avikalpg/byok-relay/traffic/views" 2>/dev/null)
VIEWS=$(echo "$TRAFFIC" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('count',0))" 2>/dev/null || echo "N/A")
UNIQUE_VIEWS=$(echo "$TRAFFIC" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('uniques',0))" 2>/dev/null || echo "N/A")

CLONES=$(curl -s \
  -H "Authorization: token $PAT" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/avikalpg/byok-relay/traffic/clones" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('count',0))" 2>/dev/null || echo "N/A")

# Write to JSONL
METRICS_FILE="$(dirname "$0")/daily.jsonl"
echo "{\"date\":\"$DATE\",\"stars\":$STARS,\"forks\":$FORKS,\"watchers\":$WATCHERS,\"open_issues\":$OPEN_ISSUES,\"views_14d\":\"$VIEWS\",\"unique_views_14d\":\"$UNIQUE_VIEWS\",\"clones_14d\":\"$CLONES\"}" >> "$METRICS_FILE"

echo "[$DATE] stars=$STARS forks=$FORKS watchers=$WATCHERS views=$VIEWS clones=$CLONES"

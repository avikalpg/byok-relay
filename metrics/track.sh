#!/usr/bin/env bash
# metrics/track.sh — fetch and log byok-relay GitHub metrics
# Usage: ./metrics/track.sh
# Requires: ~/.secrets/github_pat.txt

set -e

REPO="avikalpg/byok-relay"
DATE=$(date -u +%Y-%m-%d)
PAT=$(cat ~/.secrets/github_pat.txt 2>/dev/null || echo "")

if [ -z "$PAT" ]; then
  echo "ERROR: GitHub PAT not found at ~/.secrets/github_pat.txt" >&2
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 is required but not installed" >&2
  exit 1
fi

# Fetch repo stats
REPO_RESPONSE=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $PAT" \
  "https://api.github.com/repos/$REPO")
REPO_HTTP=$(echo "$REPO_RESPONSE" | tail -n1)
REPO_DATA=$(echo "$REPO_RESPONSE" | sed '$d')
if [ "$REPO_HTTP" != "200" ]; then
  echo "ERROR: GitHub API returned HTTP $REPO_HTTP for repo stats" >&2
  exit 1
fi

STARS=$(echo "$REPO_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stargazers_count','?'))")
FORKS=$(echo "$REPO_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('forks_count','?'))")
OPEN_ISSUES=$(echo "$REPO_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('open_issues_count','?'))")

# Fetch traffic stats (requires push access)
VIEWS_RESPONSE=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $PAT" \
  "https://api.github.com/repos/$REPO/traffic/views")
VIEWS_HTTP=$(echo "$VIEWS_RESPONSE" | tail -n1)
VIEWS_DATA=$(echo "$VIEWS_RESPONSE" | sed '$d')
if [ "$VIEWS_HTTP" != "200" ]; then
  echo "ERROR: GitHub API returned HTTP $VIEWS_HTTP for traffic/views" >&2
  exit 1
fi
VIEWS=$(echo "$VIEWS_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('count','?'))")
UNIQUE_VISITORS=$(echo "$VIEWS_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('uniques','?'))")

CLONES_RESPONSE=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $PAT" \
  "https://api.github.com/repos/$REPO/traffic/clones")
CLONES_HTTP=$(echo "$CLONES_RESPONSE" | tail -n1)
CLONES_DATA=$(echo "$CLONES_RESPONSE" | sed '$d')
if [ "$CLONES_HTTP" != "200" ]; then
  echo "ERROR: GitHub API returned HTTP $CLONES_HTTP for traffic/clones" >&2
  exit 1
fi
CLONES=$(echo "$CLONES_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('count','?'))")
UNIQUE_CLONERS=$(echo "$CLONES_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('uniques','?'))")

# Output
echo "=== byok-relay metrics ($DATE) ==="
echo "Stars:           $STARS"
echo "Forks:           $FORKS"
echo "Open issues:     $OPEN_ISSUES"
echo "Views (14d):     $VIEWS (unique: $UNIQUE_VISITORS)"
echo "Clones (14d):    $CLONES (unique: $UNIQUE_CLONERS)"

# Append to log file
LOG_FILE="$(dirname "$0")/metrics.log"
echo "$DATE,stars=$STARS,forks=$FORKS,views=$VIEWS,unique_visitors=$UNIQUE_VISITORS,clones=$CLONES,unique_cloners=$UNIQUE_CLONERS" >> "$LOG_FILE"
echo ""
echo "Logged to $LOG_FILE"

#!/usr/bin/env bash
#
# Install Archestra Grafana dashboards. Idempotent — safe to re-run.

set -euo pipefail

# ──────────────────────────────────────────────
# Help / usage
# ──────────────────────────────────────────────
usage() {
  cat <<'EOF'
Install Archestra Grafana dashboards into an "Archestra" folder.
Idempotent — creates new dashboards or updates existing ones.

Usage:
  GRAFANA_URL=<url> GRAFANA_TOKEN=<token> ./install-dashboards.sh
  GRAFANA_URL=<url> GRAFANA_USER=<user> GRAFANA_PASS=<pass> ./install-dashboards.sh

Environment variables:
  GRAFANA_URL    Grafana base URL (default: http://localhost:3000)
  GRAFANA_TOKEN  Service Account token with Editor role or fixed:folders:writer RBAC role
  GRAFANA_USER   Basic auth username (alternative to GRAFANA_TOKEN)
  GRAFANA_PASS   Basic auth password (alternative to GRAFANA_TOKEN)

Examples:
  # Service Account token
  GRAFANA_URL=https://example.grafana.net GRAFANA_TOKEN=glsa_xxx ./install-dashboards.sh

  # Basic auth (local development)
  GRAFANA_URL=http://localhost:3000 GRAFANA_USER=admin GRAFANA_PASS=admin ./install-dashboards.sh

  # Remote install (no local clone needed)
  GRAFANA_URL=https://example.grafana.net GRAFANA_TOKEN=glsa_xxx \
    bash <(curl -sL https://raw.githubusercontent.com/archestra-ai/archestra/main/platform/dev/grafana/install-dashboards.sh)

Dashboards installed:
  - GenAI Observability    LLM request metrics, token usage, cost, latency, traces
  - MCP Monitoring         MCP tool call metrics, error rates, duration, traces
  - Agent Sessions         Session-level audit trail with LLM/MCP/log drill-down
  - Application Metrics    HTTP traffic, Node.js runtime health, resource usage
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"
GRAFANA_URL="${GRAFANA_URL%/}"  # strip trailing slash to avoid double-slash in API paths
GRAFANA_TOKEN="${GRAFANA_TOKEN:-}"
GRAFANA_USER="${GRAFANA_USER:-}"
GRAFANA_PASS="${GRAFANA_PASS:-}"
FOLDER_TITLE="Archestra"
FOLDER_UID="archestra-dashboards"

DASHBOARDS=(
  "genai-observability.json"
  "mcp-monitoring.json"
  "agent-sessions.json"
  "application-metrics.json"
)

GITHUB_RAW_BASE="https://raw.githubusercontent.com/archestra-ai/archestra/main/platform/dev/grafana/dashboards"

# ──────────────────────────────────────────────
# Auth header
# ──────────────────────────────────────────────
auth_header() {
  if [[ -n "$GRAFANA_TOKEN" ]]; then
    echo "Authorization: Bearer $GRAFANA_TOKEN"
  elif [[ -n "$GRAFANA_USER" && -n "$GRAFANA_PASS" ]]; then
    echo "Authorization: Basic $(echo -n "$GRAFANA_USER:$GRAFANA_PASS" | base64)"
  else
    echo "Error: Set GRAFANA_TOKEN or both GRAFANA_USER and GRAFANA_PASS" >&2
    echo "" >&2
    usage >&2
    exit 1
  fi
}

AUTH=$(auth_header)

# ──────────────────────────────────────────────
# Create or find the "Archestra" folder
# ──────────────────────────────────────────────
echo "Setting up folder '$FOLDER_TITLE'..."

# Check if folder already exists
check_code=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "$AUTH" "$GRAFANA_URL/api/folders/$FOLDER_UID")

if [[ "$check_code" == "200" ]]; then
  echo "  Folder already exists (uid: $FOLDER_UID)"
else
  # Create folder with stable UID
  create_response=$(curl -s -w "\n%{http_code}" \
    -X POST "$GRAFANA_URL/api/folders" \
    -H "Content-Type: application/json" \
    -H "$AUTH" \
    -d "{\"uid\": \"$FOLDER_UID\", \"title\": \"$FOLDER_TITLE\"}")
  create_code=$(echo "$create_response" | tail -1)
  if [[ "$create_code" != "200" ]]; then
    echo "  Error creating folder (HTTP $create_code): $(echo "$create_response" | sed '$d')" >&2
    exit 1
  fi
  echo "  Created folder (uid: $FOLDER_UID)"
fi

folder_uid="$FOLDER_UID"

# ──────────────────────────────────────────────
# Determine dashboard source (local files or GitHub)
# ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_DIR="$SCRIPT_DIR/dashboards"

get_dashboard_json() {
  local name="$1"
  if [[ -f "$LOCAL_DIR/$name" ]]; then
    cat "$LOCAL_DIR/$name"
  else
    curl -sL "$GITHUB_RAW_BASE/$name"
  fi
}

# ──────────────────────────────────────────────
# Import each dashboard (idempotent: creates or updates)
# ──────────────────────────────────────────────
echo ""
echo "Installing dashboards into '$FOLDER_TITLE' folder..."

created=0
updated=0
failed=0

for name in "${DASHBOARDS[@]}"; do
  dashboard_json=$(get_dashboard_json "$name")

  if [[ -z "$dashboard_json" ]]; then
    echo "  SKIP     $name (could not read file)"
    ((failed++))
    continue
  fi

  # Build the import payload: reset id/version, keep uid for idempotent upsert
  payload=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
d['id'] = None
d.pop('version', None)
payload = {
    'dashboard': d,
    'folderUid': '$folder_uid',
    'overwrite': True,
    'message': 'Installed by Archestra install-dashboards.sh'
}
print(json.dumps(payload))
" <<< "$dashboard_json")

  response=$(curl -s -w "\n%{http_code}" \
    -X POST "$GRAFANA_URL/api/dashboards/db" \
    -H "Content-Type: application/json" \
    -H "$AUTH" \
    -d "$payload")

  resp_code=$(echo "$response" | tail -1)
  resp_body=$(echo "$response" | sed '$d')

  if [[ "$resp_code" == "200" ]]; then
    slug=$(echo "$resp_body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('slug',''))" 2>/dev/null || echo "")
    version=$(echo "$resp_body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('version',0))" 2>/dev/null || echo "0")
    if [[ "$version" == "1" ]]; then
      echo "  CREATED  $name -> $GRAFANA_URL/d/$slug"
      ((created++))
    else
      echo "  UPDATED  $name (v$version) -> $GRAFANA_URL/d/$slug"
      ((updated++))
    fi
  else
    msg=$(echo "$resp_body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message','unknown error'))" 2>/dev/null || echo "$resp_body")
    echo "  FAIL     $name (HTTP $resp_code): $msg"
    ((failed++))
  fi
done

echo ""
echo "Done: $created created, $updated updated, $failed failed"

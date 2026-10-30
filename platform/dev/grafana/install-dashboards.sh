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
  GRAFANA_URL=<url> GRAFANA_TOKEN=<token> ./install-dashboards.sh [--postgres-provider <provider>]
  GRAFANA_URL=<url> GRAFANA_USER=<user> GRAFANA_PASS=<pass> ./install-dashboards.sh [--postgres-provider <provider>]

Options:
  --metrics-datasource <uid>      Prometheus data-source UID
  --traces-datasource <uid>       Tempo data-source UID (session investigation)
  --logs-datasource <uid>         Loki data-source UID (session logs)
  --kubernetes-datasource <uid>   Kubernetes Prometheus UID (defaults to metrics UID)
  --openappa-datasource <uid>     Standalone OpenAPPA Prometheus UID (defaults to metrics UID)
  --postgres-provider <provider>  PostgreSQL metrics provider for the Application Metrics dashboard.
                                  Determines which metric names are used in the PostgreSQL panels.
                                  Options:
                                    helm      Bitnami postgres_exporter sidecar (pg_* prefix) [default]
                                    otel      OTel Collector PostgreSQL Receiver (postgresql_* prefix)
                                              Works with any PostgreSQL: AWS RDS, Cloud SQL, Azure, self-hosted
                                    cloudsql  GCP Cloud Monitoring via Stackdriver Exporter
                                    azure     Azure Monitor for Azure Database for PostgreSQL

Environment variables:
  GRAFANA_URL    Grafana base URL (default: http://localhost:3000)
  GRAFANA_TOKEN  Service Account token with Editor role or fixed:folders:writer RBAC role
  GRAFANA_USER   Basic auth username (alternative to GRAFANA_TOKEN)
  GRAFANA_PASS   Basic auth password (alternative to GRAFANA_TOKEN)

Examples:
  # Service Account token (default: helm postgres_exporter metrics)
  GRAFANA_URL=https://example.grafana.net GRAFANA_TOKEN=glsa_xxx ./install-dashboards.sh

  # OTel PostgreSQL Receiver metrics (for RDS, Cloud SQL, or any direct DB connection)
  GRAFANA_URL=https://example.grafana.net GRAFANA_TOKEN=glsa_xxx ./install-dashboards.sh --postgres-provider otel

  # Basic auth (local development)
  GRAFANA_URL=http://localhost:3000 GRAFANA_USER=admin GRAFANA_PASS=admin ./install-dashboards.sh

  # Remote install (no local clone needed)
  GRAFANA_URL=https://example.grafana.net GRAFANA_TOKEN=glsa_xxx \
    bash <(curl -sL https://raw.githubusercontent.com/archestra-ai/archestra/main/platform/dev/grafana/install-dashboards.sh)

Dashboards installed:
  - LLM Proxy             Logical outcomes, inference latency, streaming and tokens
  - Costs & Limits         Estimated spend, cache use and observed limit enforcement
  - Agent Runtime          Fleet lifecycle, work health and optional Kubernetes resources
  - Guardrails & OpenAPPA   Embedded hook dispatches and optional standalone telemetry
  - MCP Monitoring         MCP tool call metrics, error rates and duration
  - Session Investigation  Session-level audit trail with LLM/MCP/log drill-down
  - Platform Health        HTTP traffic, Node.js runtime, task queue, PostgreSQL
  - Knowledge Base Operations  Connector syncs, embedding pipeline, query performance
EOF
}

# ──────────────────────────────────────────────
# Parse arguments
# ──────────────────────────────────────────────
PG_PROVIDER="helm"
METRICS_DS=""
TRACES_DS=""
LOGS_DS=""
KUBERNETES_DS=""
OPENAPPA_DS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --metrics-datasource|--traces-datasource|--logs-datasource|--kubernetes-datasource|--openappa-datasource)
      if [[ $# -lt 2 || -z "$2" ]]; then echo "Error: $1 requires a data-source UID" >&2; exit 1; fi
      case "$1" in
        --metrics-datasource) METRICS_DS="$2" ;;
        --traces-datasource) TRACES_DS="$2" ;;
        --logs-datasource) LOGS_DS="$2" ;;
        --kubernetes-datasource) KUBERNETES_DS="$2" ;;
        --openappa-datasource) OPENAPPA_DS="$2" ;;
      esac
      shift 2
      ;;
    --postgres-provider)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --postgres-provider requires a value (helm, otel, cloudsql, azure)" >&2
        exit 1
      fi
      PG_PROVIDER="$2"
      shift 2
      ;;
    --postgres-provider=*)
      PG_PROVIDER="${1#*=}"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# Validate provider
case "$PG_PROVIDER" in
  helm|otel|cloudsql|azure) ;;
  *)
    echo "Error: Invalid --postgres-provider '$PG_PROVIDER'. Must be one of: helm, otel, cloudsql, azure" >&2
    exit 1
    ;;
esac

GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"
GRAFANA_URL="${GRAFANA_URL%/}"  # strip trailing slash to avoid double-slash in API paths
GRAFANA_TOKEN="${GRAFANA_TOKEN:-}"
GRAFANA_USER="${GRAFANA_USER:-}"
GRAFANA_PASS="${GRAFANA_PASS:-}"
FOLDER_TITLE="Archestra"
FOLDER_UID="archestra-dashboards"

# Dashboard list — application-metrics uses provider-specific variant
if [[ "$PG_PROVIDER" == "helm" ]]; then
  APP_METRICS_FILE="application-metrics.json"
else
  APP_METRICS_FILE="application-metrics-${PG_PROVIDER}.json"
fi

DASHBOARDS=(
  "genai-observability.json"
  "costs-and-limits.json"
  "agent-runtime.json"
  "guardrails.json"
  "mcp-monitoring.json"
  "agent-sessions.json"
  "$APP_METRICS_FILE"
  "rag-knowledge-base.json"
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
# Keep authorization out of curl's process arguments; delete it on every exit.
auth_config=$(mktemp)
chmod 600 "$auth_config"
trap 'rm -f "$auth_config"' EXIT
printf 'header = "%s"\n' "$AUTH" > "$auth_config"
unset AUTH
export METRICS_DS TRACES_DS LOGS_DS KUBERNETES_DS OPENAPPA_DS

# ──────────────────────────────────────────────
# Create or find the "Archestra" folder
# ──────────────────────────────────────────────
echo "Setting up folder '$FOLDER_TITLE'..."

# Check if folder already exists
check_code=$(curl -s -o /dev/null -w "%{http_code}" \
  --config "$auth_config" "$GRAFANA_URL/api/folders/$FOLDER_UID")

if [[ "$check_code" == "200" ]]; then
  echo "  Folder already exists (uid: $FOLDER_UID)"
else
  # Create folder with stable UID
  create_response=$(curl -s -w "\n%{http_code}" \
    -X POST "$GRAFANA_URL/api/folders" \
    -H "Content-Type: application/json" \
    --config "$auth_config" \
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
  # For provider variants, check pg-variants subdirectory
  if [[ "$name" == "application-metrics-"* && -f "$LOCAL_DIR/pg-variants/$name" ]]; then
    cat "$LOCAL_DIR/pg-variants/$name"
  elif [[ -f "$LOCAL_DIR/$name" ]]; then
    cat "$LOCAL_DIR/$name"
  else
    # Try pg-variants path on GitHub for provider variants
    if [[ "$name" == "application-metrics-"* ]]; then
      curl -sfL "$GITHUB_RAW_BASE/pg-variants/$name"
    else
      curl -sfL "$GITHUB_RAW_BASE/$name"
    fi
  fi
}

# ──────────────────────────────────────────────
# Import each dashboard (idempotent: creates or updates)
# ──────────────────────────────────────────────
echo ""
echo "Installing dashboards into '$FOLDER_TITLE' folder..."
if [[ "$PG_PROVIDER" != "helm" ]]; then
  echo "  PostgreSQL metrics provider: $PG_PROVIDER"
fi

created=0
updated=0
failed=0

for name in "${DASHBOARDS[@]}"; do
  dashboard_json=$(get_dashboard_json "$name")

  if [[ -z "$dashboard_json" ]]; then
    echo "  SKIP     $name (could not read file)"
    ((failed+=1))
    continue
  fi

  # Build the import payload: reset id/version, keep uid for idempotent upsert
  payload=$(FOLDER_UID="$folder_uid" python3 -c "
import json, sys, os
d = json.loads(sys.stdin.read())
d['id'] = None
d.pop('version', None)
# Explicit UIDs bind portable dashboard definitions to this installation.
bindings = {
    'metrics_datasource': os.environ.get('METRICS_DS'),
    'traces_datasource': os.environ.get('TRACES_DS'),
    'logs_datasource': os.environ.get('LOGS_DS'),
    'kubernetes_datasource': os.environ.get('KUBERNETES_DS') or os.environ.get('METRICS_DS'),
    'openappa_datasource': os.environ.get('OPENAPPA_DS') or os.environ.get('METRICS_DS'),
}
for variable in d.get('templating', {}).get('list', []):
    uid = bindings.get(variable.get('name'))
    if uid:
        variable['current'] = {'text': uid, 'value': uid}
        variable['options'] = []
payload = {
    'dashboard': d,
    'folderUid': os.environ['FOLDER_UID'],
    'overwrite': True,
    'message': 'Installed by Archestra install-dashboards.sh'
}
print(json.dumps(payload))
" <<< "$dashboard_json")

  response=$(curl -s -w "\n%{http_code}" \
    -X POST "$GRAFANA_URL/api/dashboards/db" \
    -H "Content-Type: application/json" \
    --config "$auth_config" \
    -d "$payload")

  resp_code=$(echo "$response" | tail -1)
  resp_body=$(echo "$response" | sed '$d')

  if [[ "$resp_code" == "200" ]]; then
    dashboard_url=$(echo "$resp_body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('url',''))" 2>/dev/null || echo "")
    version=$(echo "$resp_body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('version',0))" 2>/dev/null || echo "0")
    if [[ "$version" == "1" ]]; then
      echo "  CREATED  $name -> $GRAFANA_URL$dashboard_url"
      ((created+=1))
    else
      echo "  UPDATED  $name (v$version) -> $GRAFANA_URL$dashboard_url"
      ((updated+=1))
    fi
  else
    msg=$(echo "$resp_body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message','unknown error'))" 2>/dev/null || echo "$resp_body")
    echo "  FAIL     $name (HTTP $resp_code): $msg"
    ((failed+=1))
  fi
done

echo ""
echo "Done: $created created, $updated updated, $failed failed"
if ((failed > 0)); then exit 1; fi

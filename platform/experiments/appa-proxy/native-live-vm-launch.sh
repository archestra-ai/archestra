#!/usr/bin/env bash
# Launch one sequential native live case after deployment-owned readiness.
set -euo pipefail

if [ "$#" -lt 4 ]; then
  printf 'usage: %s <claude|codex|opencode> <scenario> <agent-uuid> <native-proxy-url>\n' "$0" >&2
  exit 64
fi

client=$1
scenario=$2
agent_id=$3
proxy_url=$4
harness_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$client" in
  claude|codex|opencode) ;;
  *) printf 'unsupported client: %s\n' "$client" >&2; exit 64 ;;
esac
: "${APPA_NATIVE_LIVE_STATE_DIR:?set to the private fixture state directory}"
: "${APPA_NATIVE_LIVE_EVIDENCE_DIR:?set to a private evidence directory}"
: "${APPA_NATIVE_LIVE_FIXTURE_AUTH_FILE:?set to a mode-0600 fixture token reference}"
: "${APPA_NATIVE_LIVE_COLLECTOR_CONFIG_FILE:?set to a mode-0600 collector configuration reference}"
: "${APPA_NATIVE_LIVE_PROVIDER_KEYS_FILE:?set to a mode-0600 provider key reference}"

load_secret_reference() {
  local path=$1
  shift
  local line name value allowed found=" "
  [ -f "$path" ] && [ ! -L "$path" ] && [ "$(stat -c '%a' "$path")" = 600 ] || {
    printf '%s\n' "secret reference must be a regular mode-0600 file: $path" >&2
    exit 1
  }
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.+)$ ]] || {
      printf '%s\n' "secret reference must contain plain KEY=value entries: $path" >&2
      exit 1
    }
    name=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    case " $* " in
      *" $name "*) ;;
      *) printf '%s\n' "secret reference has an unexpected key: $name" >&2; exit 1 ;;
    esac
    [[ "$found" != *" $name "* ]] || {
      printf '%s\n' "secret reference has a duplicate key: $name" >&2
      exit 1
    }
    found+="$name "
    printf -v "$name" '%s' "$value"
    export "$name"
  done <"$path"
  for name in "$@"; do
    [[ "$found" == *" $name "* ]] || {
      printf '%s\n' "secret reference is missing required key: $name" >&2
      exit 1
    }
  done
}

# References are parsed as data, never evaluated as shell code.
load_secret_reference "$APPA_NATIVE_LIVE_FIXTURE_AUTH_FILE" APPA_NATIVE_FIXTURE_TOKEN APPA_NATIVE_FIXTURE_ADMIN_TOKEN
load_secret_reference "$APPA_NATIVE_LIVE_COLLECTOR_CONFIG_FILE" ARCHESTRA_NATIVE_LIVE_PG_PASSWORD
load_secret_reference "$APPA_NATIVE_LIVE_PROVIDER_KEYS_FILE" APPA_NATIVE_LIVE_ANTHROPIC_API_KEY APPA_NATIVE_LIVE_OPENAI_API_KEY APPA_NATIVE_LIVE_KIMI_API_KEY
: "${APPA_NATIVE_LIVE_ANTHROPIC_API_KEY:?missing transferred Anthropic key}"
: "${APPA_NATIVE_LIVE_OPENAI_API_KEY:?missing transferred OpenAI key}"
: "${APPA_NATIVE_LIVE_KIMI_API_KEY:?missing transferred Kimi key}"
: "${APPA_NATIVE_LIVE_EVIDENCE_MODE:=diagnostic}"
: "${APPA_NATIVE_LIVE_KUBECTL_CONTEXT:?set the Kubernetes context explicitly}"
: "${APPA_NATIVE_LIVE_RUNTIME_NAMESPACE:?set the runtime namespace explicitly}"
: "${APPA_NATIVE_LIVE_RUNTIME_SERVICE:?set the runtime service explicitly}"
: "${APPA_NATIVE_LIVE_RUNTIME_SERVICE_URL:?set the runtime service URL explicitly}"
: "${APPA_NATIVE_LIVE_RUNTIME_TRANSPORT_URL:?set the runtime transport URL explicitly}"
: "${APPA_NATIVE_LIVE_FIXTURE_NAMESPACE:?set the fixture namespace explicitly}"
: "${APPA_NATIVE_LIVE_FIXTURE_SERVICE:?set the fixture service explicitly}"
: "${APPA_NATIVE_LIVE_FIXTURE_URL:?set the fixture port-forward URL explicitly}"
: "${APPA_NATIVE_LIVE_FIXTURE_SERVICE_PORT:?set the fixture service port explicitly}"
: "${APPA_NATIVE_LIVE_BACKEND_READY_URL:?set the backend readiness URL explicitly}"
: "${APPA_NATIVE_LIVE_TILT_RESOURCE:?set the backend Tilt resource explicitly}"
: "${APPA_NATIVE_LIVE_TILT_VIEW_URL:?set the Tilt view API URL explicitly}"
: "${APPA_NATIVE_LIVE_RUNTIME_HOOK_URL:?set the configured runtime hook URL explicitly}"
: "${APPA_NATIVE_LIVE_RUNTIME_TOKEN:?set the runtime capability token explicitly}"
: "${APPA_NATIVE_LIVE_RUNTIME_SELECTOR:?set the runtime selector explicitly}"
: "${APPA_NATIVE_LIVE_RUNTIME_CONTAINER:?set the runtime container explicitly}"
: "${APPA_NATIVE_LIVE_RUNTIME_DB_PATH:?set the runtime SQLite path explicitly}"
: "${APPA_NATIVE_LIVE_PG_NAMESPACE:?set the PostgreSQL namespace explicitly}"
: "${APPA_NATIVE_LIVE_PG_SELECTOR:?set the PostgreSQL selector explicitly}"
: "${APPA_NATIVE_LIVE_PG_CONTAINER:?set the PostgreSQL container explicitly}"
: "${APPA_NATIVE_LIVE_PG_DATABASE:?set the PostgreSQL database explicitly}"
: "${APPA_NATIVE_LIVE_PG_USER:?set the PostgreSQL user explicitly}"
export ARCHESTRA_NATIVE_LIVE_PG_PASSWORD
export APPA_NATIVE_LIVE_PG_PASSWORD_ENV=ARCHESTRA_NATIVE_LIVE_PG_PASSWORD
run_id="run-$(date -u +%Y%m%dt%H%M%Sz)-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"

# The backend uses a loopback transport in development, so this launcher owns
# the matching service bridge instead of relying on a manually retained port-forward.
runtime_port_forward_pid=""
fixture_port_forward_pid=""
phase_trace_capture_pid=""
cleanup_runtime_port_forward() {
  if [ -n "$runtime_port_forward_pid" ]; then
    kill "$runtime_port_forward_pid" 2>/dev/null || true
    wait "$runtime_port_forward_pid" 2>/dev/null || true
  fi
  if [ -n "$fixture_port_forward_pid" ]; then
    kill "$fixture_port_forward_pid" 2>/dev/null || true
    wait "$fixture_port_forward_pid" 2>/dev/null || true
  fi
  if [ -n "$phase_trace_capture_pid" ]; then
    kill "$phase_trace_capture_pid" 2>/dev/null || true
    wait "$phase_trace_capture_pid" 2>/dev/null || true
  fi
}
trap cleanup_runtime_port_forward EXIT INT TERM

runtime_profile=${APPA_NATIVE_LIVE_RUNTIME_PROFILE:-}
runtime_service=$APPA_NATIVE_LIVE_RUNTIME_SERVICE
runtime_service_url=$APPA_NATIVE_LIVE_RUNTIME_SERVICE_URL
runtime_transport_url=$APPA_NATIVE_LIVE_RUNTIME_TRANSPORT_URL
runtime_transport_port=${runtime_transport_url##*:}
if [ -n "$runtime_profile" ]; then
  inventory="$(dirname "$runtime_profile")/inventory.json"
  if ! jq -e \
    --arg transport "$runtime_transport_url" \
    --arg service "${runtime_service_url#http://}" \
    '.runtimeUrl == $transport and .backendHookUrl == $transport and .runtimeForward.listener == ($transport | sub("^http://"; "")) and .service == $service' \
    "$inventory" >/dev/null; then
    printf '%s\n' 'isolated runtime profile does not attest its service-to-transport mapping' >&2
    exit 1
  fi
fi
backend_status=$(curl --silent --show-error --max-time 5 --output /dev/null \
  --write-out '%{http_code}' "$APPA_NATIVE_LIVE_BACKEND_READY_URL")
if [ "$backend_status" != "200" ]; then
  printf '%s\n' 'configured backend readiness endpoint is not ready' >&2
  exit 1
fi
if ! tilt get uiresources "$APPA_NATIVE_LIVE_TILT_RESOURCE" -o json | jq -e \
  '.status.runtimeStatus == "ok" and any(.status.conditions[]; .type == "Ready" and .status == "True")' \
  >/dev/null; then
  printf '%s\n' 'configured Tilt backend resource is not ready' >&2
  exit 1
fi
if ! kubectl --context "$APPA_NATIVE_LIVE_KUBECTL_CONTEXT" -n "$APPA_NATIVE_LIVE_RUNTIME_NAMESPACE" get service \
  "$runtime_service" >/dev/null || ! kubectl --context "$APPA_NATIVE_LIVE_KUBECTL_CONTEXT" -n "$APPA_NATIVE_LIVE_FIXTURE_NAMESPACE" get service \
  "$APPA_NATIVE_LIVE_FIXTURE_SERVICE" >/dev/null; then
  printf '%s\n' 'APPA runtime or native fixture service is unavailable' >&2
  exit 1
fi

# Capture backend stdout before the client starts. The reader accepts only JSON
# phase records and binds them to the collector's owner-scoped database rows.
phase_trace_log="$APPA_NATIVE_LIVE_STATE_DIR/backend-phase-trace-$run_id.jsonl"
phase_trace_cursor="$APPA_NATIVE_LIVE_STATE_DIR/backend-phase-trace-$run_id.cursor.json"
umask 077
: >"$phase_trace_log"
chmod 600 "$phase_trace_log"
python3 "$harness_dir/backend-phase-trace-reader.py" \
  --capture-preflight \
  --tilt-cursor-path "$phase_trace_cursor" \
  --tilt-resource "$APPA_NATIVE_LIVE_TILT_RESOURCE" \
  --log-path "$phase_trace_log" \
  >/dev/null
tilt logs --source runtime --follow "$APPA_NATIVE_LIVE_TILT_RESOURCE" >>"$phase_trace_log" 2>&1 &
phase_trace_capture_pid=$!
export APPA_NATIVE_LIVE_PHASE_TRACE_CAPTURE_PID="$phase_trace_capture_pid"
export APPA_NATIVE_LIVE_PHASE_TRACE_LOG="$phase_trace_log"
export APPA_NATIVE_LIVE_PHASE_TRACE_CURSOR="$phase_trace_cursor"

if ! lsof -iTCP:"$runtime_transport_port" -sTCP:LISTEN >/dev/null 2>&1; then
  kubectl --context "$APPA_NATIVE_LIVE_KUBECTL_CONTEXT" -n "$APPA_NATIVE_LIVE_RUNTIME_NAMESPACE" port-forward --address 127.0.0.1 \
    "service/$runtime_service" "$runtime_transport_port:18787" \
    >"$APPA_NATIVE_LIVE_STATE_DIR/runtime-port-forward.log" 2>&1 &
  runtime_port_forward_pid=$!
fi
fixture_transport_port=${APPA_NATIVE_LIVE_FIXTURE_URL##*:}
if ! [[ "$fixture_transport_port" =~ ^[0-9]{1,5}$ ]]; then
  printf '%s\n' 'fixture URL must end with its explicit local TCP port' >&2
  exit 1
fi
if ! lsof -iTCP:"$fixture_transport_port" -sTCP:LISTEN >/dev/null 2>&1; then
  kubectl --context "$APPA_NATIVE_LIVE_KUBECTL_CONTEXT" -n "$APPA_NATIVE_LIVE_FIXTURE_NAMESPACE" port-forward --address 127.0.0.1 \
    "service/$APPA_NATIVE_LIVE_FIXTURE_SERVICE" "$fixture_transport_port:$APPA_NATIVE_LIVE_FIXTURE_SERVICE_PORT" \
    >"$APPA_NATIVE_LIVE_STATE_DIR/fixture-port-forward.log" 2>&1 &
  fixture_port_forward_pid=$!
fi

for _ in $(seq 1 30); do
  runtime_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --max-time 1 "$runtime_transport_url/health" || true)
  if [ "$runtime_status" = "200" ]; then
    break
  fi
  sleep 1
done
if [ "${runtime_status:-000}" != "200" ]; then
  printf '%s\n' 'native APPA runtime port-forward did not become ready' >&2
  exit 1
fi

# A health response does not prove the authenticated proxy-v1 protocol the
# backend actually uses. These deployment inputs are explicit so no workstation
# environment file is evaluated before a provider invocation.
runtime_hook_url=$APPA_NATIVE_LIVE_RUNTIME_HOOK_URL
runtime_token=$APPA_NATIVE_LIVE_RUNTIME_TOKEN
capability_record="$APPA_NATIVE_LIVE_STATE_DIR/runtime-capabilities-$run_id.json"
capability_body=$(mktemp "$APPA_NATIVE_LIVE_STATE_DIR/runtime-capabilities-$run_id.XXXXXX")
chmod 600 "$capability_body"
capability_status=$(curl --silent --show-error --max-time 5 --output "$capability_body" \
  --write-out '%{http_code}' -H "Authorization: Bearer $runtime_token" \
  "$runtime_transport_url/proxy/v1/capabilities" || true)
capability_valid=false
if python3 - "$capability_record" "$capability_body" "$runtime_hook_url" "$runtime_transport_url" "$capability_status" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

record_path = Path(sys.argv[1])
body = Path(sys.argv[2]).read_bytes()
hook_url, transport_url, status = sys.argv[3:]
record = {
    "hook_url": hook_url,
    "runtime_transport_url": transport_url,
    "http_status": status,
    "body_sha256": hashlib.sha256(body).hexdigest(),
}
capabilities = None
try:
    capabilities = json.loads(body)
except json.JSONDecodeError:
    record["response_json"] = False
else:
    record["response_json"] = isinstance(capabilities, dict)
    if isinstance(capabilities, dict):
        record["capabilities"] = {
            key: capabilities.get(key)
            for key in (
                "protocol_version",
                "legacy_hooks",
                "completed_event_replay",
                "typed_offers",
                "restriction_acceptance",
                "human_approval",
                "approval_grants",
                "sanitized_results",
                "child_workflows",
                "child_actor_targeting",
            )
        }
valid = (
    hook_url == transport_url
    and status == "200"
    and isinstance(capabilities, dict)
    and capabilities.get("protocol_version") == 1
    and capabilities.get("legacy_hooks") is False
    and capabilities.get("completed_event_replay") is True
    and capabilities.get("typed_offers") is True
    and capabilities.get("sanitized_results") is True
)
record["valid"] = valid
record_path.write_text(json.dumps(record, sort_keys=True) + "\n", encoding="utf-8")
raise SystemExit(0 if valid else 1)
PY
then
  capability_valid=true
fi
rm -f "$capability_body"
if [ "$capability_valid" != true ]; then
  printf '%s\n' "authenticated runtime capability preflight failed; see $capability_record" >&2
  exit 1
fi
for _ in $(seq 1 30); do
  fixture_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --max-time 1 "$APPA_NATIVE_LIVE_FIXTURE_URL/health" || true)
  if [ "$fixture_status" = "200" ]; then
    break
  fi
  sleep 1
done
if [ "${fixture_status:-000}" != "200" ]; then
  printf '%s\n' 'native fixture port-forward did not become ready' >&2
  exit 1
fi

runner_args=(
  --execute
  --client "$client"
  --evidence-mode "$APPA_NATIVE_LIVE_EVIDENCE_MODE"
  --run-id "$run_id"
  --scenario "$scenario"
  --agent-id "$agent_id"
  --proxy-url "$proxy_url"
  --expected-proxy-url "$proxy_url"
  --runtime-service-url "$runtime_service_url"
  --runtime-transport-url "$runtime_transport_url"
  --allow-dev-loopback-runtime-transport
  --fixture-url "$APPA_NATIVE_LIVE_FIXTURE_URL"
  --runtime-evidence-command "bash $harness_dir/backend-phase-trace-reader.sh"
  --evidence-dir "$APPA_NATIVE_LIVE_EVIDENCE_DIR"
)
if [ -n "$runtime_profile" ]; then
  runner_args+=(--runtime-profile "$runtime_profile")
fi

if [ "$APPA_NATIVE_LIVE_EVIDENCE_MODE" != "qualifying" ]; then
  if [ -n "${APPA_NATIVE_LIVE_CLIENT_BIN:-}" ]; then
    runner_args+=(--client-bin "$APPA_NATIVE_LIVE_CLIENT_BIN")
  fi
else
  : "${APPA_NATIVE_LIVE_STOCK_PROVENANCE:?qualifying runs require a stock provenance manifest}"
  : "${APPA_NATIVE_LIVE_GATEWAY_PROFILE:?qualifying runs require a gateway profile}"
  runner_args+=(--stock-provenance "$APPA_NATIVE_LIVE_STOCK_PROVENANCE" --gateway-profile "$APPA_NATIVE_LIVE_GATEWAY_PROFILE")
  if [ -n "${APPA_NATIVE_LIVE_STOCK_CLIENT_BIN:-}" ]; then
    runner_args+=(--stock-client-bin "$APPA_NATIVE_LIVE_STOCK_CLIENT_BIN")
  fi
  if [ -n "${APPA_NATIVE_LIVE_GATEWAY_TOKEN_FILE:-}" ]; then
    runner_args+=(--gateway-token-file "$APPA_NATIVE_LIVE_GATEWAY_TOKEN_FILE")
  fi
fi

python3 "$harness_dir/native-live-runner.py" "${runner_args[@]}" "${@:5}"

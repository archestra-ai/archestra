#!/usr/bin/env bash
# Deployment-owned command consumed by native-live-runner --runtime-evidence-command.
set -euo pipefail

harness_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${APPA_NATIVE_LIVE_STATE_DIR:?set to the private fixture state directory}"

log_path="${APPA_NATIVE_LIVE_PHASE_TRACE_LOG:-$APPA_NATIVE_LIVE_STATE_DIR/backend-phase-trace.jsonl}"
collector_args=()
append_option() {
  local environment_name=$1
  local option=$2
  if [ -n "${!environment_name:-}" ]; then
    collector_args+=("$option" "${!environment_name}")
  fi
}

append_option APPA_NATIVE_LIVE_KUBECTL --kubectl
append_option APPA_NATIVE_LIVE_KUBECTL_CONTEXT --kubectl-context
append_option APPA_NATIVE_LIVE_RUNTIME_NAMESPACE --runtime-namespace
append_option APPA_NATIVE_LIVE_RUNTIME_SELECTOR --runtime-selector
append_option APPA_NATIVE_LIVE_RUNTIME_CONTAINER --runtime-container
append_option APPA_NATIVE_LIVE_RUNTIME_DB_PATH --runtime-db-path
append_option APPA_NATIVE_LIVE_REVIEW_AUDIT_CONTAINER --review-audit-container
append_option APPA_NATIVE_LIVE_REVIEW_AUDIT_PATH --review-audit-path
append_option APPA_NATIVE_LIVE_PG_NAMESPACE --pg-namespace
append_option APPA_NATIVE_LIVE_PG_SELECTOR --pg-selector
append_option APPA_NATIVE_LIVE_PG_CONTAINER --pg-container
append_option APPA_NATIVE_LIVE_PG_DATABASE --pg-database
append_option APPA_NATIVE_LIVE_PG_USER --pg-user
append_option APPA_NATIVE_LIVE_PG_PASSWORD_ENV --pg-password-env
exec python3 "$harness_dir/backend-phase-trace-reader.py" \
  --collector "$harness_dir/native-live-collector.py" \
  --log-path "$log_path" \
  "${collector_args[@]}" \
  "$@"

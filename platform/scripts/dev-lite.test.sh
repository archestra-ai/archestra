#!/usr/bin/env bash
# Checks of scripts/dev-lite.sh that need no running stack: the script is
# sourced for its functions, the processes and HTTP probes are stubbed, and
# the decisions a stack makes from them are asserted. Run from platform/:
#   bash scripts/dev-lite.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ARCHESTRA_DEV_LITE_STATE_DIR
ARCHESTRA_DEV_LITE_STATE_DIR="$(mktemp -d)"
trap 'rm -rf "$ARCHESTRA_DEV_LITE_STATE_DIR"' EXIT
# shellcheck source=dev-lite.sh
source "$SCRIPT_DIR/dev-lite.sh"
mkdir -p "$LOG_DIR"
# A stack without a cluster: the kubeconfig `up` writes does not exist.
ENV_FILE="$ARCHESTRA_DEV_LITE_STATE_DIR/env"
printf 'ARCHESTRA_ORCHESTRATOR_KUBECONFIG=%s/no-kubernetes.kubeconfig\n' "$ARCHESTRA_DEV_LITE_STATE_DIR" > "$ENV_FILE"

# --- stubs -----------------------------------------------------------------
ALIVE="backend frontend wiremock a2a" # the tmux sessions that exist
KEYCLOAK_ANSWERS=1                    # whether the realm endpoint answers
session_alive() { case " $ALIVE " in *" $1 "*) return 0 ;; esac; return 1; }
http_ok() { return 0; }
keycloak_ready() { [ "$KEYCLOAK_ANSWERS" = 1 ]; }
db_ready() { return 0; }
tmx() { return 0; }
log() { :; }
# `e2e` ends in `exec pnpm ...`: a pnpm on PATH that prints what it got.
FAKE_BIN="$ARCHESTRA_DEV_LITE_STATE_DIR/bin"
mkdir -p "$FAKE_BIN"
printf '#!/usr/bin/env bash\necho "E2E_UNAVAILABLE=${E2E_UNAVAILABLE-unset} E2E_KEYCLOAK_BACKEND_URL=${E2E_KEYCLOAK_BACKEND_URL-unset} args: $*"\n' > "$FAKE_BIN/pnpm"
chmod +x "$FAKE_BIN/pnpm"

failures=0
check() {
  local name="$1"
  shift
  if "$@"; then echo "ok   $name"; else echo "FAIL $name"; failures=$((failures + 1)); fi
}
fails() { ! "$@"; }
# Captured first: with pipefail, `grep -q` closing the pipe would fail a pipeline.
says() {
  local text="$1" out
  shift
  out="$("$@" 2>&1 || true)"
  grep -q "$text" <<<"$out"
}
wait_ready_quietly() { (ARCHESTRA_DEV_LITE_TIMEOUT_SECONDS=2 wait_ready >/dev/null 2>&1); }
wait_ready_loudly() { (ARCHESTRA_DEV_LITE_TIMEOUT_SECONDS=2 wait_ready) || true; }
e2e_output() { (PATH="$FAKE_BIN:$PATH" cmd_e2e 2>&1) || true; }
e2e_succeeds() { (PATH="$FAKE_BIN:$PATH" cmd_e2e >/dev/null 2>&1); }

# --- readiness -------------------------------------------------------------
rm -f "$KEYCLOAK_REQUESTED_FILE"
check "ready without Keycloak when none was requested" wait_ready_quietly

touch "$KEYCLOAK_REQUESTED_FILE"
KEYCLOAK_ANSWERS=0
check "not ready while a requested Keycloak has exited" fails wait_ready_quietly
check "the failure names Keycloak's log" says "keycloak exited" wait_ready_loudly

ALIVE="$ALIVE keycloak"
KEYCLOAK_ANSWERS=1
check "ready once the requested Keycloak runs and answers" wait_ready_quietly

# Keycloak answers on the first poll, then exits before the backend is ready
# on the second: the cached readiness must not hide the exit.
stale_keycloak() {
  (
    POLL=0
    http_ok() {
      case "$1" in
        */ready) POLL=$((POLL + 1)); [ "$POLL" -ge 2 ] ;;
        *) return 0 ;;
      esac
    }
    session_alive() { if [ "$1" = keycloak ] && [ "$POLL" -ge 2 ]; then return 1; fi; return 0; }
    ARCHESTRA_DEV_LITE_TIMEOUT_SECONDS=20 wait_ready
  ) 2>&1
}
check "not ready when Keycloak answered, then exited before the backend was ready" fails stale_keycloak
check "that failure names Keycloak's log too" says "keycloak exited" stale_keycloak

# --- e2e -------------------------------------------------------------------
ALIVE="backend frontend wiremock a2a"
check "e2e refuses to run while a requested Keycloak is not running" fails e2e_succeeds
check "the refusal says so" says "Keycloak was requested but is not running" e2e_output

ALIVE="$ALIVE keycloak"
out="$(e2e_output)"
check "e2e with Keycloak: only Kubernetes is unavailable" grep -q "E2E_UNAVAILABLE=kubernetes " <<<"$out"
check "e2e with Keycloak: the backend-side URL is the loopback" grep -q "E2E_KEYCLOAK_BACKEND_URL=http://127.0.0.1:$KEYCLOAK_PORT " <<<"$out"
check "e2e with Keycloak: the identity-providers project runs" grep -q -- "--project=identity-providers" <<<"$out"

rm -f "$KEYCLOAK_REQUESTED_FILE"
ALIVE="backend frontend wiremock a2a"
out="$(e2e_output)"
check "e2e without Keycloak: both unavailable" grep -q "E2E_UNAVAILABLE=kubernetes,keycloak " <<<"$out"
check "e2e without Keycloak: no backend-side Keycloak URL" grep -q "E2E_KEYCLOAK_BACKEND_URL=unset " <<<"$out"
check "e2e without Keycloak: no identity-providers project" fails grep -q -- "--project=identity-providers" <<<"$out"
out="$(E2E_UNAVAILABLE= e2e_output)"
check "a value set by hand wins, even an empty one" grep -q "E2E_UNAVAILABLE= " <<<"$out"

# --- down --------------------------------------------------------------------
touch "$KEYCLOAK_REQUESTED_FILE"
ALIVE=""
(cmd_down >/dev/null 2>&1)
check "down drops the Keycloak request" test ! -e "$KEYCLOAK_REQUESTED_FILE"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all checks passed"

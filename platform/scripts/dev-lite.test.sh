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
# The line number of the first line of $1 matching $2.
order_of() { awk -v want="$2" '$0 ~ want { print NR; exit }' <<<"$1"; }
wait_ready_quietly() { (ARCHESTRA_DEV_LITE_TIMEOUT_SECONDS=2 wait_ready >/dev/null 2>&1); }
wait_ready_loudly() { (ARCHESTRA_DEV_LITE_TIMEOUT_SECONDS=2 wait_ready) || true; }
e2e_output() { (PATH="$FAKE_BIN:$PATH" cmd_e2e 2>&1) || true; }
e2e_succeeds() { (PATH="$FAKE_BIN:$PATH" cmd_e2e >/dev/null 2>&1); }

# --- readiness -------------------------------------------------------------
never_started() { (ALIVE=""; ARCHESTRA_DEV_LITE_TIMEOUT_SECONDS=2 wait_ready) 2>&1 || true; }
check "wait before the servers were ever started says to run up" grep -q "only prepared" <<<"$(never_started)"
check "a stack an older dev-lite.sh started counts as started" wait_ready_quietly
marker_of() { (ALIVE=""; tmx() { return 0; }; start_session backend /tmp true; cat "$SERVERS_FILE"); }
check "starting a server records the checkout it serves" test "$(marker_of)" = "$PLATFORM_DIR"
touch "$SERVERS_FILE"
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

# --- modes -------------------------------------------------------------------
# Each case runs in a subshell with its own environment: a test run inside an
# Agent Runtime must not see the pod's variables.
outside() { (unset ARCHESTRA_AGENT_RUNTIME_TASK_ID ARCHESTRA_DEV_LITE_FRONTEND ARCHESTRA_DEV_LITE_SOURCE_MAPS; "$@"); }
inside() { (unset ARCHESTRA_DEV_LITE_FRONTEND ARCHESTRA_DEV_LITE_SOURCE_MAPS; export ARCHESTRA_AGENT_RUNTIME_TASK_ID=task; "$@"); }
gives() { local want="$1" got; shift; got="$("$@" 2>/dev/null)" || return 1; [ "$got" = "$want" ]; }
with_frontend() { local value="$1"; shift; ARCHESTRA_DEV_LITE_FRONTEND="$value" "$@"; }
with_maps() { local value="$1"; shift; ARCHESTRA_DEV_LITE_SOURCE_MAPS="$value" "$@"; }

check "outside an Agent Runtime the frontend is the dev server" gives dev outside default_frontend_mode
check "inside one it is a production build" gives build inside default_frontend_mode
check "ARCHESTRA_DEV_LITE_FRONTEND chooses" gives dev inside with_frontend dev default_frontend_mode
check "an unknown frontend mode is refused" fails inside with_frontend fast default_frontend_mode
check "outside an Agent Runtime the backend keeps source maps" gives " --enable-source-maps" outside backend_node_flags
check "inside one it runs without them" gives "" inside backend_node_flags
check "ARCHESTRA_DEV_LITE_SOURCE_MAPS chooses" gives " --enable-source-maps" inside with_maps true backend_node_flags
check "an unknown source-maps value is refused" fails inside with_maps yes backend_node_flags
check "inside an Agent Runtime the frontend builds without source maps" gives "ARCHESTRA_DEV_LITE_SOURCE_MAPS=false " inside frontend_build_env
check "outside one the frontend build keeps them" gives "" outside frontend_build_env
check "ARCHESTRA_DEV_LITE_SOURCE_MAPS chooses the frontend build's too" gives "" inside with_maps true frontend_build_env
check "and turns them off outside an Agent Runtime" gives "ARCHESTRA_DEV_LITE_SOURCE_MAPS=false " outside with_maps false frontend_build_env
check "an unknown source-maps value stops the frontend build" fails inside with_maps yes frontend_build_env

# start_frontend builds for every mode but dev, and records the mode, which
# `reload frontend` starts again.
frontend_start() {
  (
    ALIVE=""
    free_ports() { :; }
    build_frontend() { echo built; }
    start_session() { echo "started in $2"; }
    start_frontend "$1"
    echo "mode $(frontend_mode)"
  )
}
out="$(frontend_start build)"
check "build mode builds, then serves the standalone server" grep -q "started in $STANDALONE_DIR" <<<"$out"
check "build mode is recorded" grep -q "mode build" <<<"$(frontend_start build)"
check "dev mode builds nothing" fails grep -qx built <<<"$(frontend_start dev)"
check "dev mode is recorded" grep -q "mode dev" <<<"$(frontend_start dev)"
# A build whose static files cannot be copied next to its server fails, also
# under a caller's `if`, which switches errexit off inside build_frontend.
uncopied_build() {
  (
    scratch="$ARCHESTRA_DEV_LITE_STATE_DIR/uncopied"
    PLATFORM_DIR="$scratch/platform"
    STANDALONE_DIR="$scratch/standalone"
    mkdir -p "$PLATFORM_DIR/frontend" "$STANDALONE_DIR" "$scratch/bin"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$scratch/bin/node"
    chmod +x "$scratch/bin/node"
    PATH="$scratch/bin:$PATH"
    frontend_prebuilt() { return 1; }
    if build_frontend; then echo "build reported success"; fi
  ) 2>&1 || true
}
out="$(uncopied_build)"
check "a frontend build without its static files fails" grep -q "could not copy" <<<"$out"
check "even inside an if" fails grep -q "reported success" <<<"$out"
# A clean checkout whose build CI published installs it; anything else builds,
# from CI's build cache when one is published for its configuration.
prebuilt_build() {
  (
    scratch="$ARCHESTRA_DEV_LITE_STATE_DIR/prebuilt"
    PLATFORM_DIR="$scratch/platform"
    STANDALONE_DIR="$scratch/standalone"
    mkdir -p "$PLATFORM_DIR/frontend/.next/static" "$PLATFORM_DIR/frontend/public" "$STANDALONE_DIR/.next"
    frontend_prebuilt() { echo "prebuilt $1"; [ "$1" = install ] && [ "$PUBLISHED" = 1 ]; }
    frontend_build_node() { echo "next build"; }
    build_frontend
    cat "$LOG_DIR/frontend-build.log"
  ) 2>&1
}
: > "$LOG_DIR/frontend-build.log"
out="$(PUBLISHED=1 prebuilt_build)"
check "a published frontend is installed" grep -qx "prebuilt install" <<<"$out"
check "instead of built" fails grep -q "next build\|install-cache" <<<"$out"
: > "$LOG_DIR/frontend-build.log"
out="$(PUBLISHED=0 prebuilt_build)"
check "an unpublished one builds" grep -qx "next build" <<<"$out"
check "after seeding the build cache" test "$(order_of "$out" "^prebuilt install-cache")" -lt "$(order_of "$out" "^next build")"

# --- start order, prepare, pause --------------------------------------------
# Every step echoes its name; the builds and servers act on a scratch platform
# directory, so `keep` finds builds there and nothing touches the checkout.
lifecycle() {
  (
    ALIVE="${LIFE_ALIVE:-}"
    export ARCHESTRA_AGENT_RUNTIME_TASK_ID=task
    unset ARCHESTRA_DEV_LITE_FRONTEND ARCHESTRA_DEV_BACKEND_WATCH
    scratch="$ARCHESTRA_DEV_LITE_STATE_DIR/scratch-${BUILT:-1}"
    PLATFORM_DIR="$scratch/platform"
    STANDALONE_DIR="$scratch/standalone"
    mkdir -p "$PLATFORM_DIR/backend/dist" "$STANDALONE_DIR"
    if [ "${BUILT:-1}" = 1 ]; then
      touch "$PLATFORM_DIR/backend/dist/server.mjs" "$STANDALONE_DIR/server.js"
    fi
    require_platform_dir() { :; }
    for step in ensure_env install_dependencies install_native_addons start_postgres wait_for_db migrate \
      build_native_addons build_frontend build_backend wait_ready; do
      eval "$step() { echo \"$step \${1:-}\"; }"
    done
    # LIFE_FAIL: the stubbed steps that fail.
    for step in ${LIFE_FAIL:-}; do
      eval "$step() { echo \"$step failed\"; return 1; }"
    done
    # NATIVE_MISSING: crates whose prebuilt addon was not found.
    missing_native_addons() { if [ -n "${NATIVE_MISSING:-}" ]; then echo "$NATIVE_MISSING"; fi; }
    stop_session() { echo "stop_session $1"; ALIVE="${ALIVE// $1/}"; }
    free_ports() { :; }
    start_session() { echo "server $1"; ALIVE="$ALIVE $1"; }
    "$@"
  ) 2>&1
}
rm -f "$PAUSED_FILE" "$SERVERS_FILE"
out="$(lifecycle cmd_start 1)"
check "up builds the frontend before the backend" test "$(order_of "$out" "^build_frontend")" -lt "$(order_of "$out" "^build_backend")"
check "up builds both before starting a server" test "$(order_of "$out" "^build_backend")" -lt "$(order_of "$out" "^server backend")"
check "up starts the backend, then the frontend" test "$(order_of "$out" "^server backend")" -lt "$(order_of "$out" "^server frontend")"
check "up builds the frontend once" test "$(grep -c "^build_frontend" <<<"$out")" -eq 1
backend_running_up() { (session_alive() { [ "$1" = backend ]; }; lifecycle cmd_start 1); }
out="$(backend_running_up)"
check "up stops a running backend before the frontend builds" test "$(order_of "$out" "^stop_session backend")" -lt "$(order_of "$out" "^build_frontend")"
check "and does not rebuild that backend" fails grep -q "^build_backend" <<<"$out"
out="$(NATIVE_MISSING=app-runtime-rs LIFE_ALIVE=" backend" lifecycle cmd_start 1)"
check "up builds missing native addons first, with no server running" \
  test "$(order_of "$out" "^stop_session backend")" -lt "$(order_of "$out" "^build_native_addons")"
check "then the frontend" test "$(order_of "$out" "^build_native_addons")" -lt "$(order_of "$out" "^build_frontend")"

out="$(lifecycle cmd_prepare)"
check "prepare migrates" grep -q "^migrate" <<<"$out"
check "prepare builds nothing" fails grep -q "^build_" <<<"$out"
out="$(NATIVE_MISSING=app-runtime-rs lifecycle cmd_prepare)"
check "prepare leaves native addons without a prebuilt one to up" fails grep -q "^build_" <<<"$out"
check "prepare starts no server" fails grep -q "^server" <<<"$out"

paused_lifecycle() { printf 'frontend=%s\nbackend=1\n' "${PAUSED_MODE:-build}" > "$PAUSED_FILE"; lifecycle "$@"; }
out="$(paused_lifecycle cmd_start 1)"
check "up after pause serves the builds it has" fails grep -q "^build_" <<<"$out"
check "up after pause starts both servers" test "$(grep -c "^server" <<<"$out")" -eq 2
check "up clears the pause" test ! -f "$PAUSED_FILE"
out="$(BUILT=0 paused_lifecycle cmd_start 1)"
check "up after pause builds what is missing, before any server starts" test "$(order_of "$out" "^build_frontend")" -lt "$(order_of "$out" "^server backend")"
out="$(PAUSED_MODE=dev paused_lifecycle cmd_start 1)"
check "up after pausing another frontend mode builds this one" grep -q "^build_frontend" <<<"$out"

running_pause() { (session_alive() { return 0; }; lifecycle cmd_pause); }
out="$(running_pause)"
check "pause stops both servers" test "$(grep -c "^stop_session" <<<"$out")" -eq 2
check "pause records the pause" test -f "$PAUSED_FILE"
check "pause says how to resume" grep -q "archestra-dev-lite resume" <<<"$out"
resume_paused() { (db_ready() { return 0; }; lifecycle cmd_resume); }
running_pause >/dev/null
out="$(resume_paused)"
check "resume builds nothing" fails grep -q "^build_" <<<"$out"
check "resume starts both servers" test "$(grep -c "^server" <<<"$out")" -eq 2
check "resume clears the pause" test ! -f "$PAUSED_FILE"
check "resume without a pause does nothing" grep -q "not paused" <<<"$(resume_paused)"
printf 'frontend=none\nbackend=1\n' > "$PAUSED_FILE"
out="$(resume_paused)"
check "resume of a backend-only pause starts only the backend" test "$(grep -c "^server" <<<"$out")" -eq 1
printf 'frontend=build\nbackend=0\n' > "$PAUSED_FILE"
out="$(resume_paused)"
check "resume of a frontend-only pause starts only the frontend" test "$(grep "^server" <<<"$out")" = "server frontend"
printf 'frontend=build\nbackend=1\n' > "$PAUSED_FILE"
out="$( (BUILT=0; db_ready() { return 0; }; lifecycle cmd_resume) )"
check "resume makes a missing build before either server starts" test "$(order_of "$out" "^build_frontend")" -lt "$(order_of "$out" "^server backend")"
printf 'frontend=build\nbackend=1\n' > "$PAUSED_FILE"
( (db_ready() { return 0; }; start_backend() { return 1; }; lifecycle cmd_resume) >/dev/null 2>&1 ) || true
check "a failed resume keeps the pause" grep -q "^frontend=build" "$PAUSED_FILE"
printf 'frontend=build\nbackend=0\n' > "$PAUSED_FILE"
no_frontend_session() { start_session() { if [ "$1" = frontend ]; then return 1; fi; echo "server $1"; }; "$@"; }
( (db_ready() { return 0; }; lifecycle no_frontend_session cmd_resume) >/dev/null 2>&1 ) || true
check "a resume whose frontend session does not start keeps the pause" grep -q "^frontend=build" "$PAUSED_FILE"
rm -f "$PAUSED_FILE"
reload_beside_backend() { (frontend_mode() { echo build; }; LIFE_ALIVE=" backend" lifecycle cmd_reload frontend); }
out="$(reload_beside_backend)"
check "a production frontend reload stops the backend before it builds" test "$(order_of "$out" "^stop_session backend")" -lt "$(order_of "$out" "^build_frontend")"
check "and starts it again before the frontend" test "$(order_of "$out" "^server backend")" -lt "$(order_of "$out" "^server frontend")"
reload_backend_beside_frontend() { (frontend_mode() { echo build; }; LIFE_ALIVE=" frontend" lifecycle cmd_reload backend); }
out="$(reload_backend_beside_frontend)"
check "a backend reload stops the frontend before it builds" test "$(order_of "$out" "^stop_session frontend")" -lt "$(order_of "$out" "^build_backend")"
check "and starts it again after the backend, from its build" test "$(order_of "$out" "^server backend")" -lt "$(order_of "$out" "^server frontend")"
check "without building the frontend" fails grep -q "^build_frontend" <<<"$out"
# A one-server resume waits only for that server, through the real readiness
# check, in a shell of its own with the script's error-on-exit (a check's `if`
# would switch it off).
real_wait_resume() {
  bash -c '
    source "$1/dev-lite.sh"
    session_alive() { case " $ALIVE " in *" $1 "*) return 0 ;; esac; return 1; }
    ALIVE=""
    db_ready() { return 0; }
    build_frontend() { echo build_frontend >&2; }
    build_backend() { echo build_backend >&2; }
    start_backend() { ALIVE="$ALIVE backend"; }
    start_frontend() { ALIVE="$ALIVE frontend"; }
    http_ok() { return 0; }
    log() { :; }
    ARCHESTRA_DEV_LITE_TIMEOUT_SECONDS=5 cmd_resume
  ' real-wait "$SCRIPT_DIR" > /dev/null 2>&1
}
touch "$SERVERS_FILE"
printf 'frontend=build\nbackend=0\n' > "$PAUSED_FILE"
check "a frontend-only resume is ready without the backend" real_wait_resume
printf 'frontend=none\nbackend=1\n' > "$PAUSED_FILE"
check "a backend-only resume is ready without the frontend" real_wait_resume
rm -f "$PAUSED_FILE"
failing_frontend_reload() { (frontend_mode() { echo build; }; LIFE_FAIL=build_frontend LIFE_ALIVE=" backend" lifecycle cmd_reload frontend) || true; }
out="$(failing_frontend_reload)"
check "a failed frontend build on reload brings the backend back" \
  test "$(order_of "$out" "^build_frontend failed")" -lt "$(order_of "$out" "^server backend")"
failing_backend_start() { (frontend_mode() { echo build; }; start_backend() { return 1; }; LIFE_ALIVE=" frontend" lifecycle cmd_reload backend) || true; }
out="$(failing_backend_start)"
check "a backend that does not start on reload brings the frontend back" grep -q "^server frontend" <<<"$out"
up_beside_frontend() { (frontend_mode() { echo build; }; LIFE_ALIVE=" frontend" lifecycle cmd_start 1); }
out="$(up_beside_frontend)"
check "up stops a running frontend before the backend builds" test "$(order_of "$out" "^stop_session frontend")" -lt "$(order_of "$out" "^build_backend")"
failing_up_build() { (LIFE_FAIL=build_frontend LIFE_ALIVE=" backend" lifecycle cmd_start 1) || true; }
out="$(failing_up_build)"
check "a failed frontend build on up brings the backend back" \
  test "$(order_of "$out" "^build_frontend failed")" -lt "$(order_of "$out" "^server backend")"
check "and starts no frontend" fails grep -q "^server frontend" <<<"$out"
failing_backend_after_builds() { (frontend_mode() { echo build; }; start_backend() { echo "start_backend failed"; return 1; }; LIFE_ALIVE=" frontend" lifecycle cmd_start 1) || true; }
out="$(failing_backend_after_builds)"
check "a backend that does not start after up's builds brings the frontend back" \
  test "$(order_of "$out" "^start_backend failed")" -lt "$(order_of "$out" "^server frontend")"
failing_addon_build() { (LIFE_FAIL=build_native_addons NATIVE_MISSING=image-rs LIFE_ALIVE=" backend" lifecycle cmd_start 1) || true; }
out="$(failing_addon_build)"
check "a failed native addon build on up brings the backend back" \
  test "$(order_of "$out" "^build_native_addons failed")" -lt "$(order_of "$out" "^server backend")"
check "and builds nothing after it" fails grep -q "^build_frontend" <<<"$out"
failing_reload_restart() { (frontend_mode() { echo build; }; start_backend() { return 1; }; LIFE_ALIVE=" backend" lifecycle cmd_reload frontend) || true; }
out="$(failing_reload_restart)"
check "a frontend reload whose backend does not start again brings the frontend back" grep -q "^server frontend" <<<"$out"
gone="$ARCHESTRA_DEV_LITE_STATE_DIR/removed-checkout"
echo "$gone" > "$SERVERS_FILE"
check "pause refuses when the stack's checkout is gone" grep -q "has no scripts/dev-lite.sh any more" <<<"$( (lifecycle cmd_pause) 2>&1 || true)"
rm -f "$SERVERS_FILE"
other="$ARCHESTRA_DEV_LITE_STATE_DIR/other-checkout"
mkdir -p "$other/scripts"
printf 'echo "delegated $*"\n' > "$other/scripts/dev-lite.sh"
echo "$other" > "$SERVERS_FILE"
check "pause acts on the checkout whose servers run" grep -q "delegated pause" <<<"$(lifecycle cmd_pause)"
check "resume too" grep -q "delegated resume" <<<"$(lifecycle cmd_resume)"
rm -f "$SERVERS_FILE"
echo build > "$PAUSED_FILE"
reload_paused() { (lifecycle cmd_reload frontend) || true; }
check "reload refuses while paused" grep -q "resume' first" <<<"$(reload_paused)"
paused_alive() { (ALIVE=""; touch "$PAUSED_FILE"; require_sessions_alive); }
check "a paused stack is not reported as exited" paused_alive
rm -f "$PAUSED_FILE"

# --- down --------------------------------------------------------------------
touch "$KEYCLOAK_REQUESTED_FILE"
ALIVE=""
touch "$PAUSED_FILE" "$SERVERS_FILE"
(cmd_down >/dev/null 2>&1)
check "down drops the Keycloak request" test ! -e "$KEYCLOAK_REQUESTED_FILE"
check "down drops the pause" test ! -e "$PAUSED_FILE"
check "down forgets the servers were started" test ! -e "$SERVERS_FILE"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all checks passed"

#!/usr/bin/env bash
#
# Run the Archestra dev stack as plain processes in this platform/ checkout:
# PostgreSQL, the backend dev server and the frontend dev server. No Docker,
# kind, Helm or Tilt. A lite Agent Runtime image runs this for previews,
# manual QA, unit tests and the Playwright lite projects. Work that needs
# Kubernetes (MCP server installs, nested Agent Runtime, the code runtime)
# still needs the Tilt stack (scripts/dev-stack.sh, or a full image).
#
# Usage (from platform/):
#   scripts/dev-lite.sh up [--e2e] [--mock-data]
#                              start PostgreSQL, migrate, start the backend
#                              and frontend, wait until they answer
#   scripts/dev-lite.sh start [same options]   start without waiting
#   scripts/dev-lite.sh wait                   wait until backend and frontend answer
#   scripts/dev-lite.sh status                 processes, memory, disk, URLs
#   scripts/dev-lite.sh logs <component> [n]   tail a component log (db, migrate,
#                              backend, frontend, wiremock, a2a)
#   scripts/dev-lite.sh e2e [playwright args]  run the Playwright lite projects
#                              against this stack (needs --e2e). --e2e rewrites
#                              platform/.env for the suite; delete the file to
#                              get the defaults back on the next up. Compiles
#                              the routes the specs open first, and scales the
#                              timeouts and workers to the CPUs available
#   scripts/dev-lite.sh warm                   compile the routes the specs open,
#                              so no test waits on a first compile
#   scripts/dev-lite.sh restart [options]      down, then up again
#   scripts/dev-lite.sh reload backend|frontend  restart one component; the backend
#                              is rebuilt first when the watcher is off
#   scripts/dev-lite.sh down                   stop everything; data and caches stay
#   scripts/dev-lite.sh reset                  down, then delete the database and state
#
# The database is the installed PostgreSQL (postgresql-18 with pgvector in the
# agent image), initialised under the state dir with durability settings off.
# A PGlite socket server was tried and does not work: it multiplexes every
# client through one session, so the backend's named prepared statements and
# concurrent transactions collide (see dev/lite-runtime/README.md).
#
# Environment:
#   ARCHESTRA_DEV_LITE_STATE_DIR
#       data, logs, pid files (default $HOME/.archestra-dev-lite)
#   ARCHESTRA_DEV_LITE_DB_PORT
#       PostgreSQL port (5432)
#   ARCHESTRA_DEV_LITE_WIREMOCK_JAR
#       WireMock standalone jar for --e2e
#   ARCHESTRA_DEV_LITE_BACKEND_LOG_LEVEL
#       backend log level (info; Tilt uses debug)
#   ARCHESTRA_DEV_BACKEND_WATCH
#       true: tsdown --watch rebuilds and restarts the backend on every save and
#       keeps the build resident (about 1.2 GB); false: build once (3 s) and run
#       the server alone, `reload backend` rebuilds. Default false inside an
#       Agent Runtime, true elsewhere, as for the Tilt stack.
#   ARCHESTRA_DEV_LITE_KUBECONFIG
#       kubeconfig for the MCP orchestrator (default: none, orchestrator disabled)
#   ARCHESTRA_DEV_LITE_PUBLIC_FRONTEND_URL, ARCHESTRA_DEV_LITE_PUBLIC_API_URL
#       browser-facing origins when the stack is reached through a tunnel
#   ARCHESTRA_DEV_LITE_BANNER
#       one line shown in the UI banner
#   ARCHESTRA_DEV_AUTO_LOGIN_EMAIL
#       dev auto-login (default admin@example.com; empty disables)
#   ARCHESTRA_BETA
#       written when .env is first created (default true)
#   ARCHESTRA_FRONTEND_PORT
#       frontend port (3000); the backend stays on 9000

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM_DIR="$(dirname "$SCRIPT_DIR")"
STATE_DIR="${ARCHESTRA_DEV_LITE_STATE_DIR:-$HOME/.archestra-dev-lite}"
LOG_DIR="$STATE_DIR/logs"
ENV_FILE="$PLATFORM_DIR/.env"
PGDATA="$STATE_DIR/postgres"
DB_PORT="${ARCHESTRA_DEV_LITE_DB_PORT:-5432}"
DB_USER=archestra
DB_NAME=archestra_dev
DB_PASSWORD=archestra_dev_password
BACKEND_PORT=9000
FRONTEND_PORT="${ARCHESTRA_FRONTEND_PORT:-3000}"
WIREMOCK_PORT=9092
A2A_PORT=9191
TMUX_SOCKET=archestra-dev-lite
CRATES=(app-runtime-rs image-rs openappa-rs router-rs sandbox-rs)

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

die() {
  echo "dev-lite: $*" >&2
  exit 1
}

log() {
  echo "→ $*" >&2
}

tmx() {
  tmux -L "$TMUX_SOCKET" "$@"
}

require_platform_dir() {
  [ -f "$PLATFORM_DIR/Tiltfile" ] && [ -d "$PLATFORM_DIR/backend" ] \
    || die "not an Archestra platform/ directory: $PLATFORM_DIR"
}

database_url() {
  printf 'postgresql://%s:%s@127.0.0.1:%s/%s?schema=public' "$DB_USER" "$DB_PASSWORD" "$DB_PORT" "$DB_NAME"
}

# --- .env ------------------------------------------------------------------

env_value() {
  local line
  line="$(grep "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  printf '%s' "$line"
}

set_env_kv() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  { grep -v "^${key}=" "$ENV_FILE" || true; printf '%s=%s\n' "$key" "$value"; } > "$tmp"
  mv -f "$tmp" "$ENV_FILE"
}

unset_env_key() {
  local tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  { grep -v "^$1=" "$ENV_FILE" || true; } > "$tmp"
  mv -f "$tmp" "$ENV_FILE"
}

ensure_env() {
  local e2e="$1" email
  # A worktree bootstrap links .env to the main checkout's file; this stack
  # must not rewrite that one.
  if [ -L "$ENV_FILE" ]; then
    cp -L "$ENV_FILE" "$ENV_FILE.dev-lite" && mv -f "$ENV_FILE.dev-lite" "$ENV_FILE"
    log "replaced the linked .env with a copy for this stack"
  fi
  if [ ! -f "$ENV_FILE" ]; then
    cp "$PLATFORM_DIR/.env.example" "$ENV_FILE"
    printf '\n# Lite dev stack (scripts/dev-lite.sh)\nARCHESTRA_BETA=%s\n' "${ARCHESTRA_BETA:-true}" >> "$ENV_FILE"
    log "created .env from .env.example"
  fi
  set_env_kv ARCHESTRA_DATABASE_URL "$(database_url)"
  # Without a cluster the MCP server runtime would probe the default
  # kubeconfig every 30 s and log a warning each time. A kubeconfig path that
  # does not exist makes it disable itself once at startup.
  set_env_kv ARCHESTRA_ORCHESTRATOR_KUBECONFIG "${ARCHESTRA_DEV_LITE_KUBECONFIG:-$STATE_DIR/no-kubernetes.kubeconfig}"
  set_env_kv ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER false
  email="${ARCHESTRA_DEV_AUTO_LOGIN_EMAIL-admin@example.com}"
  if [ -n "$email" ]; then
    set_env_kv ARCHESTRA_AUTH_DEV_AUTO_AUTHENTICATE_EMAIL "$email"
  else
    unset_env_key ARCHESTRA_AUTH_DEV_AUTO_AUTHENTICATE_EMAIL
  fi
  if [ "$e2e" = 1 ]; then
    apply_e2e_env
  fi
  if [ -n "${ARCHESTRA_DEV_LITE_PUBLIC_FRONTEND_URL:-}" ]; then
    set_env_kv ARCHESTRA_FRONTEND_URL "$ARCHESTRA_DEV_LITE_PUBLIC_FRONTEND_URL"
    set_env_kv ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS \
      "$ARCHESTRA_DEV_LITE_PUBLIC_FRONTEND_URL,http://localhost:$FRONTEND_PORT,http://127.0.0.1:$FRONTEND_PORT"
  fi
  if [ -n "${ARCHESTRA_DEV_LITE_PUBLIC_API_URL:-}" ]; then
    set_env_kv ARCHESTRA_API_BASE_URL "$ARCHESTRA_DEV_LITE_PUBLIC_API_URL"
    set_env_kv NEXT_PUBLIC_ARCHESTRA_INTERNAL_API_BASE_URL "$ARCHESTRA_DEV_LITE_PUBLIC_API_URL"
  fi
  if [ -n "${ARCHESTRA_DEV_LITE_BANNER:-}" ]; then
    set_env_kv ARCHESTRA_SITE_NOTIFICATION_MESSAGE "\"$(printf '%s' "$ARCHESTRA_DEV_LITE_BANNER" | tr -d '"')\""
  fi
}

# The Playwright lite projects expect the platform configured as in
# scripts/e2e-lite-platform.env. Reuse that file so the two cannot drift;
# only the container-only lines and the sidecar hostnames change.
apply_e2e_env() {
  local line key value
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      ARCHESTRA_QUICKSTART|ARCHESTRA_AUTH_SECRET|ARCHESTRA_FRONTEND_URL|ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS) continue ;;
    esac
    value="${value//http:\/\/e2e-tests-wiremock:8080/http://127.0.0.1:$WIREMOCK_PORT}"
    set_env_kv "$key" "$value"
  done < "$SCRIPT_DIR/e2e-lite-platform.env"
  # The lite suite runs with the beta switch off: with it on, the LLM proxy
  # refuses tool-declaring requests that omit the OpenAPPA tools. The specs
  # sign in themselves, so the dev auto-login must stay off too.
  set_env_kv ARCHESTRA_BETA false
  unset_env_key ARCHESTRA_AUTH_DEV_AUTO_AUTHENTICATE_EMAIL
  log "applied the e2e-lite platform environment (ARCHESTRA_BETA=false, providers → WireMock on :$WIREMOCK_PORT)"
}

# --- processes -------------------------------------------------------------

session_alive() {
  tmx has-session -t "=$1" 2>/dev/null
}

session_pid() {
  tmx list-panes -t "=$1" -F '#{pane_pid}' 2>/dev/null | head -n 1 || true
}

# Each component runs in its own tmux session: a shell tool that cleans up
# its command's process group then cannot stop the stack, and the session
# can be attached for a look. Output goes to the component's log file.
start_session() {
  local name="$1" dir="$2" cmd="$3"
  if session_alive "$name"; then
    log "$name already running"
    return 0
  fi
  mkdir -p "$LOG_DIR"
  # One log per run: readiness checks must not read an earlier run's crash.
  if [ -f "$LOG_DIR/$name.log" ]; then mv -f "$LOG_DIR/$name.log" "$LOG_DIR/$name.previous.log"; fi
  tmx new-session -d -s "$name" -c "$dir" \
    "exec bash -c $(printf '%q' "$cmd") >> $(printf '%q' "$LOG_DIR/$name.log") 2>&1"
}

# tmux makes the pane process a session leader, so its pid is the process
# group of everything it started.
# PostgreSQL and the rest get 15 s for a clean shutdown; a dev backend gets 5 s,
# like Tilt's runner (dev/run-backend-dev.sh).
stop_session() {
  local name="$1" pid polls=30
  [ "$name" = backend ] && polls=10
  pid="$(session_pid "$name")"
  if [ -n "$pid" ]; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    for _ in $(seq 1 "$polls"); do
      group_alive "$pid" || break
      sleep 0.5
    done
    group_alive "$pid" && kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  tmx kill-session -t "=$name" 2>/dev/null || true
}

# A process of the group that has not exited. Exited ones linger as zombies
# until PID 1 reaps them, and a container whose PID 1 never does (a plain
# `sleep`) would otherwise make every stop wait out its cap.
group_alive() {
  ps -e -o pgid=,stat= | awk -v group="$1" '$1 == group && $2 !~ /^Z/ { found = 1 } END { exit !found }'
}

tree_rss_mb() {
  ps -e -o pid=,ppid=,rss= | awk -v root="$1" '
    { pid[NR] = $1; ppid[NR] = $2; rss[NR] = $3 }
    END {
      set[root] = 1; changed = 1
      while (changed) {
        changed = 0
        for (i = 1; i <= NR; i++)
          if (!(pid[i] in set) && (ppid[i] in set)) { set[pid[i]] = 1; changed = 1 }
      }
      for (i = 1; i <= NR; i++) if (pid[i] in set) sum += rss[i]
      printf "%d", sum / 1024
    }'
}

# --- database --------------------------------------------------------------

db_ready() {
  pg_isready -q -h 127.0.0.1 -p "$DB_PORT" 2>/dev/null
}

postgres_pid() {
  [ -s "$PGDATA/postmaster.pid" ] && head -n 1 "$PGDATA/postmaster.pid" || true
}

start_postgres() {
  command -v initdb >/dev/null 2>&1 \
    || die "PostgreSQL binaries are not on PATH (postgresql-18)"
  mkdir -p "$LOG_DIR"
  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    log "initialising PostgreSQL in $PGDATA"
    initdb -D "$PGDATA" -U "$DB_USER" --auth=trust -E UTF8 > "$LOG_DIR/db-initdb.log" 2>&1
  fi
  if pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
    log "postgres already running"
  else
    # A single developer's database: small buffers, no durability guarantees.
    pg_ctl -D "$PGDATA" -w -t 90 -l "$LOG_DIR/db.log" -o "-p $DB_PORT -k $STATE_DIR \
      -c listen_addresses=127.0.0.1 -c shared_buffers=${ARCHESTRA_DEV_LITE_PG_SHARED_BUFFERS:-64MB} \
      -c max_connections=${ARCHESTRA_DEV_LITE_PG_MAX_CONNECTIONS:-60} -c fsync=off -c synchronous_commit=off \
      -c full_page_writes=off -c log_min_messages=warning -c log_checkpoints=off" start >> "$LOG_DIR/db-ctl.log" 2>&1
  fi
  psql -h 127.0.0.1 -p "$DB_PORT" -U "$DB_USER" -d postgres -tAc \
    "select 1 from pg_database where datname='$DB_NAME'" | grep -qx 1 \
    || createdb -h 127.0.0.1 -p "$DB_PORT" -U "$DB_USER" "$DB_NAME"
}

wait_for_db() {
  for _ in $(seq 1 90); do
    db_ready && return 0
    sleep 1
  done
  tail -n 30 "$LOG_DIR/db.log" >&2 2>/dev/null || true
  die "database did not answer on 127.0.0.1:$DB_PORT"
}

migrate() {
  log "running migrations"
  (cd "$PLATFORM_DIR/backend" && pnpm db:migrate) > "$LOG_DIR/migrate.log" 2>&1 \
    || { tail -n 40 "$LOG_DIR/migrate.log" >&2; die "migrations failed"; }
}

# --- checkout preparation --------------------------------------------------

install_dependencies() {
  log "pnpm install"
  (cd "$PLATFORM_DIR" && CI=true pnpm install --frozen-lockfile) > "$LOG_DIR/pnpm-install.log" 2>&1 \
    || { tail -n 40 "$LOG_DIR/pnpm-install.log" >&2; die "pnpm install failed"; }
}

# The backend lazily loads NAPI addons whose .node binaries are gitignored and
# never built by pnpm install. Install the prebuilt ones published for main's
# archestra-rs tree (scripts/napi-prebuilt.mjs, about a second), else build
# them: several minutes of cargo, more on a small pod.
ensure_native_addons() {
  local crate filters=()
  if (cd "$PLATFORM_DIR" && node scripts/napi-prebuilt.mjs "${CRATES[@]}") >&2; then
    return 0
  fi
  for crate in "${CRATES[@]}"; do
    if ! ls "$PLATFORM_DIR/archestra-rs/$crate"/*.node >/dev/null 2>&1; then
      filters+=("--filter" "@archestra/$crate")
    fi
  done
  [ ${#filters[@]} -eq 0 ] && return 0
  command -v cargo >/dev/null 2>&1 \
    || die "Rust toolchain not found; cannot build ${filters[*]}"
  # Parallel napi builds each ask rustup for the components in
  # rust-toolchain.toml and race on the same download; install them once first.
  (cd "$PLATFORM_DIR" && rustup show > /dev/null 2>&1) || true
  log "building native addons (several minutes): ${filters[*]}"
  (cd "$PLATFORM_DIR" && pnpm "${filters[@]}" build:dev) > "$LOG_DIR/napi-build.log" 2>&1 \
    || { tail -n 40 "$LOG_DIR/napi-build.log" >&2; die "native addon build failed"; }
}

# --- application -----------------------------------------------------------

# A survivor from an earlier run keeps a port bound and the next server dies
# with EADDRINUSE, so sweep the dev ports before starting (as
# dev/run-backend-dev.sh does under Tilt).
free_ports() {
  local port pids
  command -v lsof > /dev/null 2>&1 || return 0
  for port in "$@"; do
    pids="$(lsof -t -i "tcp:$port" -s tcp:LISTEN 2>/dev/null || true)"
    [ -n "$pids" ] || continue
    log "killing stale listener(s) on :$port: $pids"
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    sleep 1
  done
}

# The backend and frontend run their dev commands directly. Tilt goes through
# `pnpm dev --filter`, which costs four extra Node processes per server (pnpm,
# turbo, pnpm again, the pnpm shim) and about 1 GB of RSS in total. The turbo
# `dev` task has no dependencies, so nothing is skipped.
start_backend() {
  # A running server owns the ports: freeing them first would kill it.
  if session_alive backend; then
    log "backend already running"
    return 0
  fi
  free_ports "$BACKEND_PORT" 9050
  # The backend loads platform/.env itself. With the watcher on, tsdown rebuilds
  # on every save and restarts the server (backend/tsdown.config.ts); with it
  # off, tsdown builds once and the server runs alone until `reload backend`.
  local run="exec ./node_modules/.bin/tsdown --watch" watch="${ARCHESTRA_DEV_BACKEND_WATCH:-}"
  if [ -z "$watch" ]; then
    # Inside an Agent Runtime (the pod sets ARCHESTRA_AGENT_RUNTIME_TASK_ID)
    # the agent reloads on demand; elsewhere keep the watcher.
    if [ -n "${ARCHESTRA_AGENT_RUNTIME_TASK_ID:-}" ]; then watch=false; else watch=true; fi
  fi
  if [ "$watch" = false ]; then
    log "backend watcher off: run 'archestra-dev-lite reload backend' after backend changes"
    # Build once, then run the server in a restart loop: this session is the
    # server, so a crash or an OOM kill would otherwise end it. Five exits
    # within 60 s of starting end the loop so a server that cannot start does
    # not spin.
    # shellcheck disable=SC2016 # expanded by the session's own shell
    run='./node_modules/.bin/tsdown || exit 1; quick_exits=0; while :; do started=$(date +%s); node --enable-source-maps dist/server.mjs; status=$?; if [ $(( $(date +%s) - started )) -ge 60 ]; then quick_exits=0; else quick_exits=$((quick_exits + 1)); fi; if [ "$quick_exits" -ge 5 ]; then echo "backend exited ($status) five times right after starting; giving up" >&2; exit "$status"; fi; echo "backend exited ($status); restarting in 1 s" >&2; sleep 1; done'
  fi
  start_session backend "$PLATFORM_DIR/backend" \
    "export ARCHESTRA_LOGGING_LEVEL=${ARCHESTRA_DEV_LITE_BACKEND_LOG_LEVEL:-info} ARCHESTRA_ANALYTICS=disabled ARCHESTRA_AGENT_RUNTIME_WARM_POOL_SIZE=0; $run"
}

# Mirror Tilt's get_frontend_env(): browser-visible copies of the ARCHESTRA_*
# values the Next bundle reads at start.
frontend_env() {
  local var value public
  for var in ARCHESTRA_INTERNAL_API_BASE_URL ARCHESTRA_API_BASE_URL ARCHESTRA_SENTRY_ENVIRONMENT \
    ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED ARCHESTRA_ENTERPRISE_LICENSE_KNOWLEDGE_BASE_ACTIVATED \
    ARCHESTRA_ENTERPRISE_LICENSE_FULL_WHITE_LABELING ARCHESTRA_AUTH_DISABLE_BASIC_AUTH \
    ARCHESTRA_AUTH_DISABLE_INVITATIONS; do
    value="$(env_value "$var")"
    public="$(env_value "NEXT_PUBLIC_$var")"
    if [ -n "$value" ] && [ -z "$public" ]; then
      printf 'NEXT_PUBLIC_%s=%q ' "$var" "$value"
    fi
  done
}

start_frontend() {
  if session_alive frontend; then
    log "frontend already running"
    return 0
  fi
  free_ports "$FRONTEND_PORT"
  # Next reads ARCHESTRA_* from its environment (Tilt exports .env); Node's
  # --env-file does the same here, and explicit variables take precedence.
  start_session frontend "$PLATFORM_DIR/frontend" \
    "exec env PORT=$FRONTEND_PORT ARCHESTRA_DEV_BUNDLER=${ARCHESTRA_DEV_BUNDLER:-turbopack} $(frontend_env)node --env-file=$(printf '%q' "$ENV_FILE") scripts/dev.mjs"
}

start_e2e_deps() {
  local jar="${ARCHESTRA_DEV_LITE_WIREMOCK_JAR:-}"
  [ -n "$jar" ] && [ -f "$jar" ] || die "--e2e needs ARCHESTRA_DEV_LITE_WIREMOCK_JAR pointing at a WireMock standalone jar"
  command -v java >/dev/null 2>&1 || die "--e2e needs java for WireMock"
  mkdir -p "$STATE_DIR/wiremock/__files"
  ln -sfn "$PLATFORM_DIR/helm/e2e-tests/mappings" "$STATE_DIR/wiremock/mappings"
  start_session wiremock "$STATE_DIR/wiremock" \
    "exec java -jar $(printf '%q' "$jar") --port $WIREMOCK_PORT --bind-address 127.0.0.1 --root-dir $(printf '%q' "$STATE_DIR/wiremock") --global-response-templating --disable-gzip"
  start_session a2a "$PLATFORM_DIR" \
    "exec env A2A_FIXTURE_HOST=127.0.0.1 A2A_FIXTURE_PORT=$A2A_PORT node e2e-tests/fixtures/a2a-test-agent/server.mjs"
}

# Both sidecars, so a fixture that died is restarted by the next `up --e2e`
# instead of being waited for.
e2e_enabled() {
  session_alive wiremock && session_alive a2a
}

# Either sidecar: the stack was started with --e2e, so readiness includes both.
e2e_requested() {
  session_alive wiremock || session_alive a2a
}

# --- readiness -------------------------------------------------------------

http_ok() {
  curl -fsS -m "${2:-3}" -o /dev/null "$1" 2>/dev/null
}

wait_ready() {
  local deadline=$((SECONDS + ${ARCHESTRA_DEV_LITE_TIMEOUT_SECONDS:-900})) backend_ok=0 frontend_ok=0 e2e_ok=0
  while (( SECONDS < deadline )); do
    [ "$backend_ok" = 1 ] || { http_ok "http://127.0.0.1:$BACKEND_PORT/ready" && backend_ok=1 && log "backend answers on :$BACKEND_PORT"; }
    # The first page request compiles the app; give it the time it needs.
    [ "$frontend_ok" = 1 ] || { http_ok "http://127.0.0.1:$FRONTEND_PORT/" 180 && frontend_ok=1 && log "frontend answers on :$FRONTEND_PORT"; }
    if e2e_requested; then
      [ "$e2e_ok" = 1 ] || { http_ok "http://127.0.0.1:$WIREMOCK_PORT/__admin/health" && http_ok "http://127.0.0.1:$A2A_PORT/health" && e2e_ok=1 && log "WireMock on :$WIREMOCK_PORT, A2A fixture on :$A2A_PORT"; }
    else
      e2e_ok=1
    fi
    if [ "$backend_ok" = 1 ] && [ "$frontend_ok" = 1 ] && [ "$e2e_ok" = 1 ]; then
      echo "dev stack ready: frontend :$FRONTEND_PORT, backend :$BACKEND_PORT"
      [ -n "${ARCHESTRA_DEV_LITE_PUBLIC_FRONTEND_URL:-}" ] && echo "browser URL: $ARCHESTRA_DEV_LITE_PUBLIC_FRONTEND_URL"
      return 0
    fi
    for name in backend frontend $(e2e_requested && echo "wiremock a2a"); do
      session_alive "$name" || { tail -n 40 "$LOG_DIR/$name.log" >&2 2>/dev/null || true; die "$name exited; see $LOG_DIR/$name.log"; }
    done
    # The tsdown watcher outlives a crashed server and only restarts it on the
    # next rebuild, so a startup failure would otherwise wait out the timeout.
    if [ "$backend_ok" = 0 ] && tail -n 200 "$LOG_DIR/backend.log" 2>/dev/null | grep -q "Server process exited with code: [1-9]"; then
      tail -n 40 "$LOG_DIR/backend.log" >&2
      die "backend server exited during startup; see $LOG_DIR/backend.log"
    fi
    sleep 3
  done
  for name in backend frontend; do
    echo "--- $LOG_DIR/$name.log" >&2
    tail -n 30 "$LOG_DIR/$name.log" >&2 2>/dev/null || true
  done
  die "stack not ready within ${ARCHESTRA_DEV_LITE_TIMEOUT_SECONDS:-900}s"
}

# --- commands --------------------------------------------------------------

cmd_start() {
  local wait="$1" e2e=0 mock_data=0 name
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --e2e) e2e=1; shift ;;
      --mock-data) mock_data=1; shift ;;
      -h|--help) usage 0 ;;
      *) echo "unknown argument: $1" >&2; usage 1 ;;
    esac
  done
  require_platform_dir
  mkdir -p "$STATE_DIR" "$LOG_DIR"
  # An Agent Runtime starts the stack on every turn: leave a running one alone.
  if session_alive backend && session_alive frontend && db_ready \
    && { [ "$e2e" = 0 ] || e2e_enabled; } && [ "$mock_data" = 0 ]; then
    log "stack already running; logs in $LOG_DIR"
    [ "$wait" = 1 ] && wait_ready
    return 0
  fi
  # The servers read .env when they start: switching a running stack to the
  # e2e environment restarts them.
  if [ "$e2e" = 1 ] && ! session_alive wiremock; then
    for name in backend frontend; do
      session_alive "$name" && { log "restarting $name with the e2e environment"; stop_session "$name"; }
    done
  fi
  ensure_env "$e2e"
  install_dependencies
  ensure_native_addons
  start_postgres
  wait_for_db
  migrate
  if [ "$mock_data" = 1 ]; then
    log "seeding mock data"
    (cd "$PLATFORM_DIR/backend" && pnpm db:seed:mock-data) > "$LOG_DIR/seed-mock-data.log" 2>&1 \
      || { tail -n 20 "$LOG_DIR/seed-mock-data.log" >&2; die "mock data seed failed"; }
  fi
  start_backend
  start_frontend
  [ "$e2e" = 1 ] && start_e2e_deps
  log "started; logs in $LOG_DIR"
  if [ "$wait" = 1 ]; then
    wait_ready
  fi
}

cmd_status() {
  local name pid rss url code
  printf '%-10s %-8s %-8s %s\n' COMPONENT STATE PID RSS_MB
  pid="$(postgres_pid)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    printf '%-10s %-8s %-8s %s\n' postgres up "$pid" "$(tree_rss_mb "$pid")"
  else
    printf '%-10s %-8s %-8s %s\n' postgres down - -
  fi
  for name in backend frontend wiremock a2a; do
    if session_alive "$name"; then
      pid="$(session_pid "$name")"
      rss="$(tree_rss_mb "$pid")"
      printf '%-10s %-8s %-8s %s\n' "$name" up "$pid" "$rss"
    elif [ "$name" = wiremock ] || [ "$name" = a2a ]; then
      :
    else
      printf '%-10s %-8s %-8s %s\n' "$name" down - -
    fi
  done
  echo
  for url in "http://127.0.0.1:$BACKEND_PORT/ready" "http://127.0.0.1:$FRONTEND_PORT/"; do
    code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    printf '%-40s HTTP %s\n' "$url" "${code:-000}"
  done
  [ -n "${ARCHESTRA_DEV_LITE_PUBLIC_FRONTEND_URL:-}" ] && printf 'browser URL: %s\n' "$ARCHESTRA_DEV_LITE_PUBLIC_FRONTEND_URL"
  echo
  printf 'total RSS of all processes: %d MB\n' "$(ps -eo rss= | awk '{ s += $1 } END { printf "%d", s / 1024 }')"
  if [ -r /sys/fs/cgroup/memory.stat ]; then
    printf 'cgroup anonymous memory: %d MB (file cache %d MB)\n' \
      "$(awk '/^anon / { printf "%d", $2 / 1048576 }' /sys/fs/cgroup/memory.stat)" \
      "$(awk '/^file / { printf "%d", $2 / 1048576 }' /sys/fs/cgroup/memory.stat)"
  fi
  if [ -r /sys/fs/cgroup/memory.current ]; then
    printf 'cgroup memory: current %d MB' "$(( $(cat /sys/fs/cgroup/memory.current) / 1048576 ))"
    [ -r /sys/fs/cgroup/memory.peak ] && printf ', peak %d MB' "$(( $(cat /sys/fs/cgroup/memory.peak) / 1048576 ))"
    [ -r /sys/fs/cgroup/memory.max ] && printf ', limit %s' "$(cat /sys/fs/cgroup/memory.max)"
    echo
    [ -r /sys/fs/cgroup/cpu.stat ] && printf 'cgroup cpu: %s s used\n' "$(( $(awk '/^usage_usec/ {print $2}' /sys/fs/cgroup/cpu.stat) / 1000000 ))"
  fi
  printf 'disk: state %s, node_modules %s, frontend/.next %s\n' \
    "$(du -sh "$STATE_DIR" 2>/dev/null | cut -f1)" \
    "$(du -sh "$PLATFORM_DIR/node_modules" 2>/dev/null | cut -f1)" \
    "$(du -sh "$PLATFORM_DIR/frontend/.next" 2>/dev/null | cut -f1 || echo -)"
}

cmd_down() {
  local name
  for name in frontend backend wiremock a2a; do
    session_alive "$name" && { log "stopping $name"; stop_session "$name"; }
  done
  tmx kill-server 2>/dev/null || true
  if [ -s "$PGDATA/PG_VERSION" ] && pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
    log "stopping postgres"
    pg_ctl -D "$PGDATA" -m fast -w stop >> "$LOG_DIR/db-ctl.log" 2>&1 || true
  fi
  echo "dev stack stopped; data stays in $STATE_DIR"
}

cmd_reset() {
  cmd_down
  rm -rf "$STATE_DIR"
  echo "state removed: $STATE_DIR"
}

cmd_logs() {
  local name="${1:?logs needs a component}" lines="${2:-100}"
  [ -f "$LOG_DIR/$name.log" ] || die "no log for $name in $LOG_DIR"
  tail -n "$lines" "$LOG_DIR/$name.log"
}

# CPUs this stack can count on: a CPU limit when the container has one, else
# the Pod's CPU request (an Agent Runtime sets it), else every CPU it sees.
available_cpus() {
  local quota period request
  if read -r quota period 2>/dev/null </sys/fs/cgroup/cpu.max && [ "$quota" != max ]; then
    echo $(( (quota + period - 1) / period ))
    return
  fi
  request="${ARCHESTRA_AGENT_RUNTIME_POD_CPU_REQUEST:-}"
  case "$request" in
    *m) echo $(( (${request%m} + 999) / 1000 )); return ;;
    [0-9]*) echo "${request%%.*}"; return ;;
  esac
  nproc
}

# Routes the Playwright specs open (goto and goToPage literals). A trailing
# slash means an id follows: any id compiles that dynamic route.
warm_routes() {
  # shellcheck disable=SC2016 # JavaScript, not shell
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const routes = new Set();
    const pattern = /(?:goToPage\(\s*\w+,\s*|goto\(\s*)[`"\x27](\/[^`"\x27$?#]*)/g;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (file.endsWith(".ts"))
          for (const [, route] of fs.readFileSync(file, "utf8").matchAll(pattern))
            if (route !== "/") routes.add(route.endsWith("/") ? `${route}warm` : route);
      }
    };
    walk(process.argv[1]);
    console.log([...routes].sort().join("\n"));
  ' "$PLATFORM_DIR/e2e-tests/tests"
}

# Next's dev server compiles a route on its first request. At 2 CPUs that
# takes up to 40 s, longer than the specs' navigation and assertion timeouts,
# so compile the routes the specs open before they start.
cmd_warm() {
  http_ok "http://127.0.0.1:$FRONTEND_PORT/chat" 600 || die "frontend is not ready"
  local routes started=$SECONDS
  routes="$(warm_routes)"
  log "compiling $(printf '%s\n' "$routes" | wc -l) routes the specs open"
  printf '%s\n' "$routes" | xargs -P 2 -I{} \
    curl -s -o /dev/null -m 600 -w "  %{http_code} %{time_total}s {}\n" "http://127.0.0.1:$FRONTEND_PORT{}" || true
  log "routes compiled in $((SECONDS - started)) s"
}

cmd_e2e() {
  e2e_enabled || die "start the stack with --e2e first"
  http_ok "http://127.0.0.1:$BACKEND_PORT/ready" || die "backend is not ready"
  [ "${ARCHESTRA_DEV_LITE_E2E_WARM:-1}" = 0 ] || cmd_warm
  # The browser, both dev servers and PostgreSQL share these CPUs: fewer
  # workers and longer timeouts on a small Pod. E2E_* set by hand win.
  local cpus
  cpus="$(available_cpus)"
  if [ "$cpus" -le 2 ]; then
    export E2E_WORKERS="${E2E_WORKERS:-2}" E2E_TIMEOUT_SCALE="${E2E_TIMEOUT_SCALE:-3}"
  elif [ "$cpus" -le 4 ]; then
    export E2E_WORKERS="${E2E_WORKERS:-3}" E2E_TIMEOUT_SCALE="${E2E_TIMEOUT_SCALE:-2}"
  fi
  log "Playwright on $cpus CPU(s): ${E2E_WORKERS:-3} workers, timeouts x${E2E_TIMEOUT_SCALE:-1}"
  cd "$PLATFORM_DIR/e2e-tests"
  export E2E_WIREMOCK_BASE_URL="http://127.0.0.1:$WIREMOCK_PORT"
  export E2E_WIREMOCK_INTERNAL_URL="http://127.0.0.1:$WIREMOCK_PORT"
  export E2E_A2A_FIXTURE_BASE_URL="http://127.0.0.1:$A2A_PORT"
  export E2E_UI_BASE_URL="http://localhost:$FRONTEND_PORT"
  export E2E_API_BASE_URL="http://localhost:$BACKEND_PORT"
  if [ $# -gt 0 ]; then
    exec pnpm exec playwright test "$@"
  fi
  # Same projects as scripts/e2e-lite.sh. Without Keycloak and a Kubernetes
  # cluster, the identity-provider, MCP-install and orchestrator specs fail.
  exec pnpm exec playwright test --project=chromium --project=api --grep-invert @quickstart
}

cmd_restart() {
  [ -s "$PGDATA/PG_VERSION" ] || die "nothing to restart; run 'up' first"
  cmd_down
  cmd_start 1 "$@"
}

# Restart one dev server. With ARCHESTRA_DEV_BACKEND_WATCH=false this is how backend
# changes reach the running server: tsdown builds, then the server starts.
cmd_reload() {
  require_platform_dir
  case "${1:-}" in
    backend)
      log "reloading the backend"
      stop_session backend
      start_backend
      ;;
    frontend)
      log "reloading the frontend"
      stop_session frontend
      start_frontend
      ;;
    *) die "reload: expected backend or frontend" ;;
  esac
  wait_ready
}

case "${1:-}" in
  up) shift; cmd_start 1 "$@" ;;
  restart) shift; cmd_restart "$@" ;;
  reload) shift; cmd_reload "$@" ;;
  start) shift; cmd_start 0 "$@" ;;
  wait) wait_ready ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "$@" ;;
  e2e) shift; cmd_e2e "$@" ;;
  warm) cmd_warm ;;
  down) cmd_down ;;
  reset) cmd_reset ;;
  -h|--help|help) usage 0 ;;
  *) usage 1 ;;
esac

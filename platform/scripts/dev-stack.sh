#!/usr/bin/env bash
#
# Run a parallel Archestra dev stack in the current platform/ directory.
# Picks free random ports, derives a K8s namespace, rewrites the local .env
# with the parallel-instance overrides, and runs `tilt up` so this stack can
# coexist with another `tilt up` in a different worktree.
#
# This script does NOT create or remove git worktrees. The caller (a human or
# an agent) sets up the worktree and copies platform/.env into it first:
#
#   git worktree add ../archestra-parallel-foo -b parallel/foo
#   cp <main>/platform/.env ../archestra-parallel-foo/platform/.env
#   cd ../archestra-parallel-foo/platform
#   pnpm dev:stack:up --detach
#
# Usage:
#   dev-stack.sh up           [--detach] [--namespace NAME]
#   dev-stack.sh down
#   dev-stack.sh hydrate
#   dev-stack.sh status
#
# `up`:   without --detach, execs `tilt up` in the foreground (Ctrl+C stops
#         it). With --detach, runs Tilt in the background via nohup, writes
#         a PID file, and returns once the frontend responds.
# `down`: kills the detached Tilt (if any) and runs `tilt down`.
# `hydrate`:
#         fills the parallel stack's database with admin-configured rows
#         from the main worktree's database so chat / agents / proxy work
#         without re-entering keys. Today copies the LLM-provider rows
#         (secret / chat_api_keys / models / api_key_models) with
#         ownership rewritten to the parallel admin; the verb is
#         deliberately generic so other categories (policies, agents,
#         optimization rules) can be added without renaming. Run after
#         `up --detach` finishes. Idempotent via ON CONFLICT DO NOTHING —
#         re-runs top up new rows main has gained without deleting
#         anything you added by hand.
#
# `status`:
#         lists every git worktree and whether its frontend is responding,
#         with the URL. Read-only — starts/stops nothing. The main worktree
#         shows on :3000; parallel worktrees show their persisted
#         ARCHESTRA_FRONTEND_PORT. Run from any worktree's platform/ dir.
#
# `--namespace` overrides the auto-derived K8s namespace (default:
# `archestra-dev-<sanitized-branch-name>`).

set -euo pipefail

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

require_platform_cwd() {
  if [ ! -f "Tiltfile" ] || [ ! -d "dev" ]; then
    echo "ERROR: run from a platform/ directory (no Tiltfile in $(pwd))" >&2
    exit 1
  fi
}

cmd_up() {
  local detach=false namespace=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --detach)    detach=true; shift ;;
      --namespace) namespace="${2:?--namespace needs a value}"; shift 2 ;;
      -h|--help)   usage 0 ;;
      *)           echo "unknown arg: $1" >&2; usage 1 ;;
    esac
  done

  require_platform_cwd
  local platform_dir; platform_dir="$(pwd)"
  local worktree_dir; worktree_dir="$(cd .. && pwd)"
  local env_file="$platform_dir/.env"

  if [ ! -f "$env_file" ]; then
    # Auto-copy from the main worktree (the original clone, where .git is a
    # directory). `git worktree list --porcelain` is documented to list the
    # main worktree first. Skip auto-copy if we ARE the main worktree, since
    # there's nowhere to copy from.
    # `sed -n 's/^worktree //p' | head -n1` strips the "worktree " prefix and
    # keeps the rest of the line verbatim — awk '{print $2}' would truncate
    # paths that contain spaces.
    local main_worktree main_env
    main_worktree=$(git -C "$platform_dir" worktree list --porcelain 2>/dev/null \
      | sed -n 's/^worktree //p' | head -n1)
    main_env="$main_worktree/platform/.env"
    if [ -n "$main_worktree" ] && [ "$main_env" != "$env_file" ] && [ -f "$main_env" ]; then
      echo "→ Auto-copying .env from main worktree: $main_env" >&2
      cp "$main_env" "$env_file"
    else
      cat >&2 <<EOF
ERROR: $env_file not found.

Tried auto-copying from the main worktree but no source was available.
Bootstrap .env in the main worktree first, e.g.:
  cp ${main_worktree:-<main-worktree>}/platform/.env.example ${main_worktree:-<main-worktree>}/platform/.env
EOF
      exit 1
    fi
  fi

  if [ -z "$namespace" ]; then
    local branch; branch="$(git -C "$platform_dir" branch --show-current 2>/dev/null || true)"
    if [ -z "$branch" ]; then
      echo "ERROR: not on a git branch (detached HEAD?). Pass --namespace explicitly." >&2
      exit 1
    fi
    # K8s namespace rules: lowercase alphanumeric + dashes, ≤63 chars, must
    # start AND end with alphanumeric. Cap the derived portion at 49 chars so
    # the full `archestra-dev-<x>` stays within 63, strip trailing dashes (a
    # branch like `feature/foo_` sanitizes to `feature-foo-`), and fall back
    # to `auto` if sanitization produces an empty string.
    local sanitized
    sanitized=$(echo "$branch" | tr '[:upper:]/_' '[:lower:]--' | tr -dc 'a-z0-9-' | head -c 49 | sed 's/-*$//')
    if [ -z "$sanitized" ]; then
      sanitized="auto"
    fi
    namespace="archestra-dev-${sanitized}"
  fi

  # Reuse this worktree's previously-assigned ports when they're still usable,
  # so restarts keep the same URLs (stable bookmarks / SSH tunnels). Only reuse
  # once this .env has already been through a parallel `up`, detected by the
  # ARCHESTRA_TILT_PORT marker — a var only this script writes, so it's absent
  # in the .env just auto-copied from the main worktree. Without that gate a
  # first run would reuse the inherited main-stack defaults (e.g. backend :9000)
  # and collide with the main stack. The backend port has no dedicated var — it
  # lives inside ARCHESTRA_INTERNAL_API_BASE_URL — so recover it from the URL's
  # trailing :port.
  local prior_parallel=false
  [ -n "$(read_env_var ARCHESTRA_TILT_PORT "$env_file")" ] && prior_parallel=true

  local frontend_port backend_port metrics_port pg_port pg_metrics_port int_tests_port tilt_port
  frontend_port=$(resolve_port "$(persisted_port ARCHESTRA_FRONTEND_PORT "$env_file" "$prior_parallel")")
  backend_port=$(resolve_port "$(persisted_port ARCHESTRA_INTERNAL_API_BASE_URL "$env_file" "$prior_parallel" | sed -E 's#.*:([0-9]+).*#\1#')")
  metrics_port=$(resolve_port "$(persisted_port ARCHESTRA_METRICS_PORT "$env_file" "$prior_parallel")")
  pg_port=$(resolve_port "$(persisted_port ARCHESTRA_POSTGRES_HOST_PORT "$env_file" "$prior_parallel")")
  pg_metrics_port=$(resolve_port "$(persisted_port ARCHESTRA_POSTGRES_METRICS_HOST_PORT "$env_file" "$prior_parallel")")
  int_tests_port=$(resolve_port "$(persisted_port ARCHESTRA_FRONTEND_INT_TESTS_PORT "$env_file" "$prior_parallel")")
  tilt_port=$(resolve_port "$(persisted_port ARCHESTRA_TILT_PORT "$env_file" "$prior_parallel")")

  echo "→ Rewriting $env_file with parallel-instance overrides" >&2
  # ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE is overridden too so MCP server pods
  # (when the K8s orchestrator is enabled) don't share resource names with the
  # main stack's pods in `default`. The orchestrator's RBAC is still only
  # provisioned in `default` by dev/Tiltfile.dev, so a parallel stack that
  # actively uses the K8s MCP runtime needs RBAC applied to the new namespace
  # by hand. Most parallel-stack users don't enable the K8s orchestrator and
  # this override just prevents accidental collisions.
  # NEXT_PUBLIC_ARCHESTRA_INTERNAL_API_BASE_URL is rewritten alongside the
  # ARCHESTRA_INTERNAL_API_BASE_URL it mirrors: Tiltfile.dev's sync only fills
  # NEXT_PUBLIC_* when the file doesn't already set it, so leaving an inherited
  # value in place would point the parallel frontend at the main backend.
  ARCHESTRA_DATABASE_URL="postgresql://archestra:archestra_dev_password@localhost:${pg_port}/archestra_dev?schema=public" \
  ARCHESTRA_INTERNAL_API_BASE_URL="http://localhost:${backend_port}" \
  NEXT_PUBLIC_ARCHESTRA_INTERNAL_API_BASE_URL="http://localhost:${backend_port}" \
  ARCHESTRA_FRONTEND_URL="http://localhost:${frontend_port}" \
  ARCHESTRA_METRICS_PORT="$metrics_port" \
  ARCHESTRA_K8S_NAMESPACE="$namespace" \
  ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE="$namespace" \
  ARCHESTRA_POSTGRES_HOST_PORT="$pg_port" \
  ARCHESTRA_POSTGRES_METRICS_HOST_PORT="$pg_metrics_port" \
  ARCHESTRA_FRONTEND_PORT="$frontend_port" \
  ARCHESTRA_FRONTEND_INT_TESTS_PORT="$int_tests_port" \
  ARCHESTRA_TILT_PORT="$tilt_port" \
  python3 - "$env_file" <<'PYEOF'
import os, re, sys
keys = [
  "ARCHESTRA_DATABASE_URL",
  "ARCHESTRA_INTERNAL_API_BASE_URL",
  "NEXT_PUBLIC_ARCHESTRA_INTERNAL_API_BASE_URL",
  "ARCHESTRA_FRONTEND_URL",
  "ARCHESTRA_METRICS_PORT",
  "ARCHESTRA_K8S_NAMESPACE",
  "ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE",
  "ARCHESTRA_POSTGRES_HOST_PORT",
  "ARCHESTRA_POSTGRES_METRICS_HOST_PORT",
  "ARCHESTRA_FRONTEND_PORT",
  "ARCHESTRA_FRONTEND_INT_TESTS_PORT",
  "ARCHESTRA_TILT_PORT",
]
overrides = {k: os.environ[k] for k in keys}
path = sys.argv[1]
with open(path) as f:
    lines = f.readlines()
pat = re.compile(r'^\s*([A-Z0-9_]+)\s*=')
seen, out = set(), []
for line in lines:
    m = pat.match(line)
    if m and m.group(1) in overrides:
        out.append(f'{m.group(1)}={overrides[m.group(1)]}\n')
        seen.add(m.group(1))
    else:
        out.append(line)
missing = [k for k in keys if k not in seen]
if missing:
    if out and not out[-1].endswith('\n'):
        out.append('\n')
    for k in missing:
        out.append(f'{k}={overrides[k]}\n')
with open(path, 'w') as f:
    f.writelines(out)
PYEOF

  cat >&2 <<EOF

================================================================
  Parallel Archestra dev stack
================================================================
  Frontend:    http://localhost:${frontend_port}
  Backend:     http://localhost:${backend_port}
  Metrics:     http://localhost:${metrics_port}/metrics
  Tilt UI:     http://localhost:${tilt_port}
  Postgres:    localhost:${pg_port}
  K8s ns:      ${namespace}
  Platform:    ${platform_dir}

  Tear down:   pnpm dev:stack:down    (from this directory)
================================================================

EOF

  if [ "$detach" = "true" ]; then
    local log_file="$worktree_dir/.dev-stack.log"
    local pid_file="$worktree_dir/.dev-stack.pid"
    echo "→ Launching tilt up in background (logs: $log_file)" >&2
    nohup tilt up --port="$tilt_port" >"$log_file" 2>&1 &
    local tilt_pid=$!
    echo "$tilt_pid" >"$pid_file"
    echo "→ Waiting for frontend on :${frontend_port} (can take several minutes on first run)" >&2
    local i
    for i in $(seq 1 240); do
      if curl -sf -o /dev/null "http://localhost:${frontend_port}/"; then
        echo "✅ Frontend up at http://localhost:${frontend_port}" >&2
        return 0
      fi
      if ! kill -0 "$tilt_pid" 2>/dev/null; then
        echo "❌ Tilt exited before frontend came up. Check ${log_file}" >&2
        return 1
      fi
      sleep 2
    done
    echo "⚠ Timeout waiting for frontend; Tilt still running. Check ${log_file}" >&2
    return 1
  else
    exec tilt up --port="$tilt_port"
  fi
}

cmd_down() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help) usage 0 ;;
      *)         echo "unknown arg: $1" >&2; usage 1 ;;
    esac
  done

  require_platform_cwd
  local platform_dir; platform_dir="$(pwd)"
  local worktree_dir; worktree_dir="$(cd .. && pwd)"
  local pid_file="$worktree_dir/.dev-stack.pid"

  if [ -f "$pid_file" ]; then
    local pid; pid="$(cat "$pid_file")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "→ Stopping background Tilt process (pid $pid)" >&2
      kill "$pid" 2>/dev/null || true
      local i
      for i in $(seq 1 10); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi

  echo "→ Running tilt down" >&2
  tilt down || echo "⚠ tilt down reported errors" >&2

  # The local dev-server processes (next-server, backend) can briefly outlive
  # `tilt down` and keep their host ports bound. Wait (bounded) for this stack's
  # persisted ports to be released so an immediate `up` reuses them instead of
  # seeing them taken and re-randomizing. Times out gracefully — a port still
  # held by something else just gets reallocated on the next `up`.
  local env_file="$platform_dir/.env"
  local stack_ports
  stack_ports=$( {
    read_env_var ARCHESTRA_FRONTEND_PORT "$env_file"
    read_env_var ARCHESTRA_INTERNAL_API_BASE_URL "$env_file" | sed -E 's#.*:([0-9]+).*#\1#'
    read_env_var ARCHESTRA_METRICS_PORT "$env_file"
    read_env_var ARCHESTRA_POSTGRES_HOST_PORT "$env_file"
    read_env_var ARCHESTRA_POSTGRES_METRICS_HOST_PORT "$env_file"
    read_env_var ARCHESTRA_FRONTEND_INT_TESTS_PORT "$env_file"
  } | grep -E '^[0-9]+$' || true)
  if [ -n "$stack_ports" ]; then
    local j p all_free
    for j in $(seq 1 15); do
      all_free=true
      for p in $stack_ports; do
        port_is_free "$p" || { all_free=false; break; }
      done
      [ "$all_free" = true ] && break
      sleep 1
    done
  fi

  echo "✅ Parallel dev stack stopped." >&2
}

cmd_hydrate() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help) usage 0 ;;
      *)         echo "unknown arg: $1" >&2; usage 1 ;;
    esac
  done

  require_platform_cwd
  local platform_dir; platform_dir="$(pwd)"

  # Resolve the main worktree (same logic as up's auto-copy of .env).
  local main_worktree
  main_worktree=$(git -C "$platform_dir" worktree list --porcelain 2>/dev/null \
    | sed -n 's/^worktree //p' | head -n1)
  if [ -z "$main_worktree" ] || [ "$main_worktree/platform" = "$platform_dir" ]; then
    echo "ERROR: hydrate must be run from a NON-main worktree (the parallel stack)." >&2
    exit 1
  fi
  local main_env="$main_worktree/platform/.env"
  if [ ! -f "$main_env" ]; then
    echo "ERROR: main worktree at $main_worktree has no platform/.env to read pg port from." >&2
    exit 1
  fi

  # Both stacks reuse the same DB user/password/name; only the host port
  # differs. Read each from its own .env. Default to 5432 for the main
  # worktree (`tilt up` from main doesn't set ARCHESTRA_POSTGRES_HOST_PORT).
  # `|| true` keeps pipefail from aborting on grep-finds-nothing.
  local main_pg_port parallel_pg_port target_admin_email
  main_pg_port=$( { grep -E '^ARCHESTRA_POSTGRES_HOST_PORT=' "$main_env" || true; } \
    | tail -n1 | cut -d= -f2- | tr -d '"')
  main_pg_port="${main_pg_port:-5432}"
  parallel_pg_port=$( { grep -E '^ARCHESTRA_POSTGRES_HOST_PORT=' "$platform_dir/.env" || true; } \
    | tail -n1 | cut -d= -f2- | tr -d '"')
  if [ -z "$parallel_pg_port" ]; then
    echo "ERROR: $platform_dir/.env has no ARCHESTRA_POSTGRES_HOST_PORT. Has 'up' run yet?" >&2
    exit 1
  fi
  # tsx doesn't auto-load .env, so the backend script's
  # process.env.ARCHESTRA_AUTH_ADMIN_EMAIL would otherwise be undefined. Pull
  # it from the target worktree's .env here and forward it explicitly. Empty
  # value is fine — the backend script falls back to "admin@example.com".
  target_admin_email=$( { grep -E '^ARCHESTRA_AUTH_ADMIN_EMAIL=' "$platform_dir/.env" || true; } \
    | tail -n1 | cut -d= -f2- | tr -d '"')

  local source_url="postgresql://archestra:archestra_dev_password@localhost:${main_pg_port}/archestra_dev"
  local target_url="postgresql://archestra:archestra_dev_password@localhost:${parallel_pg_port}/archestra_dev"

  echo "→ Copying provider data from main (:${main_pg_port}) -> parallel (:${parallel_pg_port})" >&2
  SOURCE_DATABASE_URL="$source_url" \
  ARCHESTRA_DATABASE_URL="$target_url" \
  ARCHESTRA_AUTH_ADMIN_EMAIL="$target_admin_email" \
    pnpm --filter @backend db:hydrate-from
}

cmd_status() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help) usage 0 ;;
      *)         echo "unknown arg: $1" >&2; usage 1 ;;
    esac
  done

  local bold='' dim='' green='' reset=''
  if [ -t 1 ]; then
    bold=$'\033[1m'; dim=$'\033[2m'; green=$'\033[32m'; reset=$'\033[0m'
  fi

  # Parse `git worktree list --porcelain` into parallel path/branch arrays. Each
  # worktree is a "worktree <path>" line followed by branch/detached lines and a
  # blank separator; the main worktree is listed first.
  local -a paths=() branches=()
  local path="" branch="" line
  while IFS= read -r line; do
    case "$line" in
      "worktree "*)
        [ -n "$path" ] && { paths+=("$path"); branches+=("${branch:-(detached)}"); }
        path="${line#worktree }"; branch="" ;;
      "branch refs/heads/"*) branch="${line#branch refs/heads/}" ;;
    esac
  done < <(git worktree list --porcelain 2>/dev/null)
  [ -n "$path" ] && { paths+=("$path"); branches+=("${branch:-(detached)}"); }

  if [ "${#paths[@]}" -eq 0 ]; then
    echo "No git worktrees found (run from inside the repo)." >&2
    exit 1
  fi

  # Resolve each worktree's frontend port and liveness. Only the main worktree
  # (index 0, plain `tilt up`) defaults to :3000; a non-main worktree without a
  # persisted ARCHESTRA_FRONTEND_PORT has no parallel stack, so don't probe :3000
  # for it and falsely report the main frontend as its own.
  local -a names=() urls=() up=()
  local i port name_w=0 branch_w=0
  for i in "${!paths[@]}"; do
    names[i]="$(basename "${paths[i]}")"
    port="$(read_env_var ARCHESTRA_FRONTEND_PORT "${paths[i]}/platform/.env" || true)"
    if ! [[ "$port" =~ ^[0-9]+$ ]]; then
      [ "$i" -eq 0 ] && port=3000 || port=""
    fi
    if [ -n "$port" ] && curl -sf -o /dev/null --max-time 2 "http://localhost:${port}/" 2>/dev/null; then
      up[i]=1
    else
      up[i]=0
    fi
    urls[i]="${port:+http://localhost:${port}}"
    urls[i]="${urls[i]:-(no parallel stack)}"
    [ "${#names[i]}" -gt "$name_w" ] && name_w="${#names[i]}"
    [ "${#branches[i]}" -gt "$branch_w" ] && branch_w="${#branches[i]}"
  done

  printf '%s\n' "${bold}Archestra frontends${reset}"
  local glyph tag color name_pad branch_pad
  for i in "${!paths[@]}"; do
    if [ "${up[i]}" -eq 1 ]; then glyph="${green}●${reset}"; color=""; else glyph="${dim}○${reset}"; color="$dim"; fi
    [ "$i" -eq 0 ] && tag="${bold}[main]${reset}" || tag="      "
    printf -v name_pad   '%-*s' "$name_w"   "${names[i]}"
    printf -v branch_pad '%-*s' "$branch_w" "${branches[i]}"
    printf ' %s  %s%s%s  %s  %s%s%s  %s%s%s\n' \
      "$glyph" "$color" "$name_pad" "$reset" "$tag" \
      "$color" "$branch_pad" "$reset" "$color" "${urls[i]}" "$reset"
  done
}

pick_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()'
}

# Read a single VAR=value from an env file (last assignment wins, value verbatim).
# Prints nothing if the file or key is absent.
read_env_var() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 0
  grep -E "^[[:space:]]*${key}[[:space:]]*=" "$file" | tail -n1 | sed -E "s/^[[:space:]]*${key}[[:space:]]*=//"
}

# Persisted port candidate for reuse: value of key $1 in env file $2, but only
# when $3 == "true" (this .env was already parallelized). Empty otherwise, so
# the caller allocates a fresh port instead of reusing an inherited main default.
persisted_port() {
  [ "$3" = true ] && read_env_var "$1" "$2"
}

port_is_free() {
  python3 - "$1" <<'PYEOF'
import socket, sys
s = socket.socket()
# SO_REUSEADDR mirrors how the dev servers themselves bind, so a port lingering
# in TIME_WAIT from this stack's own just-stopped process reads as free (the
# server can rebind it) rather than as taken. An actively-LISTENING port still
# fails to bind, so genuine conflicts are still detected.
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(("", int(sys.argv[1])))
    ok = True
except OSError:
    ok = False
finally:
    s.close()
sys.exit(0 if ok else 1)
PYEOF
}

# Keep parallel-stack ports stable across restarts: reuse the port already
# persisted in .env when it's a usable parallel port — numeric, not the default
# 3000 (which belongs to a plain `tilt up`), and currently free. Otherwise fall
# back to a fresh OS-assigned free port (which the .env rewrite then persists).
# $1 = candidate value previously read from .env (may be empty/non-numeric).
resolve_port() {
  local candidate="$1"
  if [[ "$candidate" =~ ^[0-9]+$ ]] && [ "$candidate" != "3000" ] && port_is_free "$candidate"; then
    echo "$candidate"
  else
    pick_port
  fi
}

if [ $# -lt 1 ]; then usage 1; fi
subcommand="$1"; shift
case "$subcommand" in
  up)             cmd_up "$@" ;;
  down)           cmd_down "$@" ;;
  hydrate)        cmd_hydrate "$@" ;;
  status)         cmd_status "$@" ;;
  -h|--help) usage 0 ;;
  *)         echo "unknown subcommand: $subcommand" >&2; usage 1 ;;
esac

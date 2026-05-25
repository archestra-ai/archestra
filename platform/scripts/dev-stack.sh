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
#   dev-stack.sh up   [--detach] [--namespace NAME]
#   dev-stack.sh down
#
# `up`:   without --detach, execs `tilt up` in the foreground (Ctrl+C stops
#         it). With --detach, runs Tilt in the background via nohup, writes
#         a PID file, and returns once the frontend responds.
# `down`: kills the detached Tilt (if any) and runs `tilt down`.
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
    cat >&2 <<EOF
ERROR: $env_file not found.

Copy it from your main worktree first, e.g.:
  cp <main-worktree>/platform/.env $env_file
EOF
    exit 1
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

  local frontend_port backend_port metrics_port pg_port pg_metrics_port int_tests_port tilt_port
  frontend_port=$(pick_port)
  backend_port=$(pick_port)
  metrics_port=$(pick_port)
  pg_port=$(pick_port)
  pg_metrics_port=$(pick_port)
  int_tests_port=$(pick_port)
  tilt_port=$(pick_port)

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
  echo "✅ Parallel dev stack stopped." >&2
}

pick_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()'
}

if [ $# -lt 1 ]; then usage 1; fi
subcommand="$1"; shift
case "$subcommand" in
  up)        cmd_up "$@" ;;
  down)      cmd_down "$@" ;;
  -h|--help) usage 0 ;;
  *)         echo "unknown subcommand: $subcommand" >&2; usage 1 ;;
esac

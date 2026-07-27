#!/usr/bin/env sh
set -u

cd "$(dirname "$0")/.."

export ARCHESTRA_LOGGING_LEVEL=debug
export ARCHESTRA_ANALYTICS=disabled

backend_pid=""

# The node server is a grandchild of $backend_pid (pnpm → tsdown --watch →
# node), so the TERM to $backend_pid and its direct children can miss it. A
# survivor keeps 9000/9050 bound and the next serve dies with EADDRINUSE, which
# is why `tilt trigger pnpm-dev-backend` used to leave the old server running.
# Sweep the dev ports on both stop and start.
free_backend_ports() {
  for port in 9000 "${ARCHESTRA_METRICS_PORT:-9050}"; do
    pids="$(lsof -t -i "tcp:$port" -s tcp:LISTEN 2>/dev/null || true)"
    [ -n "$pids" ] || continue
    echo "killing stale backend listener(s) on port $port: $pids" >&2
    kill -TERM $pids 2>/dev/null || true
    i=0
    while [ -n "$(lsof -t -i "tcp:$port" -s tcp:LISTEN 2>/dev/null || true)" ] && [ "$i" -lt 20 ]; do
      i=$((i + 1))
      sleep 0.25
    done
    pids="$(lsof -t -i "tcp:$port" -s tcp:LISTEN 2>/dev/null || true)"
    [ -n "$pids" ] && kill -KILL $pids 2>/dev/null || true
  done
}

stop_backend() {
  if [ -n "$backend_pid" ] && kill -0 "$backend_pid" 2>/dev/null; then
    kill -TERM "$backend_pid" 2>/dev/null || true
    pkill -TERM -P "$backend_pid" 2>/dev/null || true
    wait "$backend_pid" 2>/dev/null || true
  fi
  backend_pid=""
  free_backend_ports
}

start_backend() {
  free_backend_ports
  pnpm dev --filter @backend &
  backend_pid=$!
}

cleanup() {
  stop_backend
}

trap cleanup EXIT INT TERM

if [ "${ARCHESTRA_CODE_RUNTIME_ENABLED:-}" = "true" ]; then
  # Without an explicit runner host, the backend provisions per-organization
  # Dagger engines in-cluster, so it needs the orchestrator wired to the local
  # cluster and engine resources small enough to fit a local VM (the shipped
  # defaults reserve room for concurrent sandbox load and a large build cache).
  # An explicit ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST points the backend at
  # a pre-existing engine instead and skips all of this.
  if [ -z "${ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST:-}" ]; then
    # This backend runs on the developer's machine, not in a pod, so it reaches
    # the cluster through a kubeconfig file. ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG
    # _FROM_CURRENT_CLUSTER would call loadFromCluster(), which only resolves an
    # API server address from the in-pod service-account environment.
    if [ -z "${ARCHESTRA_ORCHESTRATOR_KUBECONFIG:-}" ] && \
       [ "${ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER:-}" != "true" ]; then
      export ARCHESTRA_ORCHESTRATOR_KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
    fi
    : "${ARCHESTRA_DAGGER_RUNTIME_ENGINE_CPU_REQUEST:=500m}"
    # Request covers the sandbox ceiling below plus the daemon's own footprint,
    # the same relationship the shipped defaults keep.
    : "${ARCHESTRA_DAGGER_RUNTIME_ENGINE_MEMORY_REQUEST:=1536Mi}"
    : "${ARCHESTRA_DAGGER_RUNTIME_ENGINE_MEMORY_LIMIT:=1536Mi}"
    : "${ARCHESTRA_DAGGER_RUNTIME_ENGINE_CACHE_STORAGE:=10Gi}"
    : "${ARCHESTRA_DAGGER_RUNTIME_ENGINE_SANDBOX_MEMORY_MAX_BYTES:=1073741824}"
    export ARCHESTRA_DAGGER_RUNTIME_ENGINE_CPU_REQUEST \
      ARCHESTRA_DAGGER_RUNTIME_ENGINE_MEMORY_REQUEST \
      ARCHESTRA_DAGGER_RUNTIME_ENGINE_MEMORY_LIMIT \
      ARCHESTRA_DAGGER_RUNTIME_ENGINE_CACHE_STORAGE \
      ARCHESTRA_DAGGER_RUNTIME_ENGINE_SANDBOX_MEMORY_MAX_BYTES
  fi

  # the Dagger SDK shells out to the `dagger` CLI to open engine sessions
  # even when the runner host is set. prod bakes the binary into the image
  # (see ../Dockerfile), so for local dev we mirror that by bootstrapping one
  # copy shared by all git worktrees for this clone.
  DAGGER_VERSION="$(sed -n 's/^ARG DAGGER_VERSION=v\{0,1\}\([0-9][^[:space:]]*\)$/\1/p' Dockerfile)"
  DAGGER_BIN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.dev-bin/dagger"
  if [ -z "$DAGGER_VERSION" ]; then
    echo "failed to read DAGGER_VERSION from Dockerfile" >&2
    exit 1
  fi
  if [ ! -x "$DAGGER_BIN" ] || ! "$DAGGER_BIN" version 2>/dev/null | grep -q "v${DAGGER_VERSION}"; then
    OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
    ARCH="$(uname -m)"
    case "$ARCH" in
      x86_64) ARCH=amd64 ;;
      aarch64) ARCH=arm64 ;;
    esac
    mkdir -p "$(dirname "$DAGGER_BIN")"
    echo "bootstrapping dagger CLI v${DAGGER_VERSION} for ${OS}/${ARCH} into ${DAGGER_BIN}" >&2
    curl -fsSL "https://dl.dagger.io/dagger/releases/${DAGGER_VERSION}/dagger_v${DAGGER_VERSION}_${OS}_${ARCH}.tar.gz" \
      | tar -xz -C "$(dirname "$DAGGER_BIN")" dagger
    chmod +x "$DAGGER_BIN"
  fi
  if [ -z "${ARCHESTRA_DAGGER_RUNTIME_CLI_BIN:-}" ] && [ -z "${ARCHESTRA_CODE_RUNTIME_DAGGER_CLI_BIN:-}" ]; then
    export ARCHESTRA_DAGGER_RUNTIME_CLI_BIN="$DAGGER_BIN"
    export ARCHESTRA_CODE_RUNTIME_DAGGER_CLI_BIN="$DAGGER_BIN"
  fi
fi

start_backend

wait "$backend_pid"

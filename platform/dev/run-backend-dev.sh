#!/usr/bin/env sh
set -u

cd "$(dirname "$0")/.."

export ARCHESTRA_LOGGING_LEVEL=debug
export ARCHESTRA_ANALYTICS=disabled

backend_pid=""

stop_backend() {
  if [ -n "$backend_pid" ] && kill -0 "$backend_pid" 2>/dev/null; then
    kill -TERM "$backend_pid" 2>/dev/null || true
    pkill -TERM -P "$backend_pid" 2>/dev/null || true
    wait "$backend_pid" 2>/dev/null || true
  fi
  backend_pid=""
}

start_backend() {
  pnpm dev --filter @backend &
  backend_pid=$!
}

cleanup() {
  stop_backend
}

trap cleanup EXIT INT TERM

if [ "${ARCHESTRA_CODE_RUNTIME_ENABLED:-}" = "true" ]; then
  if [ -z "${ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST:-}" ]; then
    export ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST="tcp://127.0.0.1:1234"
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

  if [ "$ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST" = "tcp://127.0.0.1:1234" ]; then
    while ! nc -z 127.0.0.1 1234 >/dev/null 2>&1; do
      sleep 1
    done
  fi
fi

start_backend

wait "$backend_pid"

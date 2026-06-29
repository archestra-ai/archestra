#!/bin/sh

set -eu

# Startup wrapper for production Node processes.
#
# We centralize diagnostics flags here so Docker, Helm web pods, and Helm worker
# pods all launch Node consistently:
# - --report-on-fatalerror writes a Node diagnostic report on fatal runtime errors
# - --report-uncaught-exception writes a report for uncaught exceptions
# - --diagnostic-dir keeps those artifacts in a predictable persisted location
# - --heapsnapshot-near-heap-limit is opt-in because snapshots are expensive and
#   intended for targeted near-OOM investigations
#
# Node CLI references:
# https://nodejs.org/api/cli.html#--report-on-fatalerror
# https://nodejs.org/api/cli.html#--report-uncaught-exception
# https://nodejs.org/api/cli.html#--diagnostic-dirdirectory
# https://nodejs.org/api/cli.html#--heapsnapshot-near-heap-limitmax_count
#
# Default diagnostics path differs by runtime:
# - Docker / quickstart falls back to /app/data/diagnostics
# - Helm diagnostics storage mounts a PVC at /var/diagnostics and sets the env var
export ARCHESTRA_NODE_DIAGNOSTIC_DIR="${ARCHESTRA_NODE_DIAGNOSTIC_DIR:-/app/data/diagnostics}"

mkdir -p "$ARCHESTRA_NODE_DIAGNOSTIC_DIR"

set -- \
  --enable-source-maps \
  --report-on-fatalerror \
  --report-uncaught-exception \
  --diagnostic-dir="$ARCHESTRA_NODE_DIAGNOSTIC_DIR"

if [ -n "${ARCHESTRA_NODE_HEAPSNAPSHOT_NEAR_HEAP_LIMIT:-}" ]; then
  set -- "$@" "--heapsnapshot-near-heap-limit=${ARCHESTRA_NODE_HEAPSNAPSHOT_NEAR_HEAP_LIMIT}"
fi

exec node "$@" dist/server.mjs

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
# https://nodejs.org/api/cli.html#--enable-source-maps
# https://nodejs.org/api/cli.html#--report-on-fatalerror
# https://nodejs.org/api/cli.html#--report-uncaught-exception
# https://nodejs.org/api/cli.html#--diagnostic-dirdirectory
# https://nodejs.org/api/cli.html#--heapsnapshot-near-heap-limitmax_count
#
# Default diagnostics path differs by runtime:
# - Docker / quickstart falls back to /app/data/diagnostics
# - Helm diagnostics storage mounts a PVC at /var/diagnostics and sets the env var
export ARCHESTRA_NODE_DIAGNOSTIC_DIR="${ARCHESTRA_NODE_DIAGNOSTIC_DIR:-/app/data/diagnostics}"

# An arbitrary UID (OpenShift) has no home directory, so HOME is `/`. The
# backend's caches live under HOME; give them the image's writable one.
if [ ! -w "${HOME:-/}" ] && [ -w /home/archestra ]; then
  export HOME=/home/archestra
fi

mkdir -p "$ARCHESTRA_NODE_DIAGNOSTIC_DIR"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node_max_old_space_size_mib=$(
  "$script_dir/calculate-node-max-old-space-size.sh"
)

set -- \
  --report-on-fatalerror \
  --report-uncaught-exception \
  --diagnostic-dir="$ARCHESTRA_NODE_DIAGNOSTIC_DIR"

# Source maps put TypeScript files and lines in logged stack traces. Node keeps
# every loaded chunk's decoded map in memory (about 250 MB), so the Docker
# quickstart, where nobody reads those logs, runs without them. Error reports
# are symbolicated from the maps uploaded at build time either way.
source_maps_default=true
if [ "${ARCHESTRA_QUICKSTART:-}" = "true" ]; then
  source_maps_default=false
fi
case "${ARCHESTRA_NODE_SOURCE_MAPS:-$source_maps_default}" in
  true) set -- --enable-source-maps "$@" ;;
  false) ;;
  *)
    echo "WARNING: invalid ARCHESTRA_NODE_SOURCE_MAPS value '${ARCHESTRA_NODE_SOURCE_MAPS}', using ${source_maps_default}" >&2
    if [ "$source_maps_default" = "true" ]; then
      set -- --enable-source-maps "$@"
    fi
    ;;
esac

if [ -n "$node_max_old_space_size_mib" ]; then
  echo "Configuring Node old-space limit: ${node_max_old_space_size_mib} MiB"
  set -- "$@" "--max-old-space-size=${node_max_old_space_size_mib}"
fi

if [ -n "${ARCHESTRA_NODE_HEAPSNAPSHOT_NEAR_HEAP_LIMIT:-}" ]; then
  set -- "$@" "--heapsnapshot-near-heap-limit=${ARCHESTRA_NODE_HEAPSNAPSHOT_NEAR_HEAP_LIMIT}"
fi

exec node "$@" dist/server.mjs

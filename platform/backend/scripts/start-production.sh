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

# --dns-result-order=ipv4first makes `localhost` resolve to [127.0.0.1, ::1]
# instead of [::1, 127.0.0.1]. getaddrinfo ranks ::1 first per RFC 6724
# regardless of /etc/hosts order, and Node >= 17 passes that order through
# verbatim, but every listener here binds 0.0.0.0 -- so `localhost` always
# tries a guaranteed-refused ::1 first. That is the `ECONNREFUSED ::1:9000`
# in issue #4917, and it is paid on every new connection to the loopback URL
# in clients/llm-client.ts (which the web, worker and renderer pods all use).
# IPv6 is only reordered, never dropped: ::1 remains as the fallback.
# Set here as well as in the image ENV so an operator overriding NODE_OPTIONS
# cannot silently take it away from the server processes.
set -- \
  --enable-source-maps \
  --dns-result-order=ipv4first \
  --report-on-fatalerror \
  --report-uncaught-exception \
  --diagnostic-dir="$ARCHESTRA_NODE_DIAGNOSTIC_DIR"

if [ -n "${ARCHESTRA_NODE_HEAPSNAPSHOT_NEAR_HEAP_LIMIT:-}" ]; then
  set -- "$@" "--heapsnapshot-near-heap-limit=${ARCHESTRA_NODE_HEAPSNAPSHOT_NEAR_HEAP_LIMIT}"
fi

exec node "$@" dist/server.mjs

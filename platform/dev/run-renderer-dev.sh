#!/usr/bin/env sh
set -u

# Runs the app-recording video render service (ARCHESTRA_PROCESS_TYPE=renderer)
# as its own local process, so `tilt up` exercises the same web-tier -> renderer
# proxy path that staging uses (rather than the backend rendering in-process).
#
# Opt-in: Tilt only creates this resource when ARCHESTRA_APP_RECORDING_RENDERER_URL
# is set, which also makes the backend proxy render/status/download/cancel here.
# Unset, the backend renders in-process and this never runs.
#
# It runs the SAME bundle the backend's watch build produces (dist/server.mjs),
# just in renderer mode on its own port (from ARCHESTRA_INTERNAL_API_BASE_URL),
# so a code change rebuilds once and Tilt restarts this against the fresh bundle.

cd "$(dirname "$0")/../backend"

export ARCHESTRA_PROCESS_TYPE=renderer

# Wait for the backend's watch build to produce the bundle on a cold start,
# rather than crash-looping until it appears. Non-fatal (a compile error is
# transient in watch mode — the file lands once the build goes green), but not
# silent: say what it is waiting on, and nag every 30s so a stuck build reads as
# a stuck build rather than a hung resource.
if [ ! -f dist/server.mjs ]; then
  echo "run-renderer-dev: waiting for the backend watch build to produce dist/server.mjs..." >&2
fi
waited=0
while [ ! -f dist/server.mjs ]; do
  if [ "$waited" -gt 0 ] && [ "$((waited % 30))" -eq 0 ]; then
    echo "run-renderer-dev: still no dist/server.mjs after ${waited}s — check the backend resource for a failing build." >&2
  fi
  sleep 1
  waited=$((waited + 1))
done

# exec so Tilt's TERM reaches node directly — its graceful shutdown frees the
# port — with no pnpm/tsdown wrapper in between to orphan it.
exec node dist/server.mjs

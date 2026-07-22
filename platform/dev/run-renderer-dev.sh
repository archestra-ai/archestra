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

# Run in dev mode no matter what the shell that launched `tilt up` had exported.
# The backend dev process never sees an inherited NODE_ENV (its chain goes
# through turbo, whose strict env mode strips it), but this serve_cmd bypasses
# turbo — a stray NODE_ENV=production from the launching shell flips the shared
# bundle into production behavior: analytics defaulting on, 0.0.0.0 binding,
# and better-auth's default-secret guard rejecting at boot.
unset NODE_ENV

# Wait for the backend's watch build to produce a COMPLETE bundle before booting,
# rather than crash-looping until it settles. Two things have to be true, not one:
#
#   1. dist/server.mjs exists. On a cold start (or right after tsdown's watch-mode
#      dist wipe) it briefly does not — waiting beats crash-looping.
#   2. The bundle is fully written. tsdown code-splits into hash-named chunks, and
#      dist/server.mjs pulls some of them in with `await import("./sentry-<hash>.mjs")`
#      — a *dynamic* import Node resolves only when it reaches that line at runtime.
#      Tilt restarts this resource the instant dist/server.mjs changes (its `deps`),
#      which during a rebuild is mid-write-burst: the entry chunk lands before every
#      chunk it imports does. Booting then sails past the static imports, reaches the
#      dynamic one and dies with ERR_MODULE_NOT_FOUND on a chunk that simply is not
#      on disk yet — the "fails on the first restart, succeeds on the next" symptom.
#      Waiting for the emitted dist/*.mjs set to stop changing closes the race: once
#      the write burst settles, every chunk (static and dynamically imported) exists.
#
# Non-fatal (a compile error is transient in watch mode — the files land once the
# build goes green) but not silent: say what it is waiting on, and nag every 30s so
# a stuck build reads as a stuck build rather than a hung resource.
if [ ! -f dist/server.mjs ]; then
  echo "run-renderer-dev: waiting for the backend watch build to produce dist/server.mjs..." >&2
fi

# A fingerprint of every emitted JS chunk's size (the .map sidecars are unused at
# runtime, so they're excluded). It shifts while rolldown is still writing and holds
# steady once the burst completes; two identical samples a second apart mean done.
bundle_fingerprint() {
  find dist -type f -name '*.mjs' -exec wc -c {} + 2>/dev/null | sort
}

waited=0
prev=""
while :; do
  if [ -f dist/server.mjs ]; then
    cur="$(bundle_fingerprint)"
    if [ -n "$cur" ] && [ "$cur" = "$prev" ]; then
      break
    fi
    prev="$cur"
  fi
  if [ "$waited" -gt 0 ] && [ "$((waited % 30))" -eq 0 ]; then
    echo "run-renderer-dev: still waiting on a complete dist bundle after ${waited}s — check the backend resource for a failing build." >&2
  fi
  sleep 1
  waited=$((waited + 1))
done

# The renderer's output lands in a FILE, with a background tail mirroring it
# into Tilt's log view — not the other way round. Tilt's capture pipe is the
# fragile leg here: it has been seen going dark after serve restarts, and a
# process writing straight into a wedged pipe first loses its logs and then
# blocks on the write. A file never wedges: the render failure that needs
# debugging is on disk no matter what Tilt managed to display, and the tail is
# the disposable leg. One previous run is kept for the crash-then-restart case.
LOG_FILE="renderer-dev.log"           # cwd is backend/; *.log is gitignored
mv -f "$LOG_FILE" "renderer-dev.prev.log" 2>/dev/null || true
: > "$LOG_FILE"
echo "run-renderer-dev: renderer output → backend/$LOG_FILE (previous run: backend/renderer-dev.prev.log)" >&2
echo "run-renderer-dev: serving bundle built at $(date -r dist/server.mjs +%Y-%m-%dT%H:%M:%S%z 2>/dev/null || echo '?')" >&2
tail -f "$LOG_FILE" &

# exec so Tilt's TERM reaches node directly — its graceful shutdown frees the
# port — with no pnpm/tsdown wrapper in between to orphan it. Source maps so a
# stack from the bundle names real files, not dist offsets.
exec node --enable-source-maps dist/server.mjs >> "$LOG_FILE" 2>&1

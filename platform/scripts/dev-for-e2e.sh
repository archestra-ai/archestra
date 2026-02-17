#!/usr/bin/env bash
# Launcher for E2E: set backend URL to localhost so frontend proxies to local backend, then run pnpm dev.
# Called by run-e2e-with-app.sh; do not run directly unless you want dev with forced local API.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export ARCHESTRA_API_BASE_URL="http://127.0.0.1:9000"
export NEXT_PUBLIC_ARCHESTRA_API_BASE_URL="http://127.0.0.1:9000"
cd "$PLATFORM_ROOT"
exec pnpm run dev

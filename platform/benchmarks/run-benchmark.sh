#!/usr/bin/env bash
# Run against an already-started benchmark stack. See README.md for setup.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node benchmarks/run.mjs "$@"

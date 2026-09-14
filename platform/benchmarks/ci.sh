#!/usr/bin/env bash
# Isolated stack lifecycle for CI. Local development uses benchmarks/Tiltfile.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p benchmarks/results
backend_pid=""
mock_pid=""
cleanup() {
  if [[ -n "$backend_pid" ]]; then kill "$backend_pid" 2>/dev/null || true; wait "$backend_pid" 2>/dev/null || true; fi
  if [[ -n "$mock_pid" ]]; then kill "$mock_pid" 2>/dev/null || true; wait "$mock_pid" 2>/dev/null || true; fi
  docker compose -p archestra-benchmark -f benchmarks/compose.yaml logs --no-color > benchmarks/results/postgres.log 2>&1 || true
  docker compose -p archestra-benchmark -f benchmarks/compose.yaml down --volumes
}
# Refuse to take over an existing stack, including a developer's Tilt session.
if [[ -n "$(docker compose -p archestra-benchmark -f benchmarks/compose.yaml ps -aq)" ]]; then
  echo "An archestra-benchmark stack already exists; stop it before running CI locally." >&2
  exit 1
fi
for port in 15432 19000 19050 19092; do
  if node -e 'const s=require("node:net").connect(Number(process.argv[1]),"127.0.0.1"); s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1))' "$port"; then
    echo "Port $port is in use." >&2
    exit 1
  fi
done
trap cleanup EXIT
docker compose -p archestra-benchmark -f benchmarks/compose.yaml up -d --wait
node benchmarks/mock-upstream.mjs > benchmarks/results/mock.log 2>&1 &
mock_pid=$!
node benchmarks/backend.mjs prepare > benchmarks/results/build.log 2>&1
node benchmarks/backend.mjs serve > benchmarks/results/backend.log 2>&1 &
backend_pid=$!
ready=false
for ((i=0; i<120; i++)); do
  if ! kill -0 "$backend_pid" 2>/dev/null; then
    tail -40 benchmarks/results/backend.log
    exit 1
  fi
  if curl -fsS http://127.0.0.1:19000/health > /dev/null; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then echo "Backend did not become ready" >&2; exit 1; fi
node benchmarks/run.mjs --output=benchmarks/results/ci "$@"

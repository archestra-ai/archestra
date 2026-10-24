#!/usr/bin/env bash
# Isolated stack lifecycle for CI. Local development uses benchmarks/Tiltfile.
set -euo pipefail
cd "$(dirname "$0")/.."
port_offset=0
cpu_profile=false
runner_args=()
backend_args=()
output=benchmarks/results/ci
compose_files=(-f benchmarks/compose.yaml)
for arg in "$@"; do
  case "$arg" in
    --port-offset=*) port_offset="${arg#*=}" ;;
    --cpu-profile) cpu_profile=true ;;
    *) runner_args+=("$arg") ;;
  esac
done
if [[ "$cpu_profile" == true ]]; then
  output=benchmarks/results/profile
  backend_args+=(--cpu-profile)
  runner_args+=(--diagnostic=cpu-profile)
  compose_files+=(-f benchmarks/compose.profile.yaml)
fi
if ! [[ "$port_offset" =~ ^[0-9]{1,4}$ ]]; then
  echo "Port offset must be an integer from 0 to 9999." >&2
  exit 1
fi
port_offset=$((10#$port_offset))
backend_port=$((19000 + port_offset))
mock_port=$((19092 + port_offset))
export BENCHMARK_POSTGRES_PORT=$((15432 + port_offset))
project=archestra-benchmark
if [[ "$port_offset" != 0 ]]; then project="archestra-benchmark-$port_offset"; fi
mkdir -p benchmarks/results
backend_pid=""
mock_pid=""
cleanup() {
  if [[ -n "$backend_pid" ]]; then kill "$backend_pid" 2>/dev/null || true; wait "$backend_pid" 2>/dev/null || true; fi
  if [[ -n "$mock_pid" ]]; then kill "$mock_pid" 2>/dev/null || true; wait "$mock_pid" 2>/dev/null || true; fi
  if [[ "$cpu_profile" == true ]]; then
    mkdir -p "$output"
    docker compose -p "$project" "${compose_files[@]}" exec -T postgres \
      psql -U benchmark -d benchmark -Atc \
      "SELECT coalesce(json_agg(statement), '[]'::json) FROM (SELECT query, calls, total_plan_time, total_exec_time, mean_exec_time, rows, shared_blks_hit, shared_blks_read FROM pg_stat_statements ORDER BY total_exec_time DESC) statement" \
      > "$output/postgres-statements.json" || true
  fi
  docker compose -p "$project" "${compose_files[@]}" logs --no-color > benchmarks/results/postgres.log 2>&1 || true
  docker compose -p "$project" "${compose_files[@]}" down --volumes
}
# Refuse to take over an existing stack, including a developer's Tilt session.
if [[ -n "$(docker compose -p "$project" "${compose_files[@]}" ps -aq)" ]]; then
  echo "A $project stack already exists; stop it before running CI locally." >&2
  exit 1
fi
for port in "$BENCHMARK_POSTGRES_PORT" "$backend_port" "$((19050 + port_offset))" "$mock_port"; do
  if node -e 'const s=require("node:net").connect(Number(process.argv[1]),"127.0.0.1"); s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1))' "$port"; then
    echo "Port $port is in use." >&2
    exit 1
  fi
done
trap cleanup EXIT
docker compose -p "$project" "${compose_files[@]}" up -d --wait
if [[ "$cpu_profile" == true ]]; then
  docker compose -p "$project" "${compose_files[@]}" exec -T postgres \
    psql -U benchmark -d benchmark -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION pg_stat_statements' > /dev/null
fi
node benchmarks/mock-upstream.mjs "$port_offset" > benchmarks/results/mock.log 2>&1 &
mock_pid=$!
node benchmarks/backend.mjs prepare "$port_offset" > benchmarks/results/build.log 2>&1
node benchmarks/backend.mjs serve "$port_offset" "${backend_args[@]}" > benchmarks/results/backend.log 2>&1 &
backend_pid=$!
ready=false
for ((i=0; i<120; i++)); do
  if ! kill -0 "$backend_pid" 2>/dev/null; then
    tail -40 benchmarks/results/backend.log
    exit 1
  fi
  if curl -fsS "http://127.0.0.1:$backend_port/ready" > /dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then echo "Backend did not become ready" >&2; exit 1; fi
benchmark_virtual_key=$(node benchmarks/seed.mjs "$port_offset")
if [[ "$cpu_profile" == true ]]; then
  docker compose -p "$project" "${compose_files[@]}" exec -T postgres \
    psql -U benchmark -d benchmark -Atc 'SELECT pg_stat_statements_reset()' > /dev/null
fi
ARCHESTRA_BENCHMARK_VIRTUAL_KEY="$benchmark_virtual_key" node benchmarks/run.mjs "--output=$output" \
  "--proxy-url=http://127.0.0.1:$backend_port/v1/openai/chat/completions" \
  "--mock-url=http://127.0.0.1:$mock_port/v1/chat/completions" "${runner_args[@]}"

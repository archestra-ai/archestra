#!/usr/bin/env bash
# Isolated stack lifecycle for CI. Local development uses benchmarks/Tiltfile.
set -euo pipefail
cd "$(dirname "$0")/.."
port_offset=0
cpu_profile=false
backend_limits=false
web_workers=1
runner_args=()
backend_args=()
output=benchmarks/results/ci
compose_files=(-f benchmarks/compose.yaml)
for arg in "$@"; do
  case "$arg" in
    --port-offset=*) port_offset="${arg#*=}" ;;
    --cpu-profile) cpu_profile=true ;;
    --backend-limits) backend_limits=true ;;
    --web-workers=*) web_workers="${arg#*=}" ;;
    *) runner_args+=("$arg") ;;
  esac
done
if ! [[ "$web_workers" =~ ^[1-4]$ ]]; then
  echo 'Web workers must be an integer from 1 to 4.' >&2
  exit 1
fi
backend_args+=("--web-workers=$web_workers")
if [[ "$web_workers" != 1 ]]; then runner_args+=("--web-workers=$web_workers"); fi
if [[ "$cpu_profile" == true && "$web_workers" != 1 ]]; then
  echo 'CPU profiles support one web process.' >&2
  exit 1
fi
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
# --backend-limits gives the web process the published comparison's resources:
# four pinned CPUs and 8 GiB without swap. The load client and mock share two
# other CPUs and PostgreSQL gets two more, so none competes with the backend.
client_cpus=()
backend_launcher=()
if [[ "$backend_limits" == true ]]; then
  if [[ "$(uname -s)" != Linux ]] || ! command -v systemd-run taskset > /dev/null || ! sudo -n true 2> /dev/null; then
    echo 'Backend limits need Linux with systemd-run, taskset and passwordless sudo.' >&2
    exit 1
  fi
  if (( $(nproc) < 8 )); then
    echo 'Backend limits need at least eight CPUs.' >&2
    exit 1
  fi
  client_cpus=(taskset -c 0-1)
fi
backend_port=$((19000 + port_offset))
mock_port=$((19092 + port_offset))
export BENCHMARK_POSTGRES_PORT=$((15432 + port_offset))
project=archestra-benchmark
if [[ "$port_offset" != 0 ]]; then project="archestra-benchmark-$port_offset"; fi
backend_scope="$project-backend-$$"
if [[ "$backend_limits" == true ]]; then
  backend_launcher=(sudo -n systemd-run --scope --quiet "--unit=$backend_scope"
    -p AllowedCPUs=2-5 -p MemoryMax=8G -p MemorySwapMax=0
    "--uid=$(id -u)" "--gid=$(id -g)" -- env "PATH=$PATH" "HOME=$HOME")
fi
mkdir -p benchmarks/results
backend_pid=""
mock_pid=""
cleanup() {
  if [[ -n "$backend_pid" ]]; then
    # sudo does not relay a signal from its command's own process group, which
    # includes this script, so stop a limited backend through its scope.
    if [[ "$backend_limits" == true ]]; then
      sudo -n systemctl kill --signal=SIGTERM "$backend_scope.scope" 2>/dev/null || true
    else
      kill "$backend_pid" 2>/dev/null || true
    fi
    wait "$backend_pid" 2>/dev/null || true
  fi
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
ports_to_check=("$BENCHMARK_POSTGRES_PORT" "$backend_port" "$mock_port")
for ((worker=0; worker<web_workers; worker++)); do
  ports_to_check+=("$((19050 + port_offset + worker * 100))")
done
for port in "${ports_to_check[@]}"; do
  if node -e 'const s=require("node:net").connect(Number(process.argv[1]),"127.0.0.1"); s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1))' "$port"; then
    echo "Port $port is in use." >&2
    exit 1
  fi
done
trap cleanup EXIT
rm -f "benchmarks/results/workers-$backend_port.json"
docker compose -p "$project" "${compose_files[@]}" up -d --wait
if [[ "$backend_limits" == true ]]; then
  docker update --cpuset-cpus=6-7 --cpus=2 --memory=8g --memory-swap=8g \
    "$(docker compose -p "$project" "${compose_files[@]}" ps -q postgres)" > /dev/null
fi
if [[ "$cpu_profile" == true ]]; then
  docker compose -p "$project" "${compose_files[@]}" exec -T postgres \
    psql -U benchmark -d benchmark -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION pg_stat_statements' > /dev/null
fi
${client_cpus[@]+"${client_cpus[@]}"} node benchmarks/mock-upstream.mjs "$port_offset" > benchmarks/results/mock.log 2>&1 &
mock_pid=$!
node benchmarks/backend.mjs prepare "$port_offset" > benchmarks/results/build.log 2>&1
${backend_launcher[@]+"${backend_launcher[@]}"} node benchmarks/backend.mjs serve "$port_offset" "${backend_args[@]}" > benchmarks/results/backend.log 2>&1 &
backend_pid=$!
ready=false
for ((i=0; i<120; i++)); do
  if ! kill -0 "$backend_pid" 2>/dev/null; then
    tail -40 benchmarks/results/backend.log
    exit 1
  fi
  if [[ "$web_workers" != 1 && ! -f "benchmarks/results/workers-$backend_port.json" ]]; then sleep 1; continue; fi
  if curl -fsS "http://127.0.0.1:$backend_port/ready" > /dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then echo "Backend did not become ready" >&2; exit 1; fi
if [[ "$backend_limits" == true ]]; then
  # Record the limits the kernel enforces, not the ones requested.
  cgroup="/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$backend_scope.scope")"
  memory_max=$(cat "$cgroup/memory.max")
  if [[ ! "$memory_max" =~ ^[0-9]+$ || "$(cat "$cgroup/memory.swap.max")" != 0 ]]; then
    echo 'The backend scope has no memory limit.' >&2
    exit 1
  fi
  backend_cpus=$(node -e 'let n=0;for(const r of process.argv[1].trim().split(",")){const [a,b=a]=r.split("-").map(Number);n+=b-a+1}console.log(n)' "$(cat "$cgroup/cpuset.cpus.effective")")
  runner_args+=("--backend-cpus=$backend_cpus" "--backend-memory-bytes=$memory_max")
fi
benchmark_virtual_key=$(node benchmarks/seed.mjs "$port_offset")
read -r mcp_agent_id mcp_tool mcp_token < <(node benchmarks/seed.mjs "$port_offset" mcp)
if [[ "$cpu_profile" == true ]]; then
  docker compose -p "$project" "${compose_files[@]}" exec -T postgres \
    psql -U benchmark -d benchmark -Atc 'SELECT pg_stat_statements_reset()' > /dev/null
fi
ARCHESTRA_BENCHMARK_VIRTUAL_KEY="$benchmark_virtual_key" ARCHESTRA_BENCHMARK_MCP_TOKEN="$mcp_token" \
  ${client_cpus[@]+"${client_cpus[@]}"} node benchmarks/run.mjs "--output=$output" \
  "--proxy-url=http://127.0.0.1:$backend_port/v1/openai/chat/completions" \
  "--mock-url=http://127.0.0.1:$mock_port/v1/chat/completions" \
  "--mcp-url=http://127.0.0.1:$backend_port/v1/mcp/$mcp_agent_id" "--mcp-tool=$mcp_tool" "${runner_args[@]}"

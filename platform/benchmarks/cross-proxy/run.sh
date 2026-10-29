#!/usr/bin/env bash
# CI-only, disposable, LLM proxy comparison. Never sources .env.
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ $(uname -m) == x86_64 && $(nproc) -ge 8 && ! -e .env ]] || { echo 'Requires clean Linux x86_64 runner with >=8 CPUs and no .env'; exit 1; }
mode=primary
if [[ "${1:-}" == --sensitivity && $# == 1 ]]; then mode=sensitivity; elif (($#)); then echo "Unknown arguments"; exit 1; fi
repeats=4
db_memory=2g
rows_per_run=13401
out=benchmarks/results/cross-proxy
if [[ "$mode" == sensitivity ]]; then repeats=2; db_memory=8g; rows_per_run=6401; out=benchmarks/results/cross-proxy-sensitivity; fi
[[ ! -e "$out/versions.txt" ]] || { echo "Preserve/move previous cross-proxy results before rerunning."; exit 1; }
mkdir -p "$out"
node --input-type=module -e 'import {comparisonProfile} from "./benchmarks/cross-proxy/profile.mjs"; console.log(JSON.stringify(comparisonProfile(process.argv[1]),null,2))' "$mode" > "$out/profile.json"
project=archestra-cross-proxy
lite_image=ghcr.io/berriai/litellm-database@sha256:496cc6cb0295414585790b86467566fb4c93d8e12d7f0e889f18fcfc54cbdd5e
pg_image=pgvector/pgvector:pg17@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f
for name in "$project-db" "$project-archestra" "$project-litellm" "$project-litellm-default"; do
  if docker container inspect "$name" >/dev/null 2>&1; then echo "Refusing existing container $name"; exit 1; fi
done
for port in 15432 19000 19050 19092 19400; do
  if ss -ltn "sport = :$port" | tail -n +2 | grep -q .; then echo "Port $port occupied"; exit 1; fi
done
mock_pid=''
stats_pid=''
cleanup() {
  curl -fsS http://127.0.0.1:19092/samples > "$out/upstream-all.json" 2>/dev/null || true
  [[ -z "$stats_pid" ]] || kill "$stats_pid" 2>/dev/null || true
  [[ -z "$mock_pid" ]] || kill "$mock_pid" 2>/dev/null || true
  for name in "$project-db" "$project-archestra" "$project-litellm" "$project-litellm-default"; do
    docker logs "$name" > "$out/$name.log" 2>&1 || true
    docker inspect "$name" > "$out/$name-inspect.json" 2>/dev/null || true
    docker rm -f "$name" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
node_bin=$(command -v node)
node_dir=$(dirname "$node_bin")
git rev-parse HEAD > "$out/archestra-commit.txt"
git rev-parse HEAD:platform > "$out/archestra-platform-tree.txt"
git status --porcelain > "$out/workspace-status.txt"
printf '%s\n' 'LiteLLM v1.106.4 source ea7ca16dbc3904d9e59a9505f379a2ca3091821f' "$lite_image" "$pg_image" > "$out/versions.txt"
lscpu > "$out/lscpu.txt"
free -b > "$out/memory.txt"
uname -a > "$out/kernel.txt"
node --version >> "$out/versions.txt"
docker pull "$lite_image"
docker pull "$pg_image"
docker build -f benchmarks/cross-proxy/archestra.Dockerfile -t "$project-runtime" benchmarks/cross-proxy
for image in "$lite_image" "$pg_image" "$project-runtime"; do docker image inspect "$image"; done > "$out/images.json"
docker run --rm --entrypoint python "$lite_image" -c 'from importlib.metadata import distributions,version; assert version("litellm")=="1.106.4"; print("\n".join(sorted(f"{d.metadata["Name"]}=={d.version}" for d in distributions())))' > "$out/litellm-pip-freeze.txt"
docker run -d --name "$project-db" --cpuset-cpus=6-7 --cpus=2 --memory="$db_memory" --shm-size=256m \
  -p 127.0.0.1:15432:5432 --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=benchmark -e POSTGRES_PASSWORD=benchmark -e POSTGRES_DB=benchmark "$pg_image"
for ((i=0;i<60;i++)); do docker exec "$project-db" pg_isready -U benchmark && break; sleep 1; done
docker exec "$project-db" createdb -U benchmark litellm
docker exec "$project-db" createdb -U benchmark litellm_default
taskset -c 0-1 node benchmarks/cross-proxy/stub.mjs > "$out/mock.log" 2>&1 &
mock_pid=$!
node benchmarks/backend.mjs prepare > "$out/build.log" 2>&1
start_archestra() {
  docker run -d --name "$project-archestra" --network host --cpuset-cpus=2-5 --cpus=4 --memory=8g \
    -v "$PWD:$PWD" -v "$node_dir:$node_dir:ro" -w "$PWD" -e "PATH=$node_dir:/usr/bin:/bin" \
    "$project-runtime" "$node_bin" benchmarks/backend.mjs serve
  active_proxy="$project-archestra"
  wait_ready http://127.0.0.1:19000/ready
}
start_litellm() {
  local variant=${1:-litellm}
  local database=${2:-litellm}
  docker run -d --name "$project-$variant" --network host --cpuset-cpus=2-5 --cpus=4 --memory=8g \
    -v "$PWD/benchmarks/cross-proxy/$variant.yaml:/bench/config.yaml:ro" \
    -e "DATABASE_URL=postgresql://benchmark:benchmark@127.0.0.1:15432/$database?connection_limit=20" \
    -e LITELLM_TELEMETRY=false "$lite_image" --config /bench/config.yaml --port 19400 --num_workers 1
  active_proxy="$project-$variant"
  wait_ready http://127.0.0.1:19400/health/liveliness
}
start_litellm-default() { start_litellm litellm-default litellm_default; }
wait_ready() {
  for ((i=0;i<180;i++)); do if curl -fsS "$1" >/dev/null 2>&1; then return; fi;
    if [[ $(docker inspect --format '{{.State.Running}}' "$active_proxy") != true ]]; then docker logs "$active_proxy" 2>&1 | tail -40; return 1; fi
    sleep 1;
  done
  echo "Readiness timed out: $1"; return 1
}
stop_proxy() {
  docker logs "$project-$1" > "$out/$1-$2.log" 2>&1
  docker inspect "$project-$1" > "$out/$1-$2-inspect.json"
  docker rm -f "$project-$1" >/dev/null
}
# Sample resource usage independently of load client; no unbounded loops survive cleanup.
(while true; do
  date -u +%FT%TZ
  mapfile -t running < <(docker ps --filter "name=$project-" --format '{{.Names}}')
  if ((${#running[@]})); then docker stats --no-stream --format '{{json .}}' "${running[@]}" 2>/dev/null || true; fi
  sleep 1
done) > "$out/resources.jsonl" &
stats_pid=$!
archestra_key=''
declare -A lite_keys=()
snapshot_cgroups() {
  for container in "$project-db" "$project-$target"; do
    file="$out/$target-$repeat-$1-${container##$project-}-cgroup.txt"
    printf 'TIMESTAMP %s\n' "$(date -u +%FT%TZ)" > "$file"
    docker exec "$container" sh -c 'for f in cpu.stat cpu.pressure memory.current memory.peak memory.events memory.pressure memory.swap.current; do echo "FILE $f"; cat "/sys/fs/cgroup/$f"; done' >> "$file"
  done
}
for ((repeat=1; repeat<=repeats; repeat++)); do
  if ((repeat % 2)); then order='archestra litellm-default'; else order='litellm-default archestra'; fi
  for target in $order; do
    printf '%s repeat=%s target=%s\n' "$(date -u +%FT%TZ)" "$repeat" "$target" >> "$out/order.txt"
    if [[ "$mode" == sensitivity ]]; then
      case "$target" in archestra) db=benchmark;; litellm) db=litellm;; litellm-default) db=litellm_default;; esac
      docker exec "$project-db" dropdb -U benchmark --force "$db"
      docker exec "$project-db" createdb -U benchmark "$db"
      if [[ "$target" == archestra ]]; then
        node benchmarks/backend.mjs migrate > "$out/migrate-$repeat.log" 2>&1
        archestra_key=''
      else
        unset 'lite_keys[$target]'
      fi
    fi
    "start_$target"
    if [[ "$target" == archestra ]]; then
      if [[ -z "$archestra_key" ]]; then archestra_key=$(node benchmarks/seed.mjs); fi
      key="$archestra_key"
    else
      if [[ -z "${lite_keys[$target]:-}" ]]; then
        lite_keys[$target]=$(curl -fsS http://127.0.0.1:19400/key/generate -H 'Authorization: Bearer sk-benchmark-master-key-local-only' -H 'Content-Type: application/json' -d '{"models":["gpt-4o-mini"],"key_alias":"benchmark"}' | node -e 'let s="";for await(const b of process.stdin)s+=b;const k=JSON.parse(s).key;if(!k)process.exit(1);process.stdout.write(k)')
      fi
      key="${lite_keys[$target]}"
    fi
    snapshot_cgroups before
    taskset -c 0-1 node benchmarks/cross-proxy/measure.mjs "$target" "$repeat" "$key" "$mode"
    snapshot_cgroups after
    # Poll async LiteLLM persistence to completion before stopping the process.
    expected=$((repeat * rows_per_run))
    if [[ "$mode" == sensitivity ]]; then expected=$rows_per_run; fi
    if [[ "$target" == archestra ]]; then
      query="SELECT count(*), count(*) FILTER (WHERE input_tokens=12 AND output_tokens=20), count(*) FILTER (WHERE response::text LIKE '%archestra-benchmark-ok%') FROM interactions"
      db=benchmark
    else
      query='SELECT count(*), count(*) FILTER (WHERE prompt_tokens=12 AND completion_tokens=20), count(*) FILTER (WHERE response::text LIKE '\''%archestra-benchmark-ok%'\'') FROM "LiteLLM_SpendLogs" WHERE status='\''success'\'''
      db=litellm
      if [[ "$target" == litellm-default ]]; then db=litellm_default; fi
    fi
    persisted=false
    for ((i=0;i<60;i++)); do
      counts=$(docker exec "$project-db" psql -U benchmark -d "$db" -Atc "$query")
      expected_content=$expected
      if [[ "$target" == litellm-default ]]; then expected_content=0; fi
      if [[ "$counts" == "$expected|$expected|$expected_content" ]]; then persisted=true; break; fi
      sleep 1
    done
    printf '%s\n' "$counts" > "$out/$target-$repeat-accounting.txt"
    [[ "$persisted" == true ]] || { echo "Accounting validation failed: $counts expected $expected"; exit 1; }
    if [[ "$target" != archestra ]]; then
      docker exec "$project-db" psql -U benchmark -d "$db" -Atc 'SELECT status,count(*),sum(prompt_tokens),sum(completion_tokens),count(*) FILTER (WHERE messages::text LIKE '\''%benchmark marker%'\'') FROM "LiteLLM_SpendLogs" GROUP BY status' > "$out/$target-$repeat-accounting-status.txt"
    fi
    stop_proxy "$target" "$repeat"
    if [[ "$mode" == sensitivity ]]; then docker exec "$project-db" dropdb -U benchmark --force "$db"; docker exec "$project-db" createdb -U benchmark "$db"; fi
    taskset -c 0-1 node benchmarks/cross-proxy/measure.mjs direct "$target-$repeat" unused "$mode"
  done
done
node benchmarks/cross-proxy/report.mjs "$mode"

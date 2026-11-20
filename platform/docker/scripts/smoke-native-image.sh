#!/bin/sh
set -eu

image=${1:?usage: sh smoke-native-image.sh IMAGE [DOCKER_RUN_OPTIONS...]}
shift
container=$(docker run -d \
    -e ARCHESTRA_SERVER_MANAGE_RUST_SERVICES=true \
    -e ARCHESTRA_TASK_QUEUE_RUST_ROLLUP_ENABLED=true \
    -e ARCHESTRA_LLM_PROXY_RUST_OPENAI_STREAM_ENABLED=true \
    -e ARCHESTRA_MCP_GATEWAY_RUST_DISCOVER_ENABLED=true \
    -e ARCHESTRA_DATABASE_RUST_SITE_NOTIFICATION_ENABLED=true \
    -e ARCHESTRA_ORCHESTRATOR_ENABLED=false "$@" "$image")
cleanup() {
    docker logs --tail 60 "$container" >&2
    docker rm -fv "$container" >/dev/null
}
trap cleanup EXIT

probe='require("node:http").request({socketPath:process.argv[1],path:"/internal/v1/ready",method:"POST"},r=>{r.resume();if(r.statusCode!==200)process.exitCode=1}).end()'
for attempt in $(seq 1 180); do
    if docker exec "$container" wget -q -O /dev/null http://127.0.0.1:9000/ready 2>/dev/null; then break; fi
    if [ "$attempt" = 180 ]; then exit 1; fi
    sleep 1
done
docker exec "$container" sh -ec '
    test -x /usr/local/bin/archestra-api
    test -x /usr/local/bin/archestra-worker
    if [ -n "${ARCHESTRA_DATABASE_URL:-}" ]; then
        echo "External PostgreSQL $(psql "$ARCHESTRA_DATABASE_URL" -XAtc "SHOW server_version")" | grep -E "^External PostgreSQL 18\\."
        encrypted=$(psql "$ARCHESTRA_DATABASE_URL" -XAtc "
            SELECT count(*) >= 2 AND bool_and(s.ssl)
            FROM pg_stat_activity a JOIN pg_stat_ssl s USING (pid)
            WHERE a.datname = current_database() AND a.client_addr IS NOT NULL
                AND a.pid <> pg_backend_pid()")
        test "$encrypted" = t
        test "$(psql "$ARCHESTRA_DATABASE_URL" -XAtc "SELECT count(*) > 0 FROM drizzle.__drizzle_migrations")" = t
        echo "All active TCP database sessions use TLS"
    else
        postgres --version | grep -E "PostgreSQL\\) 18\\."
    fi
    for runtime in /run/archestra-native.*; do
        test -f "$runtime/migrated"
        test -f "$runtime/worker.ready"
    done
'
api_socket=$(docker exec "$container" sh -ec '
    set -- /run/archestra-native.*/api.sock
    socket=${ARCHESTRA_DATABASE_RUST_AUDIT_LOG_SOCKET:-$1}
    test -S "$socket"
    printf "%s\n" "$socket"
')
echo "Both packaged Rust services ready after migrations"
api_pid=$(docker exec "$container" pidof archestra-api)
worker_pid=$(docker exec "$container" pidof archestra-worker)
docker exec "$container" kill -STOP "$api_pid"
docker exec "$container" node -e 'fetch("http://127.0.0.1:9000/ready").then(r => { if (r.status !== 503) process.exitCode = 1 })'
docker exec "$container" kill -CONT "$api_pid"
docker exec "$container" node -e "$probe" "$api_socket"
docker exec "$container" wget -q -O /dev/null http://127.0.0.1:9000/ready
echo "Public readiness returned 503 while the Rust API was paused and recovered after resume"
backend_pid=$(docker exec "$container" sh -ec 'for pid in $(pidof node); do
    if [ "$(readlink "/proc/$pid/cwd")" = /app/backend ]; then
        echo "$pid"
        exit 0
    fi
done
exit 1')
docker exec "$container" kill -STOP "$backend_pid"
docker kill --signal=TERM "$container" >/dev/null
# Supervisor stops frontend and worker first, then waits for the paused Node
# process. The private API must still accept work while that drain is pending.
for attempt in $(seq 1 20); do
    if docker exec "$container" sh -ec '
        test ! -d "/proc/$1"
        for d in /run/archestra-native.*; do test ! -e "$d/worker.ready"; done
    ' sh "$worker_pid"; then break; fi
    if [ "$attempt" = 20 ]; then exit 1; fi
    sleep 1
done
docker exec "$container" node -e "$probe" "$api_socket"
echo "Rust worker stopped; Rust API still ready with Fastify shutdown pending"
docker exec "$container" kill -CONT "$backend_pid"
test "$(timeout 120 docker wait "$container")" = 0
echo "Container exited 0 after ordered shutdown"

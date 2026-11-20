#!/bin/sh
set -eu

# Run from platform/ against a migrated, disposable PostgreSQL instance.
# The first three URLs must differ only in CA or hostname for the negative cases.
# The fourth must point to a reachable server with TLS disabled.
trusted=${1:?usage: sh docker/scripts/smoke-native-db-tls.sh TRUSTED_URL WRONG_CA_URL WRONG_HOST_URL NO_TLS_URL}
wrong_ca=${2:?missing wrong CA URL}
wrong_host=${3:?missing wrong hostname URL}
no_tls=${4:?missing no TLS URL}
bin=${RIIR_BIN_DIR:-archestra-rs/target/debug}
runtime=$(mktemp -d /tmp/riir-db-tls.XXXXXX)
api_pid=
worker_pid=
cleanup() {
    for pid in $api_pid $worker_pid; do
        kill -TERM "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    done
    for name in api worker rejected; do
        if [ -f "$runtime/$name.log" ]; then cat "$runtime/$name.log" >&2; fi
    done
    rm -f "$runtime/api.sock" "$runtime/worker.ready" "$runtime/api.log" "$runtime/worker.log" "$runtime/rejected.log"
    rmdir "$runtime"
}
trap cleanup EXIT
export ARCHESTRA_NATIVE_RUNTIME_DIR="$runtime"
export ARCHESTRA_TASK_QUEUE_RUST_ROLLUP_ENABLED=true
export ARCHESTRA_DATABASE_IAM_AUTH_ENABLED=false ARCHESTRA_DATABASE_ENTRA_AUTH_ENABLED=false
unset PGSSLMODE PGSSLROOTCERT

ARCHESTRA_DATABASE_URL="$trusted" "$bin/archestra-api" "$runtime/api.sock" >"$runtime/api.log" 2>&1 &
api_pid=$!
ARCHESTRA_DATABASE_URL="$trusted" "$bin/archestra-worker" >"$runtime/worker.log" 2>&1 &
worker_pid=$!
for attempt in $(seq 1 20); do
    kill -0 "$api_pid" "$worker_pid"
    if [ -f "$runtime/worker.ready" ] && curl -fsS --max-time 2 --unix-socket "$runtime/api.sock" \
        -X POST http://localhost/internal/v1/ready 2>/dev/null; then break; fi
    test "$attempt" -lt 20
    sleep 1
done
echo "Trusted CA and matching hostname: API and worker ready"
kill -TERM "$api_pid" "$worker_pid"
wait "$api_pid"
wait "$worker_pid"
api_pid=
worker_pid=
test ! -e "$runtime/api.sock"
test ! -e "$runtime/worker.ready"

reject() {
    label=$1 url=$2
    shift 2
    status=0
    ARCHESTRA_DATABASE_URL="$url" timeout 15 "$@" >"$runtime/rejected.log" 2>&1 || status=$?
    if [ "$status" -ne 1 ] || [ -e "$runtime/api.sock" ] || [ -e "$runtime/worker.ready" ]; then
        echo "$label: ${1##*/} did not fail closed (exit $status)" >&2
        exit 1
    fi
    echo "$label: ${1##*/} rejected connection"
}
for binary in api worker; do
    set -- "$bin/archestra-$binary"
    if [ "$binary" = api ]; then set -- "$@" "$runtime/api.sock"; fi
    reject "Wrong CA" "$wrong_ca" "$@"
    reject "Wrong hostname" "$wrong_host" "$@"
    reject "TLS unavailable" "$no_tls" "$@"
done
rm -f "$runtime/rejected.log"

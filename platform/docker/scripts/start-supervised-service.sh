#!/bin/sh
set -eu

case "$1" in
    backend)
        if [ -z "${ARCHESTRA_MAINTENANCE_MODE_MESSAGE:-}" ] &&
           [ "${ARCHESTRA_DATABASE_RUN_MIGRATIONS_ON_STARTUP:-}" != false ]; then
            sleep 5
            node ./scripts/migrate-with-lock.mjs
        fi
        if [ -n "${ARCHESTRA_NATIVE_RUNTIME_DIR:-}" ]; then
            touch "$ARCHESTRA_NATIVE_RUNTIME_DIR/migrated"
        fi
        exec ./scripts/start-production.sh
        ;;
    archestra-api|archestra-worker)
        until [ -f "$ARCHESTRA_NATIVE_RUNTIME_DIR/migrated" ]; do sleep 1; done
        if [ "$1" = archestra-api ]; then
            rm -f "$ARCHESTRA_NATIVE_RUNTIME_DIR/api.sock"
            exec archestra-api "$ARCHESTRA_DATABASE_RUST_AUDIT_LOG_SOCKET"
        fi
        rm -f "$ARCHESTRA_NATIVE_RUNTIME_DIR/worker.ready"
        exec archestra-worker
        ;;
    *) exit 2 ;;
esac

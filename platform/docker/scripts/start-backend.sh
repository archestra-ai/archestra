#!/bin/sh
# supervisord's backend program (docker/supervisord/supervisord.conf).
#
# Runs as soon as supervisord starts, alongside the bundled PostgreSQL and the
# frontend, instead of after fixed sleeps:
# - waits for the bundled PostgreSQL to accept connections (an external
#   database is not waited for: the migrations report its errors)
# - runs the migrations, unless maintenance mode or
#   ARCHESTRA_DATABASE_RUN_MIGRATIONS_ON_STARTUP=false turns them off
# In quickstart mode it does not wait for the embedded KinD cluster: the
# backend attaches to it when docker-entrypoint.sh publishes its kubeconfig.
set -eu

cd /app/backend

# Maintenance mode must be able to boot when the external database is down for
# planned work, so it skips the database wait and the migrations.
if [ -z "${ARCHESTRA_MAINTENANCE_MODE_MESSAGE:-}" ]; then
    # The entrypoint adds the postgres program only for the bundled database.
    if grep -q '^\[program:postgres\]' /etc/supervisord.conf; then
        waited=0
        until pg_isready -q -h 127.0.0.1 -p 5432; do
            if [ "$waited" -ge 600 ]; then
                echo "PostgreSQL is still not accepting connections after 60s; starting anyway" >&2
                break
            fi
            waited=$((waited + 1))
            sleep 0.1
        done
    fi

    if [ "${ARCHESTRA_DATABASE_RUN_MIGRATIONS_ON_STARTUP:-true}" != "false" ]; then
        node ./scripts/migrate-with-lock.mjs
    fi
fi

exec ./scripts/start-production.sh

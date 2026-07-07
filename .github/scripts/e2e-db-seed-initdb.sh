#!/bin/sh
# Bitnami PostgreSQL initdb hook that restores the pre-seeded Archestra schema
# for e2e runs, so the platform pod's boot-time `drizzle-kit migrate` finds all
# migrations already applied (a ~1-2s no-op) instead of replaying every
# migration file against a fresh database (~40-50s of the Helm deploy wait).
#
# Shipped to the postgres pod via `primary.initdb.scriptsSecret` (created by
# .github/actions/setup-archestra-platform from this file plus a dump extracted
# from the platform image built in the same CI run — see the "Seed the e2e
# database" step there). Bitnami's postgresql_custom_init_scripts sources *.sh
# files from /docker-entrypoint-initdb.d during FIRST boot only, before the pod
# reports Ready, so the restore cannot race the platform's migrate.
#
# Failure policy: never break the environment. The restore runs inside a single
# transaction with ON_ERROR_STOP, so any error rolls the database back to
# completely empty and the platform's normal full `drizzle-kit migrate` takes
# over at boot. The dump is deliberately NOT named *.sql.gz — bitnami would
# execute that itself (without --single-transaction), which could leave a
# half-restored database behind.
#
# User choreography (verified against bitnami/postgresql:latest):
# - The untrusted `vector` extension is created as the postgres superuser first
#   (POSTGRESQL_POSTGRES_PASSWORD exists because auth.enablePostgresUser
#   defaults to true). This mirrors the chart's setup-postgres-extensions init
#   container, which otherwise only runs after first boot completes.
# - The dump itself is restored as the APPLICATION user, exactly like the
#   boot-time migrate it replaces, so every object is owned by the app user.
#   Restoring as postgres instead would leave postgres-owned objects the
#   non-superuser app user cannot access (values-ci.yaml's grant-superuser.sql
#   does not help: bitnami runs *.sql initdb scripts as the app user, so that
#   ALTER USER has never actually applied).

ARCHESTRA_SEED_ARCHIVE="/docker-entrypoint-initdb.d/secret/archestra-e2e-seed.dump.gz"

archestra_seed_psql() {
    _user="$1"
    _password="$2"
    PGPASSWORD="$_password" psql \
        -U "$_user" -h 127.0.0.1 -p "${POSTGRESQL_PORT_NUMBER:-5432}" \
        -d "${POSTGRESQL_DATABASE:?POSTGRESQL_DATABASE must be set}" \
        -v ON_ERROR_STOP=1 --single-transaction --quiet
}

if [ ! -f "$ARCHESTRA_SEED_ARCHIVE" ]; then
    echo "archestra e2e seed: no seed archive at ${ARCHESTRA_SEED_ARCHIVE}; the app will run full migrations at boot"
elif [ -z "${POSTGRESQL_POSTGRES_PASSWORD:-}" ] || [ -z "${POSTGRESQL_PASSWORD:-}" ]; then
    echo "archestra e2e seed: WARNING: postgres/app credentials not in env; skipping seed restore (full migrate at boot)"
elif ! echo "CREATE EXTENSION IF NOT EXISTS vector;" |
    archestra_seed_psql postgres "$POSTGRESQL_POSTGRES_PASSWORD"; then
    echo "archestra e2e seed: WARNING: could not pre-create the vector extension; skipping seed restore (full migrate at boot)"
elif gunzip -c "$ARCHESTRA_SEED_ARCHIVE" |
    archestra_seed_psql "${POSTGRESQL_USERNAME:-archestra}" "$POSTGRESQL_PASSWORD"; then
    echo "archestra e2e seed: schema restored; drizzle-kit migrate at app boot will be a no-op"
else
    echo "archestra e2e seed: WARNING: seed restore failed and was rolled back; the app will run full migrations at boot"
fi

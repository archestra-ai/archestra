#!/bin/sh
# Build-time generator for the pre-seeded database snapshot baked into the
# platform image (Dockerfile `db-seed` stage).
#
# Boots a throwaway PostgreSQL, replays every Drizzle migration from THIS build
# context's migrations directory, and pg_dumps the result. At runtime the
# quickstart entrypoint (and, for e2e, the Helm postgres initdb hook — see
# .github/scripts/e2e-db-seed-initdb.sh) restores the dump into a fresh
# database so the boot-time `drizzle-kit migrate` is a ~1-2s no-op instead of a
# full replay. Because the dump is produced from the same migrations directory
# that ships in the image, it cannot drift from the code; `drizzle-kit migrate`
# still runs at every boot as the safety net and would apply anything missing.
#
# Dump flags:
# - --no-owner --no-privileges: the restore runs as the app user (matching what
#   boot-time migrate would have produced); baked-in ownership would break that.
# - --no-comments: COMMENT ON EXTENSION requires owning the extension, which
#   the non-superuser app user doing the restore does not.
#
# Outputs into $1:
# - seed.sql.gz         gzipped plain-format dump of the fully migrated schema
# - migrations.sha256   content hash of the migrations dir the dump was built
#                       from, so consumers can verify the seed matches their
#                       checkout before using it
set -eu

OUT_DIR="${1:?usage: generate-db-seed.sh <output-dir>}"
SEED_PGDATA=/var/lib/postgresql/seed-data
SEED_DB=archestra_seed
SEED_USER=archestra

mkdir -p "$SEED_PGDATA" /run/postgresql "$OUT_DIR"
chown -R postgres:postgres "$SEED_PGDATA" /run/postgresql

su-exec postgres initdb -D "$SEED_PGDATA"
# drizzle-kit connects over TCP; default initdb pg_hba trusts 127.0.0.1.
su-exec postgres pg_ctl -D "$SEED_PGDATA" -o "-c listen_addresses='127.0.0.1'" -w start

# Mirror the runtime bootstrap: non-superuser app user owning the database,
# with the untrusted vector extension pre-created by the superuser.
psql -v ON_ERROR_STOP=1 --username postgres <<EOSQL
CREATE USER ${SEED_USER} WITH PASSWORD 'seed';
CREATE DATABASE ${SEED_DB} OWNER ${SEED_USER};
EOSQL
psql -v ON_ERROR_STOP=1 --username postgres --dbname "$SEED_DB" \
    -c "CREATE EXTENSION IF NOT EXISTS vector;"

cd /app/backend
DATABASE_URL="postgresql://${SEED_USER}:seed@127.0.0.1:5432/${SEED_DB}" \
    ./node_modules/.bin/drizzle-kit migrate

pg_dump --username "$SEED_USER" --dbname "$SEED_DB" \
    --no-owner --no-privileges --no-comments |
    gzip -9 >"$OUT_DIR/seed.sql.gz"

su-exec postgres pg_ctl -D "$SEED_PGDATA" -m fast -w stop
rm -rf "$SEED_PGDATA"

# Hash only what determines the seed: the migration SQL plus the journal that
# orders it. Deliberately NOT the whole directory — meta/ snapshots only feed
# `drizzle-kit generate`, and the co-located *.test.ts files are excluded from
# the Docker build context by .dockerignore, so hashing them would make the
# baked hash never match a CI checkout. NUL-delimited because some migration
# filenames contain spaces (e.g. "0070_vault secrets manager.sql").
# Keep in sync with the consumer in .github/actions/setup-archestra-platform.
(
    cd /app/backend/src/database/migrations &&
        find . -type f \( -name '*.sql' -o -path './meta/_journal.json' \) -print0 |
        LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}'
) >"$OUT_DIR/migrations.sha256"

ls -la "$OUT_DIR"
echo "db seed generated: $(gunzip -c "$OUT_DIR/seed.sql.gz" | wc -c) bytes raw, migrations hash $(cat "$OUT_DIR/migrations.sha256")"

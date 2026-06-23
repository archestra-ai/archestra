#!/bin/sh
# Drives one benchmark run inside the prod platform image: provisions the bench env file, runs
# the benchmark against the Postgres sidecar + staging Dagger engine, then packages the run dir into a
# single checksummed tarball and keep-alives so CI can `kubectl cp` it from the still-live container.
# Hard-kill paths (OOM/eviction/deadline SIGKILL) never reach the marker; CI detects those itself.
set -eu
umask 077

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set (shared with the postgres sidecar)}"
BENCH_ENVS="${BENCH_ENVS:-basic}"
BENCH_LANES="${BENCH_LANES:-glm}"
KEEPALIVE_SECONDS="${KEEPALIVE_SECONDS:-900}"

# The bench resolves its Postgres from ARCHESTRA_BENCH_DATABASE_URL and creates a fresh per-run
# database on it; the backend's own ARCHESTRA_DATABASE_URL is then derived from that. `Instance::start`
# also requires the platform .env file to exist, so writing it here satisfies both. The password must
# be URL- and shell-safe (alphanumeric) — `parse_env_file` expands `$`-references.
cat > /app/.env <<EOF
ARCHESTRA_BENCH_DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@localhost:5432/postgres
EOF

# The prod image runs NODE_ENV=production, where better-auth refuses to boot on its built-in default
# secret. The bench DB is fresh and dropped each run, so the value is throwaway — a random per-run
# secret satisfies the guard without persisting or committing one. build_backend_env seeds the backend
# from the process env, so exporting it here is enough.
export ARCHESTRA_AUTH_SECRET="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"

mkdir -p /work/run

set +e
archestra-bench benchmark \
  --platform-dir /app \
  --bench-dir /bench \
  --env "${BENCH_ENVS}" \
  --lanes "${BENCH_LANES}" \
  --max-workers 1 \
  --run-dir /work/run \
  --out /work/run/report.md
bench_status=$?
set -e
# The bench exits non-zero whenever any rollout failed, which is normal for a model benchmark — so the
# exit code is logged for diagnostics but is NOT the CI health signal. CI gates on the pass count in
# aggregate.json instead (zero passes ⇒ broken harness).
echo "benchmark exited with status ${bench_status}"

# Package the run dir into one checksummed blob: `kubectl cp` silently truncates large/odd trees, so CI
# moves a single verifiable artifact instead. Runs even on bench failure so CI salvages partial results.
tar czf /work/run.tgz -C /work run
sha256sum /work/run.tgz > /work/run.tgz.sha256
touch /work/DONE

echo "run packaged; keep-alive ${KEEPALIVE_SECONDS}s so CI can kubectl cp the tarball"
sleep "${KEEPALIVE_SECONDS}"

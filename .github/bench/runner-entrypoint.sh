#!/bin/sh
# Drives one benchmark run inside the prod platform image and owns reporting end to end: provisions the
# bench env file, runs the benchmark against the Postgres sidecar + staging Dagger engine, then exports
# TensorBoard scalars, uploads artifacts to GCS, and posts the Slack summary. The final publish step's
# exit code encodes harness health (zero passes ⇒ broken), so the pod's terminal phase is the signal CI
# reads — CI applies the Job and leaves, it does not wait or copy anything out.
set -eu
umask 077

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set (shared with the postgres sidecar)}"
BENCH_ENVS="${BENCH_ENVS:-basic}"
BENCH_LANES="${BENCH_LANES:-glm}"

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

# The bench exits non-zero whenever any rollout fails, which is normal for a model benchmark — so its
# exit code is not the health signal. Health is read from aggregate.json by the publish step. tee keeps
# progress visible in `kubectl logs` and captures it for upload.
set +e
archestra-bench benchmark \
  --platform-dir /app \
  --bench-dir /bench \
  --env "${BENCH_ENVS}" \
  --lanes "${BENCH_LANES}" \
  --run-dir /work/run \
  --out /work/run/report.md 2>&1 | tee /work/run/bench.log
set -e

# Package the run dir (report, aggregate, per-rollout JSON, backend + bench logs) so the GCS upload
# carries one verifiable archive alongside the unpacked aggregate/report.
tar czf /work/run.tgz -C /work run

# Reporting deps are baked into the image venv, so these run with plain python3 (no runtime fetch).
# Best-effort export: a missing aggregate (hard bench crash) must still reach the publish step so it
# reports a failure rather than the pod dying silently here; the export outcome is passed on so publish
# can flag a lost TensorBoard history.
if python3 /bench/scripts/export_tensorboard.py --run-dir /work/run --out /work/tb; then
  export BENCH_TB_EXPORT_OK=1
else
  export BENCH_TB_EXPORT_OK=0
fi

# Final step: uploads to GCS, posts Slack, and exits non-zero on a broken harness so the pod's terminal
# phase reflects run health.
exec python3 /bench/scripts/publish_run.py --tb /work/tb --run-dir /work/run --tarball /work/run.tgz

#!/bin/sh
# Drives one benchmark run inside the prod platform image and owns reporting end to end: provisions the
# bench env file, runs the benchmark against its Postgres sidecar + dedicated Dagger engine, then exports
# TensorBoard scalars, uploads artifacts to GCS, and posts the Slack summary. The final publish step's
# exit code encodes harness health (zero passes ⇒ broken), so the pod's terminal phase is the signal CI
# reads — CI applies the Job and leaves, it does not wait or copy anything out.
set -eu
umask 077

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set (shared with the postgres sidecar)}"
BENCH_ENVS="${BENCH_ENVS:-basic}"
BENCH_LANES="${BENCH_LANES:-glm}"
service_account_dir=/var/run/secrets/kubernetes.io/serviceaccount
run_dir=/work/run
bench_phase=bootstrap
publish_finished=0
failure_notified=0
bench_pid=
log_tail_pid=

# The normal publisher uploads the full run and posts its own summary. A hard failure before that
# point used to leave no signal at all: the Job's one-hour TTL deletes the only copy of stderr. Keep
# this deliberately dependency-free so it can report an RBAC/bootstrap/archive failure too.
notify_early_failure() {
  [ "${publish_finished}" -eq 0 ] || return 0
  [ "${failure_notified}" -eq 0 ] || return 0
  failure_notified=1

  webhook="${SLACK_BENCH_WEBHOOK_URL:-}"
  [ -n "${webhook}" ] || return 0

  export BENCH_FAILURE_PHASE="${bench_phase}"
  export BENCH_FAILURE_RUN="${GITHUB_RUN_NUMBER:-unknown}-${GITHUB_RUN_ATTEMPT:-unknown}"
  export BENCH_FAILURE_URL="${RUN_URL:-}"
  if ! python3 - <<'PY'
import json
import os
import urllib.request

text = (
    f"❌ benchmark runner stopped before publishing "
    f"(run {os.environ['BENCH_FAILURE_RUN']}, phase {os.environ['BENCH_FAILURE_PHASE']})"
)
if url := os.environ.get("BENCH_FAILURE_URL"):
    text += f"\n<{url}|run>"
request = urllib.request.Request(
    os.environ["SLACK_BENCH_WEBHOOK_URL"],
    data=json.dumps({"text": text}).encode(),
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(request, timeout=15) as response:
    print(f"posted early benchmark failure summary ({response.status})", flush=True)
PY
  then
    printf 'warning: could not post early benchmark failure summary\n' >&2
  fi
}

cleanup_dagger() {
  status=$?
  trap - EXIT
  notify_early_failure
  if [ -n "${DAGGER_ENGINE_POD:-}" ]; then
    # Never let cleanup decide the exit code: under `set -e` a failed read here would replace the
    # publish status, and that status is the run-health signal CI reads off the pod's terminal phase.
    namespace=$(cat "${service_account_dir}/namespace" 2>/dev/null) || namespace=archestra
    if ! curl -fsS --max-time 10 --request DELETE \
      --cacert "${service_account_dir}/ca.crt" \
      --header "Authorization: Bearer $(cat "${service_account_dir}/token")" \
      "https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT_HTTPS:-443}/api/v1/namespaces/${namespace}/pods/${DAGGER_ENGINE_POD}" \
      >/dev/null; then
      printf 'warning: could not delete Dagger pod %s\n' "${DAGGER_ENGINE_POD}" >&2
    fi
  fi
  exit "${status}"
}
trap cleanup_dagger EXIT
trap 'bench_phase=terminated; [ -z "${bench_pid}" ] || kill "${bench_pid}" 2>/dev/null || true; [ -z "${log_tail_pid}" ] || kill "${log_tail_pid}" 2>/dev/null || true; exit 143' HUP INT TERM

# Check with the pod's actual identity; the CI deploy identity deliberately cannot impersonate it.
namespace=$(cat "${service_account_dir}/namespace")
KUBECONFIG=/tmp/bench-kubeconfig
export KUBECONFIG
cat > "${KUBECONFIG}" <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: in-cluster
    cluster:
      server: https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT_HTTPS:-443}
      certificate-authority: ${service_account_dir}/ca.crt
users:
  - name: in-cluster
    user:
      tokenFile: ${service_account_dir}/token
contexts:
  - name: in-cluster
    context:
      cluster: in-cluster
      user: in-cluster
      namespace: ${namespace}
current-context: in-cluster
EOF
require_rbac() {
  description=$1
  shift
  if verdict=$(kubectl auth can-i "$@" --namespace "${namespace}" --request-timeout=10s 2>&1) && \
    [ "${verdict}" = yes ]; then
    return 0
  fi
  if [ "${verdict}" = no ]; then
    printf 'error: benchmark service account cannot %s in %s\n' "${description}" "${namespace}" >&2
  else
    printf 'error: could not check permission to %s: %s\n' "${description}" "${verdict}" >&2
  fi
  return 1
}
rbac_failures=0
require_rbac 'exec into pods' create pods --subresource=exec || rbac_failures=$((rbac_failures + 1))
require_rbac 'delete pods' delete pods || rbac_failures=$((rbac_failures + 1))
[ "${rbac_failures}" -eq 0 ] || exit 1

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

mkdir -p "${run_dir}"

# The bench exits non-zero whenever any rollout fails, which is normal for a model benchmark — so its
# exit code is not the health signal. Health is read from aggregate.json by the publish step. A
# background tail keeps progress visible in `kubectl logs` while the file is captured for upload.
set +e
bench_phase=benchmark
archestra-bench benchmark \
  --platform-dir /app \
  --bench-dir /bench \
  --env "${BENCH_ENVS}" \
  --lanes "${BENCH_LANES}" \
  --run-dir "${run_dir}" \
  --out "${run_dir}/report.md" > "${run_dir}/bench.log" 2>&1 &
bench_pid=$!
# Keep rollout progress in the container logs without putting the benchmark pipeline in the shell's
# foreground. That lets SIGTERM interrupt `wait`, run the failure notifier, and use the grace period.
tail -n +1 -f "${run_dir}/bench.log" &
log_tail_pid=$!
wait "${bench_pid}"
kill "${log_tail_pid}" 2>/dev/null || true
wait "${log_tail_pid}" 2>/dev/null || true
bench_pid=
log_tail_pid=
set -e

# Package the run dir (report, aggregate, per-rollout JSON, backend + bench logs) so the GCS upload
# carries one verifiable archive alongside the unpacked aggregate/report.
bench_phase=archive
tar czf /work/run.tgz -C /work run

# Reporting deps are baked into the image venv, so these run with plain python3 (no runtime fetch).
# Best-effort export: a missing aggregate (hard bench crash) must still reach the publish step so it
# reports a failure rather than the pod dying silently here; the export outcome is passed on so publish
# can flag a lost TensorBoard history.
bench_phase=tensorboard_export
if python3 /bench/scripts/export_tensorboard.py --run-dir "${run_dir}" --out /work/tb; then
  export BENCH_TB_EXPORT_OK=1
else
  export BENCH_TB_EXPORT_OK=0
fi

# Final step: uploads to GCS, posts Slack, and exits non-zero on a broken harness so the pod's terminal
# phase reflects run health. Capture the code explicitly: `set -e` would otherwise invoke the early
# failure notifier after a normal (but unhealthy) publisher result, duplicating its Slack message.
# Not `exec`ed, so the EXIT trap runs after publishing and removes the
# separate Dagger pod. The benchmark runs in the background specifically so SIGTERM interrupts the
# shell's `wait`, posts the early failure notice, and then tears down the Dagger engine before the
# termination grace period expires.
bench_phase=publish
set +e
python3 /bench/scripts/publish_run.py --tb /work/tb --run-dir "${run_dir}" --tarball /work/run.tgz
publish_status=$?
set -e
publish_finished=1
exit "${publish_status}"

# Benchmark CI

`.github/workflows/benchmark.yml` runs `archestra-bench` daily against the currently-deployed
staging platform image, an ephemeral Postgres sidecar, and the shared staging managed Dagger engine.
It never mutates the live staging Deployment, its DB, or its data. Trigger manually from the Actions
tab (`workflow_dispatch`) or wait for the daily cron.

The k8s Job owns the run end to end: the pod runs the benchmark, exports TensorBoard scalars, uploads
artifacts to GCS, and posts the Slack summary. CI only builds the image, applies the Job, and watches a
short fail-fast window (a boot/infra failure terminates the pod fast and reds CI with its logs; a pod
still running past the window is left to finish and self-report). Run health (zero passes ⇒ broken
harness) is the pod's exit code, so its terminal phase is the signal.

Files:

- `Dockerfile` — bench runner image: the `archestra-bench` binary + `/bench` fixtures + reporting
  scripts + `uv` on top of the resolved `PLATFORM_IMAGE`.
- `runner-entrypoint.sh` (`run-benchmark`) — writes `/app/.env`, runs the bench, then exports
  TensorBoard, uploads to GCS, and posts Slack. The reporting scripts live in `ai-labs/scripts/` and
  are copied into the image as `/bench/scripts/`.
- `job.yaml` — the k8s Job (bench container + `pgvector` sidecar). `${...}` filled by `envsubst` in CI.

## One-time prerequisites (not automated)

### 1. GCS history bucket + IAM

```sh
gcloud storage buckets create gs://archestra-bench-history \
  --project friendly-path-465518-r6 --location us-central1 --uniform-bucket-level-access

# Expire raw run dirs after 30 days (they are disposable; TensorBoard event files under tb/ are tiny —
# keep them).
printf '{"rule":[{"action":{"type":"Delete"},"condition":{"age":30,"matchesPrefix":["runs/"]}}]}' \
  > /tmp/lifecycle.json
gcloud storage buckets update gs://archestra-bench-history --lifecycle-file=/tmp/lifecycle.json

# The pod uploads results as the platform Deployment's service account (Workload Identity), so grant
# THAT GCP SA object write. Resolve it from the k8s SA annotation (point kubectl at staging first):
gcloud container clusters get-credentials archestra-staging \
  --zone us-central1-a --project friendly-path-465518-r6
PLATFORM_GSA=$(kubectl get sa archestra-platform -n archestra \
  -o jsonpath='{.metadata.annotations.iam\.gke\.io/gcp-service-account}')
gcloud storage buckets add-iam-policy-binding gs://archestra-bench-history \
  --member="serviceAccount:${PLATFORM_GSA}" --role="roles/storage.objectAdmin"

# So the Slack `report` / `details` links (storage.cloud.google.com authenticated URLs) open for any
# signed-in org member — read-only, org domain only, not allUsers/public.
gcloud storage buckets add-iam-policy-binding gs://archestra-bench-history \
  --member="domain:archestra.ai" --role="roles/storage.objectViewer"
```

### 2. GitHub secrets

All three are synced into the `archestra-bench-secrets` k8s secret each run, where the pod reads them:

- `ZAI_API_KEY` — the glm lane key (`api_key_env = ZAI_API_KEY` in `ai-labs/lanes.toml`).
- `OPENROUTER_API_KEY` — the key for every `provider = "openrouter"` lane in
  `ai-labs/lanes.toml` (their default `api_key_env`).
- `SLACK_BENCH_WEBHOOK_URL` — Slack incoming webhook for the summary message. If unset, the pod skips
  the Slack post.

These cover every lane in `job.yaml`'s `BENCH_LANES` set. The `kimi` lane is not in that set and its
`KIMI_API_KEY` is not synced — add both if you ever put it on the CI roster.

The WIF auth and GKE creds reuse the existing
`DEVELOPMENT_OAUTH_PROXY_RELEASER_GCP_SERVICE_ACCOUNT_NAME` /
`DEVELOPMENT_OAUTH_PROXY_RELEASER_GCP_WORKLOAD_IDENTITY_PROVIDER_IDENTIFIER` secrets.

## GCS layout

```
gs://archestra-bench-history/
  tb/daily/overall/        TensorBoard scalar event files (run-wide tags)
  tb/daily/lane=<lane>/    per-(env, task) tags; lanes are sibling series sharing task tags
  runs/<run>/aggregate.json        per-run aggregate
  runs/<run>/report.md             per-run markdown report
  runs/<run>/run.tgz               full run dir (per-rollout JSON, backend + bench logs)
```

`<run>` is `${GITHUB_RUN_NUMBER}-${GITHUB_RUN_ATTEMPT}`; the TensorBoard step is
`GITHUB_RUN_NUMBER * 100 + GITHUB_RUN_ATTEMPT`, so scalar history is monotonic across re-runs.

## Viewing TensorBoard (optional long-lived serving)

Point TensorBoard straight at the bucket — it reads `gs://` natively:

```sh
tensorboard --logdir gs://archestra-bench-history/tb/daily
```

Run it locally, or as a long-lived pod with `kubectl port-forward` for shared access (not provisioned
here).

# Benchmark CI

`.github/workflows/benchmark.yml` runs `archestra-bench` daily against the currently-deployed
staging platform image, an ephemeral Postgres sidecar, and the shared staging managed Dagger engine.
It never mutates the live staging Deployment, its DB, or its data. Trigger manually from the Actions
tab (`workflow_dispatch`) or wait for the daily cron.

Files:

- `Dockerfile` — bench runner image: the `archestra-bench` binary + `/bench` fixtures + `uv` on top of
  the resolved `PLATFORM_IMAGE`.
- `runner-entrypoint.sh` (`run-benchmark`) — writes `/app/.env`, runs the bench, packages the
  run dir into `run.tgz` + sha, then keep-alives for `kubectl cp`.
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

# Grant the CI releaser SA object write (same SA the workflow authenticates as).
gcloud storage buckets add-iam-policy-binding gs://archestra-bench-history \
  --member="serviceAccount:<RELEASER_SA_EMAIL>" --role="roles/storage.objectAdmin"
```

### 2. GitHub secrets

- `ZAI_API_KEY` — the glm lane key (`api_key_env = ZAI_API_KEY` in `archestra-bench/lanes.toml`). The
  workflow syncs it into the `archestra-bench-secrets` k8s secret each run.
- `SLACK_BENCH_WEBHOOK_URL` — Slack incoming webhook for the summary message. If unset, the Slack step
  is skipped.

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

---
name: archestra-dev-investigate
description: Use when investigating Archestra bugs or incidents, especially staging issues, backend 50x errors, Sentry traces/logs, Drizzle failed queries, DB connection exhaustion, deploy regressions, Kubernetes/runtime symptoms, or unclear root causes.
---

# Archestra Investigation

Use this skill for incident and bug investigation. It is for evidence gathering, root-cause analysis, and clear reporting, not for changing production data.

Run repo commands from `platform/` unless specifically instructed otherwise.

If the `sentry-cli` skill is available, load it before running Sentry commands.

## Safety

- Do not run destructive Sentry commands.
- Do not run data-modifying SQL. Read-only `SELECT` queries are allowed.
- Do not copy Sentry event payloads, real user emails, IPs, customer names, tokens, cookies, or raw IDs into code, tests, docs, commits, or PR text.
- In user-facing summaries, report neutral technical facts: endpoint shape, timestamp range, issue class, trace count, pod/deploy shape, and likely cause.
- Treat Sentry issue titles as symptoms. Always inspect the nested exception cause before deciding root cause.

## Investigation Mindset

- Start from the user-provided symptom, then widen only as evidence requires.
- Separate symptom, trigger, and root cause.
- Prefer correlated evidence over single-event guesses: issue event, nested exception, trace logs, nearby errors, deploy/config state, and relevant source code.
- Verify whether a failure is isolated, bursty, release-correlated, or systemic.
- If a root cause points to runtime configuration, inspect repo defaults and environment-specific values before proposing code changes.

## First Pass

1. Identify the scope: user-provided URL, UUID, issue text, event time, staging environment, and likely project.
2. Prefer explicit org/project because auto-detection often fails from this repo.
3. Start narrow with the exact user-provided UUID/error string, then broaden to traces, related issues, and adjacent time windows.

Useful commands:

```bash
sentry project list <org>/ --json
sentry issue list <org>/<project> --query "<exact text or uuid>" --limit 20 --json --fields shortId,title,level,status,count,userCount,firstSeen,lastSeen,permalink
sentry log list <org>/<project> --period 7d --limit 100 --query "<exact text or uuid>" --json --fields sentry.item_id,timestamp,message,severity,trace
sentry explore <org>/<project> --dataset errors --period 7d --limit 50 --query "<exact text or uuid>" --field title --field timestamp --field transaction --field trace --field "count()" --json
```

Notes:

- Backend has logs; frontend may not. If frontend logs are unavailable, search frontend errors, spans, and replays.
- Use absolute time ranges with `Z`, for example `2026-06-04T12:25:00Z..2026-06-04T12:28:00Z`.

## Evidence Ladder

Use the smallest set of evidence that proves the point:

1. Exact matching log/error/span/replay for the user-provided identifier.
2. Event details with nested exception/cause and tags.
3. Trace logs and sibling spans/events.
4. Nearby time-window aggregates to identify bursts.
5. Runtime/deploy configuration: staging values, replica counts, worker counts, pool sizes, rollout strategy, feature flags.
6. Source code path for the failing endpoint/model/service.
7. Kubernetes/Postgres runtime checks if the correct cluster context is available.

## Failed Query Workflow

For `Error: Failed query: ...`, do not diagnose from the SQL string alone. Drizzle wraps the actual Postgres or network cause.

1. Find the issue/event.
2. Extract the nested exception value.
3. Correlate with trace logs and nearby errors.

Commands:

```bash
sentry issue events <ISSUE_SHORT_ID> --limit 5 --json
sentry event view <org>/<project> <event_id> --json --fields id,metadata.function,metadata.value,entries.0.data.values.0.value,entries.0.data.values.1.value,contexts.trace.trace_id,dateCreated,culprit,tags
sentry trace logs <org>/<project>/<trace_id> --json
```

Interpretation:

- `sorry, too many clients already`: Postgres connection exhaustion.
- `remaining connection slots are reserved for roles with the SUPERUSER attribute`: Postgres connection exhaustion near `max_connections`.
- `connect ECONNREFUSED <host>:5432`: Postgres endpoint refused connections. Usually DB pod restart, service endpoint flap, network issue, or all retries exhausted during a short outage.
- `column ... does not exist` or `relation ... does not exist`: deploy/migration ordering or schema drift, not DB unreliability.
- `Connection terminated`, `ECONNRESET`, `ETIMEDOUT`, or timeout messages: transient network/DB restart class; check retry logs and pod restarts.

## Connection Exhaustion Checks

When the nested cause is connection exhaustion, inspect deployment sizing before blaming user traffic.

Repo files to check:

- `.github/values-staging.yaml`
- `platform/helm/archestra/values.yaml`
- `platform/backend/src/config.ts`
- `platform/backend/src/database/index.ts`

Connection budget formula:

```text
steady_possible_connections = (web_replicas + worker_replicas) * ARCHESTRA_DATABASE_POOL_MAX
rollout_possible_connections = (web_replicas + web_surge + worker_replicas + worker_surge) * ARCHESTRA_DATABASE_POOL_MAX
```

Remember:

- `ARCHESTRA_DATABASE_POOL_MAX` is per Node process.
- Web pods and worker pods each create their own pool.
- Rolling update surge temporarily increases the number of pools.
- Readiness probes call a DB health query every 10 seconds per pod.
- Idle pool connections remain for 30 seconds by default.
- A single request can fan out into parallel DB queries, especially agent enrichment flows.

If bundled Postgres is used, verify whether pool demand can exceed Postgres `max_connections`. Recommended staging mitigation is usually to lower `ARCHESTRA_DATABASE_POOL_MAX` rather than increase Postgres connections.

Example sizing logic:

```text
safe_pool_max = floor((postgres_max_connections - reserved_connections - admin_headroom) / max_rollout_pods)
```

Use a small staging pool such as `8` or `10` unless there is evidence of sustained query queueing.

## Deploy/Config Checks

When an incident looks surprising for the current traffic level, inspect environment-specific configuration.

Common files:

- `.github/values-staging.yaml`
- `platform/helm/archestra/values.yaml`
- `platform/backend/src/config.ts`
- `platform/backend/src/database/index.ts`
- `platform/backend/src/server.ts`

Questions to answer:

- How many web pods and worker pods run in steady state?
- Does rollout surge temporarily increase pod count?
- Do workers run separately or in-process with web pods?
- Which env vars change behavior in this environment?
- Did the release introduce schema/config expectations that migrations may not have satisfied?
- Are probes, retries, background jobs, or reconnect loops adding load independent of human users?

## Retry/Reachability Checks

For `ECONNREFUSED` or other transient DB connection errors, check whether retries were happening and whether they mostly succeeded.

Commands:

```bash
sentry explore <org>/<project> --dataset logs --period "<start>Z..<end>Z" --limit 50 --query "message:*Transient*" --field severity --field "count()" --json
sentry explore <org>/<project> --dataset logs --period "<start>Z..<end>Z" --limit 100 --query "message:*Transient*" --field trace --field "count()" --json
sentry explore <org>/<project> --dataset errors --period "<start>Z..<end>Z" --limit 100 --query "Failed query" --field title --field transaction --field trace --field "count()" --json
```

Interpretation:

- Many retry logs with few final errors means retries masked most of a short DB outage.
- Repeated exactly-three retry logs per trace usually means retry budget was exhausted.
- A tight cluster of final 50x errors means the outage exceeded the retry window or the DB was saturated.

## Kubernetes Runtime Checks

Only run these if the current kube context points at staging. Verify context first.

```bash
kubectl config current-context
kubectl get deploy,statefulset,pods,svc -n <namespace>
kubectl get endpoints -n <namespace>
kubectl describe pod -n <namespace> <postgres_pod>
kubectl logs -n <namespace> <postgres_pod> --previous
```

Read-only Postgres checks:

```sql
SHOW max_connections;
SHOW superuser_reserved_connections;
SELECT count(*) AS connections, state FROM pg_stat_activity GROUP BY state ORDER BY connections DESC;
SELECT usename, application_name, client_addr, state, count(*) FROM pg_stat_activity GROUP BY usename, application_name, client_addr, state ORDER BY count(*) DESC;
```

Do not run `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `CREATE`, `DROP`, or migration commands without explicit approval.

## Common Staging Patterns

### Pool Oversubscription

Symptoms:

- Nested cause is `too many clients` or `remaining connection slots...`.
- Multiple unrelated SQL queries fail in the same minute.
- Better Auth/session lookup and application routes fail together.
- Low human user count still causes errors.

Likely cause:

- Too many pods times too-large per-process pool, especially with workers and rollout surge.

Mitigations:

- Lower `ARCHESTRA_DATABASE_POOL_MAX` for staging.
- Reduce web or worker replicas.
- Add PgBouncer or use managed Postgres if concurrency needs are real.
- Add dashboard/alert for connection utilization.

### DB Endpoint Flap

Symptoms:

- Nested cause is `ECONNREFUSED <host>:5432`.
- Many `Transient database error, retrying query` logs across traces.
- Final failed query count is lower than retry count.

Likely cause:

- DB pod restart, endpoint update, node disruption, readiness gap, or network transient.

Mitigations:

- Check Postgres pod restarts/OOM.
- Check service endpoints and node events.
- Keep retry budget, but do not treat retries as a substitute for DB availability.

### Migration/Deploy Drift

Symptoms:

- Nested cause is missing column/table/relation.
- Error starts immediately after a release.

Likely cause:

- Code deployed before migration completed, old pod/new schema mismatch, or failed migration.

Mitigations:

- Check release timestamp, migration job/logs, and running pod versions.
- Use the migrations skill if schema or migration files need changes.

## Reporting Template

Use this structure in the final response:

```text
Findings:
- What failed, when, and on which endpoint shape.
- Nested DB/network cause, not just the Sentry issue title.
- Count of related traces/errors/logs in the time window.
- Whether this is connection exhaustion, reachability flap, migration drift, or app-query behavior.

Why few users can still trigger it:
- Replica count, worker count, per-process pool size, rollout surge, retries, readiness probes, and request fanout.

Immediate mitigation:
- Smallest operational change first.

Follow-up:
- Runtime checks and code/config changes worth considering.
```

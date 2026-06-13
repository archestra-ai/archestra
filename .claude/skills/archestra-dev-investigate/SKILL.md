---
name: archestra-dev-investigate
description: Use when investigating Archestra bugs or incidents, especially staging issues, backend 50x errors, Sentry traces/logs, Drizzle failed queries, DB connection exhaustion, deploy regressions, or Kubernetes/runtime symptoms. Layers Archestra-specific knowledge on top of the generic /investigate process.
---

# Archestra Investigation

This is the Archestra-specific layer on top of the generic investigation process. It does not restate that process — it gives you where Archestra signals live, the exact Sentry recipes, and the known staging failure modes.

## Start here

1. **Drive the process with `/investigate`.** It owns the workflow (symptom → evidence map → ground truth → mechanism → root cause → fix), the evidence-priority ordering, the why-ladder, and the output template. If `/investigate` is not installed, install it from `arsenyinfo/skills` (https://github.com/arsenyinfo/skills); fall back to running the steps from memory only if you can't.
2. **Load `sentry-cli`** before running any Sentry command.
3. Treat the sections below as the Archestra entries in your `/investigate` evidence map — the concrete locations, selectors, and tools for this system.
4. Run repo commands from `platform/` unless told otherwise.

## Archestra safety notes

Generic safety lives in `/investigate`. The Archestra-specific rules:

- Read-only `SELECT` only against staging Postgres. No `INSERT/UPDATE/DELETE/ALTER/CREATE/DROP` or migrations without explicit approval. No destructive Sentry commands.
- Never copy Sentry payloads, real user emails, IPs, customer names, tokens, cookies, or raw IDs into code, tests, docs, commits, or PR text.
- In summaries, report neutral technical facts: endpoint shape, timestamp range, issue class, trace count, pod/deploy shape, likely cause.
- Sentry issue titles are symptoms. A Drizzle `Failed query: ...` is a wrapper — always inspect the nested exception cause before naming a root cause.

## Where Archestra signals live

- **Backend** emits logs to Sentry. **Frontend** often does not — for frontend, search errors, spans, and replays instead.
- **Prefer explicit `<org>/<project>`** in every command. Auto-detection usually fails from this repo.
- Start narrow with the user's exact UUID/error string, then broaden to traces, related issues, and adjacent time windows.
- Use absolute UTC ranges with `Z`, e.g. `2026-06-04T12:25:00Z..2026-06-04T12:28:00Z`.

```bash
sentry project list <org>/ --json
sentry issue list <org>/<project> --query "<exact text or uuid>" --limit 20 --json --fields shortId,title,level,status,count,userCount,firstSeen,lastSeen,permalink
sentry log list <org>/<project> --period 7d --limit 100 --query "<exact text or uuid>" --json --fields sentry.item_id,timestamp,message,severity,trace
sentry explore <org>/<project> --dataset errors --period 7d --limit 50 --query "<exact text or uuid>" --field title --field timestamp --field transaction --field trace --field "count()" --json
```

## Failed query workflow

For `Error: Failed query: ...`, do not diagnose from the SQL string. Drizzle wraps the real Postgres/network cause.

```bash
sentry issue events <ISSUE_SHORT_ID> --limit 5 --json
sentry event view <org>/<project> <event_id> --json --fields id,metadata.function,metadata.value,entries.0.data.values.0.value,entries.0.data.values.1.value,contexts.trace.trace_id,dateCreated,culprit,tags
sentry trace logs <org>/<project>/<trace_id> --json
```

Nested-cause interpretation:

- `sorry, too many clients already` / `remaining connection slots are reserved...`: Postgres connection exhaustion near `max_connections`.
- `connect ECONNREFUSED <host>:5432`: DB endpoint refused — DB pod restart, service endpoint flap, network issue, or retries exhausted during a short outage.
- `column/relation ... does not exist`: deploy/migration ordering or schema drift, not DB unreliability.
- `Connection terminated`, `ECONNRESET`, `ETIMEDOUT`, timeouts: transient network/DB restart class; check retry logs and pod restarts.

## Connection budget

When the nested cause is exhaustion, size the deployment before blaming traffic. Files: `.github/values-staging.yaml`, `platform/helm/archestra/values.yaml`, `platform/backend/src/config.ts`, `platform/backend/src/database/index.ts`.

```text
steady   = (web_replicas + worker_replicas) * ARCHESTRA_DATABASE_POOL_MAX
rollout  = (web_replicas + web_surge + worker_replicas + worker_surge) * ARCHESTRA_DATABASE_POOL_MAX
safe_pool_max = floor((postgres_max_connections - reserved - admin_headroom) / max_rollout_pods)
```

- `ARCHESTRA_DATABASE_POOL_MAX` is per Node process; web and worker pods each hold their own pool.
- Rolling-update surge temporarily adds pools. Readiness probes run a DB query every 10s per pod. Idle connections linger ~30s. One request can fan out into parallel queries (e.g. agent enrichment).
- Why few users still trigger it: replica count × per-process pool × rollout surge + probes + retries + request fanout, not human concurrency.
- Preferred staging mitigation is lowering `ARCHESTRA_DATABASE_POOL_MAX` (try `8`–`10`) over raising Postgres `max_connections`.

## Deploy/config checks

When an incident is surprising for the traffic level, inspect environment-specific config. Files above plus `platform/backend/src/server.ts`. Answer: how many web/worker pods steady-state; does surge raise pod count; do workers run separately or in-process; which env vars change behavior here; did the release add schema/config expectations migrations may not have met; are probes/retries/jobs/reconnect loops adding load independent of users.

## Retry/reachability checks

For `ECONNREFUSED` and transient DB errors, check whether retries happened and mostly succeeded.

```bash
sentry explore <org>/<project> --dataset logs --period "<start>Z..<end>Z" --limit 100 --query "message:*Transient*" --field trace --field "count()" --json
sentry explore <org>/<project> --dataset errors --period "<start>Z..<end>Z" --limit 100 --query "Failed query" --field title --field transaction --field trace --field "count()" --json
```

- Many retry logs, few final errors: retries masked a short DB outage.
- Exactly three retry logs per trace: retry budget exhausted.
- Tight cluster of final 50x: outage exceeded the retry window or DB was saturated.

## Kubernetes runtime checks

Only if the current context points at staging — verify first.

```bash
kubectl config current-context
kubectl get deploy,statefulset,pods,svc,endpoints -n <namespace>
kubectl describe pod -n <namespace> <postgres_pod>
kubectl logs -n <namespace> <postgres_pod> --previous
```

Read-only Postgres:

```sql
SHOW max_connections;
SHOW superuser_reserved_connections;
SELECT count(*) AS connections, state FROM pg_stat_activity GROUP BY state ORDER BY connections DESC;
SELECT usename, application_name, client_addr, state, count(*) FROM pg_stat_activity GROUP BY usename, application_name, client_addr, state ORDER BY count(*) DESC;
```

## Known staging failure modes

**Pool oversubscription** — nested cause `too many clients`/`remaining connection slots`; multiple unrelated queries fail in the same minute; auth/session and app routes fail together; low user count. Cause: too many pods × too-large per-process pool, amplified by workers and surge. Fix: lower `ARCHESTRA_DATABASE_POOL_MAX`, reduce replicas, or add PgBouncer/managed Postgres; add a connection-utilization alert.

**DB endpoint flap** — nested cause `ECONNREFUSED :5432`; many `Transient database error, retrying query` logs; final failure count below retry count. Cause: DB pod restart, endpoint update, node disruption, readiness gap. Fix: check Postgres restarts/OOM, service endpoints, node events; keep the retry budget but don't treat it as availability.

**Migration/deploy drift** — nested cause missing column/table/relation, starting right after a release. Cause: code deployed before migration completed, or old pod / new schema mismatch. Fix: check release timestamp, migration job/logs, running pod versions; use `archestra-dev-migrations` if schema/migration files need changes.

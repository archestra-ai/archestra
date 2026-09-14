---
name: archestra-dev-investigate
description: Use when investigating Archestra bugs or incidents — staging issues, backend 50x errors, Drizzle failed queries, DB connection pressure, deploy regressions, or Kubernetes/runtime symptoms. Orientation only; defers the process to /investigate.
---

# Archestra Investigation

Orientation for debugging Archestra. For the process itself — evidence-first, find the mechanism before fixing — use `/investigate` if you have it. This skill only adds what's specific to Archestra.

## What's specific here

- **Signals live in Sentry, unevenly.** Backend logs ship there; frontend usually doesn't, so reach for errors, spans, and replays instead. Pass `<org>/<project>` explicitly — auto-detection fails from this repo. Load the `sentry-cli` skill for the commands.
- **Drizzle hides the real cause.** `Failed query: <sql>` is a wrapper, and the SQL is rarely the problem. Read the nested exception — that's where Postgres or the network says what actually failed.
- **The pool is per Node process.** Each web and worker pod holds its own pool of `ARCHESTRA_DATABASE_POOL_MAX`, so DB connection demand is roughly pods × pool, pushed higher by rollout surge, readiness probes, and per-request query fanout. A few users can exhaust Postgres without unusual traffic — do that arithmetic before blaming load.
- **Surprising-for-the-traffic usually means config, not code.** Check `values-staging.yaml`, the helm values, and backend config / DB setup before reaching for a code change.

## Tools, by angle

Reach for the one that matches the question; load `archestra-dev-observability` for URLs, setup, and span/metric names.

- **Sentry** (via the `sentry-cli` skill) — a specific failure: the error, its nested cause, and the trace for one request.
- **Tempo** (traces) — where a request spent time or stalled, and how far it fanned out across LLM, MCP, and DB spans.
- **Prometheus / `llm_*` metrics** (`/metrics`) — is it systemic? Rates and aggregates for tokens/cost, error rate, and throughput over time.
- **Grafana** — dashboards over traces and metrics; line a spike up against a deploy.
- **kubectl** (staging only, read-only) — runtime ground truth the dashboards miss: pod restarts/OOM, service endpoints, live Postgres connection counts. Verify the context points at staging first.

## Failure classes to expect

Name the class first — it decides whether the fix is sizing, availability, or release ordering:

- **Connection pressure.** Exhaustion (`too many clients`, `connection slots reserved`) is a sizing problem — do the pool arithmetic above. Endpoint flap (`ECONNREFUSED :5432`, `ECONNRESET`, timeouts) is an availability problem — check DB pod restarts and whether retries absorbed it.
- **Deploy / migration drift.** A missing column or relation right after a release means code shipped ahead of its migration, not a flaky DB. Use `archestra-dev-migrations` if schema files need to change.

## Boundaries

- Staging Postgres: read-only `SELECT` only. No data mutation, schema changes, or migrations without explicit approval. No destructive Sentry commands.
- Keep payloads out of artifacts: no real emails, IPs, tokens, customer names, or raw IDs in code, tests, docs, commits, or PRs. Report neutral facts — endpoint shape, time range, issue class, counts.

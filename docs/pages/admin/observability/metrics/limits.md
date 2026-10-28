---
title: Limit Metrics
description: Identify exhausted budgets and rate limits, their targets, and enforcement behavior.
order: 2
lastUpdated: 2026-10-28
---

Identify which spend, token, or request limit was exhausted and whether it blocked a request.

## Metrics

Limit metrics have their own labels; LLM request and agent labels do not apply.

| Metric | Type | Labels | Measures |
| --- | --- | --- | --- |
| <span id="llm_limit_checks_total"></span>`llm_limit_checks_total` | Counter | `entity_type`, `limit_kind`, `behavior`, `outcome` | Rule evaluations during request admission. |
| <span id="llm_limit_storage_errors_total"></span>`llm_limit_storage_errors_total` | Counter | `operation` | Failures validating, admitting, settling, or cancelling limit usage. |
| <span id="llm_limit_last_exceeded_timestamp_seconds"></span>`llm_limit_last_exceeded_timestamp_seconds` | Gauge | Detail labels below | Unix timestamp of the last known exhausted rule evaluation. |
| <span id="llm_limit_last_exceeded_threshold"></span>`llm_limit_last_exceeded_threshold` | Gauge | Detail labels below | Configured allowance at that evaluation. |
| <span id="llm_limit_last_exceeded_usage"></span>`llm_limit_last_exceeded_usage` | Gauge | Detail labels below | Recorded usage at that evaluation. |

`behavior` is `hard` or `soft`. `limit_kind` is `token_cost`, `tokens`, or `requests`; legacy per-minute types use the same token/request values. `entity_type` is the configured scope: `organization`, `team`, `agent`, `user`, `virtual_key`, `environment`, or `llm_oauth_client`.

`outcome` is `within_limit`, `blocked` for a hard refusal (including unavailable spend), `exceeded` for an exhausted soft rule, or `usage_unavailable` when unknown spend is allowed by a soft rule. Unknown usage is not evidence that a threshold was crossed and does not emit detail gauges. Hard limits retain their existing failure behavior; soft limits do not block for unknown spend.

Each evaluated rule contributes an observation. One request can contribute several, and checks can stop at a hard refusal. These counters are neither distinct request counts nor unique threshold crossings. Token and spend checks reflect reported usage; responses already in flight can exceed an allowance before another request is checked. The aggregate counters are local to each process, reset on restart, and have no limit, user, or key identifiers.

### Identifying the Affected Rule

The three detail gauges share `limit_id`, `entity_id`, `entity_type`, `limit_kind`, `behavior`, `cleanup_interval`, and `source` labels. `source` is `explicit` or `default_user`. These are internal rule and target IDs, never API key secrets, request IDs, emails, display names, or client-supplied agent IDs. The target is the entity whose allowance was checked: a team limit identifies the team, not each caller using it. Default user allowances identify the affected managed user and the default configuration's ID; the configuration may be global or environment-specific.

For explicit rules, link an alert to `/llm/limits?edit=<limit_id>` in your Archestra frontend to see the target's display name, models, interval, and configuration. Default-user alerts should link to `/llm/limits` and include the user ID; their configuration IDs are not explicit-rule edit links. Names and model lists stay in Archestra rather than multiplying metric labels. Scrape access exposes internal IDs, so restrict it to your monitoring administrators.

Threshold and usage are numeric samples, not label values. Their units follow `limit_kind`: dollars for `token_cost`, token counts for `tokens`, and request counts for `requests`. Request usage is the recorded count before admission, excluding the rejected request. The gauges describe the last exhausted check, not current usage or current configuration. A reset, edit, or deletion does not erase a historical observation immediately. Unknown spend does not emit an exhausted observation.

Detailed series scale with configured rules and targets that hit them, including individual managed users for default allowances. Repeated checks overwrite the same observation. Inactive detail is removed after 24 hours on scrape; process restarts clear it. Account for that cardinality when sizing monitoring. Drop the `llm_limit_last_exceeded_.*` families at scrape time if you only need fleet-level aggregates. The aggregate counters retain their original small label set.

A recent-hit alert can use the timestamp directly, including when only one exhausted check was observed (a new counter series alone may not have a baseline for `increase`):

```promql
time() - max by (limit_id, entity_id, entity_type, limit_kind, behavior, cleanup_interval, source) (
  llm_limit_last_exceeded_timestamp_seconds
) < 300
```

This retains the rule and target context and selects the newest observation across replicas. Filter `behavior="soft"` or `"hard"` on the metric as needed. The threshold and usage gauges retain the same labels and scrape instance; avoid summing allowances or usage across replicas. All of these metrics observe request admission checks: they do not detect a token/spend crossing at response settlement or an idle workload reaching a cap without another check. A hit lost before its process is scraped cannot be recovered from Prometheus; these gauges are not a durable event log.

For soft-limit exceeded checks over five minutes:

```promql
sum by (entity_type, limit_kind) (
  increase(llm_limit_checks_total{behavior="soft",outcome="exceeded"}[5m])
)
```

For hard-limit refusal observations per second:

```promql
sum by (entity_type, limit_kind) (
  rate(llm_limit_checks_total{behavior="hard",outcome="blocked"}[5m])
)
```

`llm_limit_storage_errors_total` uses `operation="validation"`, `"admission"`, `"settlement"`, or `"cancellation"`. A storage error is separate from an exhausted allowance. See [Limit Behavior](/docs/llm-proxy/costs-and-limits/limits#limit-behavior) to choose enforcement behavior.

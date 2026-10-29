---
title: Agent Runtime Metrics
description: Track agent run outcomes, startup time, delivery, and runtime health.
order: 4
lastUpdated: 2026-10-28
---

Track agent runs from startup through completion and identify tasks waiting for attention.

## Metrics

| Metric | Type | Labels | Measures |
| --- | --- | --- | --- |
| <span id="agent_runtime_runs_started_total"></span>`agent_runtime_runs_started_total` | Counter | | [Agent Runtime](/docs/agents/runtime) runs that reached a running backend |
| <span id="agent_runtime_runs_terminated_total"></span>`agent_runtime_runs_terminated_total` | Counter | `outcome` | Finished runs: `completed`, `failed`, `stopped_by_user`, `expired_ttl`, or `expired_idle` |
| <span id="agent_runtime_provision_duration_seconds"></span>`agent_runtime_provision_duration_seconds` | Histogram | | Startup time, including scheduling and image pulls |
| <span id="agent_runtime_steers_total"></span>`agent_runtime_steers_total` | Counter | `steer_mode` | Steering messages delivered into running sessions |
| <span id="agent_runtime_completion_deliveries_total"></span>`agent_runtime_completion_deliveries_total` | Counter | `interface`, `outcome` | Final replies delivered to `chatops` or `email` |
| <span id="agent_runtime_crossing_refusals_total"></span>`agent_runtime_crossing_refusals_total` | Counter | `reason` | Runtime tool calls [Guardrails](/docs/agents/guardrails) refused or held at the runtime boundary |
| <span id="agent_runtime_pending_exports_total"></span>`agent_runtime_pending_exports_total` | Counter | `outcome` | Pending runtime file exports and their outcomes: `pinned`, `admitted`, `held`, or `discard_failed` |
| <span id="agent_runtime_observed_reads_total"></span>`agent_runtime_observed_reads_total` | Counter | `outcome` | Runtime reads a governed session made while [Guardrails](/docs/agents/guardrails) enforcement was off: `signed` so they pass once it is back on, or `unsigned` because the call could not be recorded |
| <span id="agent_runtime_health_tasks"></span>`agent_runtime_health_tasks` | Gauge | `agent_id`, `backend`, `condition` | Current task counts per condition |
| <span id="agent_runtime_health_age_seconds"></span>`agent_runtime_health_age_seconds` | Gauge | `agent_id`, `backend`, `condition` | Age of the oldest task per condition |
| <span id="agent_runtime_health_collection_timestamp_seconds"></span>`agent_runtime_health_collection_timestamp_seconds` | Gauge | | Time of the last health snapshot |

Filter `agent_runtime_crossing_refusals_total` by `reason` to identify missing session proofs, rejected clients, refused launches, or held runtime output.

`agent_runtime_health_tasks` conditions are `working`, `submitted`, `input_required`, `auth_required`, `failed_recent` (the last 15 minutes), and `completion_pending`. Conditions overlap: a task waiting for authentication also counts as `working`. `agent_runtime_health_age_seconds` conditions are `heartbeat`, `submitted`, and `completion_pending`.

Every replica reports the same health gauge values, so aggregate them with `max`, not `sum`. Alert on failed scrapes too, because missing samples do not mean healthy runs. A fresh heartbeat shows the orchestration is alive, not that the agent is making progress.

This alert finds runs whose heartbeat is more than two minutes old:

```promql
max by (agent_id, backend) (
  agent_runtime_health_age_seconds{condition="heartbeat"}
) > 120
```

Add a pending period (`for: 5m`) to skip transient spikes.

---
title: Observability Metrics
sidebarTitle: Metrics
description: Scrape Archestra's Prometheus metrics and look up every metric name and label
order: 1
lastUpdated: 2026-10-22
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra serves Prometheus metrics in OpenMetrics format. Scrape them to chart and alert on LLM cost and latency, MCP tool calls, coding agent health, and background jobs.

## Scraping

Each process serves its own registry, so scrape every pod:

| Process | Endpoint | Emits |
| --- | --- | --- |
| Web | `http://<pod>:9050/metrics` | Requests served by the web tier: LLM, MCP, chat, coding agents, HTTP |
| Worker | `http://<pod>:9000/metrics` | Knowledge Base syncs and embeddings, the task queue, scheduled tasks, and the LLM and MCP calls they make |

The Helm chart runs the worker as its own Deployment by default. Sum counters across web and worker pods: an agent run from a schedule reports its LLM metrics from a worker pod.

[`ARCHESTRA_METRICS_PORT`](/docs/admin/deployment/configuration#ARCHESTRA_METRICS_PORT) changes the web port. Worker pods serve metrics on their API port, `9000`.

### Authentication

The endpoint is open by default. Set [`ARCHESTRA_METRICS_SECRET`](/docs/admin/deployment/configuration#ARCHESTRA_METRICS_SECRET) to require a bearer token on web and worker pods. Requests without it get `401`.

```yaml
scrape_configs:
  - job_name: archestra
    authorization:
      type: Bearer
      credentials: <ARCHESTRA_METRICS_SECRET>
    kubernetes_sd_configs:
      - role: pod
```

### Helm Pod Annotations

For a Prometheus that discovers pods by annotation, add these to the chart values:

```yaml
archestra:
  podAnnotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "9050"
    prometheus.io/path: /metrics
```

The chart rewrites `prometheus.io/port` to `9000` on worker pods.

To check a pod, run `curl -s http://<pod>:9050/metrics | grep "# HELP llm_"`. Add `-H "Authorization: Bearer <secret>"` when a secret is set.

## Labels

Most LLM metrics share these labels:

| Label | Values |
| --- | --- |
| `provider`, `model` | The LLM provider and model, for example `anthropic` and `claude-sonnet-4-5` |
| `agent_id`, `agent_name` | The Archestra agent that made the call. All [LLM Proxy](/docs/llm-proxy) traffic reports `agent_name="LLM Proxy"`. Knowledge Base calls report `agent_name="Knowledge Base"` with an empty `agent_id`. |
| `agent_type` | `agent`, `llm_proxy`, `mcp_gateway`, or `profile` |
| `organization_id` | The owning organization |
| `source` | Where the request came from, for example `api`, `chat`, `chatops:slack`, `email`, `schedule-trigger`, `app:llm_complete`, `knowledge:embedding`, or `knowledge:reranker` |

MCP tool call metrics carry `agent_id`, `agent_name`, `agent_type`, `mcp_server_name`, `tool_name`, and `status` (`success` or `error`).

### Agent Labels

Go to an agent's **Advanced** tab and add a key and value under **Labels**. Each agent label becomes an extra label on the LLM, MCP, and `agent_runs_total` metrics. Prometheus allows only letters, digits, and underscores in label names, so other characters become `_`: `cost-center` turns into `cost_center`.

### Dimensions Without Labels

Users, skills, apps, and client-supplied IDs are not metric labels. Use these sources instead:

- **Users:** [per-user statistics](/docs/llm-proxy/costs-and-limits/costs#per-user-usage), or the `archestra.user.*` [span attributes](/docs/admin/observability/tracing#identity-attributes).
- **Skills and apps:** [per-skill](/docs/llm-proxy/costs-and-limits/costs#per-skill-cost) and [per-app](/docs/llm-proxy/costs-and-limits/costs#per-app-cost) statistics. App LLM spend shows in the LLM metrics as `source="app:llm_complete"`.
- **Client-supplied agent IDs** from the [`X-Archestra-Agent-Id`](/docs/llm-proxy#custom-headers) header: the `archestra.external_agent_id` span attribute. Only `agent_runs_total` carries it as a label.
- **Credentials:** the `archestra.virtual_key.id` span attribute.

## LLM Metrics

| Metric | Type | Extra Labels | Measures |
| --- | --- | --- | --- |
| <span id="llm_request_duration_seconds"></span>`llm_request_duration_seconds` | Histogram | `status_code` | LLM request duration |
| <span id="llm_tokens_total"></span>`llm_tokens_total` | Counter | `type` (`input`, `output`) | Tokens used. `input` excludes prompt-cache tokens. |
| <span id="llm_cache_tokens_total"></span>`llm_cache_tokens_total` | Counter | `cache_type` (`read`, `write`) | Prompt-cache tokens read from or written to the provider cache |
| <span id="llm_token_usage"></span>`llm_token_usage` | Histogram | | Input plus output tokens per request |
| <span id="llm_cost_total"></span>`llm_cost_total` | Counter | `billing_mode`, `auth_method` | Estimated list-price cost in USD. Needs [model pricing](/docs/llm-proxy/costs-and-limits#model-pricing). |
| <span id="llm_cache_cost_total"></span>`llm_cache_cost_total` | Counter | | Cost in USD of prompt-cache reads and writes |
| <span id="llm_cache_savings_total"></span>`llm_cache_savings_total` | Counter | | USD saved by cache reads at the discounted price |
| <span id="llm_time_to_first_token_seconds"></span>`llm_time_to_first_token_seconds` | Histogram | | Streaming: from the upstream call to the provider's first chunk |
| <span id="llm_time_to_first_byte_seconds"></span>`llm_time_to_first_byte_seconds` | Histogram | | Streaming: from request receipt to the first byte sent to the client |
| <span id="llm_tokens_per_second"></span>`llm_tokens_per_second` | Histogram | | Output token throughput |
| <span id="llm_blocked_tools_total"></span>`llm_blocked_tools_total` | Counter | | Tool calls blocked by [guardrails](/docs/agents/guardrails) |
| <span id="agent_runs_total"></span>`agent_runs_total` | Counter | `external_agent_id` | Unique runs, counted by the [`X-Archestra-Run-Id`](/docs/llm-proxy#custom-headers) header |
| <span id="llm_active_users"></span>`llm_active_users` | Gauge | `window` (`24h`, `7d`) only | Distinct users with at least one LLM request in the window |

`billing_mode` is `metered` for per-token billing and `subscription` for flat-rate subscription credentials. Billed spend is `sum(llm_cost_total{billing_mode="metered"})`. `auth_method` is `provider_key`, `virtual_key`, `passthrough_virtual_key`, `jwks`, `oauth_client_credentials`, `oauth_user`, `internal`, or `unknown`.

`llm_time_to_first_byte_seconds` minus `llm_time_to_first_token_seconds` is the time Archestra spends before the upstream call: authentication and guardrails.

Every replica reports the same `llm_active_users` value, so aggregate it with `max()`, not `sum()`. [`ARCHESTRA_METRICS_ACTIVE_USERS_REFRESH_INTERVAL_MS`](/docs/admin/deployment/configuration#ARCHESTRA_METRICS_ACTIVE_USERS_REFRESH_INTERVAL_MS) sets the refresh interval; `0` turns the metric off.

LLM and MCP metrics carry trace exemplars, so a Grafana panel can link a data point to its trace. See [Exemplars](/docs/admin/observability#exemplars).

## Limit Metrics

These metrics cover LLM spend, token, and request limits. They have their own labels; agent and request labels do not apply.

| Metric | Type | Labels | Measures |
| --- | --- | --- | --- |
| <span id="llm_limit_checks_total"></span>`llm_limit_checks_total` | Counter | `entity_type`, `limit_kind`, `behavior`, `outcome` | Rule evaluations during request admission. |
| <span id="llm_limit_storage_errors_total"></span>`llm_limit_storage_errors_total` | Counter | `operation` | Failures validating, admitting, settling, or cancelling limit usage. |
| <span id="llm_limit_last_exceeded_timestamp_seconds"></span>`llm_limit_last_exceeded_timestamp_seconds` | Gauge | Detail labels below | Unix timestamp of the last known exhausted rule evaluation. |
| <span id="llm_limit_last_exceeded_threshold"></span>`llm_limit_last_exceeded_threshold` | Gauge | Detail labels below | Configured allowance at that evaluation. |
| <span id="llm_limit_last_exceeded_usage"></span>`llm_limit_last_exceeded_usage` | Gauge | Detail labels below | Recorded usage at that evaluation. |

`behavior` is `hard` or `soft`. `limit_kind` is `token_cost`, `tokens`, or `requests`; legacy per-minute types use the same token/request values. `entity_type` is the configured scope: `organization`, `team`, `agent`, `user`, `virtual_key`, `environment`, or `llm_oauth_client`.

`outcome` is `within_limit`, `blocked` for an exhausted hard rule, `exceeded` for an exhausted soft rule, or `usage_unavailable` when spend cannot be evaluated. Unknown usage is not evidence that a threshold was crossed. Hard limits retain their existing failure behavior; soft limits do not block for unknown spend.

Each evaluated rule contributes an observation. One request can contribute several, and checks can stop at a hard refusal. These counters are neither distinct request counts nor unique threshold crossings. Token and spend checks reflect reported usage; responses already in flight can exceed an allowance before another request is checked. The aggregate counters are local to each process, reset on restart, and have no limit, user, or key identifiers.

### Identifying the affected rule

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

## MCP Metrics

| Metric | Type | Measures |
| --- | --- | --- |
| <span id="mcp_tool_calls_total"></span>`mcp_tool_calls_total` | Counter | Tool calls through the [MCP Gateway](/docs/mcp/gateway) |
| <span id="mcp_tool_call_duration_seconds"></span>`mcp_tool_call_duration_seconds` | Histogram | Tool call duration |
| <span id="mcp_request_size_bytes"></span>`mcp_request_size_bytes` | Histogram | Tool call argument size |
| <span id="mcp_response_size_bytes"></span>`mcp_response_size_bytes` | Histogram | Tool call result size |
| <span id="mcp_server_deployment_status"></span>`mcp_server_deployment_status` | Gauge | State of each self-hosted MCP server, by `server_name` and `state` |

`mcp_server_deployment_status` is `1` for the server's current `state`: `not_created`, `pending`, `running`, `failed`, `succeeded`, `hibernated`, or `waking`. `count(mcp_server_deployment_status{state="running"} == 1)` counts running servers.

## Agent Runtime Health

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

## Knowledge Base Metrics

| Metric | Labels | Measures |
| --- | --- | --- |
| <span id="rag_connector_syncs_total"></span>`rag_connector_syncs_total`, <span id="rag_connector_sync_duration_seconds"></span>`rag_connector_sync_duration_seconds` | `connector_type`, `status` | Connector syncs (`success`, `failed`, or `partial`) and their duration |
| <span id="rag_documents_processed_total"></span>`rag_documents_processed_total`, <span id="rag_documents_ingested_total"></span>`rag_documents_ingested_total`, <span id="rag_chunks_created_total"></span>`rag_chunks_created_total` | `connector_type` | Documents read, documents added or updated, and chunks created |
| <span id="rag_documents_without_text_total"></span>`rag_documents_without_text_total` | `connector_type` | Documents skipped because they have no extractable text |
| <span id="rag_ocr_pages_total"></span>`rag_ocr_pages_total` | `connector_type`, `outcome` | Scanned PDF pages sent to OCR |
| <span id="rag_embedding_batches_total"></span>`rag_embedding_batches_total`, <span id="rag_embedding_documents_total"></span>`rag_embedding_documents_total` | `status` | Embedding batches and documents |
| <span id="rag_queries_total"></span>`rag_queries_total`, <span id="rag_query_duration_seconds"></span>`rag_query_duration_seconds`, <span id="rag_query_results_count"></span>`rag_query_results_count` | `search_type` | Searches, their end-to-end duration, and results returned |
| <span id="rag_search_lane_timeout_total"></span>`rag_search_lane_timeout_total` | `lane` | Search lanes cut by the database statement timeout |
| <span id="rag_quote_verification_total"></span>`rag_quote_verification_total` | `result` | Chat-answer quotes checked against their cited source |
| <span id="rag_permission_syncs_total"></span>`rag_permission_syncs_total` | `connector_type`, `status` | Permission sync passes |
| `rag_permission_sync_*` | `connector_type` | Permission sync gaps: group failures, dropped principals, ACL over-approximations, unreadable containers, restriction fallbacks, and skipped identity lookups |
| <span id="rag_access_token_truncations_total"></span>`rag_access_token_truncations_total` | `kind` | Users whose group memberships exceeded the per-user cap at query time |
| <span id="rag_knowledge_query_unresolved_identity_total"></span>`rag_knowledge_query_unresolved_identity_total` | | Searches limited to organization-wide documents because the caller had no email |

## Skill and Sandbox Metrics

| Metric | Labels | Measures |
| --- | --- | --- |
| <span id="skill_activations_total"></span>`skill_activations_total` | `activation_type` | [Skill](/docs/agents/skills) activations: `slash_command`, `chat_attachment`, [`load_skill`](/docs/reference/archestra-mcp-server#load_skill), or `delegation` |
| <span id="skill_context_tokens_total"></span>`skill_context_tokens_total` | `activation_type` | Tokens that skill activations added to model context |
| <span id="sandbox_commands_total"></span>`sandbox_commands_total`, <span id="sandbox_command_duration_seconds"></span>`sandbox_command_duration_seconds` | `status` | [Code Sandbox](/docs/agents#code-sandbox) commands: `ok`, `script_error`, `timeout`, or `runtime_error` |
| <span id="sandbox_runtime_errors_total"></span>`sandbox_runtime_errors_total` | `code` | Sandbox runtime errors. `engine_unreachable` means the sandbox engine is down. |
| <span id="sandbox_runtime_status"></span>`sandbox_runtime_status` | `status` | `1` for the runtime's current status: `disabled`, `initializing`, `ready`, `error`, or `stopped` |

## Background Task Metrics

| Metric | Labels | Measures |
| --- | --- | --- |
| <span id="task_queue_tasks_enqueued_total"></span>`task_queue_tasks_enqueued_total`, <span id="task_queue_tasks_completed_total"></span>`task_queue_tasks_completed_total` | `task_type` | Tasks queued and completed |
| <span id="task_queue_tasks_failed_total"></span>`task_queue_tasks_failed_total` | `task_type` | Failed attempts. The task may be retried. |
| <span id="task_queue_tasks_dead_total"></span>`task_queue_tasks_dead_total` | `task_type` | Tasks that ran out of retries |
| <span id="task_queue_task_duration_seconds"></span>`task_queue_task_duration_seconds` | `task_type` | Task duration |
| <span id="task_queue_active_tasks"></span>`task_queue_active_tasks` | `task_type` | Tasks running now |
| <span id="task_queue_stuck_tasks_reset_total"></span>`task_queue_stuck_tasks_reset_total` | | Stuck tasks returned to the queue |
| <span id="schedule_trigger_runs_total"></span>`schedule_trigger_runs_total` | `agent_name`, `status` | [Scheduled task](/docs/chat/projects#scheduled-tasks) runs: `success`, `failed`, or `cancelled` |

Common `task_type` values are `connector_sync`, `batch_embedding`, `permission_sync`, and `schedule_trigger_run_execute`.

## Platform Metrics

| Metric | Labels | Measures |
| --- | --- | --- |
| <span id="http_request_duration_seconds"></span>`http_request_duration_seconds`, <span id="http_request_summary_seconds"></span>`http_request_summary_seconds` | `method`, `route`, `status_code` | API request duration, as a histogram and as a summary with quantiles |
| <span id="database_pool_connections"></span>`database_pool_connections` | `state` | Database pool connections: `total`, `idle`, and `waiting` |
| <span id="database_pool_size_limit"></span>`database_pool_size_limit` | | Maximum pool size per process |
| <span id="audit_write_failures_total"></span>`audit_write_failures_total` | `source`, `resource_type` | Audit log rows that failed to save |
| <span id="file_storage_orphaned_objects_total"></span>`file_storage_orphaned_objects_total` | `provider`, `scope` | Stored files left behind by a failed delete |
| <span id="chat_message_feedback_total"></span>`chat_message_feedback_total` | `feedback` | Thumbs up, thumbs down, and cleared ratings on chat answers |
| `process_*`, `nodejs_*` | | Standard Node.js process metrics: CPU, memory, heap, event loop lag, and garbage collection |

## Example Queries

```promql
# Billed LLM spend per agent over the last day
sum by (agent_name) (increase(llm_cost_total{billing_mode="metered"}[1d]))

# 95th percentile LLM latency per model
histogram_quantile(0.95, sum by (le, model) (rate(llm_request_duration_seconds_bucket[5m])))

# MCP tool error rate per server
sum by (mcp_server_name) (rate(mcp_tool_calls_total{status="error"}[5m]))
  / sum by (mcp_server_name) (rate(mcp_tool_calls_total[5m]))
```

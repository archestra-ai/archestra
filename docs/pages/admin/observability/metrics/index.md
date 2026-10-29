---
title: Metrics
description: Configure Prometheus scraping and explore Archestra's metric references.
order: 1
lastUpdated: 2026-10-28
---

Scrape Archestra's Prometheus metrics to track model spend, tool calls, agent runs, and platform health. Choose a reference below to look up metric names, labels, and aggregation behavior.

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

Go to an agent's **Advanced** tab and add a key and value under **Labels**. Each agent label becomes an extra label on the LLM, MCP, and [`agent_runs_total`](/docs/admin/observability/metrics/llm#agent_runs_total) metrics. Prometheus allows only letters, digits, and underscores in label names, so other characters become `_`: `cost-center` turns into `cost_center`.

### Dimensions Without Labels

LLM and MCP request metrics do not carry user, skill, app, or client-supplied identity labels, except where noted below. [Limit metrics](/docs/admin/observability/metrics/limits) separately identify the configured budget target. Use these sources for request attribution:

- **Users:** [per-user statistics](/docs/llm-proxy/costs-and-limits/costs#per-user-usage), or the `archestra.user.*` [span attributes](/docs/admin/observability/tracing#identity-attributes).
- **Skills and apps:** [per-skill](/docs/llm-proxy/costs-and-limits/costs#per-skill-cost) and [per-app](/docs/llm-proxy/costs-and-limits/costs#per-app-cost) statistics. App LLM spend shows in the LLM metrics as `source="app:llm_complete"`.
- **Client-supplied agent IDs** from the [`X-Archestra-Agent-Id`](/docs/llm-proxy#custom-headers) header: the `archestra.external_agent_id` span attribute. Only [`agent_runs_total`](/docs/admin/observability/metrics/llm#agent_runs_total) carries it as a label.
- **Credentials:** the `archestra.virtual_key.id` span attribute.

<!-- Preserve published fragments beside the automatic Explore cards. -->
<span id="example-queries"></span>
<span id="llm-metrics"></span><span id="llm_request_duration_seconds"></span><span id="llm_tokens_total"></span><span id="llm_cache_tokens_total"></span><span id="llm_token_usage"></span><span id="llm_cost_total"></span><span id="llm_cache_cost_total"></span><span id="llm_cache_savings_total"></span><span id="llm_time_to_first_token_seconds"></span><span id="llm_time_to_first_byte_seconds"></span><span id="llm_tokens_per_second"></span><span id="llm_blocked_tools_total"></span><span id="agent_runs_total"></span><span id="llm_active_users"></span>
<span id="limit-metrics"></span><span id="llm_limit_checks_total"></span><span id="llm_limit_storage_errors_total"></span><span id="llm_limit_last_exceeded_timestamp_seconds"></span><span id="llm_limit_last_exceeded_threshold"></span><span id="llm_limit_last_exceeded_usage"></span>
<span id="mcp-metrics"></span><span id="mcp_tool_calls_total"></span><span id="mcp_tool_call_duration_seconds"></span><span id="mcp_request_size_bytes"></span><span id="mcp_response_size_bytes"></span><span id="mcp_server_deployment_status"></span>
<span id="agent-runtime-health"></span><span id="agent_runtime_runs_started_total"></span><span id="agent_runtime_runs_terminated_total"></span><span id="agent_runtime_provision_duration_seconds"></span><span id="agent_runtime_steers_total"></span><span id="agent_runtime_completion_deliveries_total"></span><span id="agent_runtime_crossing_refusals_total"></span><span id="agent_runtime_pending_exports_total"></span><span id="agent_runtime_observed_reads_total"></span><span id="agent_runtime_health_tasks"></span><span id="agent_runtime_health_age_seconds"></span><span id="agent_runtime_health_collection_timestamp_seconds"></span>
<span id="knowledge-base-metrics"></span><span id="rag_connector_syncs_total"></span><span id="rag_connector_sync_duration_seconds"></span><span id="rag_documents_processed_total"></span><span id="rag_documents_ingested_total"></span><span id="rag_chunks_created_total"></span><span id="rag_documents_without_text_total"></span><span id="rag_ocr_pages_total"></span><span id="rag_embedding_batches_total"></span><span id="rag_embedding_documents_total"></span><span id="rag_queries_total"></span><span id="rag_query_duration_seconds"></span><span id="rag_query_results_count"></span><span id="rag_search_lane_timeout_total"></span><span id="rag_quote_verification_total"></span><span id="rag_permission_syncs_total"></span><span id="rag_access_token_truncations_total"></span><span id="rag_knowledge_query_unresolved_identity_total"></span>
<span id="skill-and-sandbox-metrics"></span><span id="skill_activations_total"></span><span id="skill_context_tokens_total"></span><span id="sandbox_commands_total"></span><span id="sandbox_command_duration_seconds"></span><span id="sandbox_runtime_errors_total"></span><span id="sandbox_runtime_status"></span>
<span id="background-task-metrics"></span><span id="task_queue_tasks_enqueued_total"></span><span id="task_queue_tasks_completed_total"></span><span id="task_queue_tasks_failed_total"></span><span id="task_queue_tasks_dead_total"></span><span id="task_queue_task_duration_seconds"></span><span id="task_queue_active_tasks"></span><span id="task_queue_stuck_tasks_reset_total"></span><span id="schedule_trigger_runs_total"></span>
<span id="platform-metrics"></span><span id="http_request_duration_seconds"></span><span id="http_request_summary_seconds"></span><span id="database_pool_connections"></span><span id="database_pool_size_limit"></span><span id="audit_write_failures_total"></span><span id="file_storage_orphaned_objects_total"></span><span id="chat_message_feedback_total"></span>

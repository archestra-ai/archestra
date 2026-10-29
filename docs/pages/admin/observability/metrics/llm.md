---
title: LLM Metrics
description: Look up LLM latency, token usage, prompt caching, and cost metrics.
order: 1
lastUpdated: 2026-10-28
---

Track LLM request latency, token usage, and billed spend across providers and models. See [Labels](/docs/admin/observability/metrics#labels) for request and agent dimensions.

## Metrics

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

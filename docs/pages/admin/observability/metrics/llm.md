---
title: LLM Metrics
description: Look up LLM latency, token usage, prompt caching, and cost metrics.
order: 1
lastUpdated: 2026-10-30
---

Track LLM request latency, token usage, and billed spend across providers and models. See [Labels](/docs/admin/observability/metrics#labels) for request and agent dimensions.

## Metrics

| Metric | Type | Extra Labels | Measures |
| --- | --- | --- | --- |
| <span id="llm_request_duration_seconds"></span>`llm_request_duration_seconds` | Histogram | `status_code` | Upstream-call latency; streaming measures establishment, not completion. Retries can add observations. |
| <span id="llm_proxy_request_duration_seconds"></span>`llm_proxy_request_duration_seconds` | Histogram | `provider`, `operation`, `stream`, `outcome`, `error_origin`, `status_code` only | End-to-end logical proxy and model router inference duration, including preflight, retries, and full stream completion |
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

Upstream LLM and MCP metrics carry trace exemplars, so a Grafana panel can link a data point to its trace. See [Exemplars](/docs/admin/observability#exemplars).

## Proxy Request Outcomes

Track end-to-end request outcomes, throttling, and latency across the [LLM Proxy](/docs/llm-proxy) and model router with `llm_proxy_request_duration_seconds`, separating Archestra policy decisions from upstream provider and client failures.

Each observation records one logical inference request from handler entry through completion, including preflight, retries, failovers, and the full response stream. Use `llm_proxy_request_duration_seconds_count` as the request counter; Archestra does not emit a separate counter metric. Use the existing `llm_request_duration_seconds` for upstream-call latency: its count can include retries, and misses preflight refusals and failures after streaming headers.

The metric covers inference requests handled by the shared proxy and model router. It excludes requests rejected by authentication or validation before reaching those handlers, model listing, unsupported passthrough endpoints, and provider file routes.

| Label | Values |
| --- | --- |
| `provider` | Resolved provider name (such as `openai` or `anthropic`), or `router` when a model-router request fails before routing selects a provider |
| `operation` | Inference operation, such as `chat`, `generate_content`, or `embedding` |
| `stream` | `true` or `false` |
| `outcome` | `success`, `incomplete`, `error`, `throttled`, `denied`, `cancelled`, `timeout`, or `overloaded` |
| `error_origin` | `none` for `success` or `incomplete`, `archestra`, `provider`, or `client` |
| `status_code` | HTTP response status code (`100`–`599`, normalized to `500` if invalid, or `499` when the client disconnects before headers are sent) |

`incomplete` identifies a provider terminal such as an output-token limit; it has no error origin.

If a streaming request fails after HTTP `200` headers are sent, `status_code` stays `200` while `outcome` and `error_origin` record the midstream failure. To keep cardinality bounded, this histogram carries only the six labels above and omits model, agent, user, team, and key dimensions. For per-request attribution, use the metadata-only `archestra.llm_proxy.request` OpenTelemetry log event in [Proxy Request Log Events](/docs/admin/observability/tracing#proxy-request-log-events); existing token, cache, and cost metrics above, [costs and limits](/docs/llm-proxy/costs-and-limits), and [LLM spans](/docs/admin/observability/tracing#llm-spans) keep their existing dimensions.

Archestra's OTLP pipeline exports traces and logs (`/v1/traces` and `/v1/logs`), not native OTLP metrics. Configure your OpenTelemetry collector or Prometheus server to scrape `/metrics` to ingest this histogram, and query `llm_proxy_request_duration_seconds_count` for throttle and error rates:

```promql
# Upstream provider rate limits (requests/sec by provider)
sum by (provider) (
  rate(llm_proxy_request_duration_seconds_count{outcome="throttled", error_origin="provider"}[5m])
)

# Internal Archestra throttles and policy or limit denials (requests/sec)
sum by (outcome) (
  rate(llm_proxy_request_duration_seconds_count{outcome=~"throttled|denied", error_origin="archestra"}[5m])
)

# Non-success request rate by origin and outcome, including midstream 200 failures
sum by (provider, error_origin, outcome) (
  rate(llm_proxy_request_duration_seconds_count{outcome!="success"}[5m])
)
```

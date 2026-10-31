---
title: Guardrails and OpenAPPA Metrics
description: Track embedded OpenAPPA hook dispatches and latency, or map standalone OpenAPPA daemon metrics.
order: 9
lastUpdated: 2026-10-31
---

Track [Guardrails](/docs/agents/guardrails) hook volume, decision outcomes, and hook dispatch latency from Archestra's Prometheus `/metrics` endpoint, or map OTLP metrics from a standalone OpenAPPA daemon.

## Collection Setup

Choose the setup for the runtime you operate. Embedded hooks and standalone daemon instruments use different export paths; configuring traces alone does not collect either set of metrics.

### Archestra Embedded Hooks

1. Scrape every web and worker pod using the endpoints and authentication in [Scraping](/docs/admin/observability/metrics#scraping). No additional OTLP metrics exporter is needed for embedded hooks.
2. If your collector filters metric names, retain `openappa_hook_dispatches_total` and all `openappa_hook_dispatch_duration_seconds` histogram series (`_bucket`, `_sum`, and `_count`). Keep the `hook` and `decision` labels and the existing pod identity labels.
3. Exercise a Guardrails-enabled request, then query `sum by (hook, decision) (openappa_hook_dispatches_total)` in Prometheus. Check both the pod endpoint and the remote backend if the series is missing; an idle or older application process may not emit it.
4. Select that Prometheus source as **Metrics** on the Guardrails & OpenAPPA dashboard. Its embedded hook panels use these scraped series.

### Standalone Daemon OTLP Metrics

Only follow these steps if you run the standalone OpenAPPA daemon. Archestra's embedded runtime does not emit the standalone `appa_*` instruments.

1. Enable an OTLP HTTP receiver and a **metrics** pipeline in your OpenTelemetry Collector. You can reuse the receiver serving traces and logs; add the metrics pipeline alongside those existing pipelines. For example, a Collector Contrib configuration can expose Prometheus samples on port 9464:

   ```yaml
   receivers:
     otlp:
       protocols:
         http:
           endpoint: 0.0.0.0:4318
   exporters:
     prometheus:
       endpoint: 0.0.0.0:9464
   service:
     pipelines:
       metrics:
         receivers: [otlp]
         exporters: [prometheus]
   ```

   Restrict receiver and exporter access to your telemetry network and configure authentication for your environment. This example shows the metrics branch; preserve any existing traces and logs pipelines.

2. Configure the standalone daemon with `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318` and restart it. Use the collector address reachable from the daemon. Leave `OTEL_SDK_DISABLED` unset or `false`; configure `OTEL_EXPORTER_OTLP_HEADERS` if your receiver requires authentication. The daemon sends metrics to `/v1/metrics` alongside its traces and logs.
3. Have Prometheus scrape the collector's `:9464/metrics` endpoint. Alternatively, use a `prometheusremotewrite` exporter in the metrics pipeline to send samples directly to your Prometheus-compatible backend with that backend's credentials.
4. After an export interval, query `appa_runtime_uptime_seconds` in the destination. Exercise a policy decision and check the corresponding counters below. Keep the daemon's service identity stable; do not add session or request IDs as metric labels.
5. Select the receiving Prometheus source as **OpenAPPA metrics** on the dashboard and expand its standalone daemon row. This may be the same source used for Archestra metrics.

## Embedded Hook Metrics

Archestra exposes two metric families on its standard Prometheus scrape endpoint (`:9050/metrics` on web pods and `:9000/metrics` on worker pods; see [Scraping](/docs/admin/observability/metrics#scraping)).

| Metric | Type | Labels | Measures |
| --- | --- | --- | --- |
| <span id="openappa_hook_dispatches_total"></span>`openappa_hook_dispatches_total` | Counter | `hook`, `decision` | Completed embedded OpenAPPA hook dispatches, including failures; one observation after policy-move retries. |
| <span id="openappa_hook_dispatch_duration_seconds"></span>`openappa_hook_dispatch_duration_seconds` | Histogram | `hook`, `decision` | Embedded OpenAPPA hook dispatch wall time in seconds (`0.001` to `300`s buckets), including policy resolution inside dispatch, native initialization, storage, consults, and retries. |

### Dispatch Semantics

Each observation records one logical hook dispatch across the embedded host boundary after any policy-move retries settle. One user request or agent turn can trigger multiple hook dispatches (such as `session_start`, `tool_result`, `prompt`, `tool_call`, and `turn_end`), and a single `tool_call` dispatch can evaluate policy rules, consult helpers or annotators, and retry when an organization's policy revision moves. These metrics do not count individual engine rule checks or unique user requests.

Metric collection cannot alter enforcement. If metric recording is disabled or fails, Archestra preserves the original hook decision or error unchanged.

### Labels

Both families use closed label sets to keep cardinality bounded and never emit organization, session, user, agent, or call IDs, tool names, arguments, policy text, or error messages.

| Label | Values |
| --- | --- |
| `hook` | `session_start`, `prompt`, `tool_call`, `tool_result`, `turn_end`, `cancel_call`, `child_address`, `child_end`, `child_return`, yell, or `other` for an unrecognized hook |
| `decision` | `ack`, `allow_call`, `pass_control`, `deny_call`, `block`, `replace_output`, `deliver_value`, `child_return`, `context`, `refuse`, `mcp_result`, `other` for an unrecognized decision, or `error` when the dispatch rejects |

Related boundary counters on other pages track downstream effects: [`llm_blocked_tools_total`](/docs/admin/observability/metrics/llm#llm_blocked_tools_total) counts tool calls blocked at the LLM Proxy, and [`agent_runtime_crossing_refusals_total`](/docs/admin/observability/metrics/agent-runtime#agent_runtime_crossing_refusals_total) counts runtime boundary refusals.

Shared policy preloading for a tool-call batch and principal lookup happen before this boundary and are excluded.

Query dispatch rates, failures, and tail latency with PromQL:

```promql
# Embedded hook dispatch rate by hook and decision
sum by (hook, decision) (
  rate(openappa_hook_dispatches_total[5m])
)

# Failed dispatches or structured runtime refusals
sum by (hook, decision) (
  rate(openappa_hook_dispatches_total{decision=~"error|refuse"}[5m])
)

# 95th-percentile hook dispatch wall time by hook
histogram_quantile(
  0.95,
  sum by (le, hook) (rate(openappa_hook_dispatch_duration_seconds_bucket[5m]))
)
```

## Standalone OpenAPPA Daemon Metrics

The standalone [OpenAPPA](https://github.com/archestra-ai/OpenAPPA) daemon ships a separate OpenTelemetry metrics exporter that is not wired into Archestra's embedded NAPI runtime. Standalone `appa_*` series do not appear on Archestra's `/metrics` scrape endpoint, and Archestra's built-in OTLP exporter forwards traces and logs (`/v1/traces` and `/v1/logs`), not OTLP metrics.

To collect standalone daemon metrics in Prometheus, point the standalone daemon at an OpenTelemetry Collector metrics pipeline (`otlp` receiver to a `prometheus` or `prometheusremotewrite` exporter). Standard Prometheus translation maps the dotted OTLP instrument names below to `appa_*` series:

| Metric | OTLP Instrument | Type | Labels | Measures |
| --- | --- | --- | --- | --- |
| <span id="appa_policy_decisions_total"></span>`appa_policy_decisions_total` | `appa.policy.decisions` | Counter | `outcome` (`allowed`, `denied`) | Policy decisions recorded by the standalone daemon |
| <span id="appa_policy_check_duration_seconds"></span>`appa_policy_check_duration_seconds` | `appa.policy.check.duration` | Histogram | `outcome` (`allowed`, `denied`, `error`) | Standalone policy check duration, including failed evaluations |
| <span id="appa_external_calls_total"></span>`appa_external_calls_total` | `appa.external.calls` | Counter | `role`, `outcome` (`answered`, `no_answer`) | External helper, annotator, or authority calls by role and outcome |
| <span id="appa_external_call_duration_seconds"></span>`appa_external_call_duration_seconds` | `appa.external.call.duration` | Histogram | `role`, `outcome` (`answered`, `no_answer`) | Duration of external helper, annotator, or authority calls |
| <span id="appa_remedy_attempts_total"></span>`appa_remedy_attempts_total` | `appa.remedy.attempts` | Counter | `outcome` (`executed`, `declined`, `no_answer`, `refused`) | Remedy attempts by outcome |
| <span id="appa_remedy_duration_seconds"></span>`appa_remedy_duration_seconds` | `appa.remedy.duration` | Histogram | `outcome` (`executed`, `declined`, `no_answer`, `refused`) | Duration of remedy attempts |
| <span id="appa_runtime_failures_total"></span>`appa_runtime_failures_total` | `appa.runtime.failures` | Counter | `component`, `error_type` | Standalone runtime failures by component and error type |
| <span id="appa_yell_reports_total"></span>`appa_yell_reports_total` | `appa.yell.reports` | Counter | `source` | Diagnostic yell reports received by source |
| <span id="appa_runtime_uptime_seconds"></span>`appa_runtime_uptime_seconds` | `appa.runtime.uptime` | Gauge | | Standalone daemon uptime in seconds |

---
title: Guardrails and OpenAPPA Metrics
description: Monitor OpenAPPA hooks and engine operations through Archestra's standard Prometheus endpoint.
order: 9
lastUpdated: 2026-10-31
---

Track [Guardrails](/docs/agents/guardrails) hooks and OpenAPPA engine operations through Archestra's standard Prometheus `/metrics` endpoint.

## Collection Setup

Scrape every Archestra web and worker pod using the [standard metrics endpoints and authentication](/docs/admin/observability/metrics#scraping). Hook and engine metrics are included in the same response. No additional exporter, receiver, or data source is required.

If your collector filters metric names, retain `openappa_hook_*`, `appa_*`, and [`agent_runtime_crossing_refusals_total`](/docs/admin/observability/metrics/agent-runtime#agent_runtime_crossing_refusals_total), including histogram `_bucket`, `_sum`, and `_count` series. Preserve the metric labels and pod identity labels.

Exercise a Guardrails-enabled request, then query `sum by (hook, decision) (openappa_hook_dispatches_total)` and `sum by (outcome) (appa_policy_decisions_total)` in Prometheus. Select that Prometheus source as **Metrics** on the Guardrails & OpenAPPA dashboard. Metrics appear when their corresponding operations run; an absent event-driven series is not a successful zero.

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

## Engine Metrics

These metrics describe policy checks, external calls, remedies, and runtime failures inside Archestra. They use the same endpoint as hook metrics. Durations are in seconds. Counters and histograms are cumulative for each process; scrapes do not reset them.

| Metric | Type | Labels | Measures |
| --- | --- | --- | --- |
| <span id="appa_policy_decisions_total"></span>`appa_policy_decisions_total` | Counter | `outcome` (`allowed`, `denied`) | Completed tool-proposal policy decisions |
| <span id="appa_policy_check_duration_seconds"></span>`appa_policy_check_duration_seconds` | Histogram | `outcome` (`allowed`, `denied`, `error`) | Policy-check duration, including failed evaluations |
| <span id="appa_external_calls_total"></span>`appa_external_calls_total` | Counter | `role`, `outcome` (`answered`, `no_answer`) | External helper, annotator, or authority calls |
| <span id="appa_external_call_duration_seconds"></span>`appa_external_call_duration_seconds` | Histogram | `role`, `outcome` (`answered`, `no_answer`) | External-call duration |
| <span id="appa_remedy_attempts_total"></span>`appa_remedy_attempts_total` | Counter | `outcome` (`executed`, `declined`, `no_answer`, `refused`) | Remedy attempts |
| <span id="appa_remedy_duration_seconds"></span>`appa_remedy_duration_seconds` | Histogram | `outcome` (`executed`, `declined`, `no_answer`, `refused`) | Remedy duration |
| <span id="appa_runtime_failures_total"></span>`appa_runtime_failures_total` | Counter | `component`, `error_type` | Runtime failures classified by bounded component and error type |

A host hook acknowledgment is distinct from a tool-proposal policy decision. One hook dispatch can include multiple engine operations. Compare these counters by their documented operation rather than treating them as interchangeable request counts.

Only operational labels are exported. Organization, user, session, tool, policy, and request content are excluded. If engine collection fails, Archestra continues serving its other process metrics.

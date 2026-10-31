---
title: Observability
description: Connect your monitoring stack and install dashboards
order: 8
lastUpdated: 2026-10-30
---

Monitor your instance in your existing stack. For individual requests and conversations inside Archestra, use [Logs](/docs/admin/logs).

| Need | Set up |
| --- | --- |
| Request rates, latency, costs, guardrails, and infrastructure health | [Prometheus metrics](/docs/admin/observability/metrics). |
| Follow a model request or tool call across services | [OpenTelemetry traces and backend logs](/docs/admin/observability/tracing). |
| Administrative changes sent to a SIEM | [Audit log export](/docs/admin/observability/audit-logs). |
| Frontend sessions and page timings | [Real User Monitoring](#real-user-monitoring-rum). |

<span id="distributed-tracing-and-logs"></span>

<span id="installing-dashboards"></span>

<span id="real-user-monitoring"></span>

<span id="scraping-prometheus-metrics"></span>

## Collect Guardrails Metrics

Include [OpenAPPA collection setup](/docs/admin/observability/metrics/openappa#collection-setup) when connecting your monitoring stack. Embedded hooks are collected with the normal Archestra Prometheus scrape. If you operate a standalone OpenAPPA daemon, also enable an OTLP **metrics** branch in your collector and configure the daemon's exporter; the receiver can be shared with traces and logs.

## Grafana Dashboards

<span id="grafana-dashboards"></span>

Archestra publishes eight prebuilt Grafana dashboards. Core operational dashboards require Prometheus only.

| Dashboard | Key Visualizations | Data Sources |
| --- | --- | --- |
| LLM Proxy (`archestra-genai-observability`) | Proxy and model router outcomes, upstream and streaming latency, token rates, and prompt-cache usage | Prometheus (optional Tempo for exemplars) |
| Costs & Limits | Metered and subscription spend, prompt-cache savings, limit rule evaluations, storage errors, and recent exhausted allowances | Prometheus |
| Agent Runtime | Fleet-wide run lifecycle, provisioning latency, steering, completion delivery, boundary refusals, task health, and optional Kubernetes pod resources | Prometheus (optional Kubernetes Prometheus with cAdvisor and `kube-state-metrics`) |
| Guardrails / OpenAPPA | Embedded OpenAPPA hook dispatches and latency by hook and decision, runtime boundary refusals and optional standalone daemon metrics | Prometheus (optional OTLP metrics pipeline for standalone `appa_*` series) |
| MCP Monitoring (`archestra-mcp-monitoring`) | MCP Gateway tool call rates, error counts, execution duration, payload sizes, and self-hosted server deployment status | Prometheus (optional Tempo for exemplars) |
| Knowledge Base Operations (`archestra-rag-knowledge-base`) | Connector syncs, document ingestion, OCR, embedding batches, search latency, quote verification, and permission sync gaps | Prometheus |
| Platform Health (`archestra-application-metrics`) | HTTP throughput, Node.js memory and event loop lag, database connection pool, background task queue, and PostgreSQL health | Prometheus |
| Session Investigation (`archestra-agent-sessions`) | Per-session timeline, LLM calls, MCP tool invocations, trace waterfalls, and correlated logs across [Agent Runtime](/docs/agents/runtime) and external client sessions | Tempo; optional Loki |

Import or update the dashboards with a Grafana service account that can write dashboards and folders and read/query the selected data sources. Basic authentication also works with `GRAFANA_USER` and `GRAFANA_PASS`:

```bash
GRAFANA_URL=https://grafana.example.com GRAFANA_TOKEN=glsa_xxx \
  bash <(curl -sL https://raw.githubusercontent.com/archestra-ai/archestra/main/platform/dev/grafana/install-dashboards.sh)
```

<span id="exemplars"></span>

The installer is idempotent and upserts every dashboard into the `Archestra` folder (`archestra-dashboards`) using stable UIDs—including `archestra-genai-observability` for **LLM Proxy**, `archestra-application-metrics` for **Platform Health**, and `archestra-agent-sessions` for **Session Investigation**—so existing dashboard links stay intact. For external databases on **Platform Health**, pass `--postgres-provider otel` (or `cloudsql`, `azure`; defaults to `helm` for the Bitnami `postgres_exporter` sidecar). To link upstream latency spikes on **LLM Proxy** and **MCP Monitoring** to Tempo traces, enable Prometheus exemplars with `--enable-feature=exemplar-storage`.

To preselect data sources during import, pass their Grafana UIDs:

```bash
GRAFANA_URL=https://grafana.example.com GRAFANA_TOKEN=glsa_xxx \
  ./install-dashboards.sh --metrics-datasource prometheus \
  --traces-datasource tempo --logs-datasource loki
```

`--kubernetes-datasource` and `--openappa-datasource` select separate Prometheus sources for optional rows; both default to the metrics UID when supplied. You can also select sources from each dashboard's filters.

### Data Sources and Metric Semantics

Model and agent filters on **LLM Proxy** affect upstream usage; logical request outcomes have their own filters. **Costs & Limits** has separate cost and limit filters, with **Cost breakdown** selecting the grouping dimension. **Scrape job** selects a Prometheus target group; leave **All** selected unless you need one group of processes.

Each dashboard scopes its optional data sources and aggregates multi-replica metrics according to how Archestra exports them:

- **Session timelines vs. runtime fleet health:** **Session Investigation** inspects individual conversations—working for both [Agent Runtime](/docs/agents/runtime) runs and external client sessions that propagate session context via [`X-Archestra-Session-Id`](/docs/llm-proxy#custom-headers) or [`X-Appa-Session-ID`](/docs/agents/guardrails/clients#session-headers)—and adds trace waterfalls and span logs when Tempo and Loki are configured. **Agent Runtime** tracks fleet, workload, and pod health rather than a per-session event timeline.
- **Optional Kubernetes row on Agent Runtime:** The Kubernetes resource panels require **cAdvisor** and **kube-state-metrics**. Scrape kubelet `/metrics/cadvisor` and the kube-state-metrics endpoint into that source, preserving `cluster`, `namespace`, `pod`, and `container` labels. Verify `kube_pod_status_phase` and `container_memory_working_set_bytes` return runtime pod series before expanding the row. The panels use an independent Kubernetes Prometheus data source variable and **Cluster**, **Namespace**, and **Runtime pod name regex** filters so you can target your runtime pods without editing queries.
- **Historical limit detail vs. live headroom:** On **Costs & Limits**, [`llm_limit_last_exceeded_timestamp_seconds`](/docs/admin/observability/metrics/limits#llm_limit_last_exceeded_timestamp_seconds), [`llm_limit_last_exceeded_threshold`](/docs/admin/observability/metrics/limits#llm_limit_last_exceeded_threshold), and [`llm_limit_last_exceeded_usage`](/docs/admin/observability/metrics/limits#llm_limit_last_exceeded_usage) report process-local observations from the last 24 hours at the time a check was exhausted, not live budget headroom.
- **Replica-wide health gauges:** Fleet health reported identically by every replica (such as [`agent_runtime_health_tasks`](/docs/admin/observability/metrics/agent-runtime#agent_runtime_health_tasks), [`agent_runtime_health_age_seconds`](/docs/admin/observability/metrics/agent-runtime#agent_runtime_health_age_seconds)) aggregate with `max` across replicas, never `sum`.
- **Guardrails and OpenAPPA metrics:** Embedded hook metrics ([`openappa_hook_dispatches_total`](/docs/admin/observability/metrics/openappa#openappa_hook_dispatches_total) and [`openappa_hook_dispatch_duration_seconds`](/docs/admin/observability/metrics/openappa#openappa_hook_dispatch_duration_seconds)) come from Archestra's `/metrics` scrape. Standalone OpenAPPA daemon panels use the collector's OTLP metrics branch; see [collection setup](/docs/admin/observability/metrics/openappa#collection-setup).

## Real User Monitoring (RUM)

Frontend monitoring requires an [Enterprise license](/docs/get-started/pricing-model).

1. Set the collector endpoint in your environment:
   ```bash
   ARCHESTRA_RUM_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
   ```
2. If your collector requires authentication, set [`ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_BEARER`](/docs/admin/deployment/configuration#ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_BEARER), or both [`ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_USERNAME`](/docs/admin/deployment/configuration#ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_USERNAME) and [`ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_PASSWORD`](/docs/admin/deployment/configuration#ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_PASSWORD).
3. Restart the backend to initialize the telemetry pipeline.

Browser events route securely through the Archestra backend and arrive at your collector under the service name `Archestra Web`. Events never contain prompt text, messages, email addresses, or secrets.

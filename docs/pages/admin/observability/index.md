---
title: Observability
description: Connect your monitoring stack and install dashboards
order: 8
lastUpdated: 2026-10-22
---

Monitor your instance in your existing stack. For individual requests and conversations inside Archestra, use [Logs](/docs/admin/logs).

| Need | Set up |
| --- | --- |
| Request rates, latency, costs, and infrastructure health | [Prometheus metrics](/docs/admin/observability/metrics). |
| Follow a model request or tool call across services | [OpenTelemetry traces and backend logs](/docs/admin/observability/tracing). |
| Frontend sessions and page timings | [Real User Monitoring](#real-user-monitoring-rum). |

<span id="distributed-tracing-and-logs"></span>

<span id="installing-dashboards"></span>

<span id="real-user-monitoring"></span>

<span id="scraping-prometheus-metrics"></span>

## Grafana Dashboards

<span id="grafana-dashboards"></span>

Archestra publishes five prebuilt Grafana dashboards covering LLM consumption, tool executions, agent sessions, and platform health.

| Dashboard | Key Visualizations | Data Sources |
| --- | --- | --- |
| GenAI Observability | Token rates, request costs, latency, active models | Prometheus, Tempo |
| MCP Monitoring | Tool call rates, error counts, execution duration | Prometheus, Tempo |
| Agent Sessions | Individual session timeline, tool invocations, span logs | Prometheus, Tempo, Loki |
| Application Metrics | HTTP throughput, Node.js memory, event loop lag, DB pool | Prometheus |
| Knowledge Base Operations | Connector sync duration, document indexing, embeddings | Prometheus |

Import dashboards into Grafana using a service account token with editor permissions:

```bash
GRAFANA_URL=https://grafana.example.com GRAFANA_TOKEN=glsa_xxx \
  bash <(curl -sL https://raw.githubusercontent.com/archestra-ai/archestra/main/platform/dev/grafana/install-dashboards.sh)
```

<span id="exemplars"></span>

For external databases, specify the PostgreSQL exporter provider with `--postgres-provider otel` (or `cloudsql`, `azure`). To link metric spikes directly to Tempo traces, enable Prometheus exemplars with `--enable-feature=exemplar-storage`.

## Real User Monitoring (RUM)

Frontend monitoring requires an [Enterprise license](/docs/get-started/pricing-model).

1. Set the collector endpoint in your environment:
   ```bash
   ARCHESTRA_RUM_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
   ```
2. If your collector requires authentication, set [`ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_BEARER`](/docs/admin/deployment/configuration#ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_BEARER), or both [`ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_USERNAME`](/docs/admin/deployment/configuration#ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_USERNAME) and [`ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_PASSWORD`](/docs/admin/deployment/configuration#ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_PASSWORD).
3. Restart the backend to initialize the telemetry pipeline.

Browser events route securely through the Archestra backend and arrive at your collector under the service name `Archestra Web`. Events never contain prompt text, messages, email addresses, or secrets.

---
title: Grafana Dashboards
description: Install Archestra's prebuilt Grafana dashboards for LLM usage, MCP tools, agent sessions, and platform health
order: 4
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra publishes five Grafana dashboards for its [metrics](/docs/admin/observability/metrics), [traces, and logs](/docs/admin/observability/tracing).

| Dashboard | Shows | Data Sources |
| --- | --- | --- |
| [Archestra GenAI Observability](https://github.com/archestra-ai/archestra/blob/main/platform/dev/grafana/dashboards/genai-observability.json) | LLM requests, tokens, cost, latency, external agent runs, and traces | Prometheus, Tempo |
| [Archestra MCP Monitoring](https://github.com/archestra-ai/archestra/blob/main/platform/dev/grafana/dashboards/mcp-monitoring.json) | Tool calls, error rates, duration, MCP server deployments, and traces | Prometheus, Tempo |
| [Archestra Agent Sessions](https://github.com/archestra-ai/archestra/blob/main/platform/dev/grafana/dashboards/agent-sessions.json) | Recent sessions, and one session's LLM calls, tool calls, and logs | Prometheus, Tempo, Loki |
| [Archestra Application Metrics](https://github.com/archestra-ai/archestra/blob/main/platform/dev/grafana/dashboards/application-metrics.json) | HTTP traffic, Node.js runtime, task queue, and PostgreSQL | Prometheus |
| [Archestra / Knowledge Base Operations](https://github.com/archestra-ai/archestra/blob/main/platform/dev/grafana/dashboards/rag-knowledge-base.json) | Connector syncs, the embedding pipeline, and search performance | Prometheus |

## Installing the Dashboards

Prerequisites: a Grafana [service account](https://grafana.com/docs/grafana/latest/administration/service-accounts/) token with the **Editor** role or the narrower `fixed:folders:writer` role. The Agent Sessions dashboard also needs [backend logs](/docs/admin/observability/tracing#logs) in Loki.

1. Run the install script:

   ```bash
   GRAFANA_URL=https://grafana.example.com GRAFANA_TOKEN=glsa_xxx \
     bash <(curl -sL https://raw.githubusercontent.com/archestra-ai/archestra/main/platform/dev/grafana/install-dashboards.sh)
   ```

   To use basic authentication, set `GRAFANA_USER` and `GRAFANA_PASS` in place of `GRAFANA_TOKEN`.

2. In Grafana, go to **Dashboards → Archestra**. The folder holds the five dashboards.
3. Open a dashboard and pick your Prometheus, Tempo, and Loki data sources in the selectors at the top.

Re-run the script to update the dashboards; it updates existing ones in place. If you cannot run the script, download the JSON files linked in the table and upload each one in Grafana under **Dashboards → New → Import**.

### PostgreSQL Metrics

The PostgreSQL panels on Application Metrics expect metric names from one exporter. Pass `--postgres-provider` to match yours:

| Provider | Metric Prefix | Use When |
| --- | --- | --- |
| `helm` (default) | `pg_*` | The bundled Bitnami PostgreSQL chart runs its metrics exporter |
| `otel` | `postgresql_*` | An OpenTelemetry Collector PostgreSQL receiver reads any PostgreSQL, including RDS, Cloud SQL, and Azure |
| `cloudsql` | `stackdriver_cloudsql_*` | The Stackdriver exporter reads Google Cloud SQL metrics |
| `azure` | `azure_*` | Azure Monitor metrics for Azure Database for PostgreSQL |

```bash
GRAFANA_URL=https://grafana.example.com GRAFANA_TOKEN=glsa_xxx \
  bash <(curl -sL https://raw.githubusercontent.com/archestra-ai/archestra/main/platform/dev/grafana/install-dashboards.sh) \
  --postgres-provider otel
```

## Exemplars

LLM and MCP metrics carry exemplars: the trace ID of a sample request. With exemplars on, a dot on a latency or cost panel opens its trace in Tempo. To turn on exemplars:

1. Start Prometheus with `--enable-feature=exemplar-storage`.
2. In Grafana, go to **Connections → Data sources**, open your Prometheus data source, and under **Exemplars** add a link with the label name `traceID` to your Tempo data source.

If you provision data sources as code, add this to the Prometheus data source:

```yaml
jsonData:
  exemplarTraceIdDestinations:
    - name: traceID
      datasourceUid: tempo
```

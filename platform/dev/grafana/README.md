# Grafana dashboards

`install-dashboards.sh` upserts the eight dashboards by UID into the Archestra folder. Use `--help` for data-source bindings and PostgreSQL providers. Operational dashboards use Prometheus; Session Investigation uses Tempo and optional Loki.

Run from `platform/`:

```sh
python3 dev/grafana/generate-dashboards.py
python3 dev/grafana/generate-pg-dashboard-variants.py
python3 -m unittest discover -s dev/grafana -p 'test_*.py'
```

Install `promtool` on `PATH` to run the query behavior checks; the importer tests need only Python and curl. The query cases execute the actual dashboard expressions for absent telemetry, idle counters, failures, counter resets, empty fleets, stale snapshots, replica deduplication, and latest limit observations.

Edit `generate-dashboards.py` for LLM Proxy, Costs & Limits, Agent Runtime, Guardrails & OpenAPPA, the RAG quality row, and shared navigation. Edit MCP, Platform Health, Session Investigation, and the other RAG panels in their JSON files. Both generators run in `pnpm codegen` and support Python 3.9 or newer.

The Kubernetes row requires kube-state-metrics and cAdvisor; standalone OpenAPPA requires its own OTLP metrics pipeline. Their sources and filters are independent of Archestra's metrics source. Missing exporters must not appear as healthy zero values.

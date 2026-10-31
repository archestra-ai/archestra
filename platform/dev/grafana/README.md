# Grafana dashboards

`install-dashboards.sh` upserts the eight dashboards by UID into the Archestra folder. Use `--help` for data-source bindings and PostgreSQL providers. Operational dashboards use Prometheus; Session Investigation requires Tempo and Loki.

Run from `platform/`:

```sh
python3 dev/grafana/generate-dashboards.py
python3 dev/grafana/generate-pg-dashboard-variants.py
python3 -m unittest discover -s dev/grafana -p 'test_*.py'
```

Install `promtool` on `PATH` to run the query behavior checks; the importer tests need only Python and curl. The query cases execute the actual dashboard expressions for absent telemetry, idle counters, failures, counter resets, empty fleets, stale snapshots, replica deduplication, and latest limit observations.

Edit `generate-dashboards.py` for LLM Proxy, Costs & Limits, Agent Runtime, Guardrails & OpenAPPA, the RAG quality row, and shared navigation. Edit Session Investigation in `session_dashboard.py`; edit MCP, Platform Health, and the other RAG panels in their JSON files. Both generators run in `pnpm codegen` and support Python 3.9 or newer.

Shared headers, supported filter dimensions, and MCP state presentation live in `dashboard_ux.py`. Add panel explanations to `panel-descriptions.json` or the generator; generation fails if a data panel has none. Header images from `assets/` are embedded so imports do not depend on an external image host.

The Kubernetes row requires kube-state-metrics and cAdvisor and can use an independent source. OpenAPPA hook and engine metrics use the standard Archestra metrics source. Missing exporters must not appear as healthy zero values.

Session Investigation reads cumulative `archestra.session.summary` log snapshots from the same aggregation as the application Logs page. The table selects one latest snapshot per session; never sum snapshots or compute totals from a limited trace search. A session link sets both `sessionId` and `traceId`, opening the correlated logs and waterfall side by side. Operation logs contain metadata only.

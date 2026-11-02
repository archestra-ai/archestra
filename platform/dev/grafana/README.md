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

Session Investigation reads cumulative `archestra.session.summary` log snapshots from the same aggregation as the application Logs page. The table selects one latest snapshot per session; never sum snapshots or compute totals from a limited trace search. A session link selects `sessionId`; a Loki detected-field query resolves `traceId` from the matching summary. The trace fills the page width, with session logs below it. Operation logs contain metadata only.

Loki filter variables use Grafana’s `doublequote` format. Its `json` format returns scalar strings without quotes, which makes these LogQL filters invalid. The trace lookup extracts the body’s trace ID into `session_trace_id` so it cannot collide with log metadata. Loki’s Detected field values variable query (type 2) is required; session and trace IDs remain structured metadata, never indexed stream labels.

To check Session Investigation with the actual Grafana 13.3 data transforms and
Scenes formatters, install test-only dependencies outside the workspace:

```sh
mkdir -p /tmp/grafana-session-check
pnpm --dir /tmp/grafana-session-check add --ignore-scripts @grafana/data@13.3.0 @grafana/scenes@9.2.0
GRAFANA_CHECK_NODE_MODULES=/tmp/grafana-session-check/node_modules node dev/grafana/test-session-dashboard.cjs
```

This uses synthetic snapshots to check scalar quoting, coherent session totals,
ordering and the omitted Agent type column. It does not inject logs or metrics
into any observability stack. Session and Trace ID controls are both visible;
the trace is filled from the selected session and also accepts direct entry.

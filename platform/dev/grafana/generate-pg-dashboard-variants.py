#!/usr/bin/env python3
"""
Generate PostgreSQL dashboard variants for different metric providers.

Takes the base application-metrics.json (which uses Bitnami postgres_exporter
metrics with pg_* prefix) and generates variants for:
  - otel:     OTel Collector PostgreSQL Receiver (postgresql_* prefix)
              Works with any PostgreSQL: AWS RDS, GCP Cloud SQL, Azure, self-hosted
  - cloudsql: GCP Cloud Monitoring via Stackdriver Exporter
  - azure:    Azure Monitor metrics for Azure Database for PostgreSQL

Usage:
  python3 generate-pg-dashboard-variants.py
"""

import copy
import json
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
BASE_DASHBOARD = SCRIPT_DIR / "dashboards" / "application-metrics.json"
OUTPUT_DIR = SCRIPT_DIR / "dashboards" / "pg-variants"

# ---------------------------------------------------------------------------
# Provider definitions
# ---------------------------------------------------------------------------
# Each provider defines:
#   description:  added to dashboard description
#   panels:       dict of panel_id -> transform spec
#
# All variants share the same dashboard UID and title so they overwrite
# each other on install — the customer sees one dashboard, not four.
#
# Panel transform spec:
#   title:   override panel title (optional)
#   unit:    override field unit (optional)
#   targets: list of {refId, expr, legendFormat} dicts replacing all targets
# ---------------------------------------------------------------------------

PROVIDERS = {
    "otel": {
        "description": (
            "PostgreSQL metrics from the OpenTelemetry Collector PostgreSQL Receiver. "
            "Works with any PostgreSQL instance including AWS RDS, GCP Cloud SQL, "
            "Azure Database for PostgreSQL, and self-hosted."
        ),
        "panels": {
            501: {
                "targets": [
                    {"refId": "A", "expr": "sum(postgresql_backends)", "legendFormat": ""},
                ],
            },
            502: {
                "targets": [
                    {"refId": "A", "expr": "postgresql_connection_max", "legendFormat": ""},
                ],
            },
            503: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "sum(postgresql_backends) / sum(postgresql_connection_max) * 100",
                        "legendFormat": "",
                    },
                ],
            },
            511: {
                "title": "WAL Age",
                "unit": "s",
                "targets": [
                    {"refId": "A", "expr": "postgresql_wal_age_seconds", "legendFormat": ""},
                ],
            },
            504: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "postgresql_backends",
                        "legendFormat": "{{datname}}",
                    },
                ],
            },
            505: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "postgresql_db_size_bytes",
                        "legendFormat": "{{datname}}",
                    },
                ],
            },
            506: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "rate(postgresql_commits_total[$__rate_interval])",
                        "legendFormat": "commits - {{datname}}",
                    },
                    {
                        "refId": "B",
                        "expr": "rate(postgresql_rollbacks_total[$__rate_interval])",
                        "legendFormat": "rollbacks - {{datname}}",
                    },
                ],
            },
            507: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": (
                            "sum by (datname) (rate(postgresql_blocks_read_total{source=\"heap_hit\"}[$__rate_interval])) / "
                            "(sum by (datname) (rate(postgresql_blocks_read_total{source=\"heap_hit\"}[$__rate_interval])) + "
                            "sum by (datname) (rate(postgresql_blocks_read_total{source=\"heap_read\"}[$__rate_interval])))"
                        ),
                        "legendFormat": "hit ratio - {{datname}}",
                    },
                ],
            },
            508: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": 'sum by (datname) (rate(postgresql_operations_total{operation="ins"}[$__rate_interval]))',
                        "legendFormat": "inserted - {{datname}}",
                    },
                    {
                        "refId": "B",
                        "expr": 'sum by (datname) (rate(postgresql_operations_total{operation="upd"}[$__rate_interval]))',
                        "legendFormat": "updated - {{datname}}",
                    },
                    {
                        "refId": "C",
                        "expr": 'sum by (datname) (rate(postgresql_operations_total{operation="del"}[$__rate_interval]))',
                        "legendFormat": "deleted - {{datname}}",
                    },
                    {
                        "refId": "D",
                        "expr": 'sum by (datname) (rate(postgresql_operations_total{operation="hot_upd"}[$__rate_interval]))',
                        "legendFormat": "hot updated - {{datname}}",
                    },
                ],
            },
            509: {
                "title": "Locks by Mode (N/A)",
                "targets": [
                    {
                        "refId": "A",
                        "expr": "postgresql_database_locks",
                        "legendFormat": "{{mode}} - {{datname}}",
                    },
                ],
            },
            510: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "rate(postgresql_deadlocks_total[$__rate_interval])",
                        "legendFormat": "{{datname}}",
                    },
                ],
            },
            512: {
                "title": "Temp Files Created",
                "unit": "ops",
                "targets": [
                    {
                        "refId": "A",
                        "expr": "rate(postgresql_temp_files_total[$__rate_interval])",
                        "legendFormat": "{{datname}}",
                    },
                ],
            },
        },
    },
    "cloudsql": {
        "description": (
            "PostgreSQL metrics from GCP Cloud Monitoring via the Stackdriver Exporter. "
            "For Google Cloud SQL for PostgreSQL instances."
        ),
        "panels": {
            501: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "sum(stackdriver_cloudsql_database_postgresql_num_backends)",
                        "legendFormat": "",
                    },
                ],
            },
            502: {
                "title": "Max Connections (N/A)",
                "targets": [
                    {"refId": "A", "expr": "", "legendFormat": ""},
                ],
            },
            503: {
                "title": "Connection Utilization (N/A)",
                "targets": [
                    {"refId": "A", "expr": "", "legendFormat": ""},
                ],
            },
            511: {
                "title": "WAL Write Rate",
                "unit": "Bps",
                "targets": [
                    {
                        "refId": "A",
                        "expr": "rate(stackdriver_cloudsql_database_postgresql_write_ahead_log_inserted_bytes_count[$__rate_interval])",
                        "legendFormat": "",
                    },
                ],
            },
            504: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "stackdriver_cloudsql_database_postgresql_num_backends",
                        "legendFormat": "{{database_id}}",
                    },
                ],
            },
            505: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "stackdriver_cloudsql_database_postgresql_tuple_size",
                        "legendFormat": "{{database_id}}",
                    },
                ],
            },
            506: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": 'rate(stackdriver_cloudsql_database_postgresql_transaction_count{transaction_type="commit"}[$__rate_interval])',
                        "legendFormat": "commits",
                    },
                    {
                        "refId": "B",
                        "expr": 'rate(stackdriver_cloudsql_database_postgresql_transaction_count{transaction_type="rollback"}[$__rate_interval])',
                        "legendFormat": "rollbacks",
                    },
                ],
            },
            507: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "stackdriver_cloudsql_database_postgresql_data_cache_hit_ratio",
                        "legendFormat": "hit ratio",
                    },
                ],
            },
            508: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": 'rate(stackdriver_cloudsql_database_postgresql_tuples_processed_count{operation="insert"}[$__rate_interval])',
                        "legendFormat": "inserted",
                    },
                    {
                        "refId": "B",
                        "expr": 'rate(stackdriver_cloudsql_database_postgresql_tuples_processed_count{operation="update"}[$__rate_interval])',
                        "legendFormat": "updated",
                    },
                    {
                        "refId": "C",
                        "expr": 'rate(stackdriver_cloudsql_database_postgresql_tuples_processed_count{operation="delete"}[$__rate_interval])',
                        "legendFormat": "deleted",
                    },
                    {
                        "refId": "D",
                        "expr": "rate(stackdriver_cloudsql_database_postgresql_tuples_fetched_count[$__rate_interval])",
                        "legendFormat": "fetched",
                    },
                ],
            },
            509: {
                "title": "Locks by Mode (N/A)",
                "targets": [
                    {"refId": "A", "expr": "", "legendFormat": ""},
                ],
            },
            510: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "rate(stackdriver_cloudsql_database_postgresql_deadlock_count[$__rate_interval])",
                        "legendFormat": "deadlocks",
                    },
                ],
            },
            512: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "rate(stackdriver_cloudsql_database_postgresql_temp_bytes_written_count[$__rate_interval])",
                        "legendFormat": "temp bytes",
                    },
                ],
            },
        },
    },
    "azure": {
        "description": (
            "PostgreSQL metrics from Azure Monitor for Azure Database for PostgreSQL "
            "Flexible Server. Metric names follow the azure-metrics-exporter / "
            "Grafana Alloy Azure integration naming conventions. "
            "Adjust metric names if your exporter uses a different prefix."
        ),
        "panels": {
            501: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "sum(azure_active_connections_average)",
                        "legendFormat": "",
                    },
                ],
            },
            502: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "azure_max_connections_average",
                        "legendFormat": "",
                    },
                ],
            },
            503: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "sum(azure_active_connections_average) / sum(azure_max_connections_average) * 100",
                        "legendFormat": "",
                    },
                ],
            },
            511: {
                "title": "Transaction Log Storage",
                "targets": [
                    {
                        "refId": "A",
                        "expr": "azure_txlogs_storage_used_average",
                        "legendFormat": "",
                    },
                ],
            },
            504: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "azure_active_connections_average",
                        "legendFormat": "{{resource_name}}",
                    },
                ],
            },
            505: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "azure_storage_used_average",
                        "legendFormat": "{{resource_name}}",
                    },
                ],
            },
            506: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "rate(azure_xact_commit_total[$__rate_interval])",
                        "legendFormat": "commits",
                    },
                    {
                        "refId": "B",
                        "expr": "rate(azure_xact_rollback_total[$__rate_interval])",
                        "legendFormat": "rollbacks",
                    },
                ],
            },
            507: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": (
                            "rate(azure_blks_hit_total[$__rate_interval]) / "
                            "(rate(azure_blks_hit_total[$__rate_interval]) + "
                            "rate(azure_blks_read_total[$__rate_interval]))"
                        ),
                        "legendFormat": "hit ratio",
                    },
                ],
            },
            508: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "rate(azure_tup_inserted_total[$__rate_interval])",
                        "legendFormat": "inserted",
                    },
                    {
                        "refId": "B",
                        "expr": "rate(azure_tup_updated_total[$__rate_interval])",
                        "legendFormat": "updated",
                    },
                    {
                        "refId": "C",
                        "expr": "rate(azure_tup_deleted_total[$__rate_interval])",
                        "legendFormat": "deleted",
                    },
                    {
                        "refId": "D",
                        "expr": "rate(azure_tup_returned_total[$__rate_interval])",
                        "legendFormat": "returned",
                    },
                    {
                        "refId": "E",
                        "expr": "rate(azure_tup_fetched_total[$__rate_interval])",
                        "legendFormat": "fetched",
                    },
                ],
            },
            509: {
                "title": "Locks by Mode (N/A)",
                "targets": [
                    {"refId": "A", "expr": "", "legendFormat": ""},
                ],
            },
            510: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "rate(azure_deadlocks_total[$__rate_interval])",
                        "legendFormat": "deadlocks",
                    },
                ],
            },
            512: {
                "targets": [
                    {
                        "refId": "A",
                        "expr": "rate(azure_temp_bytes_total[$__rate_interval])",
                        "legendFormat": "temp bytes",
                    },
                ],
            },
        },
    },
}


def transform_dashboard(base: dict, provider: dict) -> dict:
    """Create a provider-specific variant of the dashboard."""
    dashboard = copy.deepcopy(base)

    # Update metadata
    # Keep same UID and title so variants overwrite each other on install
    dashboard["description"] = (
        dashboard.get("description", "") + "\n\n" + provider["description"]
    ).strip()

    panel_transforms = provider["panels"]

    for panel in dashboard["panels"]:
        panel_id = panel.get("id")
        if panel_id not in panel_transforms:
            continue

        spec = panel_transforms[panel_id]

        # Override title if specified
        if "title" in spec:
            panel["title"] = spec["title"]

        # Override unit if specified
        if "unit" in spec:
            fc = panel.get("fieldConfig", {})
            defaults = fc.get("defaults", {})
            defaults["unit"] = spec["unit"]
            fc["defaults"] = defaults
            panel["fieldConfig"] = fc

        # Replace targets
        if "targets" in spec:
            base_target = panel["targets"][0] if panel.get("targets") else {}
            new_targets = []
            for t_spec in spec["targets"]:
                target = copy.deepcopy(base_target)
                target["refId"] = t_spec["refId"]
                target["expr"] = t_spec["expr"]
                target["legendFormat"] = t_spec["legendFormat"]
                # Ensure range queries for timeseries panels
                if panel.get("type") == "timeseries":
                    target["instant"] = False
                    target["range"] = True
                new_targets.append(target)
            panel["targets"] = new_targets

    return dashboard


def main():
    with open(BASE_DASHBOARD) as f:
        base = json.load(f)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    for name, provider in PROVIDERS.items():
        dashboard = transform_dashboard(base, provider)
        output_path = OUTPUT_DIR / f"application-metrics-{name}.json"
        with open(output_path, "w") as f:
            json.dump(dashboard, f, indent=2)
            f.write("\n")
        print(f"Generated {output_path}")


if __name__ == "__main__":
    main()

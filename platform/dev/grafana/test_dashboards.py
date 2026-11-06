"""Behavior checks for the dashboard importer and PromQL (requires promtool on PATH)."""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).parent


def panels(items):
    for panel in items:
        yield panel
        yield from panels(panel.get("panels", []))


def expression(board, title, variables=None):
    dashboard = json.loads((ROOT / "dashboards" / f"{board}.json").read_text())
    query = next(p for p in panels(dashboard["panels"]) if p["title"] == title)[
        "targets"
    ][0]["expr"]
    values = {
        "__rate_interval": "5m",
        "__range": "5m",
        "cost_group": "provider",
        **(variables or {}),
    }
    return re.sub(
        r"\$(?:\{([^}:]+)(?::[^}]+)?\}|([a-zA-Z_][a-zA-Z_0-9]*))",
        lambda m: values.get(m[1] or m[2], ".*"),
        query,
    )


class ImporterTest(unittest.TestCase):
    def test_upsert_preserves_identity_binds_sources_and_reports_failures(self):
        received = []
        fail = False

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

            def do_POST(self):
                payload = json.loads(
                    self.rfile.read(int(self.headers["Content-Length"]))
                )
                received.append(payload)
                self.send_response(403 if fail else 200)
                self.end_headers()
                self.wfile.write(
                    json.dumps({"version": 2, "message": "denied"}).encode()
                )

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        env = {
            **os.environ,
            "GRAFANA_URL": f"http://127.0.0.1:{server.server_port}",
            "GRAFANA_TOKEN": "synthetic-test-token",
        }
        cmd = [
            "bash",
            str(ROOT / "install-dashboards.sh"),
            "--metrics-datasource",
            "metrics-test",
            "--traces-datasource",
            "traces-test",
            "--logs-datasource",
            "logs-test",
        ]
        try:
            for _ in range(2):
                result = subprocess.run(
                    cmd, env=env, capture_output=True, text=True, check=True
                )
                self.assertNotIn("synthetic-test-token", result.stdout + result.stderr)
            self.assertEqual(len(received), 16)
            self.assertEqual(
                [p["dashboard"]["uid"] for p in received[:8]],
                [p["dashboard"]["uid"] for p in received[8:]],
            )
            self.assertEqual(len({p["dashboard"]["uid"] for p in received}), 8)
            for payload in received:
                self.assertTrue(payload["overwrite"])
                self.assertEqual(payload["folderUid"], "archestra-dashboards")
                for var in payload["dashboard"]["templating"]["list"]:
                    if var["type"] == "datasource":
                        expected = {
                            "traces_datasource": "traces-test",
                            "logs_datasource": "logs-test",
                        }.get(var["name"], "metrics-test")
                        self.assertEqual(var["current"]["value"], expected)
            fail = True
            self.assertNotEqual(
                subprocess.run(cmd, env=env, capture_output=True).returncode, 0
            )
        finally:
            server.shutdown()
            server.server_close()


@unittest.skipUnless(
    shutil.which("promtool"), "Install promtool to run PromQL behavior checks"
)
class PromQLTest(unittest.TestCase):
    def test_missing_errors_resets_replicas_and_latest_limit_observation(self):
        llm = expression("genai-observability", "Successful completed requests")
        mcp = expression("mcp-monitoring", "Tool Health Gauge")
        limit = expression("costs-and-limits", "Usage at last exceeded check: tokens")

        def check(expr, value, labels="{}"):
            return {
                "expr": expr,
                "eval_time": "5m",
                "exp_samples": (
                    [] if value is None else [{"labels": labels, "value": value}]
                ),
            }

        def series(name, values):
            return {"series": name, "values": values}

        common = 'limit_id="limit-a",entity_id="agent-a",entity_type="agent",limit_kind="tokens",behavior="block",cleanup_interval="day",source="proxy"'
        tests = [
            {
                "name": "missing exporter stays unknown",
                "input_series": [],
                "promql_expr_test": [check(llm, None), check(mcp, None)],
            },
            {
                "name": "only failures means zero success",
                "input_series": [
                    series(
                        'llm_proxy_request_duration_seconds_count{outcome="error"}',
                        "0+1x5",
                    ),
                    series('mcp_tool_calls_total{status="error"}', "0+1x5"),
                ],
                "promql_expr_test": [check(llm, 0), check(mcp, 0)],
            },
            {
                "name": "absent error series means success with real traffic",
                "input_series": [
                    series(
                        'llm_proxy_request_duration_seconds_count{outcome="success"}',
                        "0+1x5",
                    ),
                    series('mcp_tool_calls_total{status="success"}', "0+1x5"),
                ],
                "promql_expr_test": [check(llm, 100), check(mcp, 100)],
            },
            {
                "name": "counter resets stay within a real success ratio",
                "input_series": [
                    series(
                        'llm_proxy_request_duration_seconds_count{outcome="success"}',
                        "8 9 0 1 2 3",
                    ),
                    series(
                        'llm_proxy_request_duration_seconds_count{outcome="error"}',
                        "8 9 0 1 2 3",
                    ),
                ],
                "promql_expr_test": [check(llm, 50)],
            },
            {
                "name": "idle counters do not imply healthy traffic",
                "input_series": [
                    series(
                        'llm_proxy_request_duration_seconds_count{outcome="success"}',
                        "1+0x5",
                    )
                ],
                "promql_expr_test": [check(f"({llm}) != bool ({llm})", 1)],
            },
            {
                "name": "latest limit replica wins even when older usage is larger",
                "input_series": [
                    series(
                        f'llm_limit_last_exceeded_timestamp_seconds{{{common},instance="old"}}',
                        "100+0x5",
                    ),
                    series(
                        f'llm_limit_last_exceeded_timestamp_seconds{{{common},instance="new"}}',
                        "200+0x5",
                    ),
                    series(
                        f'llm_limit_last_exceeded_usage{{{common},instance="old"}}',
                        "900+0x5",
                    ),
                    series(
                        f'llm_limit_last_exceeded_usage{{{common},instance="new"}}',
                        "100+0x5",
                    ),
                ],
                "promql_expr_test": [check(limit, 100, "{" + common + "}")],
            },
        ]
        selected_tokens = expression(
            "genai-observability", "Tokens / second", {"model": "chosen"}
        )
        selected_logical = expression(
            "genai-observability", "Requests / second", {"model": "chosen"}
        )
        selected_cost = expression(
            "costs-and-limits",
            "Estimated spend by selected dimension",
            {
                "model": "chosen",
                "auth_method": "provider_key",
                "billing_mode": "metered",
            },
        )
        tests.extend(
            [
                {
                    "name": "model filters apply to token usage but not logical requests",
                    "input_series": [
                        series(
                            'llm_tokens_total{model="chosen",provider="example",type="input"}',
                            "0+60x5",
                        ),
                        series(
                            'llm_tokens_total{model="other",provider="example",type="input"}',
                            "0+600x5",
                        ),
                        series(
                            'llm_proxy_request_duration_seconds_count{outcome="success"}',
                            "0+60x5",
                        ),
                    ],
                    "promql_expr_test": [
                        check(selected_tokens, 1, '{provider="example",type="input"}'),
                        check(selected_logical, 1),
                    ],
                },
                {
                    "name": "cost filters intersect model authentication and billing dimensions",
                    "input_series": [
                        series(
                            'llm_cost_total{model="chosen",provider="example",auth_method="provider_key",billing_mode="metered"}',
                            "0+60x5",
                        ),
                        series(
                            'llm_cost_total{model="other",provider="example",auth_method="provider_key",billing_mode="metered"}',
                            "0+600x5",
                        ),
                        series(
                            'llm_cost_total{model="chosen",provider="example",auth_method="oauth_user",billing_mode="subscription"}',
                            "0+600x5",
                        ),
                    ],
                    "promql_expr_test": [
                        check(selected_cost, 300, '{provider="example"}')
                    ],
                },
            ]
        )
        snapshot_age = expression(
            "agent-runtime", "Age of last successful fleet snapshot"
        )
        working = expression("agent-runtime", "Working tasks")
        failed_hooks = expression("guardrails", "Failed dispatches in selected period")
        tests.extend(
            [
                {
                    "name": "empty collected fleet is zero",
                    "input_series": [
                        series(
                            "agent_runtime_health_collection_timestamp_seconds",
                            "100+0x5",
                        )
                    ],
                    "promql_expr_test": [check(working, 0)],
                },
                {
                    "name": "last successful snapshot remains visible after a failed scrape",
                    "input_series": [
                        series(
                            "agent_runtime_health_collection_timestamp_seconds",
                            "60 60 stale _ _ _",
                        )
                    ],
                    "promql_expr_test": [check(snapshot_age, 240)],
                },
                {
                    "name": "successful hooks imply zero observed errors",
                    "input_series": [
                        series(
                            'openappa_hook_dispatches_total{hook="tool_call",decision="allow_call"}',
                            "0+1x5",
                        )
                    ],
                    "promql_expr_test": [check(failed_hooks, 0)],
                },
            ]
        )
        phases = expression("agent-runtime", "Runtime pods by phase")
        tests.append(
            {
                "name": "same pod names across clusters remain distinct",
                "input_series": [
                    series(
                        'kube_pod_status_phase{cluster="a",namespace="demo",pod="agent-run-demo",phase="Running"}',
                        "1+0x5",
                    ),
                    series(
                        'kube_pod_status_phase{cluster="b",namespace="demo",pod="agent-run-demo",phase="Running"}',
                        "1+0x5",
                    ),
                    series(
                        'kube_pod_status_phase{cluster="b",namespace="demo",pod="agent-run-demo",phase="Running",instance="replica"}',
                        "1+0x5",
                    ),
                ],
                "promql_expr_test": [check(phases, 2, '{phase="Running"}')],
            }
        )
        runtime_dashboard = json.loads((ROOT / "dashboards" / "agent-runtime.json").read_text())
        runtime_regex = next(v["current"]["value"] for v in runtime_dashboard["templating"]["list"] if v["name"] == "runtime_pod")
        tests.append(
            {
                "name": "default runtime filter includes cold and warm pool pods",
                "input_series": [
                    series('kube_pod_status_phase{cluster="a",namespace="demo",pod="agent-run-demo",phase="Running"}', "1+0x5"),
                    series('kube_pod_status_phase{cluster="a",namespace="demo",pod="archestra-warm-demo",phase="Running"}', "1+0x5"),
                    series('kube_pod_status_phase{cluster="a",namespace="demo",pod="ordinary-pod",phase="Running"}', "1+0x5"),
                ],
                "promql_expr_test": [check(expression("agent-runtime", "Runtime pods by phase", {"runtime_pod": runtime_regex}), 2, '{phase="Running"}')],
            }
        )
        health = expression("agent-runtime", "Oldest task heartbeat")
        tests.append(
            {
                "name": "replicated health gauges are not summed",
                "input_series": [
                    series(
                        'agent_runtime_health_age_seconds{condition="heartbeat",instance="a"}',
                        "42+0x5",
                    ),
                    series(
                        'agent_runtime_health_age_seconds{condition="heartbeat",instance="b"}',
                        "42+0x5",
                    ),
                ],
                "promql_expr_test": [check(health, 42)],
            }
        )
        for case in tests:
            case["interval"] = "1m"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "queries.yml"
            path.write_text(json.dumps({"evaluation_interval": "1m", "tests": tests}))
            result = subprocess.run(
                ["promtool", "test", "rules", str(path)], capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()

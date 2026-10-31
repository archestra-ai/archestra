#!/usr/bin/env python3
"""Generate the operational dashboard pack; JSON remains directly importable."""
import json
from pathlib import Path

from dashboard_ux import refine_dashboard

ROOT = Path(__file__).parent
OUT = ROOT / "dashboards"
CATALOG = [
    ("genai-observability", "archestra-genai-observability", "LLM Proxy"),
    ("costs-and-limits", "archestra-costs-and-limits", "Costs & Limits"),
    ("agent-runtime", "archestra-agent-runtime", "Agent Runtime"),
    ("guardrails", "archestra-guardrails", "Guardrails & OpenAPPA"),
    ("mcp-monitoring", "archestra-mcp-monitoring", "MCP Monitoring"),
    ("rag-knowledge-base", "archestra-rag-knowledge-base", "Knowledge Base Operations"),
    ("application-metrics", "archestra-application-metrics", "Platform Health"),
    ("agent-sessions", "archestra-agent-sessions", "Session Investigation"),
]
M = {"type": "prometheus", "uid": "${metrics_datasource}"}
J = 'job=~"$job"'
R = "$__rate_interval"
WINDOW = "$__range"


def selector(name, labels=""):
    return f'{name}{{{J}{"," if labels else ""}{labels}}}'


def match(name, value, op="="):
    return f'{name}{op}"{value}"'


def rate(name, labels="", group=""):
    return f'sum{(" by ("+group+")") if group else ""} (rate({selector(name, labels)}[{R}]))'


def increase(name, labels="", group=""):
    return f'sum{(" by ("+group+")") if group else ""} (increase({selector(name, labels)}[{WINDOW}]))'


def quantile(name, q=0.95, labels="", group=""):
    keys = "le" + ("," + group if group else "")
    return f'histogram_quantile({q}, sum by ({keys}) (rate({selector(name+"_bucket",labels)}[{R}])))'


def datasource(name="metrics_datasource", kind="prometheus", label="Metrics"):
    return {
        "name": name,
        "label": label,
        "type": "datasource",
        "query": kind,
        "refresh": 1,
        "options": [],
        "current": {},
    }


def queryvar(name, query, label=None, ds=None):
    return {
        "name": name,
        "label": label or name,
        "type": "query",
        "datasource": ds or M,
        "query": {"query": query, "refId": name},
        "refresh": 1,
        "sort": 1,
        "includeAll": True,
        "allValue": ".*",
        "multi": True,
        "current": {"text": "All", "value": "$__all"},
        "options": [],
    }


class Board:
    def __init__(self, key, description, extra_vars=None):
        _, uid, title = next(x for x in CATALOG if x[0] == key)
        self.key = key
        self.y = 0
        self.x = 0
        self.row_height = 0
        self.panels = []
        self.data = {
            "id": None,
            "uid": uid,
            "title": "Archestra / " + title,
            "description": description,
            "tags": ["archestra", "observability"],
            "schemaVersion": 40,
            "version": 1,
            "editable": True,
            "timezone": "browser",
            "time": {"from": "now-1h", "to": "now"},
            "refresh": "30s",
            "annotations": {"list": []},
            "templating": {
                "list": [
                    datasource(),
                    queryvar(
                        "job",
                        'label_values({__name__=~"llm_tokens_total|agent_runtime_health_collection_timestamp_seconds|http_request_duration_seconds_count"}, job)',
                        "Deployment job",
                    ),
                ]
                + (extra_vars or [])
            },
            "panels": self.panels,
        }

    def flush(self):
        if self.x:
            self.y += self.row_height
            self.x = self.row_height = 0

    def row(self, title, description=""):
        self.flush()
        self.panels.append(
            {
                "id": len(self.panels) + 1,
                "type": "row",
                "title": title,
                "collapsed": False,
                "panels": [],
                "description": description,
                "gridPos": {"x": 0, "y": self.y, "w": 24, "h": 1},
            }
        )
        self.y += 1

    def note(self, text):
        self.flush()
        self.panels.append(
            {
                "id": len(self.panels) + 1,
                "type": "text",
                "title": "Read this dashboard",
                "options": {"mode": "markdown", "content": text},
                "gridPos": {"x": 0, "y": self.y, "w": 24, "h": 4},
            }
        )
        self.y += 4

    def panel(
        self,
        title,
        expr,
        unit="short",
        kind="timeseries",
        legend="auto",
        description="",
        width=12,
        ds=None,
    ):
        height = 4 if kind == "stat" else 8
        if self.x + width > 24:
            self.flush()
        target = {
            "refId": "A",
            "expr": expr,
            "legendFormat": legend,
            "instant": kind in ("stat", "table", "bargauge"),
            "range": kind not in ("stat", "table", "bargauge"),
        }
        p = {
            "id": len(self.panels) + 1,
            "title": title,
            "type": kind,
            "description": description,
            "datasource": ds or M,
            "gridPos": {"x": self.x, "y": self.y, "w": width, "h": height},
            "targets": [target],
            "fieldConfig": {
                "defaults": {
                    "unit": unit,
                    "noValue": "No samples",
                    "color": {"mode": "palette-classic"},
                    "thresholds": {
                        "mode": "absolute",
                        "steps": [{"color": "green", "value": None}],
                    },
                },
                "overrides": [],
            },
            "options": {
                "tooltip": {"mode": "multi", "sort": "desc"},
                "legend": {"displayMode": "list", "placement": "bottom", "calcs": []},
            },
        }
        if kind == "stat":
            p["options"] = {
                "reduceOptions": {
                    "calcs": ["lastNotNull"],
                    "fields": "",
                    "values": False,
                },
                "textMode": "auto",
                "colorMode": "none",
                "graphMode": "none",
            }
        if kind == "bargauge":
            p["options"] = {
                "reduceOptions": {
                    "calcs": ["lastNotNull"],
                    "fields": "",
                    "values": False,
                },
                "orientation": "horizontal",
                "displayMode": "gradient",
                "showUnfilled": False,
            }
        if kind == "table":
            target["format"] = "table"
            p["options"] = {"showHeader": True, "cellHeight": "sm"}
        self.panels.append(p)
        self.x += width
        self.row_height = max(height, self.row_height)
        if self.x == 24:
            self.flush()

    def save(self):
        decorate(self.data)
        collapse_optional_rows(self.data)
        (OUT / (self.key + ".json")).write_text(json.dumps(self.data, indent=2) + "\n")


def collapse_optional_rows(d):
    panels = []
    active = None
    for panel in d["panels"]:
        if panel["type"] == "row":
            active = None
            if "(optional" in panel.get("title", "") or panel.get("id") == 500:
                panel["collapsed"] = True
                panel.setdefault("panels", [])
                active = panel
            panels.append(panel)
        elif active is not None:
            active["panels"].append(panel)
        else:
            panels.append(panel)
    d["panels"] = panels


def decorate(d):
    refine_dashboard(d)
    for variable in d.get("templating", {}).get("list", []):
        if variable.get("type") == "datasource":
            variable["current"] = {}
            variable["options"] = []
            variable.pop("regex", None)
    d["links"] = [
        {
            "title": title,
            "type": "link",
            "url": "/d/" + uid,
            "includeVars": uid != "archestra-agent-sessions"
            and d["uid"] != "archestra-agent-sessions",
            "keepTime": True,
            "targetBlank": False,
        }
        for _, uid, title in CATALOG
        if uid != d["uid"]
    ]
    d["links"].append(
        {
            "title": "Metrics reference",
            "type": "link",
            "url": "https://archestra.ai/docs/admin/observability/metrics",
            "targetBlank": True,
        }
    )


def llm():
    b = Board(
        "genai-observability",
        "Logical proxy outcomes and client-visible latency; upstream usage is a separate observation.",
    )
    b.note(
        "Choose the deployment job. **No samples** can mean no traffic, unavailable telemetry, or a disabled feature; it is not a healthy zero. Logical request outcomes include preflight and full streaming. Provider attribution can remain `router` when admission fails before a provider is selected. Model/agent breakdowns below apply only to upstream metrics."
    )
    b.row("Logical proxy requests")
    n = "llm_proxy_request_duration_seconds_count"
    b.panel("Requests / second", rate(n), "reqps", "stat", width=6)
    b.panel(
        "Successful completed requests",
        f'100 * ({rate(n,match("outcome","success"))} or ({rate(n)} * 0)) / {rate(n)}',
        "percent",
        "stat",
        description="Success is outcome=success. Incomplete, denied, cancelled and operational failures remain separate outcomes. No traffic has no percentage.",
        width=6,
    )
    b.panel(
        "P95 full request duration",
        quantile("llm_proxy_request_duration_seconds"),
        "s",
        "stat",
        width=6,
    )
    b.panel("Requests in selected period", increase(n), "short", "stat", width=6)
    b.panel(
        "Outcomes / second", rate(n, group="outcome"), "reqps", legend="{{outcome}}"
    )
    b.panel(
        "Operational errors and throttles",
        rate(
            n, 'outcome=~"error|throttled|timeout|overloaded"', "error_origin,outcome"
        ),
        "reqps",
        legend="{{error_origin}} / {{outcome}}",
    )
    b.panel(
        "Denials, cancellations and incomplete responses",
        rate(n, 'outcome=~"denied|cancelled|incomplete"', "outcome"),
        "reqps",
        legend="{{outcome}}",
    )
    b.panel(
        "Full request latency by provider (P95)",
        quantile("llm_proxy_request_duration_seconds", group="provider"),
        "s",
        legend="{{provider}}",
    )
    b.row("Upstream inference and streaming")
    b.panel(
        "Upstream call duration by provider (P95)",
        quantile("llm_request_duration_seconds", group="provider"),
        "s",
        legend="{{provider}}",
        description="Existing upstream duration metric; excludes preflight and is not the logical-request denominator.",
    )
    b.panel(
        "Client first-byte latency (P95)",
        quantile("llm_time_to_first_byte_seconds", group="provider"),
        "s",
        legend="{{provider}}",
        description="Request receipt to first client byte, including preflight.",
    )
    b.panel(
        "First upstream chunk (P95)",
        quantile("llm_time_to_first_token_seconds", group="provider"),
        "s",
        legend="{{provider}}",
    )
    b.panel(
        "Generation throughput (P50)",
        quantile("llm_tokens_per_second", 0.5, group="provider"),
        "short",
        legend="{{provider}}",
        description="Output tokens per second; sample distribution, not request volume.",
    )
    b.panel(
        "Tokens / second",
        rate("llm_tokens_total", group="provider,type"),
        "short",
        legend="{{provider}} / {{type}}",
    )
    b.panel(
        "Cached tokens / second",
        rate("llm_cache_tokens_total", group="cache_type"),
        "short",
        legend="{{cache_type}}",
    )
    b.panel(
        "Upstream calls by model",
        rate("llm_request_duration_seconds_count", group="model"),
        "reqps",
        legend="{{model}}",
    )
    b.panel(
        "Upstream calls by agent",
        f'topk(10, {rate("llm_request_duration_seconds_count",group="agent_name")})',
        "reqps",
        legend="{{agent_name}}",
    )
    b.save()


def costs():
    b = Board(
        "costs-and-limits",
        "Estimated inference spend, cache use, and observed limit enforcement.",
    )
    b.note(
        "Spend is an estimate based on configured list prices, not an invoice. Metered and subscription-covered estimates are shown separately. Cache read savings are gross, not net of cache-write surcharges. Limits count **rule evaluations**; one request can evaluate several rules. Last-exceeded values describe a past check, not current budget remaining."
    )
    b.row("Estimated spend")
    b.panel(
        "Metered estimate in selected period",
        increase("llm_cost_total", 'billing_mode="metered"'),
        "currencyUSD",
        "stat",
        width=8,
    )
    b.panel(
        "Subscription-covered equivalent",
        increase("llm_cost_total", 'billing_mode="subscription"'),
        "currencyUSD",
        "stat",
        description="List-price equivalent; not an additional token bill.",
        width=8,
    )
    b.panel(
        "Gross cache-read savings",
        increase("llm_cache_savings_total"),
        "currencyUSD",
        "stat",
        width=8,
    )
    b.panel(
        "Estimated spend / hour",
        rate("llm_cost_total", 'billing_mode="metered"', "provider") + " * 3600",
        "currencyUSD",
        legend="{{provider}}",
        description="Rolling estimated USD per hour, not spend already incurred in this hour.",
    )
    b.panel(
        "Estimated spend by model",
        increase("llm_cost_total", 'billing_mode="metered"', "model"),
        "currencyUSD",
        kind="bargauge",
        legend="{{model}}",
    )
    b.panel(
        "Estimated spend by agent",
        f'topk(10, {increase("llm_cost_total",match("billing_mode","metered"),"agent_name")})',
        "currencyUSD",
        kind="bargauge",
        legend="{{agent_name}}",
    )
    b.panel(
        "Cache tokens in selected period",
        increase("llm_cache_tokens_total", group="cache_type"),
        "short",
        kind="bargauge",
        legend="{{cache_type}}",
    )
    b.panel(
        "Estimated spend by selected dimension",
        increase("llm_cost_total", group="${cost_group:raw}"),
        "currencyUSD",
        kind="bargauge",
        width=24,
        description="Estimated list-price inference cost in the selected period, grouped by Cost breakdown after applying the cost filters. Subscription usage is a price equivalent, not an extra token bill.",
    )
    b.row("Limit enforcement")
    b.panel(
        "Rule evaluations / second",
        rate("llm_limit_checks_total", group="behavior,outcome"),
        "ops",
        legend="{{behavior}} / {{outcome}}",
    )
    b.panel(
        "Hard rule refusals / second",
        rate(
            "llm_limit_checks_total",
            'behavior="hard",outcome="blocked"',
            "entity_type,limit_kind",
        ),
        "ops",
        legend="{{entity_type}} / {{limit_kind}}",
    )
    b.panel(
        "Soft exceeded evaluations / second",
        rate(
            "llm_limit_checks_total",
            'behavior="soft",outcome="exceeded"',
            "entity_type,limit_kind",
        ),
        "ops",
        legend="{{entity_type}} / {{limit_kind}}",
    )
    b.panel(
        "Limit storage failures / second",
        rate("llm_limit_storage_errors_total", group="operation"),
        "ops",
        legend="{{operation}}",
    )
    b.row("Last known exhausted checks")
    keys = "limit_id,entity_id,entity_type,limit_kind,behavior,cleanup_interval,source"
    b.panel(
        "Last exceeded check time",
        f'1000 * max by ({keys}) ({selector("llm_limit_last_exceeded_timestamp_seconds")})',
        "dateTimeAsIso",
        kind="table",
        width=24,
        description="Newest observation per rule/target across replicas. Retained for 24 hours in each process; absent is not proof of budget headroom.",
    )
    for k, u in [
        ("token_cost", "currencyUSD"),
        ("tokens", "short"),
        ("requests", "short"),
    ]:
        b.panel(
            "Usage at last exceeded check: " + k,
            f'max by ({keys}) ({selector("llm_limit_last_exceeded_usage",match("limit_kind",k))} and topk by ({keys}) (1, {selector("llm_limit_last_exceeded_timestamp_seconds",match("limit_kind",k))}))',
            u,
            kind="table",
            width=12,
        )
        b.panel(
            "Threshold at last exceeded check: " + k,
            f'max by ({keys}) ({selector("llm_limit_last_exceeded_threshold",match("limit_kind",k))} and topk by ({keys}) (1, {selector("llm_limit_last_exceeded_timestamp_seconds",match("limit_kind",k))}))',
            u,
            kind="table",
            width=12,
            description="Historical observation. Compare only matching rule, target and check time; replicas can hold different observations.",
        )
    b.save()


def runtime():
    kds = {"type": "prometheus", "uid": "${kubernetes_datasource}"}
    extra = [
        datasource("kubernetes_datasource", label="Kubernetes metrics"),
        queryvar("cluster", "label_values(kube_pod_info, cluster)", "Cluster", kds),
        queryvar(
            "namespace",
            'label_values(kube_pod_info{cluster=~"$cluster"}, namespace)',
            "Namespace",
            kds,
        ),
        {
            "name": "runtime_pod",
            "label": "Runtime pod name regex",
            "type": "textbox",
            "query": "agent-run-.*",
            "current": {"text": "agent-run-.*", "value": "agent-run-.*"},
            "options": [],
        },
    ]
    b = Board(
        "agent-runtime",
        "Fleet work health and runtime provisioning; individual session history is in Session Investigation.",
        extra,
    )
    b.note(
        "Fleet lifecycle counters are global to the selected deployment job. Health conditions **overlap** and are database snapshots: deduplicate replicas with max before summing configured agents. Fresh heartbeats show orchestration liveness, not proof of model progress. Kubernetes panels use their own data source and require kube-state-metrics/cAdvisor; missing collectors show No samples. Change the pod regex to include custom workloads or warm pools."
    )
    b.row("Task health")
    for condition, title in [
        ("working", "Working tasks"),
        ("submitted", "Submitted tasks"),
        ("input_required", "Waiting for input"),
        ("auth_required", "Waiting for authentication"),
        ("completion_pending", "Completions pending delivery"),
        ("failed_recent", "Failures in the last 15 minutes"),
    ]:
        b.panel(
            title,
            f'sum(max by (job,agent_id,backend) ({selector("agent_runtime_health_tasks",match("condition",condition))})) or (0 * max({selector("agent_runtime_health_collection_timestamp_seconds")}))',
            "short",
            "stat",
            width=8,
        )
    b.panel(
        "Age of last successful fleet snapshot",
        f'time() - max(max_over_time({selector("agent_runtime_health_collection_timestamp_seconds")}[{WINDOW}]))',
        "s",
        "stat",
        width=8,
    )
    b.panel(
        "Oldest task heartbeat",
        f'max({selector("agent_runtime_health_age_seconds",match("condition","heartbeat"))})',
        "s",
        "stat",
        width=8,
    )
    b.panel(
        "Oldest undelivered completion",
        f'max({selector("agent_runtime_health_age_seconds",match("condition","completion_pending"))})',
        "s",
        "stat",
        width=8,
    )
    b.panel(
        "Attention by agent and backend",
        f'max by (job,agent_id,backend,condition) ({selector("agent_runtime_health_tasks",match("condition","working","!="))}) > 0',
        "short",
        "table",
        width=24,
    )
    b.row("Lifecycle and delivery")
    b.panel(
        "Runs reaching running / second",
        rate("agent_runtime_runs_started_total"),
        "ops",
    )
    b.panel(
        "Terminal outcomes / second",
        rate("agent_runtime_runs_terminated_total", group="outcome"),
        "ops",
        legend="{{outcome}}",
        description="Includes provisioning failures; do not divide by successful starts to manufacture a failure percentage.",
    )
    b.panel(
        "Successful provisioning duration (P95)",
        quantile("agent_runtime_provision_duration_seconds"),
        "s",
    )
    b.panel(
        "Completion delivery outcomes",
        rate("agent_runtime_completion_deliveries_total", group="interface,outcome"),
        "ops",
        legend="{{interface}} / {{outcome}}",
    )
    b.panel(
        "Runtime boundary refusals",
        rate("agent_runtime_crossing_refusals_total", group="reason"),
        "ops",
        legend="{{reason}}",
    )
    b.panel(
        "Steering messages / second",
        rate("agent_runtime_steers_total", group="steer_mode"),
        "ops",
        legend="{{steer_mode}}",
    )
    b.panel(
        "Pending export outcomes",
        rate("agent_runtime_pending_exports_total", group="outcome"),
        "ops",
        legend="{{outcome}}",
    )
    b.panel(
        "Sandbox command outcomes",
        rate("sandbox_commands_total", group="status"),
        "ops",
        legend="{{status}}",
    )
    b.panel(
        "Sandbox engine failures",
        rate("sandbox_runtime_errors_total", group="code"),
        "ops",
        legend="{{code}}",
    )
    b.panel(
        "Sandbox runtime state by replica",
        f'max by(job,instance,pod,status) ({selector("sandbox_runtime_status")})',
        "short",
        "table",
    )
    b.row("Kubernetes workload resources (optional)")
    scope = 'cluster=~"$cluster",namespace=~"$namespace",pod=~"$runtime_pod"'
    for expr, title, unit in [
        (
            f"sum by(phase) (max by(cluster,namespace,pod,phase) (kube_pod_status_phase{{{scope}}}))",
            "Runtime pods by phase",
            "short",
        ),
        (
            f'sum(max by(cluster,namespace,pod) (kube_pod_status_ready{{{scope},condition="true"}}))',
            "Ready runtime pods",
            "short",
        ),
        (
            f'sum by(cluster,namespace,pod) (max by(cluster,namespace,pod,container) (rate(container_cpu_usage_seconds_total{{{scope},container!="",container!="POD"}}[{R}])))',
            "CPU cores used by pod",
            "cores",
        ),
        (
            f'sum by(cluster,namespace,pod) (max by(cluster,namespace,pod,container) (container_memory_working_set_bytes{{{scope},container!="",container!="POD"}}))',
            "Memory working set by pod",
            "bytes",
        ),
        (
            f"sum by(cluster,namespace,pod) (max by(cluster,namespace,pod,container) (increase(kube_pod_container_status_restarts_total{{{scope}}}[{WINDOW}])))",
            "Container restarts in selected period",
            "short",
        ),
        (
            f'max by(cluster,namespace,pod,container,reason) (kube_pod_container_status_last_terminated_reason{{{scope},reason="OOMKilled"}})',
            "Last termination was OOMKilled",
            "short",
        ),
        (
            'sum(max by(cluster,node) (kube_node_status_allocatable{cluster=~"$cluster",resource="cpu",unit="core"}))',
            "Cluster allocatable CPU cores",
            "cores",
        ),
        (
            'sum(max by(cluster,node) (kube_node_status_allocatable{cluster=~"$cluster",resource="memory",unit="byte"}))',
            "Cluster allocatable memory",
            "bytes",
        ),
    ]:
        b.panel(
            title,
            expr,
            unit,
            legend=(
                "{{phase}}"
                if title == "Runtime pods by phase"
                else (
                    "{{cluster}} / {{namespace}} / {{pod}} / {{container}}"
                    if title == "Last termination was OOMKilled"
                    else (
                        "{{cluster}} / {{namespace}} / {{pod}}"
                        if "by pod" in title or "restarts" in title
                        else "auto"
                    )
                )
            ),
            kind=(
                "table"
                if title
                in (
                    "Container restarts in selected period",
                    "Last termination was OOMKilled",
                )
                else "timeseries"
            ),
            ds=kds,
            description="Requires Kubernetes collectors. Cluster capacity is shared with workloads outside the selected namespace.",
        )
    b.save()


def guardrails():
    ods = {"type": "prometheus", "uid": "${openappa_datasource}"}
    b = Board(
        "guardrails",
        "Embedded hook decisions and optional standalone OpenAPPA engine telemetry.",
        [
            datasource("openappa_datasource", label="Standalone OpenAPPA metrics"),
            queryvar(
                "openappa_job",
                "label_values(appa_policy_decisions_total, job)",
                "Standalone job",
                ods,
            ),
        ],
    )
    b.note(
        "Embedded counters measure one logical host hook dispatch, including policy-move retries, policy resolution inside dispatch, storage and consult waits. Decisions such as ack/context are lifecycle acknowledgments, not policy allows. Errors are distinct from structured denials/refusals. No tool arguments, names, session IDs or raw errors are metric labels. Standalone APPA below uses a separate OTLP metrics pipeline; those series do not come from Archestra’s scrape endpoint."
    )
    b.row("Embedded OpenAPPA hooks")
    b.panel(
        "Dispatches in selected period",
        increase("openappa_hook_dispatches_total"),
        "short",
        "stat",
        width=8,
    )
    b.panel(
        "Failed dispatches in selected period",
        increase("openappa_hook_dispatches_total", 'decision="error"')
        + " or (0 * "
        + increase("openappa_hook_dispatches_total")
        + ")",
        "short",
        "stat",
        width=8,
    )
    b.panel(
        "P95 tool-call hook duration",
        quantile("openappa_hook_dispatch_duration_seconds", labels='hook="tool_call"'),
        "s",
        "stat",
        width=8,
    )
    b.panel(
        "Decisions / second",
        rate("openappa_hook_dispatches_total", group="hook,decision"),
        "ops",
        legend="{{hook}} / {{decision}}",
    )
    b.panel(
        "Duration by hook (P95)",
        quantile("openappa_hook_dispatch_duration_seconds", group="hook"),
        "s",
        legend="{{hook}}",
    )
    b.panel(
        "Structured denials and refusals",
        rate(
            "openappa_hook_dispatches_total",
            'decision=~"deny_call|block|refuse"',
            "hook,decision",
        ),
        "ops",
        legend="{{hook}} / {{decision}}",
    )
    b.panel(
        "Runtime boundary refusals",
        rate("agent_runtime_crossing_refusals_total", group="reason"),
        "ops",
        legend="{{reason}}",
    )
    b.row("Standalone OpenAPPA (optional OTLP metrics)")
    sj = 'job=~"$openappa_job"'
    for expr, title, unit, legend in [
        (
            f"sum by(outcome) (rate(appa_policy_decisions_total{{{sj}}}[{R}]))",
            "Tool proposal decisions",
            "ops",
            "{{outcome}}",
        ),
        (
            f"histogram_quantile(0.95, sum by(le,outcome) (rate(appa_policy_check_duration_seconds_bucket{{{sj}}}[{R}])))",
            "Policy check duration (P95)",
            "s",
            "{{outcome}}",
        ),
        (
            f"sum by(role,outcome) (rate(appa_external_calls_total{{{sj}}}[{R}]))",
            "External consult outcomes",
            "ops",
            "{{role}} / {{outcome}}",
        ),
        (
            f"sum by(outcome) (rate(appa_remedy_attempts_total{{{sj}}}[{R}]))",
            "Remedy attempts",
            "ops",
            "{{outcome}}",
        ),
        (
            f"sum by(component,error_type) (rate(appa_runtime_failures_total{{{sj}}}[{R}]))",
            "Runtime failures by component",
            "ops",
            "{{component}} / {{error_type}}",
        ),
        (
            f"max by(job,instance) (appa_runtime_uptime_seconds{{{sj}}})",
            "Standalone runtime uptime",
            "s",
            "{{job}} / {{instance}}",
        ),
    ]:
        b.panel(title, expr, unit, legend=legend, ds=ods)
    b.save()


def refresh_navigation():
    for key, uid, title in CATALOG:
        p = OUT / (key + ".json")
        d = json.loads(p.read_text())
        d["title"] = "Archestra / " + title
        decorate(d)
        collapse_optional_rows(d)
        p.write_text(json.dumps(d, indent=2) + "\n")


def rag_additions():
    p = OUT / "rag-knowledge-base.json"
    d = json.loads(p.read_text())
    # A generated addition uses stable dedicated IDs and does not accumulate on rerun.
    d["panels"] = [x for x in d["panels"] if x.get("id", 0) < 700]
    b = Board(
        "rag-knowledge-base",
        "Connector ingestion, retrieval, OCR and permission synchronization.",
    )
    b.panels = d["panels"]
    b.data = d
    b.y = max(x["gridPos"]["y"] + x["gridPos"]["h"] for x in b.panels)
    b.row("Ingestion quality and access control")
    items = [
        (
            "rag_documents_without_text_total",
            "Documents without extracted text",
            "connector_type",
        ),
        ("rag_ocr_pages_total", "OCR outcomes", "connector_type,outcome"),
        (
            "rag_permission_syncs_total",
            "Permission synchronization",
            "connector_type,status",
        ),
        (
            "rag_permission_sync_dropped_principals_total",
            "Dropped permission principals",
            "connector_type,reason",
        ),
        ("rag_search_lane_timeout_total", "Search lane timeouts", "lane"),
        ("rag_quote_verification_total", "Quote verification", "result"),
    ]
    for name, title, group in items:
        b.panel(
            title,
            rate(
                name,
                labels=(
                    'connector_type=~"$connector_type"'
                    if "connector_type" in group
                    else ""
                ),
                group=group,
            ),
            "ops",
            legend=" / ".join("{{" + x + "}}" for x in group.split(",")),
        )
    for i, x in enumerate(b.panels[-7:]):
        x["id"] = 700 + i
    b.save()


if __name__ == "__main__":
    llm()
    costs()
    runtime()
    guardrails()
    refresh_navigation()
    rag_additions()

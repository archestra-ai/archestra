"""Shared presentation and filter semantics for the portable dashboard pack."""

import base64
import json
from html import escape
import re
from pathlib import Path

ROOT = Path(__file__).parent
DESCRIPTIONS = json.loads((ROOT / "panel-descriptions.json").read_text())
HEADERS = {
    "archestra-genai-observability": "Request outcomes and upstream performance. Model and agent filters apply to upstream panels.",
    "archestra-costs-and-limits": "Estimated inference spend and limit enforcement. Cost filters do not apply to limit panels.",
    "archestra-agent-runtime": "Task health, provisioning, and optional Kubernetes resources.",
    "archestra-guardrails": "Hook decisions, policy checks, external calls, and remedies.",
    "archestra-mcp-monitoring": "Tool calls, latency, and server state. Tool-call filters do not apply to server state.",
    "archestra-application-metrics": "API traffic, process health, background tasks, and database pools.",
    "archestra-rag-knowledge-base": "Document syncs, embeddings, and search. Optional diagnostics appear when those features run.",
    "archestra-agent-sessions": "Inspect inference and tool calls for a session. Trace details require Tempo; logs require Loki.",
}


def panels(items):
    for panel in items:
        yield panel
        yield from panels(panel.get("panels", []))


def query_variable(name, label, metric, description=""):
    query = f'label_values({metric}{{job=~"$job"}}, {name})'
    return {
        "name": name,
        "label": label,
        "description": description,
        "type": "query",
        "datasource": {"type": "prometheus", "uid": "${metrics_datasource}"},
        "query": {"query": query, "refId": name},
        "refresh": 1,
        "sort": 1,
        "includeAll": True,
        "allValue": ".*",
        "multi": True,
        "current": {"text": "All", "value": "$__all"},
        "options": [],
    }


def refine_dashboard(d):
    variables = d.get("templating", {}).get("list", [])
    for v in variables:
        if v["name"] == "job":
            v["label"] = "Scrape job"
            v["description"] = (
                "Prometheus target group: a set of monitored processes. Leave All to include every matching source."
            )
    if d["uid"] in ("archestra-genai-observability", "archestra-costs-and-limits"):
        add_inference_filters(d)
    elif d["uid"] == "archestra-guardrails":
        for name, label in [("hook", "Hook"), ("decision", "Decision")]:
            if not any(v["name"] == name for v in variables):
                variables.append(
                    query_variable(name, label, "openappa_hook_dispatches_total")
                )
        for p in panels(d["panels"]):
            for t in p.get("targets", []):
                if "expr" in t:
                    t["expr"] = re.sub(
                        r"(openappa_hook_dispatch[a-z_]*\{)([^}]*)(\})",
                        lambda m: m[1]
                        + m[2]
                        + ("" if "hook=~" in m[2] else ',hook=~"$hook"')
                        + (
                            ""
                            if 'decision=~"$decision"' in m[2]
                            else ',decision=~"$decision"'
                        )
                        + m[3],
                        t["expr"],
                    )
    if d["uid"] == "archestra-mcp-monitoring":
        refine_mcp(d)
    for p in panels(d["panels"]):
        if p.get("type") in ("stat", "gauge", "bargauge"):
            mappings = (
                p.setdefault("fieldConfig", {})
                .setdefault("defaults", {})
                .setdefault("mappings", [])
            )
            if not any(
                m.get("type") == "special"
                and m.get("options", {}).get("match") == "null+nan"
                for m in mappings
            ):
                mappings.append(
                    {
                        "type": "special",
                        "options": {
                            "match": "null+nan",
                            "result": {"color": "gray", "text": "No samples"},
                        },
                    }
                )
        if p.get("targets"):
            p["description"] = p.get("description") or DESCRIPTIONS.get(p["title"], "")
            if not p["description"]:
                raise ValueError("Missing panel explanation: " + p["title"])
        if p.get("title") == "Ingestion quality and access control":
            p["title"] = "OCR, permissions, and search diagnostics (optional)"
            p["description"] = (
                "Event-driven diagnostics. OCR, permission sync, and quote verification emit samples when those paths run; absent samples are not proof of a successful operation."
            )
    add_header(d)


def add_inference_filters(d):
    cost = d["uid"] == "archestra-costs-and-limits"
    variables = d["templating"]["list"]
    names = {v["name"] for v in variables}
    source = "llm_cost_total" if cost else "llm_tokens_total"
    dims = [
        ("provider", "Provider"),
        ("model", "Model"),
        ("agent_name", "Agent"),
        ("agent_type", "Agent type"),
        ("source", "Source"),
    ]
    dims += (
        [("billing_mode", "Billing mode"), ("auth_method", "Authentication")]
        if cost
        else [
            ("operation", "Operation"),
            ("stream", "Streaming"),
            ("outcome", "Outcome"),
            ("error_origin", "Error origin"),
            ("status_code", "HTTP status"),
        ]
    )
    if cost:
        dims += [("entity_type", "Limit target type"), ("limit_kind", "Limit kind")]
    for name, label in dims:
        if name in names:
            continue
        if cost and name in ("entity_type", "limit_kind"):
            metric = "llm_limit_checks_total"
            description = "Limit evaluation and historical detail panels only."
        elif cost:
            metric = source
            description = (
                "Cost samples only; limit rule panels use independent dimensions."
            )
        elif name in ("model", "agent_name", "agent_type", "source"):
            metric = source
            description = "Upstream usage only; logical outcome panels do not carry this dimension."
        else:
            metric = "llm_proxy_request_duration_seconds_count"
            description = (
                "Provider attribution for both logical outcomes and upstream usage."
                if name == "provider"
                else "Logical request outcomes only."
            )
        variable = query_variable(name, label, metric, description)
        if not cost and name == "provider":
            variable["query"][
                "query"
            ] = 'label_values({__name__=~"llm_tokens_total|llm_proxy_request_duration_seconds_count",job=~"$job"}, provider)'
        variables.append(variable)
    if cost and "cost_group" not in names:
        variables.append(
            {
                "name": "cost_group",
                "label": "Cost breakdown",
                "type": "custom",
                "query": "Provider : provider, Model : model, Agent : agent_name, Agent type : agent_type, Source : source, Billing mode : billing_mode, Authentication : auth_method",
                "current": {"text": "Provider", "value": "provider"},
                "includeAll": False,
                "multi": False,
                "options": [],
            }
        )
    for p in panels(d["panels"]):
        logical = False
        cache = False
        for t in p.get("targets", []):
            if "expr" not in t:
                continue

            def scope(m):
                nonlocal logical, cache
                metric, labels = m[1], m[2]
                if (
                    cost
                    and metric == "llm_cost_total"
                    and p["title"]
                    not in (
                        "Metered estimate in selected period",
                        "Subscription-covered equivalent",
                    )
                ):
                    labels = re.sub(r',?billing_mode="metered"', "", labels)
                if metric.startswith("llm_limit_"):
                    if cost and metric != "llm_limit_storage_errors_total":
                        for key in ("entity_type", "limit_kind"):
                            value = f'{key}=~"${key}"'
                            if value not in labels:
                                labels += "," + value
                        return metric + "{" + labels + "}"
                    return m[0]
                if metric == "llm_active_users":
                    return m[0]
                if metric.startswith("llm_proxy_request_duration_seconds"):
                    logical = True
                    keys = (
                        [
                            "provider",
                            "operation",
                            "stream",
                            "outcome",
                            "error_origin",
                            "status_code",
                        ]
                        if not cost
                        else ["provider"]
                    )
                else:
                    keys = ["provider", "model", "agent_name", "agent_type", "source"]
                    if metric == "llm_cost_total" and cost:
                        keys += ["billing_mode", "auth_method"]
                    cache |= metric.startswith("llm_cache_")
                for key in keys:
                    # Dedicated hard filters and variable filters are intersections, not replacements.
                    value = f'{key}=~"${key}"'
                    if value not in labels:
                        if key == "billing_mode" and re.search(
                            r"\bbilling_mode=", labels
                        ):
                            continue
                        labels += "," + value
                return metric + "{" + labels + "}"

            t["expr"] = re.sub(r"\b(llm_[a-zA-Z0-9_]+)\{([^}]*)\}", scope, t["expr"])
        description = p.get("description") or DESCRIPTIONS.get(p["title"], "")
        extra = ""
        if logical:
            extra = " Model, agent, agent type, and source filters do not apply to these logical outcomes."
        if cache and cost:
            extra = " Billing and authentication filters do not apply to cache metrics."
        if cost and (
            "Metered estimate in selected period" == p["title"]
            or "Subscription-covered equivalent" == p["title"]
        ):
            extra = " This comparison keeps its named billing mode regardless of the Billing mode filter."
        if description and extra.strip() not in description:
            p["description"] = description + extra
        elif description:
            p["description"] = description


def refine_mcp(d):
    for panel in d["panels"]:
        if panel.get("id") in range(2, 8):
            panel["gridPos"]["x"] = ((panel["id"] - 2) % 3) * 8
            panel["gridPos"]["w"] = 8
    d["templating"]["list"] = [
        v
        for v in d["templating"]["list"]
        if v["name"] not in ("traceId", "traces_datasource")
    ]
    states = [
        ("running", "Running", "green"),
        ("pending", "Pending", "yellow"),
        ("failed", "Failed", "red"),
        ("hibernated", "Hibernated", "purple"),
        ("waking", "Waking", "blue"),
        ("succeeded", "Succeeded", "green"),
        ("not_created", "Not created", "gray"),
    ]
    for p in panels(d["panels"]):
        if p["title"] == "Deployment Status Summary":
            p["options"]["text"] = {"titleSize": 12, "valueSize": 16}
            p["targets"] = [
                {
                    "refId": chr(65 + i),
                    "expr": f'sum(max by(server_name) (mcp_server_deployment_status{{job=~"$job",state="{state}"}}))',
                    "legendFormat": title,
                    "instant": True,
                    "range": False,
                }
                for i, (state, title, color) in enumerate(states)
            ]
            p["fieldConfig"]["overrides"] = [
                {
                    "matcher": {"id": "byName", "options": title},
                    "properties": [
                        {"id": "color", "value": {"fixedColor": color, "mode": "fixed"}}
                    ],
                }
                for state, title, color in states
            ]
            p["description"] = (
                "Current self-hosted MCP server counts by state, deduplicated across scrape replicas. Hibernated servers are intentionally asleep; Waking means a server is starting again. Tool-call filters do not apply."
            )
        elif p["title"] == "MCP Server Deployments":
            p["targets"][0][
                "expr"
            ] = 'max by(server_name,state) (mcp_server_deployment_status{job=~"$job"}) == 1'
            p["fieldConfig"]["defaults"]["custom"]["cellOptions"] = {"type": "auto"}
            p["fieldConfig"]["overrides"] = [
                {
                    "matcher": {"id": "byName", "options": "State"},
                    "properties": [
                        {
                            "id": "mappings",
                            "value": [
                                {
                                    "type": "value",
                                    "options": {
                                        state: {
                                            "color": color,
                                            "index": i,
                                            "text": title,
                                        }
                                        for i, (state, title, color) in enumerate(
                                            states
                                        )
                                    },
                                }
                            ],
                        },
                        {
                            "id": "custom.cellOptions",
                            "value": {
                                "type": "color-background",
                                "mode": "basic",
                                "applyToRow": True,
                            },
                        },
                    ],
                }
            ]
            p["description"] = (
                "Current state of each self-hosted MCP server, deduplicated across replicas. Rows use the state color: pending yellow, hibernated purple, waking blue, failed red. Tool-call filters do not apply."
            )


def add_header(d):
    # Keep one compact, consistent header; logo bytes are embedded for offline imports.
    old = [
        p
        for p in d["panels"]
        if p.get("type") == "text"
        and (p.get("gridPos", {}).get("y") == 0 or p.get("id") in (90000, 90001))
    ]
    old_ids = {p["id"] for p in old}
    remaining = [p for p in d["panels"] if p["id"] not in old_ids]
    min_y = min((p["gridPos"]["y"] for p in remaining), default=2)
    delta = 2 - min_y
    for p in panels(remaining):
        p["gridPos"]["y"] += delta
    appa = d["uid"] == "archestra-guardrails"
    asset = (
        ROOT / "assets" / ("openappa-mark-light.gif" if appa else "archestra-mark.png")
    )
    mime = "image/gif" if appa else "image/png"
    data = base64.b64encode(asset.read_bytes()).decode()
    title = escape(d["title"].removeprefix("Archestra / "))
    copy = escape(HEADERS[d["uid"]])
    mark = "OpenAPPA" if appa else "Archestra"
    header = {
        "id": 90001,
        "type": "text",
        "title": "",
        "transparent": True,
        "gridPos": {"x": 0, "y": 0, "w": 24, "h": 2},
        "options": {
            "mode": "html",
            "content": (
                '<div style="display:flex;align-items:center;gap:16px;min-height:48px">'
                f'<img alt="{mark}" src="data:{mime};base64,{data}" width="48" height="48" '
                'style="flex:0 0 48px;width:48px;height:48px;object-fit:contain;border-radius:6px" />'
                '<div style="min-width:0">'
                f'<h2 style="font-size:16px;line-height:24px;font-weight:600;margin:0">{title}</h2>'
                f'<p style="font-size:14px;line-height:20px;margin:4px 0 0">{copy}</p>'
                "</div></div>"
            ),
        },
    }
    d["panels"] = [header] + remaining

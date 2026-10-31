"""Session listing uses persisted cumulative snapshots, never sums of sampled spans."""

import json
from pathlib import Path

ROOT = Path(__file__).parent


def refresh_sessions():
    path = ROOT / "dashboards/agent-sessions.json"
    d = json.loads(path.read_text())
    fields = {
        "first_request": ("First request", "dateTimeAsIso"),
        "last_request": ("Last request", "dateTimeAsIso"),
        "agent": ("Agent", None),
        "user": ("User", None),
        "models": ("Models", None),
        "source": ("Source", None),
        "auth_methods": ("Authentication", None),
        "credentials": ("Credentials", None),
        "requests": ("Requests", "short"),
        "request_duration_ms": ("Total request time", "ms"),
        "elapsed_ms": ("Session elapsed", "ms"),
        "estimated_cost": ("Estimated cost", "currencyUSD"),
        "billed_cost": ("Billed cost", "currencyUSD"),
        "subscription_cost": ("Subscription equivalent", "currencyUSD"),
        "input_tokens": ("Input tokens", "short"),
        "output_tokens": ("Output tokens", "short"),
        "cache_read_tokens": ("Cache read tokens", "short"),
        "cache_write_tokens": ("Cache write tokens", "short"),
    }
    overrides = [
        {
            "matcher": {"id": "byName", "options": key + " (firstNotNull)"},
            "properties": [{"id": "displayName", "value": title}]
            + ([{"id": "unit", "value": unit}] if unit else []),
        }
        for key, (title, unit) in fields.items()
    ]
    link = "/d/archestra-agent-sessions?var-sessionId=${__value.raw:percentencode}&var-traces_datasource=${traces_datasource}&var-logs_datasource=${logs_datasource}&${__url_time_range}"
    overrides.insert(
        0,
        {
            "matcher": {"id": "byName", "options": "session_id"},
            "properties": [
                {"id": "displayName", "value": "Session ID"},
                {
                    "id": "links",
                    "value": [
                        {
                            "title": "Open session logs and trace",
                            "url": link,
                            "targetBlank": False,
                        }
                    ],
                },
            ],
        },
    )
    aggregate = {
        key: {"operation": "aggregate", "aggregations": ["firstNotNull"]}
        for key in fields
    }
    aggregate["session_id"] = {"operation": "groupby", "aggregations": []}
    d["panels"] = [
        {
            "id": 3,
            "title": "Recent Agent Sessions",
            "type": "table",
            "gridPos": {"x": 0, "y": 3, "w": 24, "h": 12},
            "description": "One row per session, with the cost, usage, and identity details shown on the application Logs page. Totals cover the full session. The time range limits which recently updated sessions appear; up to 5,000 updates are searched.",
            "datasource": {"type": "loki", "uid": "${logs_datasource}"},
            "targets": [
                {
                    "refId": "A",
                    "expr": '{service_name="Archestra"} | event_name="archestra.session.summary" | json | agent =~ ${agent_name:doublequote}',
                    "queryType": "range",
                    "direction": "backward",
                    "maxLines": 5000,
                }
            ],
            "options": {
                "showHeader": True,
                "cellHeight": "sm",
                "sortBy": [{"displayName": "Last request", "desc": True}],
            },
            "fieldConfig": {
                "defaults": {
                    "custom": {"align": "auto", "cellOptions": {"type": "auto"}}
                },
                "overrides": overrides,
            },
            "transformations": [
                {
                    "id": "extractFields",
                    "options": {"source": "Line", "format": "json", "replace": True},
                },
                {
                    "id": "sortBy",
                    "options": {
                        "sort": [
                            {"field": "last_request", "desc": True},
                            {"field": "requests", "desc": True},
                        ]
                    },
                },
                {"id": "groupBy", "options": {"fields": aggregate}},
                {
                    "id": "organize",
                    "options": {
                        "renameByName": {
                            key + " (firstNotNull)": key for key in fields
                        },
                        "indexByName": {
                            (key if key == "session_id" else key + " (firstNotNull)"): i
                            for i, key in enumerate(["session_id", *fields])
                        },
                    },
                },
            ],
        },
        {
            "id": 8,
            "title": "Session Logs",
            "type": "logs",
            "gridPos": {"x": 0, "y": 39, "w": 24, "h": 18},
            "description": "Requests, tool calls, policy decisions, and application events for the selected session. Expand an event to inspect its details.",
            "datasource": {"type": "loki", "uid": "${logs_datasource}"},
            "targets": [
                {
                    "refId": "A",
                    "expr": '{service_name="Archestra"} | session_id = ${sessionId:doublequote} | event_name != "archestra.session.summary"',
                    "direction": "backward",
                    "queryType": "range",
                    "maxLines": 5000,
                }
            ],
            "options": {
                "showTime": True,
                "showLabels": False,
                "wrapLogMessage": True,
                "sortOrder": "Ascending",
                "enableLogDetails": True,
            },
        },
        {
            "id": 10,
            "title": "Session Trace",
            "type": "traces",
            "gridPos": {"x": 0, "y": 15, "w": 24, "h": 24},
            "description": "Timing and parent-child relationships for this session’s turns, inference requests, tool calls, and Guardrails hooks. A hook includes the policy checks and consults it performs.",
            "datasource": {"type": "tempo", "uid": "${traces_datasource}"},
            "targets": [{"refId": "A", "query": "${traceId}", "queryType": "traceId"}],
        },
    ]
    d["panels"][-2:] = [d["panels"][-1], d["panels"][-2]]
    d["description"] = (
        "Review who used each session, what it cost, and where time went."
    )
    for i, v in enumerate(d["templating"]["list"]):
        if v["name"] in ("sessionId", "traceId"):
            selected = v["name"] == "sessionId"
            stream = (
                '{service_name="Archestra"} | event_name="archestra.session.summary"'
            )
            if not selected:
                stream += ' | session_id = ${sessionId:doublequote} | json session_trace_id="trace_id"'
            d["templating"]["list"][i] = {
                "name": v["name"],
                "label": "Session ID" if selected else "Trace ID",
                "type": "query",
                "datasource": {"type": "loki", "uid": "${logs_datasource}"},
                "query": {
                    "type": 2,
                    "label": "session_id" if selected else "session_trace_id",
                    "stream": stream,
                    "refId": "SessionLookup",
                },
                "refresh": 2,
                "sort": 1,
                "multi": False,
                "includeAll": False,
                "options": [],
                "current": {},
                "hide": 0,
                "skipUrlSync": False,
                "allowCustomValue": True,
                "description": "Select a session or click its row below."
                if selected
                else "Filled from the selected session. Enter another trace ID to inspect it directly.",
            }
    path.write_text(json.dumps(d, indent=2) + "\n")

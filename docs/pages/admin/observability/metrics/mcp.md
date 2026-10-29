---
title: MCP Metrics
description: Look up MCP tool calls, payload sizes, latency, and server deployment status.
order: 3
lastUpdated: 2026-10-28
---

Track tool calls through the MCP Gateway and the state of self-hosted MCP servers. See [Labels](/docs/admin/observability/metrics#labels) for request and agent dimensions.

## Metrics

| Metric | Type | Measures |
| --- | --- | --- |
| <span id="mcp_tool_calls_total"></span>`mcp_tool_calls_total` | Counter | Tool calls through the [MCP Gateway](/docs/mcp/gateway) |
| <span id="mcp_tool_call_duration_seconds"></span>`mcp_tool_call_duration_seconds` | Histogram | Tool call duration |
| <span id="mcp_request_size_bytes"></span>`mcp_request_size_bytes` | Histogram | Tool call argument size |
| <span id="mcp_response_size_bytes"></span>`mcp_response_size_bytes` | Histogram | Tool call result size |
| <span id="mcp_server_deployment_status"></span>`mcp_server_deployment_status` | Gauge | State of each self-hosted MCP server, by `server_name` and `state` |

`mcp_server_deployment_status` is `1` for the server's current `state`: `not_created`, `pending`, `running`, `failed`, `succeeded`, `hibernated`, or `waking`. `count(mcp_server_deployment_status{state="running"} == 1)` counts running servers.

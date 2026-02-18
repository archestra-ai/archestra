---
title: Observability
category: Archestra Platform
order: 5
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This document is human-built, shouldn't be updated with AI. Don't change anything here.
-->

# Observability

![Archestra Logs Viewer](/docs/automated_screenshots/platform_logs_viewer.png)

Archestra exposes Prometheus metrics and OpenTelemetry traces for monitoring system health, tracking HTTP requests, and analyzing LLM API performance.

## Metrics

The endpoint `http://localhost:9050/metrics` exposes Prometheus-formatted metrics including:

### Generative AI Metrics

#### LLM Metrics

- `llm_request_duration_seconds` - LLM API request duration by provider, model, agent_id, agent_name, agent_type, external_agent_id, and status code
- `llm_tokens_total` - Token consumption by provider, model, agent_id, agent_name, agent_type, external_agent_id, and type (input/output)
- `llm_cost_total` - Estimated cost in USD by provider, model, agent_id, agent_name, agent_type, and external_agent_id. Requires token pricing to be configured in Archestra.
- `llm_blocked_tools_total` - Counter of tool calls blocked by tool invocation policies, grouped by provider, model, agent_id, agent_name, agent_type, and external_agent_id
- `llm_time_to_first_token_seconds` - Time to first token (TTFT) for streaming requests, by provider, agent_id, agent_name, agent_type, external_agent_id, and model. Helps developers choose models with lower initial response latency.
- `llm_tokens_per_second` - Output tokens per second throughput, by provider, agent_id, agent_name, agent_type, external_agent_id, and model. Allows comparing model response speeds for latency-sensitive applications.

> **Note:** `agent_id` and `agent_name` are the internal Archestra agent identifier and name. `external_agent_id` contains the external agent ID passed via the [`X-Archestra-Agent-Id`](/docs/platform-llm-proxy#custom-headers) header — this allows clients to associate metrics with their own agent identifiers. If the header is not provided, the label will be empty. `agent_type` indicates the type of agent: `agent`, `llm_proxy`, `mcp_gateway`, or `profile`.

#### MCP Metrics

- `mcp_tool_calls_total` - Total MCP tool calls by agent_id, agent_name, agent_type, mcp_server_name, tool_name, and status (success/error)
- `mcp_tool_call_duration_seconds` - MCP tool call execution duration by agent_id, agent_name, agent_type, mcp_server_name, tool_name, and status

### Archestra Application Metrics

#### HTTP Metrics

- `http_request_duration_seconds_count` - Total HTTP requests by method, route, and status
- `http_request_duration_seconds_bucket` - Request duration histogram buckets
- `http_request_summary_seconds` - Request duration summary with quantiles

#### Process Metrics

- `process_cpu_user_seconds_total` - CPU time in user mode
- `process_cpu_system_seconds_total` - CPU time in system mode
- `process_resident_memory_bytes` - Physical memory usage
- `process_start_time_seconds` - Process start timestamp

#### Node.js Runtime Metrics

- `nodejs_eventloop_lag_seconds` - Event loop lag (latency indicator)
- `nodejs_heap_size_used_bytes` - V8 heap memory usage
- `nodejs_heap_size_total_bytes` - Total V8 heap size
- `nodejs_external_memory_bytes` - External memory usage
- `nodejs_active_requests_total` - Currently active async requests
- `nodejs_active_handles_total` - Active handles (file descriptors, timers)
- `nodejs_gc_duration_seconds` - Garbage collection timing by type
- `nodejs_version_info` - Node.js version information

## Distributed Tracing

Archestra exports OpenTelemetry traces to help you understand request flows and identify performance bottlenecks. Traces can be consumed by any OTLP-compatible backend (Jaeger, Tempo, Honeycomb, Grafana Cloud, etc.).

### Configuration

Configure the OpenTelemetry Collector endpoint via environment variable:

```bash
ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT=http://your-collector:4318
```

This base URL is used for both traces (`/v1/traces`) and logs (`/v1/logs`). If not specified, it defaults to `http://localhost:4318`.

### Authentication

Archestra supports authentication for OTEL trace export through environment variables. Authentication is optional and can be configured using either basic authentication or bearer token authentication.

#### Bearer Token Authentication

Bearer token authentication takes precedence over basic authentication when both are configured:

```bash
ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_BEARER=your-bearer-token
```

This adds an `Authorization: Bearer your-bearer-token` header to all OTEL requests.

#### Basic Authentication

For basic authentication, **both** username and password must be provided:

```bash
ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME=your-username
ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD=your-password
```

This adds an `Authorization: Basic base64(username:password)` header to all OTEL requests.

#### No Authentication

If none of the authentication environment variables are configured, traces will be sent without authentication headers.

### Content Capture

Archestra can capture prompt/completion content and tool call arguments/results as span events for full audit trail visibility. This is enabled by default and can be disabled via the `ARCHESTRA_OTEL_CAPTURE_CONTENT` [environment variable](/docs/platform-deployment#observability--metrics).

When enabled, traces include:

- **LLM spans** - `gen_ai.content.prompt` event with the request messages, and `gen_ai.content.completion` event with the response text
- **MCP spans** - `gen_ai.content.input` event with tool call arguments, and `gen_ai.content.output` event with tool call results

Content is truncated to 10,000 characters per event by default to avoid oversized spans. This limit is configurable via the `ARCHESTRA_OTEL_CONTENT_MAX_LENGTH` [environment variable](/docs/platform-deployment#observability--metrics).

### Metric-to-Trace Exemplars

All LLM and MCP metrics include trace exemplars. When viewing these metrics in Grafana, you can click on individual data points to jump directly to the corresponding trace in Tempo. This requires:

- Prometheus configured with `--enable-feature=exemplar-storage`
- Grafana Prometheus datasource configured with `exemplarTraceIdDestinations` pointing to your Tempo datasource

### Verbose Tracing

By default, traces only contain GenAI-specific spans (LLM calls, MCP tool calls) for a clean, focused view. To also capture internal infrastructure spans (HTTP routes, outgoing HTTP calls, Node.js fetch, etc), set the `ARCHESTRA_OTEL_VERBOSE_TRACING` [environment variable](/docs/platform-deployment#observability--metrics) to `true`. This is useful for debugging but produces significantly more spans.

When [Sentry](/docs/platform-deployment#observability--metrics) is configured, infrastructure auto-instrumentations are automatically enabled so that Sentry receives full traces for internal debugging. However, the customer-facing OTLP export is filtered to only include GenAI/MCP spans — customers see a clean trace view while Sentry gets the complete picture. Setting `ARCHESTRA_OTEL_VERBOSE_TRACING=true` disables this filtering, sending all spans to both Sentry and OTLP.

### What's Traced

Archestra automatically traces:

- **LLM API calls** - Calls to LLM providers with dedicated spans showing model, tokens, and response time
- **MCP tool calls** - Tool executions through the MCP Gateway with tool name, server, and duration
- **HTTP requests** (verbose mode only) - All API requests with method, route, and status code

Trace attributes follow the [OTEL GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/) where applicable.

### LLM Request Spans

Each LLM API call produces a span with `SpanKind.CLIENT` (indicating an outbound call to an external LLM API) and includes detailed attributes for filtering and analysis:

**Request Attributes:**

- `route.category=llm-proxy` - All LLM proxy requests
- `gen_ai.operation.name` - The operation type (`chat`, `generate_content`)
- `gen_ai.provider.name` - Provider name (`openai`, `anthropic`, `gemini`, etc.)
- `gen_ai.request.model` - Model name (e.g., `gpt-4`, `claude-3-5-sonnet-20241022`)
- `gen_ai.request.streaming` - Whether the request was streaming (`true`/`false`)
- `server.address` - Base URL of the LLM provider API
- `gen_ai.agent.id` - Internal Archestra agent ID
- `gen_ai.agent.name` - Internal Archestra agent name
- `gen_ai.conversation.id` - Session ID for grouping related LLM calls (from [`X-Archestra-Session-Id`](/docs/platform-llm-proxy#custom-headers) header)
- `archestra.agent.type` - Agent type (`agent`, `llm_proxy`, `mcp_gateway`, `profile`)
- `archestra.execution.id` - Execution ID (from [`X-Archestra-Execution-Id`](/docs/platform-llm-proxy#custom-headers) header)
- `archestra.external_agent_id` - Client-provided agent ID (from [`X-Archestra-Agent-Id`](/docs/platform-llm-proxy#custom-headers) header)
- `archestra.label.<key>` - Custom agent labels (e.g., `archestra.label.environment=production`)
- `archestra.user.id` - The Archestra user ID who made the request (when available)
- `archestra.user.email` - The Archestra user email (when available)
- `archestra.user.name` - The Archestra user display name (when available)

**Response Attributes:**

- `gen_ai.response.model` - The model that actually generated the response (may differ from request model)
- `gen_ai.response.id` - Provider-assigned response ID
- `gen_ai.usage.input_tokens` - Number of input tokens consumed
- `gen_ai.usage.output_tokens` - Number of output tokens generated
- `gen_ai.usage.total_tokens` - Total tokens (input + output)
- `archestra.cost` - Estimated cost in USD (requires [token pricing](/docs/platform-cost-management#token-pricing) configuration)
- `gen_ai.response.finish_reasons` - Why the model stopped generating (e.g., `["stop"]`, `["tool_calls"]`, `["end_turn"]`)

**Error Attributes:**

- `error.type` - The error class name when an exception occurs during the LLM call

**Span Names:**

Span names follow the GenAI semconv format `{operation} {model}`:

- `chat gpt-4o-mini` - OpenAI, Anthropic, Cohere, and other chat-based providers
- `generate_content gemini-2.0-flash` - Gemini content generation calls

### MCP Tool Call Spans

Each MCP tool call executed through the MCP Gateway produces a dedicated span:

**Span Attributes:**

- `route.category=mcp-gateway` - All MCP Gateway tool calls
- `gen_ai.operation.name=execute_tool` - Operation type
- `gen_ai.tool.name` - The full tool name (e.g., `github__list_repos`)
- `gen_ai.tool.type=function` - Tool type (all MCP tools are function-type)
- `gen_ai.tool.call.id` - Unique identifier for this tool call invocation
- `mcp.server.name` - The MCP server handling the tool call (e.g., `github`, `slack`)
- `gen_ai.agent.id` - Internal Archestra agent ID
- `gen_ai.agent.name` - Internal Archestra agent name
- `gen_ai.conversation.id` - Session ID (when available)
- `archestra.agent.type` - Agent type
- `archestra.label.<key>` - Custom agent labels
- `archestra.user.id` - The Archestra user ID (when available)
- `archestra.user.email` - The Archestra user email (when available)
- `archestra.user.name` - The Archestra user display name (when available)
- `mcp.is_error_result` - Whether the tool returned an error result (`true`/`false`). This is distinct from span status ERROR, which indicates an exception during execution.
- `error.type` - The error class name when an exception occurs during tool execution

**Span Names:**

- `execute_tool {tool_name}` - e.g., `execute_tool github__list_repos`

### Session Tracking

Archestra supports session-based grouping of LLM and tool call traces via the `gen_ai.conversation.id` attribute. Pass a session ID via the [`X-Archestra-Session-Id`](/docs/platform-llm-proxy#custom-headers) header in your LLM proxy requests to group all related traces together. This enables viewing the full timeline of LLM calls and tool executions within a single agent session.

### Chat Traces

When using the built-in chat feature, each chat turn produces a unified trace that groups LLM calls and MCP tool executions under a single parent span:

```
chat {agentName}                       ← parent span (SpanKind.SERVER)
├── chat {model}                       ← LLM call via proxy (SpanKind.CLIENT)
├── execute_tool {tool_name}           ← MCP tool execution
└── chat {model}                       ← follow-up LLM call after tool result
```

The parent span (`route.category=chat`) carries the agent identity and session ID. LLM proxy calls from chat are linked via W3C `traceparent` header propagation, so the LLM spans appear as children rather than independent root traces. MCP tool executions run within the same async context and are automatically parented.

This same unified tracing applies to all agent invocation paths:

| Invocation Path | `route.category` | `archestra.trigger.source` |
| --------------- | ---------------- | -------------------------- |
| Chat UI         | `chat`           | —                          |
| A2A Protocol    | `a2a`            | —                          |
| MS Teams        | `chatops`        | `ms-teams`                 |
| Email           | `email`          | `email`                    |

The `archestra.trigger.source` span attribute lets you filter traces by invocation channel (e.g., find all agent executions triggered from MS Teams).

External LLM proxy calls produce independent root traces.

### Custom Agent Labels

Labels are key-value pairs that can be configured when creating or updating agents through the Archestra UI. Use them, for example, to logically group agents by environment or application type. Once added, labels automatically appear in:

- **Metrics** - As additional label dimensions on all LLM and MCP metrics. Use them to drill down into charts. _Note that `kebab-case` labels will be converted to `snake_case` here because of Prometheus naming rules._
- **Traces** - As `archestra.label.<key>` span attributes. Use them to filter traces.

## Grafana Dashboards

We provide four Grafana dashboards for monitoring Archestra:

- **[GenAI Observability](https://github.com/archestra-ai/archestra/blob/main/platform/dev/grafana/dashboards/genai-observability.json)** — LLM request metrics, token usage, cost analysis, latency, and traces
- **[MCP Monitoring](https://github.com/archestra-ai/archestra/blob/main/platform/dev/grafana/dashboards/mcp-monitoring.json)** — MCP tool call metrics, error rates, duration, and traces
- **[Agent Sessions](https://github.com/archestra-ai/archestra/blob/main/platform/dev/grafana/dashboards/agent-sessions.json)** — Session-level agent audit trail with drill-down into LLM calls, MCP tool calls, and correlated logs
- **[Application Metrics](https://github.com/archestra-ai/archestra/blob/main/platform/dev/grafana/dashboards/application-metrics.json)** — HTTP traffic, Node.js runtime health, and resource usage for monitoring your Archestra deployment

To install all four dashboards at once, create a [Grafana Service Account](https://grafana.com/docs/grafana/latest/administration/service-accounts/) token with the **Editor** [basic role](https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/#organization-roles), or the [`fixed:folders:writer`](https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/access-control/rbac-fixed-basic-role-definitions/) RBAC role for more granular access, and run:

```bash
GRAFANA_URL=https://your-grafana-instance GRAFANA_TOKEN=glsa_xxx \
  bash <(curl -sL https://raw.githubusercontent.com/archestra-ai/archestra/main/platform/dev/grafana/install-dashboards.sh)
```

This creates an "Archestra" folder and imports all dashboards. The script is idempotent — safe to re-run after updates to create new dashboards or update existing ones.

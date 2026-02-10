---
title: Observability
category: Archestra Platform
order: 5
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This document is human-built, shouldn't be updated with AI. Don't change anything here.
-->

# Platform Observability

![Platform Logs Viewer](/docs/automated_screenshots/platform_logs_viewer.png)

The Archestra platform exposes Prometheus metrics and OpenTelemetry traces for monitoring system health, tracking HTTP requests, and analyzing LLM API performance.

## Health Check

The endpoint `http://localhost:9000/health` returns basic service status:

```json
{
  "status": "Archestra Platform API",
  "version": "0.0.1"
}
```

## Metrics

The endpoint `http://localhost:9050/metrics` exposes Prometheus-formatted metrics including:

### HTTP Metrics

- `http_request_duration_seconds_count` - Total HTTP requests by method, route, and status
- `http_request_duration_seconds_bucket` - Request duration histogram buckets
- `http_request_summary_seconds` - Request duration summary with quantiles

### LLM Metrics

- `llm_request_duration_seconds` - LLM API request duration by provider, model, agent_id, profile_id, profile_name, and status code
- `llm_tokens_total` - Token consumption by provider, model, agent_id, profile_id, profile_name, and type (input/output)
- `llm_cost_total` - Estimated cost in USD by provider, model, agent_id, profile_id, and profile_name. Requires token pricing to be configured in Archestra.
- `llm_blocked_tools_total` - Counter of tool calls blocked by tool invocation policies, grouped by provider, model, agent_id, profile_id, and profile_name
- `llm_time_to_first_token_seconds` - Time to first token (TTFT) for streaming requests, by provider, agent_id, profile_id, profile_name, and model. Helps developers choose models with lower initial response latency.
- `llm_tokens_per_second` - Output tokens per second throughput, by provider, agent_id, profile_id, profile_name, and model. Allows comparing model response speeds for latency-sensitive applications.

> **Note:** The `agent_id` label contains the external agent ID passed via the `X-Archestra-Agent-Id` header. This allows clients to associate metrics with their own agent identifiers. If the header is not provided, the label will be empty. Use `profile_id` and `profile_name` for the internal Archestra profile identifier.

### MCP Metrics

- `mcp_tool_calls_total` - Total MCP tool calls by profile_name, mcp_server_name, tool_name, and status (success/error)
- `mcp_tool_call_duration_seconds` - MCP tool call execution duration by profile_name, mcp_server_name, tool_name, and status

### Process Metrics

- `process_cpu_user_seconds_total` - CPU time in user mode
- `process_cpu_system_seconds_total` - CPU time in system mode
- `process_resident_memory_bytes` - Physical memory usage
- `process_start_time_seconds` - Process start timestamp

### Node.js Runtime Metrics

- `nodejs_eventloop_lag_seconds` - Event loop lag (latency indicator)
- `nodejs_heap_size_used_bytes` - V8 heap memory usage
- `nodejs_heap_size_total_bytes` - Total V8 heap size
- `nodejs_external_memory_bytes` - External memory usage
- `nodejs_active_requests_total` - Currently active async requests
- `nodejs_active_handles_total` - Active handles (file descriptors, timers)
- `nodejs_gc_duration_seconds` - Garbage collection timing by type
- `nodejs_version_info` - Node.js version information

## Distributed Tracing

The platform exports OpenTelemetry traces to help you understand request flows and identify performance bottlenecks. Traces can be consumed by any OTLP-compatible backend (Jaeger, Tempo, Honeycomb, Grafana Cloud, etc.).

### Configuration

Configure the OpenTelemetry Collector endpoint via environment variable:

```bash
ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT=http://your-collector:4318/v1/traces
```

If not specified, the platform defaults to `http://localhost:4318/v1/traces`.

### Authentication

The platform supports authentication for OTEL trace export through environment variables. Authentication is optional and can be configured using either basic authentication or bearer token authentication.

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

### What's Traced

The platform automatically traces:

- **HTTP requests** - All API requests with method, route, and status code
- **LLM API calls** - External calls to OpenAI, Anthropic, and Gemini with dedicated spans showing exact response time

### LLM Request Spans

Each LLM API call includes detailed attributes for filtering and analysis:

**Span Attributes:**

- `route.category=llm-proxy` - All LLM proxy requests
- `llm.provider` - Provider name (`openai`, `anthropic`, `gemini`)
- `llm.model` - Model name (e.g., `gpt-4`, `claude-3-5-sonnet-20241022`)
- `llm.stream` - Whether the request was streaming (`true`/`false`)
- `profile.id` - The ID of the profile handling the request
- `profile.name` - The name of the profile handling the request
- `profile.<label_key>` - Custom profile labels (e.g., `environment=production`, `team=data-science`)

**Span Names:**

- `openai.chat.completions` - OpenAI chat completion calls
- `anthropic.messages` - Anthropic message calls
- `gemini.generateContent` - Gemini content generation calls

These dedicated spans show the exact duration of external LLM API calls, separate from your application's processing time.

### MCP Tool Call Spans

Each MCP tool call executed through the MCP Gateway produces a dedicated span:

**Span Attributes:**

- `route.category=mcp-gateway` - All MCP Gateway tool calls
- `mcp.server_name` - The MCP server handling the tool call (e.g., `github`, `slack`)
- `mcp.tool_name` - The full tool name (e.g., `github__list_repos`)
- `profile.id` - The ID of the profile executing the tool call
- `profile.name` - The name of the profile executing the tool call
- `profile.<label_key>` - Custom profile labels
- `mcp.is_error_result` - Whether the tool returned an error result (`true`/`false`). This is distinct from span status ERROR, which indicates an exception during execution.

**Span Names:**

- `mcp.<server_name>.<tool_name>` - e.g., `mcp.github.github__list_repos`

### Custom Profile Labels

Labels are key-value pairs that can be configured when creating or updating profiles through the Archestra Platform UI. Use them, for example, to logically group profiles by environment or application type. Once added, labels automatically appear in:

- **Metrics** - As additional label dimensions on `llm_request_duration_seconds` and `llm_tokens_total`. Use them to drill down into charts. _Note that `kebab-case` labels will be converted to `snake_case` here because of Prometheus naming rules._
- **Traces** - As span attributes. Use them to filter traces.

## Grafana Dashboard

We've prepared a Grafana dashboard with charts visualizing the "four golden signals", LLM token usage and traces. To download the dashboard template, head [here](https://github.com/archestra-ai/archestra/blob/main/platform/dev/grafana/dashboards/platform.json)

## Setting Up Prometheus

_The following instructions assume you are familiar with Grafana and Prometheus and have them already set up._

Add the following to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: "archestra-backend"
    static_configs:
      - targets: ["localhost:9050"] # Platform API base URL
    scrape_interval: 15s
    metrics_path: /metrics
```

If you are unsure what the Platform API base URL is, check the Platform UI's Settings. While the Platform API is exposed
on port 9000, `/metrics` is exposed separately on port 9050.

## Chart Examples

Here are some PromQL queries for Grafana charts to get you started:

### HTTP Metrics

- Request rate by route:

  ```promql
  rate(http_request_duration_seconds_count[5m])
  ```

- Error rate by route:
  ```promql
  sum(rate(http_request_duration_seconds_count{status_code=~"4..|5.."}[5m])) by (route, method) / sum(rate(http_request_duration_seconds_count[5m])) by (route, method) * 100
  ```
- Response time percentiles:
  ```promql
  histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))
  ```
- Memory usage:
  ```promql
  process_resident_memory_bytes / 1024 / 1024
  ```

### LLM Metrics

- LLM requests per second by profile and provider:

  ```promql
  sum(rate(llm_request_duration_seconds_count[5m])) by (profile_name, provider)
  ```

- LLM error rate by provider:

  ```promql
  sum(rate(llm_request_duration_seconds_count{status_code!="200"}[5m])) by (provider) / sum(rate(llm_request_duration_seconds_count[5m])) by (provider) * 100
  ```

- LLM token usage rate (tokens/sec) by profile name:

  ```promql
  sum(rate(llm_tokens_total[5m])) by (provider, profile_name, type)
  ```

- Total tokens by profile name:

  ```promql
  sum(rate(llm_tokens_total[5m])) by (profile_name, type)
  ```

- Request duration by profile name and provider:

  ```promql
  histogram_quantile(0.95, sum(rate(llm_request_duration_seconds_bucket[5m])) by (profile_name, provider, le))
  ```

- Error rate by profile:

  ```promql
  sum(rate(llm_request_duration_seconds_count{status_code!~"2.."}[5m])) by (profile_name) / sum(rate(llm_request_duration_seconds_count[5m])) by (profile_name)
  ```

- Cost rate by profile and provider (USD/min):

  ```promql
  sum(rate(llm_cost_total[5m])) by (profile_name, provider) * 60
  ```

- Total accumulated cost by model:

  ```promql
  sum(llm_cost_total) by (model)
  ```

- Time to first token (TTFT) p95 by model:

  ```promql
  histogram_quantile(0.95, sum(rate(llm_time_to_first_token_seconds_bucket[5m])) by (model, le))
  ```

- Average time to first token by provider:

  ```promql
  sum(rate(llm_time_to_first_token_seconds_sum[5m])) by (provider) / sum(rate(llm_time_to_first_token_seconds_count[5m])) by (provider)
  ```

- Tokens per second throughput p50 by model:

  ```promql
  histogram_quantile(0.50, sum(rate(llm_tokens_per_second_bucket[5m])) by (model, le))
  ```

- Average tokens per second by provider and model:

  ```promql
  sum(rate(llm_tokens_per_second_sum[5m])) by (provider, model) / sum(rate(llm_tokens_per_second_count[5m])) by (provider, model)
  ```

### MCP Metrics

- Tool calls per second by MCP server:

  ```promql
  sum(rate(mcp_tool_calls_total[5m])) by (mcp_server_name)
  ```

- Tool call error rate by MCP server:

  ```promql
  sum(rate(mcp_tool_calls_total{status="error"}[5m])) by (mcp_server_name) / sum(rate(mcp_tool_calls_total[5m])) by (mcp_server_name)
  ```

- Tool call duration p95 by MCP server:

  ```promql
  histogram_quantile(0.95, sum(rate(mcp_tool_call_duration_seconds_bucket[5m])) by (mcp_server_name, le))
  ```

- Tool calls per second by tool name:

  ```promql
  sum(rate(mcp_tool_calls_total[5m])) by (tool_name)
  ```

- Average tool call duration by profile:

  ```promql
  sum(rate(mcp_tool_call_duration_seconds_sum[5m])) by (profile_name) / sum(rate(mcp_tool_call_duration_seconds_count[5m])) by (profile_name)
  ```

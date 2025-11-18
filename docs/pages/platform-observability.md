---
title: Observability
category: Archestra Platform
order: 5
---

# Platform Observability

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

- `llm_request_duration_seconds` - LLM API request duration by provider, agent_id, agent_name, and status code
- `llm_tokens_total` - Token consumption by provider, agent_id, agent_name, and type (input/output)
- `llm_blocked_tool_total` - Counter of tool calls blocked by tool invocation policies, grouped by provider, agent_id, and agent_name

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
- `agent.id` - The ID of the agent handling the request
- `agent.name` - The name of the agent handling the request
- `agent.<label_key>` - Custom agent labels (e.g., `environment=production`, `team=data-science`)

**Span Names:**

- `openai.chat.completions` - OpenAI chat completion calls
- `anthropic.messages` - Anthropic message calls
- `gemini.generateContent` - Gemini content generation calls

These dedicated spans show the exact duration of external LLM API calls, separate from your application's processing time.

### Custom Agent Labels

Labels are key-value pairs that can be configured when creating or updating agents through the Archestra Platform UI. Use them, for example, to logically group agents by environment or application type. Once added, labels automatically appear in:

- **Metrics** - As additional label dimensions on `llm_request_duration_seconds` and `llm_tokens_total`. Use them to drill down into charts. _Note that `kebab-case` labels will be converted to `snake_case` here because of Prometheus naming rules._
- **Traces** - As span attributes. Use them to filter traces.

## Grafana Dashboard

We've prepared a Grafana dashboard with charts visualizing the "four golden signals", LLM token usage and traces. To download the dashboard template, head [here](https://github.com/archestra-ai/archestra/blob/main/platform/dev/grafana/dashboards/platform.json)

## Setting Up Prometheus

_The following instructions assume you are familiar with Grafana and Prometheus and have them already set up._

Add the following to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'archestra-backend'
    static_configs:
      - targets: ['localhost:9050'] # Platform API base URL
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

- LLM requests per second by agent and provider:

  ```promql
  sum(rate(llm_request_duration_seconds_count[5m])) by (agent_name, provider)
  ```

- LLM error rate by provider:

  ```promql
  sum(rate(llm_request_duration_seconds_count{status_code!="200"}[5m])) by (provider) / sum(rate(llm_request_duration_seconds_count[5m])) by (provider) * 100
  ```

- LLM token usage rate (tokens/sec) by agent name:

  ```promql
  sum(rate(llm_tokens_total[5m])) by (provider, agent_name, type)
  ```

- Total tokens by agent name:

  ```promql
  sum(rate(llm_tokens_total[5m])) by (agent_name, type)
  ```

- Request duration by agent name and provider:

  ```promql
  histogram_quantile(0.95, sum(rate(llm_request_duration_seconds_bucket[5m])) by (agent_name, provider, le))
  ```

- Error rate by agent:

  ```promql
  sum(rate(llm_request_duration_seconds_count{status_code!~"2.."}[5m])) by (agent_name) / sum(rate(llm_request_duration_seconds_count[5m])) by (agent_name)
  ```

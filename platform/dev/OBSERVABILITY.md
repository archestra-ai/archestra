# Observability with OpenTelemetry and Grafana Tempo

This project includes distributed tracing using OpenTelemetry and Grafana Tempo for monitoring and debugging API requests.

## Overview

The observability stack consists of:

- **OpenTelemetry SDK**: Instruments the Fastify application to collect traces
- **OpenTelemetry Collector**: Receives traces from the application and forwards them to Tempo
- **Grafana Tempo**: Stores distributed traces
- **Grafana**: Visualizes traces and metrics with a unified UI

## Architecture

```
[Fastify App] --traces--> [OTel Collector] --traces--> [Tempo]
                                                          |
                                                      [Grafana (Browser)]
```

## Quick Start

### Local Development with Tilt

When running the application with Tilt, the observability stack is automatically deployed:

```bash
tilt up
```

This will start:

- **Grafana UI**: http://localhost:3002
- **Tempo API**: http://localhost:3200
- **OTel Collector**: Listening on ports 4317 (gRPC) and 4318 (HTTP)

### Viewing Traces

1. Open Grafana UI at http://localhost:3002
2. Navigate to "Explore" in the left sidebar
3. Select "Tempo" from the datasource dropdown
4. Use the "Search" tab to find traces or use TraceQL to query traces
5. Click on any trace to see detailed span information

#### Searching and Filtering Traces

Tempo supports multiple ways to find and filter traces:

**Search by Tags:**
In the Grafana Tempo datasource, use the Search tab to filter by resource attributes:

- `service.name="Archestra Platform API"` - Shows traces from the API service
- `route.category="llm-proxy"` - Shows only requests to `/v1/openai/*`, `/v1/anthropic/*`, `/v1/gemini/*`
- `llm.provider="openai"` - Shows only OpenAI requests
- `llm.model="gpt-4"` - Shows only requests using GPT-4

**TraceQL Queries:**
Use TraceQL for more advanced filtering:

```
{ span.route.category="llm-proxy" && span.llm.provider="openai" && span.llm.model="gpt-4" }
```

This shows only OpenAI GPT-4 requests with all their spans.

**Filter by Agent Labels:**
If agents have custom labels defined, you can filter by them:

```
{ span.agent.environment="production" }
```

## Grafana Dashboards

### Archestra Platform Dashboard

The main monitoring dashboard is available at: **http://localhost:3002/d/archestra-platform**

This dashboard provides comprehensive monitoring across four key areas:

#### 1. System Resources
- **CPU Usage**: Process CPU utilization over time
- **Memory Usage**: Resident memory consumption

#### 2. LLM Metrics  
- **LLM Token Usage**: Input and output token rates by agent
  - Blue lines: Input tokens
  - Green lines: Output tokens
  - Stacked view shows total token consumption

#### 3. Application Metrics
- **Request Rate**: HTTP requests per second by route
- **Request Duration**: p95 and p50 latency percentiles  
- **Error Rate**: 4xx and 5xx error rates by route and status code
- **Route Filter**: Use the "Route (App Metrics)" dropdown to filter by specific API endpoints

#### 4. OTEL Traces
The traces section has two panels: **All Traces** displays recent traces in a table format, while **Individual Trace** shows detailed span breakdowns for selected traces. Initially, the "Individual Trace" panel will be empty. Click on any trace in the table, then chose "Trace link" from the context menu to see the individual trace.

### Dashboard Features

**Time Range Controls:**
- Default: Last 15 minutes with 5-second refresh
- Adjustable via the time picker in the top-right

**Interactive Filtering:**
- **Route Filter**: Applies only to Application Metrics panels
- Filter by specific API routes like `/v1/openai/*`, `/health`, etc.

**Panel Navigation:**
- Click on any metric spike to drill down to specific time ranges
- Use panel legends to toggle specific series on/off
- Hover over data points for detailed values

### Accessing Trace Details

From the dashboard, you can access detailed trace information in two ways:

1. **Grafana Explore**: Navigate to Explore → Tempo datasource
2. **Direct Tempo queries**: Use TraceQL for advanced trace filtering

**Common TraceQL Queries:**
```
# All traces from the API service
{ service.name="Archestra Platform API" }

# LLM proxy requests only  
{ span.route.category="llm-proxy" }

# Slow requests (>1 second)
{ duration > 1s }

# OpenAI requests with errors
{ span.llm.provider="openai" && status=error }
```

## Configuration

### Environment Variables

The OTEL exporter endpoint can be configured via environment variables:

```bash
# In your .env file
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
```

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

## Configuration

### Environment Variables

The OpenTelemetry exporter endpoint can be configured via environment variables:

```bash
# In your .env file
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
```

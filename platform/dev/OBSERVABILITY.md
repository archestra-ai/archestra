# Observability with OpenTelemetry and Jaeger

This project includes distributed tracing using OpenTelemetry and Jaeger for monitoring and debugging API requests.

## Overview

The observability stack consists of:

- **OpenTelemetry SDK**: Instruments the Fastify application to collect traces
- **OpenTelemetry Collector**: Receives traces from the application and forwards them to Jaeger
- **Jaeger**: Stores and visualizes distributed traces

## Architecture

```
[Fastify App] --traces--> [OTel Collector] --traces--> [Jaeger]
                                                           |
                                                   [Jaeger UI (Browser)]
```

## Quick Start

### Local Development with Tilt

When running the application with Tilt, the observability stack is automatically deployed:

```bash
tilt up
```

This will start:

- **Jaeger UI**: http://localhost:16686
- **OTel Collector**: Listening on ports 4317 (gRPC) and 4318 (HTTP)

### Viewing Traces

1. Open Jaeger UI at http://localhost:16686
2. Select "Archestra Platform API" from the Service dropdown
3. Click "Find Traces" to see all traces
4. Click on any trace to see detailed span information

#### Filtering Traces

You can filter traces using tags to narrow down specific types of requests:

**Filter by LLM Proxy Requests:**

- Tag: `route.category=llm-proxy`
- Shows only requests to `/v1/openai/*`, `/v1/anthropic/*`, `/v1/gemini/*`

**Filter by LLM Provider:**

- Tag: `llm.provider=openai` (or `anthropic`, `gemini`)
- Shows only requests to a specific LLM provider

**Filter by Model:**

- Tag: `llm.model=gpt-4` (or any other model name)
- Shows only requests using a specific model

**Combine Multiple Tags:**
You can add multiple tags to create more specific filters. For example:

- `route.category=llm-proxy` + `llm.provider=openai` + `llm.model=gpt-4`
- Shows only OpenAI GPT-4 requests

## Configuration

### Environment Variables

The OpenTelemetry exporter endpoint can be configured via environment variables:

```bash
# In your .env file
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
```

---
name: archestra-dev-observability
description: Use when changing Archestra tracing, metrics, OpenTelemetry, Tempo, Grafana, Prometheus, LLM/MCP spans, observability labels, or local observability setup.
---

# Archestra Observability

Use this skill before changing tracing, metrics, span naming, metric labels, or local observability setup.

Run commands from `platform/` unless specifically instructed otherwise.

## Local setup

```bash
tilt trigger observability
docker compose -f dev/docker-compose.observability.yml up -d
```

`tilt trigger observability` starts the full observability stack: Tempo, OTEL Collector, Prometheus, and Grafana.

The docker-compose command is an alternative local setup with pre-configured datasources.

## Local URLs

- Tempo API: `http://localhost:3200/`.
- Grafana: `http://localhost:3002/`.
- Prometheus: `http://localhost:9090/`.
- Backend metrics: `http://localhost:9050/metrics`.

## Tracing

- Follow OTEL GenAI Semantic Conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/.
- LLM spans use `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.operation.name`, and `archestra.label.<key>` for dynamic labels.
- MCP spans use `gen_ai.tool.name` and `mcp.server.name`.
- Session tracking uses `gen_ai.conversation.id` from the `X-Archestra-Session-Id` header.
- Span names are `chat {model}`, `generate_content {model}`, and `execute_tool {tool_name}`.
- Agent label keys are fetched from the database on startup and included as resource attributes.
- Traces are stored in Grafana Tempo.
- User identity is tracked with `archestra.user.id`, `archestra.user.email`, and `archestra.user.name` when available.
- LLM spans include `archestra.cost` in USD and `gen_ai.usage.total_tokens`.

## Metrics

- Prometheus metrics `llm_request_duration_seconds` and `llm_tokens_total` include `agent_id`, `agent_name`, `agent_type`, `external_agent_id`, and dynamic agent labels as dimensions.
- `agent_id` is internal.
- `external_agent_id` comes from the client-provided header and is used for agent execution metrics.
- MCP metrics include `agent_id`, `agent_name`, and `agent_type`.
- Metrics are reinitialized on startup with current label keys from the database.

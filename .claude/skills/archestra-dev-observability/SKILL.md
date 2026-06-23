---
name: archestra-dev-observability
description: Use when changing Archestra tracing, metrics, OpenTelemetry, Tempo, Grafana, Prometheus, LLM/MCP spans, observability labels, or local observability setup.
---

# Archestra Observability

Use this skill before changing tracing, metrics, span naming, metric labels, or local observability setup.

Run commands from `platform/` unless specifically instructed otherwise.

## Naming new attributes and metrics

Before introducing any new span attribute or metric name, look it up — do not coin a name from intuition.

- **Span attributes**: search the OTEL semantic-convention registry and use the existing attribute verbatim if one fits. Registry: https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/ (wider set: https://opentelemetry.io/docs/specs/semconv/registry/attributes/). Example: prompt-cache tokens are `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cache_creation.input_tokens`, not a custom `archestra.usage.*`. Only use an `archestra.*` name when nothing in the registry fits, and say why in a comment.
- **"Not yet stable" is not a reason to avoid a standard name.** The whole `gen_ai.*` namespace is Development-stability, including the `gen_ai.usage.*` attributes already emitted here — match that bar, don't custom-namespace to dodge it.
- **Metrics**: match the existing `llm_*` / prom-client family and label names in `metrics/`; don't introduce a new metric style. Add a label value to an existing metric only if it won't change what current aggregates mean — otherwise add a dedicated metric (cache tokens use a separate `llm_cache_tokens_total`, not new `type` values on `llm_tokens_total`).

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

- Follow OTEL GenAI Semantic Conventions (see "Naming new attributes and metrics" — check the registry before adding any attribute): https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/.
- LLM spans use `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.operation.name`, and `archestra.agent.label.<key>` for dynamic agent labels.
- MCP spans use `gen_ai.tool.name` and `mcp.server.name`.
- Team metadata uses the custom `archestra.<scope>.team.*` namespace (no OTEL registry equivalent), where scope is the principal the teams belong to — `agent` (the executing agent's teams) or `user` (the requesting user's teams). `archestra.<scope>.team.ids` / `.names` are array-valued (a principal can belong to multiple teams), and `archestra.<scope>.team.label.<key>` carries team labels merged per key across the principal's teams. Set via `setTeamAttributes(span, teams, scope)` in `observability/tracing/attributes.ts`; agent teams come from `AgentTeamModel.getTeamLabelInfoForAgent` and user teams from `TeamModel.getTeamLabelInfoForUser`, resolved once per request.
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

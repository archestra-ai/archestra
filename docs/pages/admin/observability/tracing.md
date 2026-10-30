---
title: Tracing
description: Send OpenTelemetry traces and logs for every LLM call, tool call, and agent run to your collector
order: 2
lastUpdated: 2026-10-30
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Send model requests, tool calls, and backend logs to your OpenTelemetry collector.

## Configuration

1. Set [`ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT`](/docs/admin/deployment/configuration#ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT) to the collector's **OTLP HTTP** base URL, usually port 4318:

   ```bash
   ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
   ```

2. If required, set [`ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_BEARER`](/docs/admin/deployment/configuration#ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_BEARER), or both [`ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME`](/docs/admin/deployment/configuration#ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME) and [`ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD`](/docs/admin/deployment/configuration#ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD). Bearer authentication takes precedence.
3. Set [`ARCHESTRA_OTEL_TRACES_SAMPLE_RATE`](/docs/admin/deployment/configuration#ARCHESTRA_OTEL_TRACES_SAMPLE_RATE) if you need to reduce ingest volume.
4. Restart the backend and send a chat message.
5. Search your tracing backend for service **Archestra** and a span named `chat <agent name>`.

Archestra appends `/v1/traces` and `/v1/logs` to the base URL.

### Logs

Archestra sends its backend logs to the same collector. Each record carries `trace_id` and `span_id`, plus `session_id` inside an agent session. Your tracing backend uses them to jump from a span to its logs.

## Content Capture

Archestra records message and tool content as span events:

| Span | Event | Content |
| --- | --- | --- |
| LLM | `gen_ai.content.prompt` | The request messages |
| LLM | `gen_ai.content.completion` | The response text |
| MCP | `gen_ai.content.input` | The tool arguments |
| MCP | `gen_ai.content.output` | The tool result |

Each event is truncated to 10,000 characters; [`ARCHESTRA_OTEL_CONTENT_MAX_LENGTH`](/docs/admin/deployment/configuration#ARCHESTRA_OTEL_CONTENT_MAX_LENGTH) changes the limit.

Capture is on by default. Set [`ARCHESTRA_OTEL_CAPTURE_CONTENT=false`](/docs/admin/deployment/configuration#ARCHESTRA_OTEL_CAPTURE_CONTENT) to leave the events out. With [content encryption](/docs/admin/content-encryption) on, capture is off by default. This keeps encrypted content from reaching your telemetry backend as plaintext. [`ARCHESTRA_OTEL_CAPTURE_CONTENT=true`](/docs/admin/deployment/configuration#ARCHESTRA_OTEL_CAPTURE_CONTENT) turns it back on.

When content capture is disabled or a session suppresses content capture, LLM span error statuses also omit provider error messages.

## Verbose Tracing

By default, Archestra exports only agent spans: LLM calls, MCP tool calls, agent runs, and Knowledge Base calls. Set [`ARCHESTRA_OTEL_VERBOSE_TRACING=true`](/docs/admin/deployment/configuration#ARCHESTRA_OTEL_VERBOSE_TRACING) to also export HTTP routes, outgoing HTTP calls, database queries, and DNS lookups. Use it for debugging. It multiplies span volume.

## Trace Structure

Each agent turn groups its model requests and tool calls in one trace.

The root span's `route.category` tells you how the agent was invoked:

| Invocation | `route.category` |
| --- | --- |
| Chat UI | `chat` |
| [A2A](/docs/agents/triggers-and-channels/webhook-a2a) | `a2a` |
| Slack, Microsoft Teams, Telegram | `chatops` |
| Email | `email` |

Calls from your own applications to the [LLM Proxy](/docs/llm-proxy) (`route.category=llm-proxy`) and the [MCP Gateway](/docs/mcp/gateway) (`route.category=mcp-gateway`) start their own traces.

To group LLM Proxy calls into one trace, send [`X-Archestra-Session-Id`](/docs/llm-proxy#custom-headers) with your conversation ID. Archestra records it as `gen_ai.conversation.id`. When Guardrails are active, [`X-Appa-Session-ID`](/docs/agents/guardrails/clients#session-headers) takes precedence as the recorded session identity. MCP Gateway spans do not group by `X-Archestra-Session-Id`.

## LLM Spans

LLM spans use `{operation} {model}`; Knowledge Base embeddings use `embedding {model}`. Use these attributes to filter requests and compare token use and cost.

| Attribute | Value |
| --- | --- |
| `gen_ai.operation.name` | `chat` or `generate_content` |
| `gen_ai.provider.name` | The provider, for example `openai` or `anthropic` |
| `gen_ai.request.model`, `gen_ai.response.model` | The requested model and the model that answered |
| `gen_ai.request.streaming` | `true` or `false` |
| `server.address` | The provider's base URL |
| `gen_ai.response.id`, `gen_ai.response.finish_reasons` | The provider's response ID and stop reasons, such as `["stop"]` or `["tool_calls"]` |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.total_tokens` | Token counts. Input includes cached tokens. |
| `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens` | Prompt-cache reads and writes, part of the input tokens |
| `archestra.usage.cache_creation.1h_input_tokens` | Cache writes at the one-hour TTL (Anthropic and Bedrock) |
| `gen_ai.usage.reasoning.output_tokens` | Reasoning tokens, part of the output tokens (OpenAI and Gemini) |
| `archestra.cost` | Estimated cost in USD. Needs [model pricing](/docs/llm-proxy/costs-and-limits#model-pricing). |
| `archestra.billing.mode` | `metered` or `subscription` |
| `archestra.trigger.source` | Where the call came from, for example `api`, `chat`, `chatops:slack`, or `knowledge:embedding` |
| `archestra.auth.method` | How the request authenticated, for example `virtual_key` or `oauth_user` |
| `archestra.virtual_key.id`, `archestra.passthrough_virtual_key.id` | The [virtual key](/docs/llm-proxy/authentication) used, if any |
| `archestra.app.id`, `archestra.app.name` | The [app](/docs/chat/apps) that made the call, if any |
| `archestra.external_agent_id` | The [`X-Archestra-Agent-Id`](/docs/llm-proxy#custom-headers) header value |
| `archestra.run.id` | The [`X-Archestra-Run-Id`](/docs/llm-proxy#custom-headers) header value |
| `error.type` | The error class, when the call fails |

`gen_ai.usage.input_tokens` includes cached tokens. The `llm_tokens_total{type="input"}` metric does not. It reads lower when prompt caching is active.

Knowledge Base embedding and reranking calls have no agent attributes. Their `archestra.trigger.source` is `knowledge:embedding` or `knowledge:reranker`.

## MCP Tool Call Spans

Each tool call through the MCP Gateway is a span named `execute_tool {tool_name}`, for example `execute_tool github__list_repos`.

| Attribute | Value |
| --- | --- |
| `gen_ai.operation.name` | `execute_tool` |
| `gen_ai.tool.name` | The full tool name |
| `gen_ai.tool.call.id` | The tool call ID |
| `mcp.server.name` | The MCP server, for example `github` |
| `mcp.is_error_result` | `true` when the tool returned an error result |
| `mcp.blocked` | `true` when a [guardrail](/docs/agents/guardrails) blocked the call |
| `mcp.blocked_reason` | Why the call was blocked |
| `error.type` | The error class, when the call throws |

A blocked call never runs. Its span records the policy decision with span status `ERROR` and the reason as the status message.

## Identity Attributes

LLM spans, MCP spans, and agent run root spans carry who made the request:

| Attribute | Value |
| --- | --- |
| `gen_ai.agent.id`, `gen_ai.agent.name` | The Archestra agent. LLM Proxy calls report `LLM Proxy`. |
| `archestra.agent.type` | `agent`, `llm_proxy`, `mcp_gateway`, or `profile` |
| `archestra.agent.label.<key>` | Each agent label, for example `archestra.agent.label.environment=production` |
| `archestra.agent.team.ids`, `archestra.agent.team.names` | The agent's teams (arrays) |
| `archestra.agent.team.label.<key>` | The agent's team labels, merged per key across its teams (arrays) |
| `archestra.user.id`, `archestra.user.email`, `archestra.user.name` | The user who made the request, when known |
| `archestra.user.team.ids`, `archestra.user.team.names` | The user's teams (arrays) |
| `archestra.user.team.label.<key>` | The user's team labels, merged per key (arrays) |
| `gen_ai.conversation.id` | The session ID |

The LLM Proxy has no labels or teams. Filter its traffic by the `archestra.user.team.*`, `archestra.external_agent_id`, or `archestra.app.name` attributes.

## Proxy Request Log Events

Attribute logical [LLM Proxy](/docs/llm-proxy) and model router outcomes—including throttled, denied, cancelled, and midstream-failed requests—to a model, agent, user, app, or virtual key with the `archestra.llm_proxy.request` OpenTelemetry log event.

When an inference request handled by the shared proxy or model router finishes, logger `archestra-llm-proxy` emits one structured log record with body `"LLM proxy request completed"` (`INFO` on success or an incomplete terminal, `WARN` on failure) attached to the active trace context (`trace_id` and `span_id`). Like [`llm_proxy_request_duration_seconds`](/docs/admin/observability/metrics/llm#llm_proxy_request_duration_seconds), it records one event per logical request across internal retries and failovers, and excludes pre-handler authentication or validation rejections, model listing, unsupported passthrough endpoints, and provider file routes.

Emission is best-effort and unsampled, so every completed proxy inference request emits the event regardless of [`ARCHESTRA_OTEL_TRACES_SAMPLE_RATE`](/docs/admin/deployment/configuration#ARCHESTRA_OTEL_TRACES_SAMPLE_RATE). The record uses a metadata-only allowlist—never prompts, completions, request or response bodies, headers, or error messages—and is not durable log replication. Use [LLM spans](#llm-spans) for token and cost attribution, [limit metrics](/docs/admin/observability/metrics/limits) for rule evaluations, and [audit logs](/docs/admin/observability/audit-logs) for administrative actions.

| Attribute | Value |
| --- | --- |
| `gen_ai.provider.name` | Provider name (for example `openai` or `anthropic`), or `router` if a model-router request fails before provider selection |
| `gen_ai.operation.name` | Inference operation, such as `chat`, `generate_content`, or `embedding` |
| `gen_ai.request.streaming` | `true` or `false` |
| `http.response.status_code` | Committed HTTP status code (`200` when a stream fails after headers are sent, `499` on client disconnect before headers) |
| `archestra.proxy.outcome` | `success`, `incomplete`, `error`, `throttled`, `denied`, `cancelled`, `timeout`, or `overloaded` |
| `archestra.proxy.error_origin` | `none` for `success` or `incomplete`, `archestra`, `provider`, or `client` |
| `archestra.proxy.duration_seconds` | End-to-end logical request duration in seconds, including preflight and streaming |
| `error.type` | Normalized failure status code as a string (such as `"429"` or `"502"`), present on failed requests even when `http.response.status_code` is `200` |
| `gen_ai.request.model` | Requested model name, when resolved |
| `archestra.organization.id`, `gen_ai.agent.id`, `archestra.user.id` | Organization, agent, and user IDs, when available |
| `archestra.virtual_key.id`, `archestra.passthrough_virtual_key.id` | [Virtual key](/docs/llm-proxy/authentication) or passthrough virtual key ID, when used |
| `archestra.app.id` | [App](/docs/chat/apps) ID, when called from an app |
| `archestra.trigger.source` | Invocation source, such as `api`, `chat`, or `email`, when available |
| `archestra.model_pool.member_model`, `archestra.model_pool.id`, `archestra.provider_api_key.id`, `archestra.proxy.pool_attempts` | Configured final model-pool member model, pool ID, provider credential ID, and number of pool attempts, when a pool is used |

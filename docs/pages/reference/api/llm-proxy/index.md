---
title: LLM Proxy
description: Configure model access, limits, routing, and provider credentials; inspect request logs
order: 5
lastUpdated: 2026-11-04
---

Route model requests through Archestra and manage provider access, model choices, and limits.

To inspect saved requests, see [LLM Proxy Logs](/docs/reference/api/llm-proxy/logs). [Auto Routing](/docs/reference/api/llm-proxy/auto-routing) has its own endpoint reference.

## Authentication

For model requests, send a standard virtual key or an OAuth access token with `llm:proxy` scope as `Authorization: Bearer <credential>`. Provider inference routes also support a passthrough virtual key in `X-Archestra-Virtual-Key` alongside the provider credential, or a JWT from a configured identity provider. See [LLM Proxy Authentication](/docs/llm-proxy/authentication) for setup and examples.

The [Unified Model API](/docs/llm-proxy/unified-model) accepts standard virtual keys and LLM OAuth tokens. Management routes under `/api/*` use the [REST API authentication](/docs/reference/api#authentication) described on the API overview.

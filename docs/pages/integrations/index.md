---
title: Integrations
description: Connect AI clients and agent frameworks to the LLM Proxy and MCP Gateway
order: 8
lastUpdated: 2026-10-06
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

An integration connects your existing AI client to Archestra. Model requests route through the LLM Proxy for central authentication, audit logging, spending controls, and security guardrails. Clients that support MCP can also use the MCP Gateway to invoke tools assigned to an Archestra agent or gateway.

Choose the guide for your client:

- **Coding Clients:** start with [Connect Your Agents](/docs/get-started/connect) for quick setup. [Claude Code](/docs/integrations/claude-code) covers subscription and API-key inference routing.
- **Claude Desktop:** use the [Claude Desktop](/docs/integrations/claude-desktop) setup helper for guided installation, conversation import, and recovery.
- **Hosted Agents:** connect a [Microsoft Foundry](/docs/integrations/foundry) agent to an MCP Gateway for enterprise tool execution.
- **Web UIs & Automation:** connect [n8n and Open WebUI](/docs/integrations/web-ui-and-automation) to the proxy and gateway.
- **AI SDKs & Frameworks:** route [Vercel AI SDK, Pydantic AI, and Mastra](/docs/integrations/sdks-and-frameworks) model calls through Archestra.

An LLM virtual key authenticates model requests. A gateway token authenticates MCP calls. They are separate credentials; use each with its matching endpoint.

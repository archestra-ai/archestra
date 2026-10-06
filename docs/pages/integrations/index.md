---
title: Integrations
description: Connect AI clients and agent frameworks to the LLM Proxy and MCP Gateway
order: 8
sidebarChildren: false
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

An integration connects your existing AI client to Archestra. Model requests go through the LLM Proxy for authentication, logs, costs, and guardrails. Clients that support MCP can also use the MCP Gateway to call the tools assigned to an Archestra agent or gateway.

Choose the guide for your client:

- **Coding clients:** start with [Connect Your Agents](/docs/get-started/connect) for generated setup. [Claude Code](/docs/integrations/claude-code) covers subscription and API-key inference.
- **Claude Desktop:** use its [setup helper](/docs/integrations/claude-desktop), including conversation import and recovery.
- **Manual model connections:** follow [n8n](/docs/integrations/n8n), [Open WebUI](/docs/integrations/openwebui), or the SDK and framework guides below.
- **Hosted tools:** connect a [Microsoft Foundry](/docs/integrations/foundry) agent to an MCP Gateway. Foundry continues to host the model.

An LLM virtual key authenticates model requests. A gateway token authenticates MCP calls. They are separate credentials; use each with its matching endpoint.

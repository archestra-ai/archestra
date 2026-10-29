---
title: Reference
description: Look up environment variables, permissions, API endpoints, built-in MCP tools, and the Apps SDK
order: 10
lastUpdated: 2026-10-19
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Look up an exact value here: an environment variable, a permission, an endpoint, or a built-in tool.

You can manage Archestra in three ways, and all three check the same [permissions](/docs/reference/permissions):

- **Web app:** for people.
- **[Platform API](/docs/reference/api):** for scripts and CI, with an API key.
- **[Archestra MCP Server](/docs/reference/archestra-mcp-server):** for agents. Its built-in tools create agents, install MCP servers, and query knowledge, as the person using the agent.

Deployment-wide settings that the web app does not show are [environment variables](/docs/admin/deployment/configuration). An [MCP App](/docs/chat/apps) calls platform tools through the [Apps SDK](/docs/reference/apps-sdk), as the person viewing it.

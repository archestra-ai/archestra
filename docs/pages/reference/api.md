---
title: "API Reference"
description: "Authenticate platform API requests and explore the endpoint reference."
order: 1
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

The platform API manages Archestra resources — agents, MCP servers, policies, users — from scripts and integrations. For model requests and MCP tool calls, see [LLM Proxy Authentication](/docs/llm-proxy/authentication) and [MCP Authentication](/docs/mcp/authentication) instead.

## Authentication

Send an API key in the `Authorization` header, without a `Bearer` prefix:

```bash
curl -H "Authorization: arch_..." https://archestra.example.com/api/agents
```

Protected endpoints return `401` without a valid key or session. A key whose role lacks the endpoint's permission returns `403`.

### Personal API Keys

A personal API key acts as the user who created it. Its permissions always match that user's current role. Use personal keys for local scripts and your own automation.

To create one, click your name in the sidebar, go to **API Keys**, and click **Create API Key**. Copy the key right away. You cannot view it again.

### Service Accounts

A service account is an organization-owned identity for CI, scheduled jobs, and shared integrations. Its keys keep working when the person who created them leaves.

Go to **Settings → Service Accounts**, click **Create service account**, and assign it a role. Then open the account and click **Create API key**. Disabling or deleting the account stops all of its keys. To rotate a key, create a new one, switch your clients to it, and delete the old one. See [LLM API Permissions](/docs/admin/access-control#llm-api-permissions) for the roles that export costs and logs.

## Endpoints

:::swagger-ui
:::

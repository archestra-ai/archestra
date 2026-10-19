---
title: "API Reference"
description: "Authenticate scripts and CI with an API key, then browse every platform endpoint"
order: 3
lastUpdated: 2026-10-20
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Automate anything the web app does from scripts and CI: create agents, install MCP servers, change policies, and export costs and logs. The web app runs on this same API, and every endpoint checks the same [permissions](/docs/reference/permissions).

This API manages Archestra. To send model requests or call MCP tools, use the [LLM Proxy](/docs/llm-proxy/authentication) or an [MCP Gateway](/docs/mcp/authentication) instead.

## Authentication

Send an API key in the `Authorization` header, without a `Bearer` prefix:

```bash
curl -H "Authorization: arch_..." https://archestra.example.com/api/agents
```

A request without a valid key returns `401`. A key whose role lacks the endpoint's permission returns `403`.

Use one of two kinds of key:

- **Personal API key:** acts as you, with your current permissions. Use it for your own scripts.
- **Service account key:** belongs to the organization, so it keeps working after the person who made it leaves. Use it for CI, scheduled jobs, and shared integrations.

### Personal API Keys

Click your name in the sidebar, go to **API Keys**, and click **Create API Key**. Copy the key right away. You cannot view it again.

### Service Accounts

1. Go to **Settings → Service Accounts** and click **Create service account**.
2. Give it a role that holds only the permissions the job needs.
3. Open the account and click **Create API key**.

- To export organization-wide costs, the role needs [`llmCost:read`](/docs/reference/permissions#llmCost:read). Add [`member:read`](/docs/reference/permissions#member:read) to break costs down by person.
- To export every log, the role needs [`log:read`](/docs/reference/permissions#log:read) and [`log:admin`](/docs/reference/permissions#log:admin).
- To rotate a key, create a new one, move your clients to it, and delete the old one. Disabling or deleting the account stops all its keys.

## Leave Out Agent Tools

Add `includeTools=false` to read agents without their tools. The tools are most of the response, because each one carries its name and description. These endpoints include them by default:

- `GET /api/agents`
- `GET /api/agent-catalog`
- `GET /api/mcp-gateways/default`

```bash
curl -H "Authorization: arch_..." "https://archestra.example.com/api/agents?includeTools=false"
```

- `toolsCount` and `subagentsCount` are always present.
- With `includeTools=false`, `tools` is an empty array. It means "not requested", not "no tools assigned".

## Endpoints

:::swagger-ui
:::

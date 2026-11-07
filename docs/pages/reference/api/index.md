---
title: "API Reference"
description: "Find Archestra API endpoints by task, with request and response fields alongside each operation"
order: 3
lastUpdated: 2026-11-07
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Automate management tasks from scripts and CI: create agents, install MCP servers, change policies, and export costs and logs. Management endpoints check the same [permissions](/docs/reference/permissions) as the web app.

These topic pages also include the [LLM Proxy](/docs/reference/api/llm-proxy) and [MCP Gateway](/docs/reference/api/mcp-gateway) transport endpoints. Their authentication differs from management requests; check each operation before calling it.

## Authentication

For management requests, send an API key in the `Authorization` header, without a `Bearer` prefix:

```bash
curl -H "Authorization: arch_..." https://archestra.example.com/api/agents
```

A management request without a valid key returns `401`. A key whose role lacks the endpoint's permission returns `403`.

Use one of two kinds of key:

- **Personal API key:** acts as you, with your current permissions. Use it for your own scripts.
- **Service account key:** belongs to the organization, so it keeps working after the person who made it leaves. Use it for CI, scheduled jobs, and shared integrations.

### Personal API Keys

Click your name in the sidebar, go to **API Keys**, and click **Create API Key**. Copy the key right away. You cannot view it again.

### Service Accounts

1. Go to **Settings → Service Accounts** and click **Create service account**.
2. Give it a role that holds only the permissions the job needs.
3. Open the account and click **Create API key**.

- To export organization-wide costs, the role needs [`llmCost:read`](/docs/reference/permissions#llmCost:read). Add [`member:read`](/docs/reference/permissions#member:read) to break costs down by person, agent, or virtual key; without it, those breakdowns cover only the account's own usage.
- To export every log, the role needs [`log:read`](/docs/reference/permissions#log:read) and [`log:admin`](/docs/reference/permissions#log:admin).
- To rotate a key, create a new one, move your clients to it, and delete the old one. Disabling or deleting the account stops all its keys.
- For CI that can get an OIDC token, such as GitHub Actions, skip the key: use [Workload Identity Federation](/docs/admin/identity/workload-identity).

<span id="leave-out-agent-tools"></span>
## Explore the API

Choose a topic below to find the endpoints, parameters, permissions, and response fields for your task. The [OpenAPI document](https://raw.githubusercontent.com/archestra-ai/archestra/main/docs/openapi.json) remains available for code generation.

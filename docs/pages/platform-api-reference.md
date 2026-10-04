---
title: "API Reference"
category: Archestra Platform
description: "Authenticate platform API requests and explore the endpoint reference."
order: 6
lastUpdated: 2026-10-03
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Use the platform API to manage Archestra resources from scripts and integrations. The interactive reference below lists endpoints, request parameters, and responses.

## Authentication

Use a personal API key or service account token in the `Authorization` header.

### Personal API Keys

Personal API keys are owned by one user. Create them in the API Keys section in **Personal Settings** — click your name in the sidebar. They use the owner's current role, so permission changes to that user immediately affect the key.

Use personal keys for local scripts, development tools, and user-owned automation.

### Service Accounts

Service accounts are organization-owned identities for automation. Create them from **Settings → Service Accounts**, assign a role, and create an API key.

Service account requests authorize from the service account's assigned role. Disable or delete the service account to stop all its keys. Delete an individual key when rotating credentials.

See [LLM API Permissions](/docs/platform-access-control#llm-api-permissions) for cost and log export roles.

Use service accounts for CI, scheduled jobs, and shared integrations. These credentials remain independent of individual users.

## Endpoints

For model requests and MCP tools, see [LLM Proxy Authentication](/docs/platform-llm-proxy-authentication) and [MCP Authentication](/docs/mcp-authentication).

:::swagger-ui
:::

---
title: API Reference
description: Authenticate management requests, filter resources, and update permissions safely
order: 1
lastUpdated: 2026-10-15
---

Manage agents, servers, policies, and users from scripts or CI through the platform API. Model inference uses [LLM Proxy authentication](/docs/llm-proxy/authentication); MCP calls use [MCP authentication](/docs/mcp/authentication).

## Authentication

Send the API key directly in `Authorization`, without `Bearer`. Keep it in an environment variable rather than source code.

```bash
curl --fail-with-body \
  -H "Authorization: $ARCHESTRA_API_KEY" \
  "https://archestra.example.com/api/agents"
```

A valid response confirms authentication and permission to list agents. Protected endpoints return `401` for missing or invalid authentication and `403` for insufficient permissions.

### Personal API Keys

A personal key acts as its creator with their current permissions, including assigned roles and resource grants.

Click your name in the sidebar, open **API Keys**, and choose **Create API Key**. Copy the value when shown; you cannot view it again.

### Service Accounts

Use a service account for CI or shared automation that must outlive its creator.

1. Open **Settings → Service Accounts → Create service account**.
2. Assign the roles needed by the job.
3. Share the required resources with the service account through their **Permissions** controls.
4. Open the account and choose **Create API key**.
5. Test a read request before enabling the job.

Disabling or deleting the account stops its keys. To rotate, create a replacement, switch clients, verify access, then delete the old key. See [LLM API permissions](/docs/reference/permissions#llm-api-permissions) for usage and log exports.

## Resource Access Filters

Resource lists supporting [access filters](/docs/admin/access-control#find-resources-by-access) accept these query parameters.

| Parameter | Values |
| --- | --- |
| `access` | Comma-separated `mine`, `shared`, `org`, or `others`. |
| `sharedWith` | Comma-separated `org`, `role:<id>`, `team:<id>`, `user:<id>`, or `serviceAccount:<id>`. |
| `owner` | Comma-separated user IDs. |

For `access`, `shared` matches personal or team sharing, `org` includes organization or role sharing, and `others` selects access through organization-wide authority. The UI's **Shared with me** combines `shared` and `org`; **Admin access** adds `others`. Omit `access` for every readable item.

For `sharedWith`, `org` matches grants to everyone, not role grants. Models have no owner filter; Knowledge Files filters apply to documents while directories remain visible. Check each endpoint's schema below for supported combinations.

## Resource Permissions

Read the current policy before replacing direct grants through the [permissions endpoints](/docs/reference/api#/Permissions/getResourcePermissions).

[`GET /api/resource-permissions/<resource>/<scope>`](/docs/reference/api#/Permissions/getResourcePermissions) returns the policy's `revision`, direct `grants`, `inheritedGrants`, and your `effectiveActions`. A scope is one item ID or `*` for every item of that kind.

Send `PUT` to the same URL with:

```json
{
  "revision": 3,
  "grants": [
    {
      "subject": {"type": "user", "id": "<existing-policy-manager-id>"},
      "actions": ["read", "use", "update", "delete", "manage-permissions"]
    },
    {
      "subject": {"type": "serviceAccount", "id": "<service-account-id>"},
      "actions": ["read", "use"]
    }
  ]
}
```

Replace the example revision and IDs with values from your policy and service account. Include every existing direct grant you intend to retain, especially the recipient managing access. The request replaces direct grants; inherited grants remain.

What to know:

- Use a service account ID, never an API-key ID.
- For an item, you need **Manage access** and can delegate only actions you hold. Reading a `*` policy needs [`accessPolicies:read`](/docs/reference/permissions#accessPolicies:read); updating it needs [`accessPolicies:update`](/docs/reference/permissions#accessPolicies:update).
- A concurrent save changes the revision. Read again and reconcile; do not retry with an invented revision.

## Endpoints

Choose an operation below to inspect its request, response, and required fields.

:::swagger-ui
:::

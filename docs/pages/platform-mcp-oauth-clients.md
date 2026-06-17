---
title: OAuth Clients
category: MCP
order: 1.5
description: Service account credentials for MCP gateways
lastUpdated: 2026-06-17
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

MCP OAuth clients are registered service accounts that call MCP gateways with OAuth client credentials. Use them when a backend service, automation job, or another team's bot needs machine-to-machine access to specific gateways, without a human user signing in.

This is the MCP equivalent of [LLM OAuth clients](/docs/platform-llm-proxy-authentication): the client receives a `client_id` and a one-time `client_secret`, exchanges them for a short-lived (1-hour) bearer token using the OAuth 2.0 `client_credentials` grant, and uses that token as the gateway bearer token. The grant follows the [MCP Authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), which models the gateway as a standard OAuth 2.1 resource server.

An MCP OAuth client is scoped to an explicit list of gateways. A token it issues is only accepted by the gateways on that list, so one team can hand a client to another team for access to a curated set of gateways and nothing else.

## Managing OAuth Clients

1. Go to **MCPs > Credentials > OAuth Clients**
2. Create an OAuth client
3. Select the gateways it can access
4. Copy the generated `client_id` and `client_secret` (the secret is shown only once)

Edit an OAuth client later to update its name or its allowed gateways. Rotate the client secret when the existing secret needs to be replaced; existing tokens keep working until they expire, but new tokens can only be issued with the new secret.

## Getting an Access Token

```bash
curl -X POST "https://archestra.example.com/api/auth/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  -d "scope=mcp"
```

The response contains a 1-hour `access_token`. The token is rejected by any gateway not in the client's allowed list, and by gateways in another organization.

## Calling a Gateway

Use the access token as the gateway bearer token, exactly like a static gateway token:

```bash
curl -X POST "https://archestra.example.com/v1/mcp/{gatewayId}" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'
```

## Shared Credential, Not a User Identity

An MCP OAuth client is a shared service account with no acting user. Gateway tools that resolve a per-user upstream credential at call time (**Resolve at call time**) have no user to resolve for these tokens. For gateways consumed by service accounts, assign tools to a specific installed MCP server connection (a shared or service-account credential) rather than relying on per-user resolution.

MCP tool-call logs record the authenticated OAuth client as the caller. Use this to audit which service account invoked which tools.

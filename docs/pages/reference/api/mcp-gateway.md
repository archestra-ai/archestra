---
title: MCP Gateway
description: Send MCP protocol requests and connect MCP Apps to clients
order: 3
lastUpdated: 2026-11-04
---

Send MCP protocol requests through an agent's gateway or connect an MCP App to a client.

The `/v1/mcp/{profileId}` endpoints carry MCP protocol traffic. The `/api/mcp/*` endpoints serve MCP App runtime connections. See [MCP servers and catalog](/docs/reference/api/mcp) to manage which servers and tools are available.

## Authentication

For `/v1/mcp/{profileId}`, send `Authorization: Bearer <credential>`. MCP clients can sign in through OAuth; scripts can use a platform token. A gateway can also accept JWTs from its configured identity provider. See [MCP Gateway Authentication](/docs/mcp/authentication/gateway) for the supported methods.

For your own application, use an [OAuth client](/docs/mcp/authentication/applications) with `mcp` scope and access to the gateway. MCP App runtime routes under `/api/mcp/*` have separate authentication requirements, listed on each operation below.

---
title: MCP Gateway
category: MCP
order: 1
description: Unified access point for all MCP servers
lastUpdated: 2026-04-23
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This document is human-built, shouldn't be updated with AI. Don't change anything here.

Exception:
- Screenshot
-->

MCP Gateways are the MCP endpoints you expose to clients such as Cursor, Claude Desktop, Open WebUI, and custom agents. Each gateway presents a curated set of tools through one MCP endpoint, so clients do not need to connect to every MCP server directly.

Use separate gateways when different clients, teams, or environments need different tool sets or authentication rules. For example, one gateway might expose developer tools to an engineering team, while another exposes support tools to a customer operations agent.

## Gateway Model

A gateway is a named MCP surface. It has its own visibility, authentication settings, and assigned tools. The same installed MCP server can appear behind multiple gateways, but each gateway decides which clients can reach it and which tools are exposed.

Create or edit gateways from **MCPs > Gateways**. A usable gateway needs:

- at least one assigned tool
- a supported client authentication path
- visibility that matches the users or teams that should call it

Tool assignments can point to a specific installed MCP server connection or use **Resolve at call time**. Resolve-at-call-time is useful when the same gateway should use the caller's own GitHub, Jira, or other upstream credential instead of a shared connection.

After the gateway is configured, use **Connect** to copy connection details for supported clients.

## Tool Assignment Mode

A gateway has a tool assignment mode: **Manual** (default) or **Automatic**.          

In **Manual** mode, an admin picks each tool individually. Each assignment can be pinned to a specific installed MCP server connection, or use **Resolve at call time** (see Gateway Model above).

In **Automatic** mode, the gateway's tools are derived from labels. The gateway receives every tool from every [catalog entry](/docs/platform-private-registry#labels) that shares at least one `key: value` label pair with the gateway. For example, a gateway labeled `department: finance` automatically receives tools from every MCP catalog item tagged `department: finance`. These tools are kept in sync when labels are changed or new catalog items are added.

When Automatic mode is used together with [Search-and-run tool mode](#search-and-run-tool-mode), matched tools are not exposed directly through MCP `tools/list`. The label-matched catalog tools define the full set of tools that `search_tools` can discover and `run_tool` can execute behind the scenes.

**Automatic** mode puts some constraints on upstream MCP servers:

1. The gateway will inherit _all_ tools from matched catalog items, not a configurable subset of the MCP server tools.
2. Credential resolution is set to **Resolve at call time** for all upstream MCP servers. Each caller must have their own access to the upstream MCP servers. Gateways that need a single shared service-account connection should stay in **Manual** mode.

**Example.** A finance team owns five catalog entries today — Snowflake, NetSuite, Stripe, Salesforce, and Confluence — and expects to add more over time. The admin tags each entry `department: finance` and creates an MCP gateway labeled the same. The gateway picks up every tool from those five entries without manual wiring. When the team adds an SAP integration to the registry six months later, only that catalog entry needs the `department: finance` label; the gateway includes its tools on the next save. 

## Authentication

Gateway authentication and upstream MCP server authentication are separate. The client authenticates to Archestra first. When a tool runs, Archestra resolves the credential needed by that specific upstream MCP server.

```mermaid
graph LR
    subgraph Clients
        C1["Cursor / IDE"]
        C2["Open WebUI"]
        C3["Agent App"]
    end

    subgraph Archestra["Archestra Platform"]
        GW["MCP Gateway"]
        CR["Credential<br/>Resolution"]
        GW --> CR
    end

    subgraph Passthrough["Remote MCP Servers"]
        U1["GitHub"]
        U2["Atlassian"]
        U3["ServiceNow"]
    end

    subgraph Hosted["Self-hosted MCP Servers"]
        H1["Custom Server"]
        H2["Internal Tool"]
    end

    C1 -- "Gateway Token" --> GW
    C2 -- "Gateway Token" --> GW
    C3 -- "Gateway Token" --> GW
    CR -- "Upstream MCP Server Token" --> U1
    CR -- "Upstream MCP Server Token" --> U2
    CR -- "Upstream MCP Server Token" --> U3
    CR -- "stdio or HTTP" --> H1
    CR -- "stdio or HTTP" --> H2

    style GW fill:#e6f3ff,stroke:#0066cc,stroke-width:2px
    style CR fill:#fff,stroke:#0066cc,stroke-width:1px
```

MCP Gateways support four client authentication paths:

- **OAuth 2.1**: MCP-native clients authenticate through the [MCP Authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization). Archestra supports Authorization Code + PKCE, DCR, CIMD, and standard well-known discovery.
- **ID-JAG**: Enterprise-managed MCP clients exchange an identity assertion JWT for an Archestra-issued MCP access token scoped to the gateway.
- **Identity Provider JWKS**: Clients send an external IdP JWT directly to the gateway. Archestra validates it against the IdP's JWKS and matches the caller to an Archestra user.
- **Bearer Token**: Direct integrations send `Authorization: Bearer arch_<token>`. Tokens can be scoped to a user, team, or organization.

Use OAuth 2.1 for standard MCP clients, ID-JAG or JWKS for enterprise-managed identity, and bearer tokens for direct service integrations or simple local setup.

See [MCP Authentication](/docs/mcp-authentication) for more details.

## Access Control

Gateway access depends on both the caller and the gateway configuration. A user must be allowed to see the MCP Gateway, usually through organization visibility or team membership, and the gateway must have the specific tool assigned to it.

If a gateway is scoped to one team, members outside that team cannot use it even if the underlying MCP server exists in the registry. This lets admins approve MCP servers centrally while still exposing different tool sets to different teams or clients.

See [Access Control](/docs/platform-access-control) for the permission model.

## Search-and-Run Tool Mode

By default, a gateway exposes every assigned tool through MCP `tools/list`.

For larger toolsets, you can enable **Search-and-run tool mode** in the gateway dialog. In that mode, clients only see the built-in [`search_tools`](/docs/platform-archestra-mcp-server#search_tools) and [`run_tool`](/docs/platform-archestra-mcp-server#run_tool) tools.

Those two tools are enabled implicitly by the mode and do not appear in the built-in tool picker. The rest of the gateway's assigned tools stay available behind the scenes:

- `search_tools` can discover them
- `run_tool` can execute them

Use this when the full tool list is too large or noisy to send to the model on every turn, but the gateway still needs the same underlying tool access.

## Custom Headers

MCP Gateways can forward selected client request headers to downstream HTTP-based MCP servers. Use this for request-specific context such as correlation IDs, tenant IDs, or other application headers that need to reach the server handling the tool call.

Configure the allowlist in the gateway's **Advanced** section. Only headers on the allowlist are forwarded; all others are dropped. Header names are case-insensitive and stored in lowercase.

Gateway header passthrough does not override credentials managed by Archestra. If a forwarded header conflicts with an upstream credential header such as `Authorization`, the credential resolved by Archestra takes precedence.

Header passthrough applies to remote MCP servers and local MCP servers using streamable-http transport. Stdio-based servers do not support HTTP headers.

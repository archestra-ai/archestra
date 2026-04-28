---
title: Private MCP Registry
category: MCP
order: 2
description: Managing your organization's MCP servers in a private registry
lastUpdated: 2026-04-27
---

<!--
Check ../docs_writer_prompt.md before changing this file.

-->

![MCP Registry](/docs/platform-mcp-registry-overview.webp)

The Private MCP Registry is the catalog of MCP servers approved for your organization. It defines what servers exist, how they should be configured, who can see them, and what credentials are required when someone installs them.

A registry entry is a reusable template. An installation is the actual connection created from that template for a person or team. Agents and [MCP Gateways](/docs/platform-mcp-gateway) use installed connections when they call tools.

## Registry Entries And Installations

An MCP server usually moves through this lifecycle:

1. An admin adds a registry entry.
2. A user or team installs the entry and provides any required credentials.
3. Archestra discovers the server's tools and stores the installation.
4. An Agent or MCP Gateway is assigned tools from that installation.
5. When a tool runs, Archestra resolves the correct installation and upstream credential.

This separation lets admins curate a small approved catalog while still allowing each user or team to connect with their own credentials.

## Server Configuration

Registry entries can describe either a remote server or a self-hosted server.

**Remote servers** run outside Archestra and are reached over HTTP. Use this for provider-hosted MCP servers or internal services already operated by another team. The registry entry stores the server URL, optional docs URL, authentication configuration, and any install-time fields users must provide.

**Self-hosted servers** run in Kubernetes through the [MCP Orchestrator](/docs/platform-orchestrator). Use this when Archestra should own the runtime. The registry entry can define the command, arguments, Docker image, transport type, environment variables, image pull secrets, and optional deployment YAML overrides.

Self-hosted servers support two transports:

- **stdio**: the default transport. Archestra runs the server process and communicates with it over standard input/output.
- **streamable-http**: runs the server as an HTTP service inside the cluster. Use this when the server needs concurrent requests, HTTP headers, or per-request credential injection.

## Credentials

The registry entry defines what credential model an installation uses. The installation stores the actual secret, OAuth token, or enterprise credential configuration.

Common patterns are:

- **No auth** for internal tools that do not call external APIs.
- **Static credentials** such as API keys, PATs, or service account tokens.
- **OAuth 2.1** for per-user SaaS access with browser authorization and automatic refresh.
- **OAuth client credentials** for shared machine-to-machine access.
- **Enterprise IdP token exchange** when Archestra should exchange the caller's enterprise identity for a downstream credential.
- **Enterprise JWT / JWKS passthrough** when the upstream MCP server validates the caller's IdP JWT itself.

Static credential fields can be prompted during installation or stored once on the catalog item. The primary credential can be injected as `Authorization`, `Authorization: Bearer`, or a custom header such as `x-api-key`, depending on what the upstream MCP server expects.

Registry entries can also define **Additional Headers** for non-auth values that should be sent on every downstream request, such as tenant IDs, API version headers, or feature flags. These headers are attached by Archestra when it calls the upstream MCP server. They are different from gateway header passthrough, which forwards selected headers from the incoming MCP client request.

See [MCP Authentication](/docs/mcp-authentication) for the full gateway and upstream credential model.

## Installation Scope

Installations can be personal or team-scoped.

- **Personal installations** are owned by one user and are useful when each person needs their own upstream account.
- **Team installations** are shared with a team and are useful for shared service accounts or team-owned integrations.

When assigning tools to an Agent or MCP Gateway, you can pin a specific installation or use **Resolve at call time**. Resolve-at-call-time resolves deterministically from the caller identity and the available personal or team-scoped credentials. If no credential can be resolved, Archestra returns an error with an install link.

See [Credential Resolution](/docs/mcp-authentication#credential-resolution) for the resolution order and missing credential behavior.

## Labels

Registry entries can carry labels — key-value pairs set under **Labels** in the registry form. Labels organize the catalog and act as a selector for [MCP Gateways](/docs/platform-mcp-gateway#tool-assignment-mode) in **Automatic** tool assignment mode. A gateway in Automatic mode receives every tool from every registry entry that shares at least one `key: value` label pair with the gateway.

For example, every catalog entry tagged `department: finance` is automatically wired into a gateway tagged `department: finance`. Adding or removing labels on a registry entry reconciles the affected gateways in sync.

## From Registry To Gateway

The registry does not expose tools to clients by itself. After a server is installed, Archestra discovers the tools exposed by that installed connection. Those tools become usable after they are assigned to an Agent or MCP Gateway.

For external MCP clients, create or edit an [MCP Gateway](/docs/platform-mcp-gateway), assign tools from installed registry entries (or use Automatic tool assignment mode to derive them from labels), then connect the client to the gateway endpoint. For built-in Archestra agents, assign the same tools from the agent's tool configuration.

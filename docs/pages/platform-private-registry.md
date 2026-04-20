---
title: Private MCP Registry
category: MCP
order: 2
description: Managing your organization's MCP servers in a private registry
lastUpdated: 2026-04-20
---

<!--
Check ../docs_writer_prompt.md before changing this file.

-->

![MCP Registry](/docs/platform-mcp-registry-overview.png)

The Private MCP Registry is the catalog of MCP servers approved for your organization. It defines what servers exist, how they should be configured, who can see them, and what credentials are required when someone installs them.

A registry entry is a reusable template. An installation is the actual connection created from that template for a person or team. Agents and [MCP Gateways](/docs/platform-mcp-gateway) use installed connections when they call tools.

## Registry Entries And Installations

An MCP server usually moves through this lifecycle:

1. An admin adds a registry entry or approves an installation request.
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

The registry entry defines what credential model an installation uses. The installation stores the actual secret or OAuth token.

Common patterns are:

- **No auth** for internal tools that do not call external APIs.
- **Static credentials** such as API keys, PATs, or service account tokens.
- **OAuth 2.1** for per-user SaaS access with browser authorization and automatic refresh.
- **OAuth client credentials** for shared machine-to-machine access.
- **Enterprise IdP token exchange** when Archestra should exchange the caller's enterprise identity for a downstream credential.
- **Enterprise JWT / JWKS passthrough** when the upstream MCP server validates the caller's IdP JWT itself.

See [MCP Authentication](/docs/mcp-authentication) for the full gateway and upstream credential model.

## Installation Scope

Installations can be personal or team-scoped.

- **Personal installations** are owned by one user and are useful when each person needs their own upstream account.
- **Team installations** are shared with a team and are useful for shared service accounts or team-owned integrations.

When assigning tools to an Agent or MCP Gateway, you can pin a specific installation or use **Resolve at call time**. Resolve-at-call-time lets Archestra choose the best credential for the current caller, which is the usual pattern for per-user credentials.

## Requests And Governance

Members can request new MCP servers from the external catalog or request a custom server. Admins review these requests from **MCP Registry > Installation Requests** and can approve or decline them with a response.

Requests keep registry changes controlled without blocking users from asking for new tools. Once approved, the server becomes available through the internal registry and follows the same installation, credential, and tool assignment flow as any other entry.

## Labels

Labels are key-value pairs that you can assign to MCP servers in the registry to organize and categorize them. For example, you might label servers by category (`database`, `ai`, `communication`), environment (`production`, `staging`), or team ownership.

Labels are useful for filtering the registry and keeping large catalogs understandable. They do not grant access by themselves; access comes from registry visibility, installation scope, team assignment, and RBAC.

## From Registry To Gateway

The registry does not expose tools to clients by itself. Tools become usable after they are assigned to an Agent or MCP Gateway.

For external MCP clients, create or edit an [MCP Gateway](/docs/platform-mcp-gateway), assign tools from installed registry entries, then connect the client to the gateway endpoint. For built-in Archestra agents, assign the same tools from the agent's tool configuration.

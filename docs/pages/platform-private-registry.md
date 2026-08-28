---
title: Private MCP Registry
category: MCP
order: 2
description: Managing your organization's MCP servers in a private registry
lastUpdated: 2026-08-27
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

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

## Finding Servers

Cards and table rows use the same active sort. Choose **Action required** when you want flagged servers first.

The scope filter narrows the list to **Personal**, **Team**, or **Organization**. An administrator can use **Other users** inside Personal to review another member's private entries and connections. Those oversight rows stay out of the default list.

Cards and table rows identify their owner or shared scope with a visibility badge. The table keeps one continuous list and shows the same badge in **Accessible to**. A dot over each self-hosted server icon shows runtime status in both views. Hover it for pod counts or idle-hibernation details. The table's **Status** column shows installation state and active alerts.

Selecting rows or cards replaces the filter controls with the matching bulk actions. Shift-click extends the selection across the visible range. The list does not move or reserve an empty action bar while nothing is selected.

Entries that expose a UI carry an **App** badge. Each [owned MCP App](./platform-apps) is also backed by its own registry entry: it appears here as a read-only card (visible to users with `app:read`) whose pencil manages the app's server settings — visibility, environment, assigned tools, and deletion — while authoring stays at `/a/:id`.

## Server Configuration

Every server has a page of its own. Its environment appears beside the server type in the header. The collapsed **Overview** keeps only useful runtime, connection, and configured authentication facts; commands, installation prompts, environment variables, generated defaults, and secret values stay in the editor or installation flow. Personal and shared **Credentials** or **Installations** remain visible below the Overview, while Usage and runtime diagnostics stay in dedicated tabs. **Edit** in the page header reopens the wizard and remains the place to inspect exact configuration.

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

A personal installation is a hard usage boundary: its credential can only ever authenticate calls made by the person who added it. It cannot be assigned, pinned, or borrowed by another user — not even by an Admin. Predefined Admins can see limited connection metadata and revoke a connection for operational oversight, but cannot use its credential. The **Inspector** honors the same boundary: it calls the server as the selected connection, so it offers only your own connections and the ones shared with you.

If a static credential is intended to be shared, add it explicitly as a **team or organization service account**. This makes the shared intent and audience visible instead of turning a person's identity into an implicit service account.

Personal installations are removed — credentials included — when their owner is deleted or leaves the organization. Team and organization installations survive their installer.

When assigning tools to an Agent or MCP Gateway, you can pin a team or organization service account, or use **Resolve at call time**. Personal installations are available only through resolve-at-call-time, which resolves deterministically from the caller identity and never exposes a person's credential as a reusable static option. If no credential can be resolved, Archestra returns an error with an install link.

See [Credential Resolution](/docs/mcp-authentication#credential-resolution) for the resolution order and missing credential behavior.

## Labels

Registry entries can carry labels — key-value pairs set under **Labels** in the registry form. Labels organize the catalog and make registry entries easier to filter and manage.

## Environments

A catalog entry can be assigned to a deployment [environment](/docs/platform-environments). The environment determines the Kubernetes namespace and network egress policy its installed MCP server runs under, and scopes which agents and gateways can use the server's tools (an agent only sees servers in its own environment). Restricted environments gate assignment behind the `mcpRegistry:deploy-to-restricted` permission.

See [Environments](/docs/platform-environments) for the full isolation model and [network egress policies](/docs/platform-environments#network-egress-policies) (including the provider support matrix and domain presets).

## From Registry To Gateway

The registry does not expose tools to clients by itself. After a server is installed, Archestra discovers the tools exposed by that installed connection. Those tools become usable after they are assigned to an Agent or MCP Gateway.

For external MCP clients, create or edit an [MCP Gateway](/docs/platform-mcp-gateway), assign tools from installed registry entries (or use Automatic tool assignment mode to derive them from labels), then connect the client to the gateway endpoint. For built-in Archestra agents, assign the same tools from the agent's tool configuration.

Each registry card shows how many agents and gateways can reach the server. Hover the count to list them, grouped by how they get access — an explicit tool assignment, or Automatic tool assignment mode. The server's **Usage** tab shows the same list as a read-only table. Personal agents all share a name, so each one is labelled with its owner. The uninstall dialog lists them too, so you can see who is affected before removing a connection.

## Needs Attention

> **Beta:** MCP server alerting is deployment-gated and off by default. Set `ARCHESTRA_MCP_SERVER_ALERTING_ENABLED=true` to enable attention ordering, diagnostics, ownership guidance, and per-viewer dismissal. A blank value follows the `ARCHESTRA_BETA` master switch.

A server is flagged only when it cannot operate: its pod failed to start, it stopped running, or its stored credential was rejected. Pending installs, image approvals, and configuration changes that leave the running server untouched are never flagged.

The registry's **Action required** sort puts flagged servers first. The sidebar count opens a table-only attention view for the servers you can fix. Each row shows the issue and the connection owner or required admin role. Use the **Issue** filter to narrow the table to failed starts, stopped servers, or rejected credentials. Issue-specific remediation stays visible in the Actions column; a row leaves only when its health signal clears. **Re-authenticate** opens a compact credential-repair form for the affected connection directly on the server details page. **Manage credentials** remains the broader view for listing, adding, and revoking connections.

Every alert can be dismissed from your queue without hiding the problem from other viewers. You can optionally add a reason; the **Dismissed** view shows it in the **Dismiss reason** column and lets you restore the alert. Select several servers to dismiss their alerts or remove their affected connections together. Bulk removal requires every selected row to identify connections you are allowed to remove and always asks for confirmation. A dismissal is pinned to one failure episode and expires automatically when the underlying failure changes.

## Refreshing Tools

Archestra stores the tool list discovered at install time. When the upstream server adds or changes tools, refresh the stored list — no reinstall needed. Tool assignments and policies are preserved.

- **Inspector**: open the server's Inspector tab and click **Refresh Tools**.
- **API**: `POST /api/mcp_server/:id/reload-tools`.
- **Automatic**: set `ARCHESTRA_MCP_SERVER_TOOLS_REFRESH_INTERVAL_MINUTES` to re-sync every installed server on an interval. See [Deployment](/docs/platform-deployment).

## Uninstalling and Restoring

Uninstalling an installation is a recoverable delete. Archestra tears down the running server and its Kubernetes secret, but keeps the installation row and its stored credentials. Nothing is erased.

The name is freed immediately. You can create a new registry entry with the name an uninstalled one used — an uninstalled entry never blocks the name.

Restoring brings the installation back marked for reinstall. It does not reconnect on its own: the credentials are still stored, so you click **Reinstall** to bring the server back up with them. You never re-enter a secret to restore.

Deleting a registry entry cascades. Archestra uninstalls every installation created from it and hides that entry's tools in one action. Restoring the entry brings back exactly the installations and tools that were removed with it, each marked for reinstall. An installation you uninstalled on its own earlier stays uninstalled — only the ones removed by this delete come back.

Viewing and restoring uninstalled entries requires the **Manage Deleted** permission (`mcpRegistry:manage-deleted` for registry entries, `mcpServerInstallation:manage-deleted` for installations). Of the predefined roles, only admins hold it; grant it to a custom role to delegate recovery.

Restore is an API action today. List uninstalled entries with `GET /api/internal_mcp_catalog?status=deleted` or uninstalled installations with `GET /api/mcp_server?status=deleted`, then restore one:

- **Installation**: `POST /api/mcp_server/:id/restore`.
- **Registry entry**: `POST /api/internal_mcp_catalog/:id/restore`.

Restoring an installation whose registry entry is still deleted is rejected — restore the entry first. Restoring is blocked when an active installation or entry already occupies the same scope or name.

## Renaming a Server

Rename a registry entry from its edit dialog. Tools take the new name prefix (`newname__tool`) immediately — no reinstall, and running servers keep running. Tool assignments and policies are preserved.

Connected MCP clients cache the tool list. After a rename they must reload it, or calls using the old tool names fail. Names are unique within the organization — a rename to a name another entry already uses is rejected. Built-in servers, like the browser preview server, cannot be renamed. App-backed registry entries cannot be renamed here either — change the name in the app's settings.

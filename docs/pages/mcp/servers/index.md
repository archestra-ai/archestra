---
title: MCP Servers
description: Add MCP servers to your organization's registry, install them, and give their tools to agents and gateways
order: 1
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

The MCP Registry is your organization's own list of approved MCP servers. Add a server once, and set it up the right way: its URL or image, how it signs in, and who can see it.

Then anyone with access installs it in a few clicks, with their own account or a shared one. Nobody copies config files or passes secrets around.

Archestra handles the hard part: signing in to each server for each person.

- [Each person's own account](/docs/mcp/servers/installing), through OAuth 2.1 or an API key they enter once. OAuth tokens refresh when the provider allows it.
- **[A shared service account](/docs/mcp/servers/installing#shared-service-accounts)** for a team or the whole organization, such as a bot.
- [Your company identity](/docs/mcp/authentication/servers#identity-provider-token-exchange), with no install at all. Archestra trades the person's identity provider token for one the server accepts, through Entra On-Behalf-Of, Okta, RFC 8693, or ID-JAG.

Archestra picks the right account for each call. See [Whose Account a Call Uses](/docs/mcp/authentication/servers#credential-resolution).

![The MCP Registry listing servers and their connection status](/docs/automated_screenshots/mcp-servers_registry.webp)

## Add and Install a Server

1. **[Add it](/docs/mcp/servers/adding):** go to **MCP Registry** and click **Add MCP Server**. Pick **Remote** for a server that runs elsewhere, or **Self-hosted** for one Archestra runs.
2. **[Install it](/docs/mcp/servers/installing):** open the server and click **Install**. Enter its credential, or sign in to it.
3. **Give its tools out:** add them to an [agent](/docs/agents) or an [MCP Gateway](/docs/mcp/gateway).

A client set up through [Connect](/docs/get-started/connect) gets the new tools right away. Its gateway offers every tool the person can use. Other agents and gateways get only the tools you pick, unless you set them to offer all tools too. See [Tool Assignment](/docs/mcp/gateway#choose-its-tools).

## Know When a Server Breaks

When a server breaks, the person who can fix it hears about it. Your GitHub sign-in expires, so you see a count next to **MCP Registry**. Your admin does not, because only you can sign in again as you.

Open the registry and sort by **Action required**. Each broken server says what to do:

- **Needs re-authentication:** click **Re-authenticate**.
- **Failed to start** or **Not running:** see [Debug a Server](/docs/mcp/servers/self-hosted#logs-and-recovery).

Waiting on someone else to fix one? Click **Dismiss** to hide it for you only.

<span id="finding-servers"></span>

## What to Know

- Remote or self-hosted? Pick remote when someone already runs the server. Pick self-hosted when Archestra should run it, hold its secrets, and show its logs.
- New tools on a server? Open it, go to **Inspector**, and click **Refresh Tools**. To refresh on a schedule, set [`ARCHESTRA_MCP_SERVER_TOOLS_REFRESH_INTERVAL_MINUTES`](/docs/reference/configuration#ARCHESTRA_MCP_SERVER_TOOLS_REFRESH_INTERVAL_MINUTES).
- **Renaming a server** renames its tools too, such as `reports__export`. Assignments and policies stay. Clients must reload their tool list.

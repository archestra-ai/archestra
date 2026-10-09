---
title: MCP Server Credentials
sidebarTitle: Server Credentials
description: Set how Archestra signs in to each MCP server, and whose account each call uses
order: 3
lastUpdated: 2026-10-06
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

These are the credentials Archestra uses to call the MCP servers behind a gateway, such as Jira or GitHub. Each MCP server signs in its own way. Set it once per server, and Archestra signs in on every call, as the right account. Ask for your open Jira tickets, and the call uses your Jira account. A status-page bot posts as the bot. Nobody pastes a key into a client.

<span id="upstream-mcp-server-authentication"></span>

## Sign-In Methods

Pick the method the server's own docs name. You set it when you [add the server](/docs/mcp/servers/adding#sign-in).

| Method | Who signs in | Pick it when |
| --- | --- | --- |
| **OAuth 2.1** | Each person, in the browser, once | The server offers OAuth. Most hosted servers do. |
| **Token header** | Each person or team, with an API key at install | The server takes an API key or a personal access token |
| **OAuth 2.0 client credentials** | One app account, with no person | The server serves machines, not people |
| **IdP token exchange** | Nobody. Archestra uses the person's company identity. | You want per-person accounts without installs. See [Company Identity](#identity-provider-token-exchange). |
| **IdP signed JWT** | Nobody. Archestra sends the person's company JWT. | The server checks your identity provider's tokens itself |

OAuth tokens refresh by themselves when the provider allows it. A **stdio** server gets its credentials once, at start, so per-call methods need **streamable-http**.

<span id="credential-resolution"></span><span id="resolve-at-call-time"></span>

## Whose Account a Call Uses

Decide per tool: should it act as the person who asks, or always as one shared account? A Jira tool should file tickets as you, so Jira shows who asked. A deploy tool can run as a bot, so nobody needs their own deploy key.

| You want | Set on the tool | Set on the server's **Connections** |
| --- | --- | --- |
| Each person acts as themselves | **Resolve at call time** | **Default credential:** **On behalf of the user** |
| Their own account, or the team's when they have none | **Resolve at call time** | **On behalf of the user**, plus a team install |
| Everyone acts as one bot | The bot's shared install | Nothing |

Set the tool's account where you [choose its tools](/docs/mcp/gateway#choose-its-tools), on the gateway or the agent. A tool pinned to a shared install always uses it, whatever the server's default says.

- Nobody's account fits? The call fails with a link to install one. Follow it, and try again.
- A personal install serves only its owner. A team install works only in agents and gateways the team can use.
- To check which account a call used, see **Identity** in the [MCP Gateway logs](/docs/admin/logs).

<span id="identity-provider-token-exchange"></span>

## Company Identity

Give every person their own account in every server, with no installs. On each call, Archestra trades the person's single sign-on token for a token the server accepts. Archestra picks the exchange from your provider:

- **Microsoft Entra ID:** On-Behalf-Of. See [Entra On-Behalf-Of](/docs/admin/identity/entra-obo).
- **Okta:** Okta's token exchange. See [Okta](/docs/admin/identity/okta).
- **Keycloak, Auth0, and other OIDC providers:** standard [RFC 8693](https://datatracker.ietf.org/doc/html/rfc8693) token exchange.
- **A server that accepts ID-JAG:** the core of MCP's Enterprise-Managed Authorization. See [what ID-JAG is](/docs/mcp/authentication/gateway#identity-assertion-jwt-authorization-grant-id-jag).

To set it up:

1. Set up your identity provider's **Enterprise-Managed Credentials**. See [Enterprise-Managed Auth](/docs/admin/identity/enterprise-managed-auth).
2. On the server, pick **IdP token exchange**, or **IdP signed JWT** if the server checks your provider's tokens itself.
3. Set the server's tools to **Resolve at call time**.

The person must sign in through OAuth, an identity provider JWT, or a personal token, and hold a usable token from your provider. A service account key has no person to exchange.

## What to Know

- OAuth refresh failed? Click **Re-authenticate** on the install.
- Changed the OAuth scopes? Reconnect to get tokens with the new scopes.
- Every call records its account. See **Identity** in the [MCP Gateway logs](/docs/admin/logs).

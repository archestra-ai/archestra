---
title: IdP Token Exchange
description: Give every person their own account in an MCP server, from their company sign-in, with no installs
order: 4
lastUpdated: 2026-11-09
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Give every person their own account in an MCP server without anyone installing it. Ask an agent for your unread mail, and the mail server sees you, not a shared bot. On each tool call, Archestra trades the person's company sign-in token for a token the server accepts, so your identity provider still decides who gets what.

Use it when the server trusts your identity provider. When it has its own sign-in, such as GitHub or Jira, use [OAuth](/docs/mcp/authentication/servers#sign-in-methods) instead. When the server checks your provider's JWT itself, pick **IdP signed JWT** instead: there is no exchange to set up.

## How Each Provider Exchanges

The exchange depends on your identity provider:

| Provider | Exchange | Set up the provider |
| --- | --- | --- |
| Microsoft Entra ID | [On-Behalf-Of](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-on-behalf-of-flow) | [Microsoft Entra ID](/docs/admin/identity/entra-obo) |
| Okta | Okta's token exchange | [Okta](/docs/admin/identity/okta) |
| Keycloak, Auth0, and other OIDC providers | [RFC 8693](https://datatracker.ietf.org/doc/html/rfc8693) token exchange | [Single Sign-On](/docs/admin/identity/sso), then **Tool Authentication** |

## Set Up a Server

Set it once per server, and every person's calls use their own account.

Before you start:

- Your identity provider's **Tool Authentication** is set up, using the guide for your provider above.
- A server that runs in your cluster uses **streamable-http** transport, so it gets a token on every call.
- People call with their own identity: through OAuth, an identity provider JWT, or a personal token, after signing in to Archestra with your provider. A team or organization token has no person to exchange.

Steps:

1. In the [MCP Registry](/docs/mcp/servers/adding), edit the server and pick **IdP token exchange** under **Authentication**.
2. Pick the **Identity Provider**, and set **Managed Resource Identifier** to the API the server calls, such as `https://graph.microsoft.com` or `api://<api-client-id>`.
3. Keep **Requested Credential** on **Bearer token** and **Injection Mode** on **Authorization: Bearer**, unless the server expects otherwise.
4. Click **Save**, then set the server's tools to **Resolve at call time** where you [choose its tools](/docs/mcp/gateway#choose-its-tools).

To check it works, call one of the server's tools. The call succeeds, and the server sees the person who asked.

## Which App the Token Is Issued To

With Entra, every downstream token names a person and an app, and Entra consent, Conditional Access, and the API's own logs all see that app. Archestra picks the app in this order:

1. **Entra agent identity:** the calling agent's own identity, when it has one. See [Microsoft Entra Agent ID](/docs/admin/identity/entra-agent-id).
2. **MCP server's client:** the server's exchange client, when it sets one. See [Give a Server Its Own Exchange Client](#give-a-server-its-own-exchange-client).
3. **Identity provider's client:** the app in your identity provider's settings, otherwise.

To see which one a call used, open it in the [MCP Gateway logs](/docs/admin/logs) and check **Token issued to**.

### Give a Server Its Own Exchange Client

Give a server its own Entra app when it needs its own consent, or must appear by name in downstream logs. It applies to Entra On-Behalf-Of. Other exchanges ignore it.

1. Register an app in Entra for this server, and grant it consent for the server's API.
2. Expose a scope on the new app, and grant the identity provider's client consent for it.
3. Edit the server in the MCP Registry, and under **Exchange Client (Optional)**, set **Client ID**.
4. Set **Client Secret**, or a **Certificate Private Key** with its **Certificate Thumbprint or Key ID**. The key wins when both are set.
5. Click **Save**.

The secret and key are write-only: the form never shows them. Leave them blank to keep the stored values.

## ID-JAG

ID-JAG lets your identity provider decide which MCP servers each person can use. It is the core of MCP's [Enterprise-Managed Authorization](https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization) extension. To have Archestra request an ID-JAG for a person instead of a bearer token, set **Requested Credential** to **ID-JAG** on the server.

The [MCP Gateway](/docs/mcp/authentication/gateway#id-jag) does not accept an ID-JAG yet.

## Troubleshooting

| What the tool call returns | Fix |
| --- | --- |
| "Configure a Managed Resource Identifier or scopes…" | Set **Managed Resource Identifier** on the server |
| "This MCP server overrides the token exchange client, but has no client secret or private key…" | Set **Client Secret** or **Certificate Private Key** under **Exchange Client** |
| An `AADSTS` error from Entra | See [Microsoft Entra ID troubleshooting](/docs/admin/identity/entra-obo#troubleshooting), or [Entra Agent ID troubleshooting](/docs/admin/identity/entra-agent-id#troubleshooting) for an agent with its own identity |

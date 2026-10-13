---
title: MCP Gateway Authentication
sidebarTitle: Gateway Authentication
description: Authenticate a client to an MCP Gateway with OAuth, a platform token, or your identity provider's JWT
order: 1
lastUpdated: 2026-10-06
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Each client proves who it is before the gateway shows any tools. Pick the method by the client you have:

| Your client | Use | Each call acts as |
| --- | --- | --- |
| Claude Code, Cursor, or another MCP client | [OAuth](#oauth-21): the client opens a browser for you | The person who signs in |
| A script or CI job | [Platform token](#bearer-token): one header | You, a team, or the organization |
| A client that already holds a token from your identity provider | [Identity provider JWT](#identity-provider-jwks): pass that token | The person in the token |
| Your own app or service | [OAuth client](/docs/mcp/authentication/applications): the app gets its own identity | The app, or the person using it |

Not sure? Use OAuth. It works with any MCP client. By default, you register nothing in Archestra first.

<span id="oauth-21"></span>

## OAuth

Paste the gateway's URL into your client. It opens your browser, you sign in, and the tools appear. You register nothing in Archestra first. Each client signs in as the person, and gets only that person's tools.

1. Copy the endpoint from the gateway's **Connect** tab into your client.
2. Sign in to Archestra in the browser, and approve the client.
3. Check that the client lists the gateway's tools.

A client registers itself in one of two ways. Archestra supports both, so any MCP client works:

- **Client ID Metadata Document:** the client's ID is a URL that describes it. Newer clients use this.
- **Dynamic Client Registration:** the client registers itself the first time it connects.

To allow only clients you register yourself, set [`ARCHESTRA_AUTH_DCR_ENABLED=false`](/docs/reference/configuration#ARCHESTRA_AUTH_DCR_ENABLED). That turns off both. Then register each client as an [OAuth client](/docs/mcp/authentication/applications).

<span id="bearer-token"></span>

## Platform Token

For a script or a CI job: one header, no browser. The client gets the tools the token's owner can use.

```text
Authorization: Bearer arch_<token>
```

| Token | Find it under | Calls act as |
| --- | --- | --- |
| **Personal Token** | Your name in the sidebar | You, with your own server accounts |
| **Team** | **Settings → Teams** | The team, with its shared accounts |
| **Organization Token** | **Settings → Auth** | The organization, with its shared accounts |

The gateway's **Connect** tab also shows your tokens, ready to copy.

- Keep a token secret. Anyone who has it acts as its owner. Click **Rotate Token** if it leaks.
- Team and organization tokens have no person behind them. They cannot use per-person tools, such as knowledge search.
- For your own app, use an [OAuth client](/docs/mcp/authentication/applications) instead. Its tokens expire, and you can limit what it reaches.

<span id="identity-provider-jwks"></span>

## Identity Provider JWT

Already signed in to Okta or Entra ID? Send that token. Nobody needs an Archestra token. Use it for an internal app or agent platform that signs people in through your company's single sign-on. Identity providers are an Enterprise feature. See [Pricing Model](/docs/get-started/pricing-model).

The call acts as the person in the token. So it can use their own server accounts, and Archestra can [exchange their identity](/docs/mcp/authentication/servers#identity-provider-token-exchange) for a token each MCP server accepts.

1. Add your OIDC provider under **Settings → Identity Providers**. See [Identity Providers](/docs/admin/identity#adding-a-provider).
2. On the gateway, go to **Advanced** and pick that provider.
3. In your client, send the token the provider issued:

   ```text
   Authorization: Bearer <jwt>
   ```

4. Check that the client lists the gateway's tools.

Archestra accepts the token only when:

- It is genuine. The signature, issuer, and expiry check out against the provider's published keys.
- It is for Archestra. Its audience is the provider's client ID in Archestra.
- It names a known person. Its email matches an Archestra user who can use the gateway. If your provider puts the email in a custom claim, set **Email Claim** under the provider's **Attribute Mapping**.

Token rejected? Open the provider and go to **Token Debugger**. It shows the claims of your own latest sign-in, so you can see which claim holds the email.

<span id="identity-assertion-jwt-authorization-grant-id-jag"></span>

## ID-JAG

ID-JAG lets your identity provider decide which MCP servers each person can use. It is the core of MCP's [Enterprise-Managed Authorization](https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization) extension. Nobody approves each server one by one:

1. The person signs in once, through your company's single sign-on.
2. The client asks your identity provider for an ID-JAG for one MCP server. The provider checks its access policy first.
3. The client trades the ID-JAG for that server's access token.

Archestra plays the client role today, not the server role. It gets ID-JAGs from your identity provider to authenticate to MCP servers for a person. See [MCP Server Credentials](/docs/mcp/authentication/servers#identity-provider-token-exchange). The gateway does not accept an ID-JAG yet.

Gateway support waits on the [Identity Continuation Assertion draft](https://datatracker.ietf.org/doc/draft-mcguinness-oauth-id-continuation-assertion/). Without it, Archestra cannot pass the person's identity on to the next server after it accepts an ID-JAG.

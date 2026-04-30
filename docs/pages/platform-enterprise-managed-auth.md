---
title: "Enterprise-Managed Auth"
category: Administration
subcategory: Identity Providers
description: "Per-user identity for downstream MCP tool calls — OBO, ID-JAG, Cross-App Access, and RFC 8693 token exchange"
order: 4
lastUpdated: 2026-04-30
---

<!--
Check ../docs_writer_prompt.md before changing this file.

Provider-agnostic concept page covering downstream-credential strategies:
- Microsoft Entra OBO
- Okta-managed token exchange
- RFC 8693 generic token exchange
- ID-JAG / Cross-App Access (XAA)

Includes a runtime flow diagram, decision table, the three-place wiring recipe,
field reference, and limitations. Per-provider walkthroughs (Entra, Okta) live
on their own pages.
-->

SSO gets the user signed in. **Enterprise-Managed Auth** is what happens after — when an agent or MCP server needs to call a downstream API and the call should carry the *user's* identity, not a shared service-account credential.

## Why this matters

When Alice asks an agent to *"summarize my unread emails"*, the agent has to call Microsoft Graph somewhere. The naive way is to give the MCP server a single shared secret. Every user's request hits Graph as the same robot account — audit logs show "the Archestra service account" read the email, not Alice. If Alice doesn't have access to a particular mailbox, the tool reads it anyway because it's running as the robot.

Enterprise-Managed Auth solves this. When Alice signs in, Archestra holds her identity-provider token. The moment a tool needs to call a downstream API, Archestra hands that token back to the IdP and asks for a *new* one — same user, scoped narrowly to the API the tool needs. The downstream call carries Alice's real identity. If she's not allowed, it fails. If she is, the audit trail shows it was her.

```mermaid
sequenceDiagram
    participant U as User (Alice)
    participant A as Archestra
    participant I as Identity Provider
    participant M as MCP Server
    participant D as Downstream API

    U->>A: Tool request ("read my email")
    A->>I: Token exchange<br/>(Alice's token + audience/scopes)
    I-->>A: New token (still Alice, scoped to D)
    A->>M: Tool call + Bearer token
    M->>D: API call as Alice
    D-->>M: Alice's data only
    M-->>A: Result
    A-->>U: Result
```

## Strategies at a glance

Archestra supports four flavors of downstream-credential exchange. Pick the one your identity provider speaks.

| Strategy | What it does | Best for | Setup guide |
| --- | --- | --- | --- |
| **Microsoft Entra OBO** | Exchanges the user's Entra access token for a Graph (or other Entra-protected API) token | Microsoft 365 environments — Outlook, Teams, SharePoint, OneDrive, your own Entra-protected APIs | [Microsoft Entra ID SSO + OBO](/docs/platform-entra-obo-setup) |
| **Okta-managed token exchange** | Exchanges the user's Okta ID token for a downstream API token, signing the request with `private_key_jwt` | Okta tenants and Okta-fronted APIs | [Okta SSO + Token Exchange](/docs/platform-okta-setup) |
| **RFC 8693 token exchange** | Generic OAuth 2.0 token exchange ([RFC 8693](https://datatracker.ietf.org/doc/html/rfc8693)) | Keycloak, Auth0 actions, custom OIDC providers that expose a token-exchange endpoint | This page (default for any non-Okta, non-Entra OIDC issuer) |
| **ID-JAG / Cross-App Access (XAA)** | Identity Assertion Authorization Grant — your IdP issues a signed assertion that a *third-party* app can swap for that app's token | Cross-app integrations where an external SaaS accepts ID-JAG (for example [motd.xaa.rocks](https://motd.xaa.rocks)) | This page |

Archestra **infers the strategy automatically** from the OIDC issuer URL: Okta hostnames → Okta-managed, Microsoft hostnames → Entra OBO, anything with `/realms/` in the path → RFC 8693, everything else → RFC 8693. You can override the inference in the Enterprise-Managed Credentials form.

## Wiring it up

To use Enterprise-Managed Auth on a given MCP server, configure three places:

1. **Identity Provider** — In **Settings > Identity Providers**, open the OIDC provider and complete the **Enterprise-Managed Credentials** section. The main fields are **Exchange Client ID**, **Exchange Client Secret**, **Exchange Token Endpoint**, **Exchange Client Authentication**, and **User Token To Exchange**.
2. **MCP catalog item** — In the server's **Multitenant Authorization** settings, choose **Identity Provider Token Exchange**. Set the **Requested Credential**, **Injection Mode**, and the **Managed Resource Identifier** (or scopes) for the downstream API.
3. **Tool assignment** — Assign the tool with **Resolve at call time** so Archestra resolves the downstream credential for the caller every time the tool runs.

Per-provider pages walk through each of these steps with concrete field values for that provider.

## ID-JAG and Cross-App Access

ID-JAG is a draft IETF spec (and the foundation of [OpenID Cross-App Access](https://openid.net/wg/cross-app-access/)) that extends the OAuth 2.0 token-exchange flow to multi-app scenarios. Instead of asking the IdP for a token Archestra itself will use, Archestra asks the IdP for a *signed assertion* that a third-party app can verify and swap for its own token.

The practical use case: your enterprise IdP (say Okta) is the source of truth for who Alice is, but Alice also uses a third-party SaaS that doesn't trust your IdP directly. With ID-JAG configured, that third-party can accept the assertion, validate the IdP's signature, and issue Alice a token without Alice ever logging in to it again.

A live demo of this is [motd.xaa.rocks](https://motd.xaa.rocks) — a "Resource" application that exchanges valid ID-JAGs for access tokens against its `/token` endpoint, then serves a message of the day at `/motd` (and exposes an MCP server at `/mcp`).

To use ID-JAG with Archestra:

1. Configure your IdP to issue ID-JAGs with the audience equal to the third-party app
2. In the MCP catalog item, set **Requested Credential** to **ID-JAG** and **Managed Resource Identifier** to the audience
3. Archestra includes the assertion in tool calls; the third-party verifies it and exchanges for its own token

## Field reference

The Enterprise-Managed Credentials form on each OIDC provider has these fields:

| Field | What it is |
| --- | --- |
| **Exchange Client ID** | The OAuth client Archestra uses when calling the IdP's token-exchange endpoint. Defaults to the main OIDC client ID. |
| **Exchange Client Secret** | The matching secret. Only used when client authentication is `client_secret_post` or `client_secret_basic`. |
| **Exchange Token Endpoint** | The IdP's token endpoint. For Entra: `https://login.microsoftonline.com/<TENANT_ID>/oauth2/v2.0/token`. For Okta: `https://<your-org>.okta.com/oauth2/v1/token`. |
| **Exchange Client Authentication** | How Archestra authenticates to the token endpoint. Options: `Private key JWT` (Okta default), `Client secret POST` (Entra OBO and RFC 8693 default), `Client secret Basic`. |
| **Signing Key ID** | The `kid` of the public key registered with the IdP. Only used with `private_key_jwt`. |
| **Client Assertion Audience** | Optional override for the `aud` claim of the client assertion. Defaults to the exchange token endpoint. |
| **User Token To Exchange** | Which token Archestra should hand back to the IdP for exchange. `Access token` (Entra default), `ID token` (Okta default), or generic `JWT`. |

### Strategy defaults

When the strategy is inferred from the issuer URL, Archestra pre-fills sensible defaults:

| Strategy | Client authentication | User token type |
| --- | --- | --- |
| **Microsoft Entra OBO** | Client secret POST | Access token |
| **Okta-managed** | Private key JWT | ID token |
| **RFC 8693** | Client secret POST | Access token |

You can override any of these in the form.

## Limitations

- **Per-user identity required.** Token exchange only works when Archestra knows which user is calling. Gateway auth methods that carry per-user identity work: **Identity Provider JWT / JWKS**, **OAuth 2.1**, **ID-JAG**, and personal user bearer tokens. Team and organization bearer tokens do not — they don't resolve to a single user.
- **HTTP transport only for local MCP servers.** Per-request token exchange and injection require the **streamable-http** transport. Local **stdio** MCP servers cannot do this — Archestra has no way to inject a fresh per-call header into a stdio process.
- **The user must have a linked IdP session.** OAuth 2.1 gateway auth works only when the authenticated Archestra user has previously signed in through the same IdP that's doing the exchange. JWKS-based gateway auth always works because the JWT itself carries the IdP identity.
- **SAML providers are not supported.** Token exchange is OIDC-only. SAML doesn't have an equivalent flow.

## See also

- [SSO](/docs/platform-sso) — sign users in via OIDC or SAML (the prerequisite for everything on this page)
- [MCP Authentication — Upstream Identity Provider Token Exchange](/docs/mcp-authentication#upstream-identity-provider-token-exchange) — implementation details and gateway-side flow
- [Microsoft Entra ID SSO + OBO](/docs/platform-entra-obo-setup) — Entra walkthrough
- [Okta SSO + Token Exchange](/docs/platform-okta-setup) — Okta walkthrough

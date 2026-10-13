---
title: "Identity Providers"
description: "Connect Okta, Microsoft Entra ID, Google, GitHub, GitLab, or any OIDC or SAML provider for sign-in and per-user tool access"
order: 4
lastUpdated: 2026-10-06
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Connect your identity provider (IdP) to sign users in with their work accounts and run MCP tools with each user's own downstream permissions.

Archestra uses your IdP for two jobs:

- **Single Sign-On (SSO):** Users sign in with their existing credentials. At each sign-in, claim rules map directory groups to Archestra roles and teams. See [Single Sign-On](/docs/admin/identity/sso).
- **Token exchange for tools:** When an agent calls an MCP tool, Archestra exchanges the caller's IdP token for a downstream API token. The tool acts as that specific user instead of a shared service account. See [Microsoft Entra ID](/docs/admin/identity/entra-obo) or [Okta](/docs/admin/identity/okta).

Identity providers are an enterprise feature. See [Pricing Model](/docs/get-started/pricing-model).

![The Identity Providers settings page with a card for each supported provider](/docs/automated_screenshots/platform-identity-providers_sso-providers-overview.webp)

## Supported Providers

| Provider | Protocol | Downstream Token Exchange | Setup Guide |
| --- | --- | --- | --- |
| Microsoft Entra ID | OIDC | On-Behalf-Of (OBO) flow | [Microsoft Entra ID](/docs/admin/identity/entra-obo) |
| Okta | OIDC | Token exchange (`private_key_jwt`) | [Okta](/docs/admin/identity/okta) |
| Google, GitHub, GitLab | OIDC | Requires RFC 8693 endpoint | [Single Sign-On](/docs/admin/identity/sso) |
| Generic OIDC (Keycloak, Auth0) | OIDC | RFC 8693 token exchange | [Single Sign-On](/docs/admin/identity/sso#supported-protocols) |
| Generic SAML | SAML 2.0 | Not supported | [Single Sign-On](/docs/admin/identity/sso#callback-urls) |

## Adding a Provider

Configuring an identity provider requires the [`identityProvider:create`](/docs/reference/permissions#identityProvider:create) permission and admin access in your IdP.

1. In your IdP, register Archestra as a web application with the callback URL matching your protocol:

| Protocol | Callback URL |
| --- | --- |
| OIDC | `https://<archestra-domain>/api/auth/sso/callback/<ProviderId>` |
| SAML (ACS URL) | `https://<archestra-domain>/api/auth/sso/saml2/sp/acs/<ProviderId>` |

The `<ProviderId>` segment is case-sensitive: `Okta`, `EntraID`, `Google`, `GitHub`, or `GitLab`. For generic providers, use the exact **Provider ID** entered in Archestra.

2. In Archestra, go to **Settings → Identity Providers** and click **Enable** on your provider card.
3. Enter the **Issuer**, **Client ID**, and **Client Secret** (or SAML metadata).
4. Configure optional **Allowed Email Domains**, **Role Mapping**, or **Team Sync**.
5. Click **Create Provider**.

Test sign-in in an incognito window. To manage email and password account policies, see [Account Security](/docs/admin/identity/account-security).

---
title: "Identity Providers"
category: Administration
description: "Index of identity-related configuration in Archestra — SSO sign-in, downstream token exchange, role mapping, team sync, and per-provider walkthroughs"
order: 2
lastUpdated: 2026-04-30
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This is the INDEX page for identity. It lists what Archestra supports per
provider, points readers at the relevant sub-page, and keeps short notes for
providers that don't yet have dedicated pages (Google, GitHub, GitLab, Generic
OIDC, Generic SAML).

Conceptual content lives elsewhere:
- platform-sso                       - SSO concept page
- platform-enterprise-managed-auth   - downstream token exchange (OBO, ID-JAG, RFC 8693)
- platform-sso-role-mapping          - role mapping
- platform-sso-team-sync             - team synchronization

Per-provider walkthroughs:
- platform-entra-obo-setup           - Microsoft Entra ID
- platform-okta-setup                - Okta
-->

![Identity Providers Overview](/docs/automated_screenshots/platform-identity-providers_sso-providers-overview.webp)

Archestra integrates with your identity provider (IdP) for two related purposes:

- **Sign-in (SSO)** — users authenticate with their existing IdP credentials. See [SSO](/docs/platform-sso).
- **Downstream MCP tool calls (Enterprise-Managed Auth)** — Archestra exchanges the signed-in user's IdP token for a downstream API token at tool-call time, so the tool runs as *that user*, not a service account. See [Enterprise-Managed Auth](/docs/platform-enterprise-managed-auth).

> **Enterprise feature:** please reach out to sales@archestra.ai for instructions about how to enable the feature.

## Supported providers

| Provider | Protocol | SSO sign-in | Role mapping | Team sync | Token exchange (downstream MCP) | Setup guide |
| --- | --- | --- | --- | --- | --- | --- |
| **Microsoft Entra ID** | OIDC | Yes | Yes | Yes (`groups` claim) | **Entra OBO** | [Entra ID SSO + OBO](/docs/platform-entra-obo-setup) |
| **Okta** | OIDC | Yes | Yes | Yes | **Okta-managed** (private key JWT, ID token) | [Okta SSO + Token Exchange](/docs/platform-okta-setup) |
| **Google** | OIDC | Yes | Yes | Yes | RFC 8693 (in form, rarely used in practice) | This page |
| **GitHub** | OIDC | Yes | Yes | Yes | RFC 8693 (in form, rarely used in practice) | This page |
| **GitLab** | OIDC | Yes | Yes | Yes | RFC 8693 (in form, rarely used in practice) | This page |
| **Generic OIDC** | OIDC | Yes | Yes | Yes | RFC 8693 (or Okta-managed / Entra OBO if issuer matches) | This page |
| **Generic SAML** | SAML 2.0 | Yes | Yes | Yes | — (not supported for SAML) | This page |

The token-exchange strategy is auto-inferred from the OIDC issuer URL: Okta hostnames → Okta-managed, Microsoft hostnames → Entra OBO, anything else → RFC 8693. See [Enterprise-Managed Auth](/docs/platform-enterprise-managed-auth#strategies-at-a-glance).

## Providers without a dedicated page

The providers below are configured directly from the **Settings > Identity Providers** card. For SSO concepts, callback URL formats, and troubleshooting, see [SSO](/docs/platform-sso).

### Google

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Navigate to **APIs & Services > Credentials**
4. Create an **OAuth 2.0 Client ID** (Web application)
5. Add the callback URL: `https://your-domain.com/api/auth/sso/callback/Google`
6. Copy the **Client ID** and **Client Secret**
7. In Archestra, click **Enable** on the Google card and paste the credentials and allowed email domains

**Google notes:**

- Discovery endpoint is auto-configured
- Optional **Hosted Domain Hint** passes Google's `hd` parameter to prefer account selection for a Workspace domain. Archestra still enforces **Allowed Email Domains** after Google returns the authenticated email.

### GitHub

1. Go to [GitHub Developer Settings](https://github.com/settings/developers) > **New OAuth App**
2. Set the **Authorization callback URL** to `https://your-domain.com/api/auth/sso/callback/GitHub`
3. Copy the **Client ID** and generate a **Client Secret**
4. In Archestra, click **Enable** on the GitHub card and paste the credentials

**GitHub limitations:**

- Users must have a **public email** set in their GitHub profile — GitHub's OAuth `/user` endpoint does not expose private emails
- PKCE is automatically disabled for GitHub (not supported by GitHub)

### GitLab

1. Go to [GitLab Applications](https://gitlab.com/-/user_settings/applications) (or your self-hosted instance) > **Add new application**
2. Set the **Redirect URI** to `https://your-domain.com/api/auth/sso/callback/GitLab`
3. Select scopes: `openid`, `email`, `profile`
4. Copy the **Application ID** (Client ID) and **Secret**
5. In Archestra, click **Enable** on the GitLab card and paste the credentials

**GitLab notes:**

- For self-hosted GitLab, set the issuer URL to your GitLab instance (`https://gitlab.yourcompany.com`)
- OIDC discovery is supported, so endpoints are auto-configured

### Generic OIDC

For OIDC providers not listed above (Auth0, Keycloak, custom), use the Generic OAuth option.

Required:

- **Provider ID:** a unique identifier (`auth0`, `keycloak`)
- **Issuer:** the OIDC issuer URL
- **Client ID** and **Client Secret**: from your IdP

Optional:

- **Discovery Endpoint:** the `.well-known/openid-configuration` URL (defaults to issuer + `/.well-known/openid-configuration`)
- **Authorization / Token / User Info / JWKS endpoints:** override the discovery defaults
- **Scopes:** additional OAuth scopes (default: `openid`, `email`, `profile`)
- **PKCE:** enable if your provider requires it
- **Enable RP-Initiated Logout:** sends `post_logout_redirect_uri` during sign-out (on by default; disable for providers that reject it)

### Generic SAML

For SAML 2.0 providers.

Required:

- **Provider ID:** a unique identifier (`okta-saml`, `adfs`)
- **Issuer:** your organization's identifier
- **SAML Issuer / Entity ID:** the IdP's entity ID (from IdP metadata)
- **SSO Entry Point URL:** the IdP's Single Sign-On URL
- **IdP Certificate:** the X.509 certificate from your IdP for signature verification

Optional:

- **IdP Metadata XML:** full XML metadata document (recommended over the individual fields above)
- **Callback URL (ACS URL):** auto-generated, can be overridden
- **SP Entity ID** and **SP Metadata XML:** for custom Service Provider configuration

**SAML notes:**

- SAML responses must be signed by the IdP
- NameID format should be `emailAddress`
- User attributes (email, firstName, lastName) should be included in the assertion
- SAML providers cannot do downstream token exchange — use OIDC for that

## Related pages

- [SSO](/docs/platform-sso) — sign-in flow, callback URLs, allowed domains, troubleshooting
- [Enterprise-Managed Auth](/docs/platform-enterprise-managed-auth) — downstream token exchange (OBO, ID-JAG, RFC 8693)
- [Role Mapping](/docs/platform-sso-role-mapping) — map IdP claims to Archestra roles
- [Team Sync](/docs/platform-sso-team-sync) — sync IdP groups to Archestra teams


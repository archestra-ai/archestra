---
title: "Single Sign-On (SSO)"
category: Archestra Platform
description: "Configure SSO providers for seamless authentication using OIDC and SAML"
order: 5
lastUpdated: 2025-11-28
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This document covers SSO configuration for Archestra Platform. Include:
- Overview of SSO support (OIDC and SAML)
- Provider-specific configuration (Okta, Google, GitHub, GitLab, Microsoft Entra ID, Generic OAuth, Generic SAML)
- Callback URL format
- Limitations and requirements
-->

![SSO Providers Overview](/docs/automated_screenshots/platform-single-sign-on_sso-providers-overview.png)

Archestra supports Single Sign-On (SSO) authentication using OpenID Connect (OIDC) and SAML 2.0 providers. Once configured, users can authenticate with their existing identity provider credentials instead of managing separate passwords.

> **Enterprise feature:** Please reach out to sales@archestra.ai for instructions about how to enable the feature.

## How SSO Works

1. Admin configures an SSO provider in **Settings > SSO Providers**
2. SSO buttons appear on the sign-in page for enabled providers
3. Users click the SSO button and authenticate with their identity provider
4. After successful authentication, users are automatically provisioned and logged in

![Sign-in with SSO](/docs/automated_screenshots/platform-single-sign-on_sign-in-with-sso.png)

## Disabling Basic Authentication

Once you have configured SSO providers, you can optionally disable the username/password login form to enforce SSO-only authentication. This is useful for organizations that want to centralize authentication through their identity provider.

To disable basic authentication, set the `ARCHESTRA_DISABLE_BASIC_AUTH` environment variable to `true`. See [Deployment - Environment Variables](/platform-deployment#environment-variables) for configuration details.

> **Important:** Ensure at least one SSO provider is configured and working before disabling basic authentication. Otherwise, users (including administrators) will not be able to sign in.

## Callback URLs

### OIDC Callback URL

All OIDC providers require a callback URL to be configured. The format is:

```
https://your-archestra-domain.com/api/auth/sso/callback/{ProviderId}
```

For local development:

```
http://localhost:3000/api/auth/sso/callback/{ProviderId}
```

The `{ProviderId}` is case-sensitive and must match exactly what you configure in Archestra (e.g., `Okta`, `Google`, `GitHub`, `GitLab`, `EntraID`).

### SAML Callback URL (ACS URL)

For SAML providers, the Assertion Consumer Service (ACS) URL format is:

```
https://your-archestra-domain.com/api/auth/sso/saml2/sp/acs/{ProviderId}
```

For local development:

```
http://localhost:3000/api/auth/sso/saml2/sp/acs/{ProviderId}
```

## Supported Providers

### Okta

Okta is an enterprise identity management platform. To configure Okta SSO:

1. In Okta Admin Console, create a new **Web Application**
2. Set the **Sign-in redirect URI** to your callback URL: `https://your-domain.com/api/auth/sso/callback/Okta`
3. Copy the **Client ID** and **Client Secret**
4. In Archestra, click **Enable** on the Okta card
5. Enter your Okta domain (e.g., `your-org.okta.com`)
6. Enter the Client ID and Client Secret
7. Click **Create Provider**

**Okta-specific requirements:**

- Disable **DPoP** (Demonstrating Proof of Possession) in your Okta application settings. Archestra does not support DPoP.
- The issuer URL is automatically set to `https://your-domain.okta.com`

### Google

Google OAuth allows users to sign in with their Google accounts.

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Navigate to **APIs & Services > Credentials**
4. Create an **OAuth 2.0 Client ID** (Web application)
5. Add your callback URL: `https://your-domain.com/api/auth/sso/callback/Google`
6. Copy the **Client ID** and **Client Secret**
7. In Archestra, click **Enable** on the Google card
8. Enter your domain and the credentials

**Google-specific notes:**

- Users must have a Google Workspace or personal Google account
- The discovery endpoint is automatically configured

### GitHub

GitHub OAuth allows users to sign in with their GitHub accounts.

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click **New OAuth App**
3. Set the **Authorization callback URL** to: `https://your-domain.com/api/auth/sso/callback/GitHub`
4. Copy the **Client ID** and generate a **Client Secret**
5. In Archestra, click **Enable** on the GitHub card
6. Enter your domain and the credentials

**GitHub limitations:**

- **Users must have a public email** set in their GitHub profile for SSO to work. GitHub's OAuth does not expose private emails through the standard user endpoint.
- To set a public email: Go to [GitHub Profile Settings](https://github.com/settings/profile) and select a public email
- PKCE is automatically disabled for GitHub (not supported)

### GitLab

GitLab OAuth allows users to sign in with their GitLab accounts (both GitLab.com and self-hosted instances).

1. Go to [GitLab Applications](https://gitlab.com/-/user_settings/applications) (or your self-hosted instance)
2. Click **Add new application**
3. Set the **Redirect URI** to: `https://your-domain.com/api/auth/sso/callback/GitLab`
4. Select scopes: `openid`, `email`, `profile`
5. Click **Save application**
6. Copy the **Application ID** (Client ID) and **Secret** (Client Secret)
7. In Archestra, click **Enable** on the GitLab card
8. Enter your domain and the credentials

**GitLab-specific notes:**

- For self-hosted GitLab, update the issuer URL to your GitLab instance (e.g., `https://gitlab.yourcompany.com`)
- GitLab supports OIDC discovery, so endpoints are automatically configured
- See [GitLab OAuth documentation](https://docs.gitlab.com/ee/integration/openid_connect_provider.html) for more details

### Microsoft Entra ID (Azure AD)

Microsoft Entra ID (formerly Azure AD) allows users to sign in with their Microsoft work or school accounts.

1. Go to [Azure Portal](https://portal.azure.com/) > **Microsoft Entra ID**
2. Navigate to **App registrations** > **New registration**
3. Enter a name and select supported account types
4. Set the **Redirect URI** to: `https://your-domain.com/api/auth/sso/callback/EntraID`
5. After creation, go to **Certificates & secrets** > **New client secret**
6. Copy the **Application (client) ID** and **Client Secret**
7. Note your **Directory (tenant) ID** from the Overview page
8. In Archestra, click **Enable** on the Microsoft Entra ID card
9. Replace `{tenant-id}` in all URLs with your actual tenant ID
10. Enter your domain and the credentials

**Entra ID-specific notes:**

- The tenant ID is required in all endpoint URLs
- For single-tenant apps, use your specific tenant ID
- For multi-tenant apps, use `common` or `organizations` instead of the tenant ID
- See [Microsoft Entra ID documentation](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc) for more details

### Generic OAuth (OIDC)

For other OIDC-compliant providers not listed above, use the Generic OAuth option.

Required information:

- **Provider ID**: A unique identifier (e.g., `azure`, `auth0`)
- **Issuer**: The OIDC issuer URL
- **Domain**: Your organization's domain
- **Client ID** and **Client Secret**: From your identity provider
- **Discovery Endpoint**: The `.well-known/openid-configuration` URL (optional if issuer supports discovery)

Optional configuration:

- **Authorization Endpoint**: Override the discovery endpoint
- **Token Endpoint**: Override the discovery endpoint
- **User Info Endpoint**: Override the discovery endpoint
- **JWKS Endpoint**: For token validation
- **Scopes**: Additional OAuth scopes (default: `openid`, `email`, `profile`)
- **PKCE**: Enable if your provider requires it

#### Using Keycloak as an OIDC Provider

[Keycloak](https://www.keycloak.org/) is an open-source identity and access management solution that can be used as an OIDC provider.

1. In Keycloak Admin Console, create a new **Client** with protocol `openid-connect`
2. Set **Client authentication** to `On`
3. Add your callback URL to **Valid redirect URIs**: `https://your-domain.com/api/auth/sso/callback/{ProviderId}`
4. Copy the **Client ID** and **Client Secret** from the Credentials tab
5. In Archestra, click **Enable** on the Generic OAuth card
6. Set the **Provider ID** (e.g., `Keycloak`)
7. Set the **Issuer** to: `https://your-keycloak-domain/realms/{realm-name}`
8. Enter the Client ID and Client Secret
9. Click **Create Provider**

### Generic SAML

Archestra supports SAML 2.0 for enterprise identity providers that don't support OIDC.

Required information:

- **Provider ID**: A unique identifier (e.g., `okta-saml`, `adfs`)
- **Issuer**: Your organization's identifier
- **Domain**: Your organization's domain
- **SAML Issuer / Entity ID**: The identity provider's entity ID (from IdP metadata)
- **SSO Entry Point URL**: The IdP's Single Sign-On URL
- **IdP Certificate**: The X.509 certificate from your IdP for signature verification

Optional configuration:

- **IdP Metadata XML**: Full XML metadata document from your IdP (recommended for robust configuration)
- **Callback URL (ACS URL)**: Automatically generated, but can be overridden
- **SP Entity ID**: Service Provider entity ID (defaults to your Archestra domain)
- **SP Metadata XML**: Custom Service Provider metadata

**SAML-specific notes:**

- SAML responses must be signed by the IdP
- The NameID format should be set to `emailAddress` in your IdP
- User attributes (email, firstName, lastName) should be included in the SAML assertion
- See your IdP's documentation for specific configuration steps

#### Using Keycloak as a SAML Provider

1. In Keycloak Admin Console, create a new **Client** with protocol `saml`
2. Set the **Client ID** to your SP Entity ID (e.g., `https://your-archestra-domain.com`)
3. Set **Root URL** to your Archestra domain
4. Add your ACS URL to **Valid redirect URIs**: `https://your-domain.com/api/auth/sso/saml2/sp/acs/{ProviderId}`
5. Configure **Client Signature Required** to `Off` (unless you're providing SP signing certificates)
6. Add protocol mappers for `email`, `firstName`, and `lastName` attributes
7. Download the IdP metadata from: `https://your-keycloak-domain/realms/{realm-name}/protocol/saml/descriptor`
8. In Archestra, click **Enable** on the Generic SAML card
9. Set the **Provider ID** (e.g., `KeycloakSAML`)
10. Paste the IdP metadata XML into the **IdP Metadata XML** field
11. Click **Create Provider**

## User Provisioning

When a user authenticates via SSO for the first time:

1. A new user account is created with their email and name from the identity provider
2. The user is added to the organization with the **member** role
3. A session is created and the user is logged in

Subsequent logins automatically link to the existing account based on email address.

## Account Linking

If a user already has an account (created via email/password), SSO authentication will automatically link to that account when:

- The email addresses match
- The SSO provider is in the trusted providers list (Okta, Google, GitHub, GitLab, Entra ID, and all SAML providers are trusted by default)

## Removing an SSO Provider

To remove a configured SSO provider:

1. Click **Configure** on the provider card
2. Click the **Delete** button
3. Confirm the deletion

Existing users who authenticated via that provider will need to use another authentication method (email/password or another SSO provider).

## Troubleshooting

### "state_mismatch" Error

This typically occurs when cookies are blocked or the callback URL doesn't match. Ensure:

- Third-party cookies are enabled in the browser
- The callback URL in your identity provider exactly matches the Archestra callback URL

### "missing_user_info" Error

The identity provider didn't return required user information. For GitHub, ensure the user has a public email set.

### "account not linked" Error

The SSO provider is not in the trusted providers list. Contact your administrator to add the provider to the trusted list.

### "invalid_dpop_proof" Error (Okta)

DPoP is enabled in your Okta application. Disable it in Okta Admin Console under the application's security settings.

### "account_not_found" Error (SAML)

The SAML assertion didn't contain the required user attributes. Ensure your IdP is configured to send:

- `NameID` in email format (recommended)
- `email` attribute
- `firstName` and `lastName` attributes (optional but recommended)

Check your IdP's protocol mapper configuration.

### "signature_validation_failed" Error (SAML)

The SAML response signature couldn't be verified. Ensure:

- The IdP certificate in Archestra matches the current signing certificate from your IdP
- If using IdP metadata, ensure it's up to date (certificates can expire or rotate)
- Re-download the IdP metadata and update the configuration

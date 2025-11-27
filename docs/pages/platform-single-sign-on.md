---
title: "Single Sign-On (SSO)"
category: Archestra Platform
description: "Configure SSO providers for seamless authentication using OIDC"
order: 5
lastUpdated: 2025-11-27
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This document covers SSO configuration for Archestra Platform. Include:
- Overview of SSO support
- Provider-specific configuration (Okta, Google, GitHub, GitLab, Microsoft Entra ID, Generic OAuth)
- Callback URL format
- Limitations and requirements
-->

![SSO Providers Overview](/assets/automated_screenshots/platform-single-sign-on_sso-providers-overview.png)

Archestra supports Single Sign-On (SSO) authentication using OpenID Connect (OIDC) providers. Once configured, users can authenticate with their existing identity provider credentials instead of managing separate passwords.

## How SSO Works

1. Admin configures an SSO provider in **Settings > SSO Providers**
2. SSO buttons appear on the sign-in page for enabled providers
3. Users click the SSO button and authenticate with their identity provider
4. After successful authentication, users are automatically provisioned and logged in

![Sign-in with SSO](/assets/automated_screenshots/platform-single-sign-on_sign-in-with-sso.png)

## Callback URL

All SSO providers require a callback URL to be configured. The format is:

```
https://your-archestra-domain.com/api/auth/sso/callback/{ProviderId}
```

For local development:

```
http://localhost:3000/api/auth/sso/callback/{ProviderId}
```

The `{ProviderId}` is case-sensitive and must match exactly what you configure in Archestra (e.g., `Okta`, `Google`, `GitHub`, `GitLab`, `EntraID`).

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

### Generic OAuth

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

## User Provisioning

When a user authenticates via SSO for the first time:

1. A new user account is created with their email and name from the identity provider
2. The user is added to the organization with the **member** role
3. A session is created and the user is logged in

Subsequent logins automatically link to the existing account based on email address.

## Account Linking

If a user already has an account (created via email/password), SSO authentication will automatically link to that account when:

- The email addresses match
- The SSO provider is in the trusted providers list (Okta, Google, GitHub, GitLab, and Entra ID are trusted by default)

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

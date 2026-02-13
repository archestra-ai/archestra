---
title: "Identity Providers"
category: Archestra Platform
description: "Configure Identity Providers for SSO authentication and MCP Gateway JWKS validation"
order: 5
lastUpdated: 2025-02-12
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This document covers Identity Provider configuration for Archestra Platform. Include:
- Overview of Identity Provider support (OIDC and SAML)
- SSO configuration
- MCP Gateway JWKS authentication
- Provider-specific configuration (Okta, Google, GitHub, GitLab, Microsoft Entra ID, Generic OAuth, Generic SAML)
- Callback URL format
- Limitations and requirements
-->

![Identity Providers Overview](/docs/automated_screenshots/platform-identity-providers_sso-providers-overview.png)

Archestra supports Identity Provider (IdP) configuration for two purposes:

1. **Single Sign-On (SSO)** — Users authenticate with their existing IdP credentials using OpenID Connect (OIDC) or SAML 2.0
2. **MCP Gateway JWKS Authentication** — External MCP clients authenticate using JWTs issued by configured IdPs, validated via JWKS. See [MCP Authentication - External IdP JWKS](/docs/mcp-authentication#external-idp-jwks) for details.

> **Enterprise feature:** Please reach out to sales@archestra.ai for instructions about how to enable the feature.

## Single Sign-On (SSO)

### How SSO Works

1. Admin configures an Identity Provider in **Settings > Identity Providers**
2. SSO buttons appear on the sign-in page for enabled providers
3. Users click the SSO button and authenticate with their identity provider
4. After successful authentication, users are automatically provisioned and logged in

![Sign-in with SSO](/docs/automated_screenshots/platform-identity-providers_sign-in-with-sso.png)

## Disabling Basic Authentication

Once you have configured SSO providers, you can optionally disable the username/password login form to enforce SSO-only authentication. This is useful for organizations that want to centralize authentication through their identity provider.

To disable basic authentication, set the `ARCHESTRA_AUTH_DISABLE_BASIC_AUTH` environment variable to `true`. See [Deployment - Environment Variables](/docs/platform-deployment#environment-variables) for configuration details.

> **Important:** Ensure at least one SSO provider is configured and working before disabling basic authentication. Otherwise, users (including administrators) will not be able to sign in.

## Disabling User Invitations

For organizations using SSO with automatic user provisioning, you may want to disable the manual invitation system entirely. This hides the invitation UI and blocks invitation API endpoints.

To disable invitations, set the `ARCHESTRA_AUTH_DISABLE_INVITATIONS` environment variable to `true`. See [Deployment - Environment Variables](/docs/platform-deployment#environment-variables) for configuration details.

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

## Role Mapping

Archestra supports automatic role assignment based on user attributes from your identity provider using [Handlebars](https://handlebarsjs.com/) templates. This allows you to map SSO groups, roles, or other claims to Archestra roles (e.g., Admin, Member, or any custom role you've defined).

### How Role Mapping Works

1. When a user authenticates via SSO, Archestra receives user attributes from the identity provider's ID token (for OIDC) or SAML assertions
2. These attributes are evaluated against your configured mapping rules in order
3. The first rule that matches determines the user's Archestra role
4. If no rules match, the user is assigned the configured default role (or "Member" if not specified)

### Configuring Role Mapping

When creating or editing an SSO provider, expand the **Role Mapping (Optional)** section:

1. **Mapping Rules**: Add one or more rules. Each rule has:
   - **Handlebars Template**: A template that renders to a non-empty string when the rule should match
   - **Archestra Role**: The role to assign when the template matches

2. **Default Role**: The role assigned when no rules match (defaults to "member")

3. **Strict Mode**: When enabled, denies user login if no mapping rules match. This is useful when you want to ensure that only users with specific IdP attributes can access Archestra. Without strict mode, users who don't match any rule are simply assigned the default role.

4. **Skip Role Sync**: When enabled, the user's role is only determined on their first login. Subsequent logins will not update their role, even if their IdP attributes change. This allows administrators to manually adjust roles after initial provisioning without those changes being overwritten on next login.

### Handlebars Template Examples

Handlebars templates should render to any non-empty string (like "true") when the rule matches. The following custom helpers are available:

| Helper      | Description                                                  |
| ----------- | ------------------------------------------------------------ |
| `includes`  | Check if an array includes a value (case-insensitive)        |
| `equals`    | Check if two values are equal (case-insensitive for strings) |
| `contains`  | Check if a string contains a substring (case-insensitive)    |
| `and`       | Logical AND - true if all values are truthy                  |
| `or`        | Logical OR - true if any value is truthy                     |
| `exists`    | True if the value is not null/undefined                      |
| `notEquals` | Check if two values are not equal                            |

**Example Templates:**

| Template                                                                                             | Description                                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `{{#includes groups "admins"}}true{{/includes}}`                                                     | Match if "admins" is in the groups array         |
| `{{#equals role "administrator"}}true{{/equals}}`                                                    | Match if role claim equals "administrator"       |
| `{{#each roles}}{{#equals this "platform-admin"}}true{{/equals}}{{/each}}`                           | Match if "platform-admin" is in roles array      |
| `{{#and department title}}{{#equals department "IT"}}true{{/equals}}{{/and}}`                        | Match IT department users with a title set       |
| `{{#with (json roles)}}{{#each this}}{{#equals this.name "admin"}}true{{/equals}}{{/each}}{{/with}}` | Match role name in JSON string claim (see below) |

> **Tip**: Templates should output any non-empty string when matching. The text "true" is commonly used but any output works.

#### Handling JSON String Claims

Some identity providers (like Okta) may send complex claims as JSON strings rather than native arrays. For example:

```json
{
  "roles": "[{\"name\":\"Application Administrator\"},{\"name\":\"archestra-admin\"}]"
}
```

To parse and match against JSON string claims, use the `json` helper with `#with`:

```handlebars
{{#with (json roles)}}{{#each this}}{{#equals
      this.name "archestra-admin"
    }}true{{/equals}}{{/each}}{{/with}}
```

This template:

1. Parses the JSON string into an array using `(json roles)`
2. Sets the parsed array as context using `#with`
3. Iterates through each role object using `#each`
4. Checks if any role's `name` property matches

### Troubleshooting Role Mapping

**Role not being assigned correctly:**

1. Check your IdP's configuration to ensure the expected claims/attributes are being sent
2. Use your IdP's token introspection or SAML assertion viewer to verify the actual data
3. Ensure your Handlebars template syntax is correct
4. Rules are evaluated in order - ensure your most specific rules come first

**Missing groups claim:**

- For OIDC: Verify your IdP is configured to include groups in the token/userinfo
- For SAML: Check that group attributes are included in the assertion and properly mapped

**Template always returns empty:**

- Check for typos in claim/attribute names (they are case-sensitive in the template)
- Ensure your IdP is sending the expected claims in the ID token
- The `includes` helper handles null/undefined arrays gracefully

## Team Synchronization

Archestra supports automatic team membership synchronization based on user group memberships from your identity provider. When users log in via SSO, they can be automatically added to or removed from Archestra teams based on their IdP groups.

### How Team Sync Works

1. Admin configures an Archestra team and links it to one or more external IdP groups
2. When a user logs in via SSO, their group memberships are extracted from the SSO token
3. Archestra compares the user's IdP groups against the external groups linked to each team
4. **Added**: Users in a linked group are automatically added to the team
5. **Removed**: Users no longer in any linked group are automatically removed (if they were added via sync)
6. **Manual members preserved**: Members added manually to a team are never removed by sync

### Configuring Team Sync

When creating or editing an SSO provider, expand the **Team Sync Configuration (Optional)** section to configure how groups are extracted from SSO tokens.

#### Team Sync Settings

1. **Enable Team Sync**: When enabled (default), users are automatically added/removed from Archestra teams based on their SSO group memberships.

2. **Groups Handlebars Template**: A [Handlebars](https://handlebarsjs.com/) template to extract group identifiers from the ID token claims. Should render to a comma-separated list or JSON array. Leave empty to use default extraction.

#### Default Group Extraction

If no custom Handlebars template is configured, Archestra automatically checks these common claim names in order:

- `groups`, `group`, `memberOf`, `member_of`, `roles`, `role`, `teams`, `team`

The first claim that contains non-empty group data is used.

#### Custom Handlebars Templates

For identity providers with non-standard ID token formats, you can use Handlebars templates to extract group identifiers from complex claim structures. The template should render to either a comma-separated list or a JSON array.

**Available Helpers:**

| Helper  | Description                                                  |
| ------- | ------------------------------------------------------------ |
| `json`  | Convert value to JSON string, or parse JSON string to object |
| `pluck` | Extract a property from each item in an array                |

**Common Examples:**

| Template                                                               | Description                                     |
| ---------------------------------------------------------------------- | ----------------------------------------------- |
| `{{#each groups}}{{this}},{{/each}}`                                   | Simple flat array: `["admin", "users"]`         |
| `{{#each roles}}{{this.name}},{{/each}}`                               | Extract names from objects: `[{name: "admin"}]` |
| `{{{json (pluck roles "name")}}}`                                      | Extract names as JSON array using pluck helper  |
| `{{#each user.memberships.groups}}{{this}},{{/each}}`                  | Nested path to groups                           |
| `{{#with (json roles)}}{{#each this}}{{this.name}},{{/each}}{{/with}}` | Parse JSON string claim, then extract names     |

**Enterprise IdP Example (Array of Objects):**

If your IdP sends roles as an array of objects:

```json
{
  "roles": [
    { "name": "Application Administrator", "attributes": [] },
    { "name": "n8n_access", "attributes": [] }
  ]
}
```

Use the template: `{{#each roles}}{{this.name}},{{/each}}` to extract `["Application Administrator", "n8n_access"]`

Or use the pluck helper: `{{{json (pluck roles "name")}}}` for a cleaner JSON array output.

**Enterprise IdP Example (JSON String Claim):**

Some IdPs (like Okta) may send complex claims as JSON **strings** rather than native arrays:

```json
{
  "roles": "[{\"name\":\"Application Administrator\"},{\"name\":\"n8n_access\"}]"
}
```

For JSON string claims, first parse the string using the `json` helper:

```handlebars
{{#with (json roles)}}{{#each this}}{{this.name}},{{/each}}{{/with}}
```

Or combine `json` and `pluck` helpers:

```handlebars
{{{json (pluck (json roles) "name")}}}
```

### Linking Teams to External Groups

After configuring how groups are extracted:

1. Navigate to **Settings > Teams**
2. Create a team or select an existing team
3. Click the **link icon** (Configure SSO Team Sync) button next to the team
4. In the dialog, enter the external group identifier(s) to link:
   - The group name as extracted by your Handlebars template or default extraction
   - For LDAP-style groups: The full DN (e.g., `cn=admins,ou=groups,dc=example,dc=com`)
   - For Azure AD: The group object ID or display name
5. Click **Add** to create the mapping
6. Repeat for additional groups if needed

### Group Identifier Matching

- Group matching is **case-insensitive** (e.g., `Engineering` matches `engineering`)
- The identifier must exactly match what your Handlebars template extracts
- A single team can be linked to multiple external groups
- Multiple teams can share the same external group mapping

### Example: Development Team Setup

Let's say you have a group in your IdP called `dev-team` and want all members to automatically join the "Development" team in Archestra:

1. Ensure your IdP sends the `groups` claim with group names
2. In Archestra, create a team called "Development"
3. Click the link icon for the team
4. Enter `dev-team` as the external group identifier
5. Click Add

Now, when users with the `dev-team` group log in via SSO, they'll automatically be added to the Development team.

### Example: Complex Roles Setup

If your IdP sends roles as objects (e.g., `roles: [{name: "admin"}, {name: "viewer"}]`):

1. Edit your SSO provider configuration
2. Expand **Team Sync Configuration**
3. Set **Groups Handlebars Template** to: `{{#each roles}}{{this.name}},{{/each}}`
4. Save the provider
5. Link your teams to group identifiers like `admin` or `viewer`

### Troubleshooting Team Sync

**Users not being added to teams:**

1. Check that **Enable Team Sync** is enabled in your SSO provider settings
2. Verify your Handlebars template extracts the expected groups from the ID token
3. Use a JWT decoder (like [jwt.io](https://jwt.io)) to inspect your ID token claims
4. Check that the group identifier in Archestra exactly matches the extracted group name
5. Ensure your IdP is configured to include group claims in the ID token (not just userinfo)
6. Check backend logs for sync errors

**Testing your Handlebars template:**

You can test Handlebars templates at [tryhandlebarsjs.com](http://tryhandlebarsjs.com/) using your actual ID token claims as input.

**Users not being removed from teams:**

- Only members with `syncedFromSso = true` are removed by sync
- Members added manually are never removed
- Verify the user's IdP groups have actually changed

**Checking ID token groups:**

Use a JWT decoder (like [jwt.io](https://jwt.io)) to inspect the ID token and verify the groups claim contains the expected values. Role mapping and team sync both use ID token claims exclusively.

## User Provisioning

When a user authenticates via SSO for the first time:

1. A new user account is created with their email and name from the identity provider
2. The user's role is determined by role mapping rules (if configured) or defaults to the provider's configured default role (or **Member** if not specified)
3. The user is added to the organization with the determined role
4. A session is created and the user is logged in

Subsequent logins automatically link to the existing account based on email address. Role mapping rules are evaluated on each login, so role changes in the IdP are reflected on next sign-in.

## Account Linking

If a user already has an account (created via email/password), SSO authentication will automatically link to that account when:

- The email addresses match
- The SSO provider is in the trusted providers list (Okta, Google, GitHub, GitLab, Entra ID, and all SAML providers are trusted by default)

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

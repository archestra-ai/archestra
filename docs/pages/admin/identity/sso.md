---
title: Single Sign-On
description: Add workplace sign-in and map directory claims to access
order: 1
lastUpdated: 2026-10-22
---

Let people sign in with their workplace accounts. Test one sign-in before requiring SSO for everyone. This is an [Enterprise feature](/docs/get-started/pricing-model).

<span id="callback-urls"></span>

<span id="linked-downstream-idps"></span>

<span id="oidc"></span>

<span id="saml-assertion-consumer-service-url"></span>

<span id="sign-in-boundaries"></span>

<span id="supported-protocols"></span>

<span id="template-helpers"></span>

## Add a Provider

For provider-specific values, use the [Entra ID](/docs/admin/identity/entra-obo) or [Okta](/docs/admin/identity/okta) guide.

1. Register Archestra as a web application in your identity provider.
2. Set its callback URL. The `{ProviderId}` is case-sensitive: `Okta`, `EntraID`, `Google`, `GitHub`, `GitLab`, or your custom Provider ID.

| Protocol | Production Callback URL | Local Development URL |
| --- | --- | --- |
| **OIDC** | `https://<domain>/api/auth/sso/callback/{ProviderId}` | `http://localhost:3000/api/auth/sso/callback/{ProviderId}` |
| **SAML (ACS URL)** | `https://<domain>/api/auth/sso/saml2/sp/acs/{ProviderId}` | `http://localhost:3000/api/auth/sso/saml2/sp/acs/{ProviderId}` |

3. Open **Settings → Identity Providers**, enable the provider, and enter its issuer, client ID, and client secret or SAML metadata.
4. Set **Allowed Email Domains** if sign-in should be restricted. Subdomains match too: `company.com` allows `eng.company.com`.
5. Click **Create Provider** and test sign-in in an incognito window.

For a provider used only for MCP token exchange, clear **Use for Single Sign-On**. It stays off the sign-in screen and does not assign roles.

## Role Mapping

Rules evaluate token claims at each sign-in. The first [Handlebars](https://handlebarsjs.com/) template returning a non-empty string assigns its target roles.

1. In **Settings → Identity Providers**, edit your provider and select **Role Mapping**.
2. Add one or more **Mapping Rules** with a template and target roles.
3. Set **Default Roles** for new users who match no rule.
4. Optional: Turn on **Strict Mode** to block sign-in for users who match no rule.
5. Optional: Turn on **Skip Role Sync** to evaluate roles only on first sign-in, leaving subsequent role changes to manual administration.

For example, map this rule to **Admin**:

```handlebars
{{#includes groups "admins"}}true{{/includes}}
```

For OIDC, ensure the ID token includes the group claim; your provider may require the `groups` scope.

## Team Sync

Sync adds and removes directory-managed team memberships while preserving members added manually in Archestra.

1. In the provider's **Team Sync** tab, verify **Enable Team Sync** is on.
2. If your IdP uses custom group claim paths, set **Groups Handlebars Template** (e.g. `{{#each groups}}{{this}},{{/each}}`). Otherwise, Archestra checks `groups`, `group`, `memberOf`, `roles`, and `teams` in order.
3. Go to **Settings → Teams**, click **Edit** on target team, and open **External Group Sync**.
4. Enter the external group identifier (such as an Entra group object ID or Okta group name) and click **Add**.

## Enforcing SSO

Lock down authentication to your identity provider once SSO sign-in is tested and verified:

1. **Disable password sign-in:** Set [`ARCHESTRA_AUTH_DISABLE_BASIC_AUTH=true`](/docs/admin/deployment/configuration#ARCHESTRA_AUTH_DISABLE_BASIC_AUTH) in the backend environment and restart. This hides the email/password form and requires SSO.
2. **Disable invitations:** Set [`ARCHESTRA_AUTH_DISABLE_INVITATIONS=true`](/docs/admin/deployment/configuration#ARCHESTRA_AUTH_DISABLE_INVITATIONS) to disable manual user invite workflows.

If SSO fails while password authentication is disabled, recover via the command line with [Account Security](/docs/admin/identity/account-security#reset-a-password-from-the-cli).

## Change an Email Claim

Keep **User ID Claim** unchanged when changing **Email Claim**. With OIDC profile updates enabled, the next sign-in updates the existing account's email. Saving the mapping does not change active sessions. An email already used by another account may require resolving that conflict first.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `state_mismatch` | Cookies blocked or mismatched callback URL | Enable browser third-party cookies and verify the IdP redirect URI matches the case-sensitive `{ProviderId}`. |
| `account not linked` | Mismatched or unverified email | Confirm the user signs in with the email address registered on Archestra, and verify the email in the IdP. |
| `account_not_found` (SAML) | Missing user attributes | Configure your SAML IdP to include `NameID` in `emailAddress` format, plus `email`, `firstName`, and `lastName`. |
| `signature_validation_failed` | Expired or rotated SAML certificate | Re-download your IdP SAML metadata and update the certificate in Archestra. |
| User missing team membership | Group claim omitted or identifier typo | Confirm the IdP sends the group claim in the ID token and that the group name in **Settings → Teams** matches verbatim. |

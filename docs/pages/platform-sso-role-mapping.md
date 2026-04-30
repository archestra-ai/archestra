---
title: "Role Mapping"
category: Administration
subcategory: Identity Providers
description: "Map SSO claims to Archestra roles using Handlebars templates"
order: 5
lastUpdated: 2026-04-30
---

<!--
Check ../docs_writer_prompt.md before changing this file.

Provider-agnostic page covering role mapping for any OIDC or SAML SSO provider.
Linked from per-provider pages (Entra, Okta, etc.) and from the parent
Identity Providers index.
-->

Archestra supports automatic role assignment based on user attributes from your identity provider using [Handlebars](https://handlebarsjs.com/) templates. This lets you map SSO groups, roles, or other claims to Archestra roles (Admin, Member, or any custom role you have defined).

## How role mapping works

1. When a user authenticates via SSO, Archestra receives user attributes from the identity provider's ID token (for OIDC) or SAML assertions
2. These attributes are evaluated against your configured mapping rules in order
3. The first rule that matches determines the user's Archestra role
4. If no rules match, the user is assigned the configured default role (or **Member** if not specified)

## Configuring role mapping

When creating or editing an SSO provider, expand the **Role Mapping (Optional)** section:

1. **Mapping Rules** — add one or more rules. Each rule has:
   - **Handlebars Template:** a template that renders to a non-empty string when the rule should match
   - **Archestra Role:** the role to assign when the template matches

2. **Default Role** — the role assigned when no rules match (defaults to "member")

3. **Strict Mode** — when enabled, denies user login if no mapping rules match. Useful when you want to ensure that only users with specific IdP attributes can access Archestra. Without strict mode, users who don't match any rule are simply assigned the default role.

4. **Skip Role Sync** — when enabled, the user's role is only determined on their first login. Subsequent logins will not update their role, even if their IdP attributes change. This allows administrators to manually adjust roles after initial provisioning without those changes being overwritten on next login.

## Handlebars template examples

Templates should render to any non-empty string (like `"true"`) when the rule matches. The following custom helpers are available:

| Helper      | Description                                                  |
| ----------- | ------------------------------------------------------------ |
| `includes`  | Check if an array includes a value (case-insensitive)        |
| `equals`    | Check if two values are equal (case-insensitive for strings) |
| `contains`  | Check if a string contains a substring (case-insensitive)    |
| `and`       | Logical AND — true if all values are truthy                  |
| `or`        | Logical OR — true if any value is truthy                     |
| `exists`    | True if the value is not null/undefined                      |
| `notEquals` | Check if two values are not equal                            |

**Example templates:**

| Template                                                                                             | Description                                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `{{#includes groups "admins"}}true{{/includes}}`                                                     | Match if "admins" is in the groups array         |
| `{{#equals role "administrator"}}true{{/equals}}`                                                    | Match if role claim equals "administrator"       |
| `{{#each roles}}{{#equals this "platform-admin"}}true{{/equals}}{{/each}}`                           | Match if "platform-admin" is in roles array      |
| `{{#and department title}}{{#equals department "IT"}}true{{/equals}}{{/and}}`                        | Match IT department users with a title set       |
| `{{#with (json roles)}}{{#each this}}{{#equals this.name "admin"}}true{{/equals}}{{/each}}{{/with}}` | Match role name in JSON string claim (see below) |

> **Tip:** templates should output any non-empty string when matching. The text `"true"` is commonly used but any output works.

### Handling JSON string claims

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

## Troubleshooting

**Role not being assigned correctly:**

1. Check your IdP's configuration to ensure the expected claims/attributes are being sent
2. Use your IdP's token introspection or SAML assertion viewer to verify the actual data
3. Ensure your Handlebars template syntax is correct
4. Rules are evaluated in order — make sure your most specific rules come first

**Missing groups claim:**

- For OIDC: verify your IdP is configured to include groups in the token/userinfo
- For SAML: check that group attributes are included in the assertion and properly mapped

**Template always returns empty:**

- Check for typos in claim/attribute names — they are case-sensitive in the template
- Ensure your IdP is sending the expected claims in the ID token
- The `includes` helper handles null/undefined arrays gracefully

You can test Handlebars templates at [tryhandlebarsjs.com](http://tryhandlebarsjs.com/) using your actual ID token claims as input. To inspect the actual claims your IdP sends, paste the ID token into [jwt.io](https://jwt.io).

## See also

- [Team Sync](/docs/platform-sso-team-sync) — automatically add or remove users from Archestra teams based on IdP group membership
- [Identity Providers](/docs/platform-identity-providers) — provider list and SSO setup

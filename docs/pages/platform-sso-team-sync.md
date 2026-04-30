---
title: "Team Sync"
category: Administration
subcategory: Identity Providers
description: "Automatically add and remove users from Archestra teams based on IdP group membership"
order: 6
lastUpdated: 2026-04-30
---

<!--
Check ../docs_writer_prompt.md before changing this file.

Provider-agnostic page covering team synchronization for any OIDC or SAML SSO
provider. Linked from per-provider pages (Entra, Okta, etc.) and from the parent
Identity Providers index.
-->

Archestra supports automatic team membership synchronization based on user group memberships from your identity provider. When users log in via SSO, they are automatically added to or removed from Archestra teams based on their IdP groups.

## How team sync works

1. Admin configures an Archestra team and links it to one or more external IdP groups
2. When a user logs in via SSO, their group memberships are extracted from the SSO token
3. Archestra compares the user's IdP groups against the external groups linked to each team
4. **Added:** users in a linked group are automatically added to the team
5. **Removed:** users no longer in any linked group are automatically removed (if they were added via sync)
6. **Manual members preserved:** members added manually to a team are never removed by sync

## Configuring team sync

When creating or editing an SSO provider, expand the **Team Sync Configuration (Optional)** section.

1. **Enable Team Sync** — when enabled (default), users are automatically added or removed from Archestra teams based on their SSO group memberships.
2. **Groups Handlebars Template** — a [Handlebars](https://handlebarsjs.com/) template that extracts group identifiers from the ID token claims. Should render to a comma-separated list or JSON array. Leave empty to use default extraction.

### Default group extraction

If no custom Handlebars template is configured, Archestra automatically checks these common claim names in order:

`groups`, `group`, `memberOf`, `member_of`, `roles`, `role`, `teams`, `team`

The first claim that contains non-empty group data is used.

### Custom Handlebars templates

For identity providers with non-standard ID token formats, use Handlebars templates to extract group identifiers from complex claim structures. The template should render to either a comma-separated list or a JSON array.

**Available helpers:**

| Helper  | Description                                                  |
| ------- | ------------------------------------------------------------ |
| `json`  | Convert value to JSON string, or parse JSON string to object |
| `pluck` | Extract a property from each item in an array                |

**Common examples:**

| Template                                                               | Description                                     |
| ---------------------------------------------------------------------- | ----------------------------------------------- |
| `{{#each groups}}{{this}},{{/each}}`                                   | Simple flat array: `["admin", "users"]`         |
| `{{#each roles}}{{this.name}},{{/each}}`                               | Extract names from objects: `[{name: "admin"}]` |
| `{{{json (pluck roles "name")}}}`                                      | Extract names as JSON array using pluck helper  |
| `{{#each user.memberships.groups}}{{this}},{{/each}}`                  | Nested path to groups                           |
| `{{#with (json roles)}}{{#each this}}{{this.name}},{{/each}}{{/with}}` | Parse JSON string claim, then extract names     |

### Enterprise IdP example — array of objects

If your IdP sends roles as an array of objects:

```json
{
  "roles": [
    { "name": "Application Administrator", "attributes": [] },
    { "name": "n8n_access", "attributes": [] }
  ]
}
```

Use the template `{{#each roles}}{{this.name}},{{/each}}` to extract `["Application Administrator", "n8n_access"]`. Or use the pluck helper for a cleaner JSON array output: `{{{json (pluck roles "name")}}}`.

### Enterprise IdP example — JSON string claim

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

## Linking teams to external groups

After configuring how groups are extracted:

1. Navigate to **Settings > Teams**
2. Create a team or select an existing one
3. Click the **link icon** (Configure SSO Team Sync) button next to the team
4. In the dialog, enter the external group identifier(s) to link:
   - The group name as extracted by your Handlebars template or default extraction
   - For LDAP-style groups: the full DN (for example `cn=admins,ou=groups,dc=example,dc=com`)
   - For Microsoft Entra ID: the group object ID or display name
5. Click **Add** to create the mapping
6. Repeat for additional groups if needed

### Group identifier matching

- Group matching is **case-insensitive** (for example `Engineering` matches `engineering`)
- The identifier must exactly match what your Handlebars template extracts
- A single team can be linked to multiple external groups
- Multiple teams can share the same external group mapping

## Examples

### Simple — Development team

You have a group in your IdP called `dev-team` and want all members to automatically join the "Development" team in Archestra:

1. Ensure your IdP sends the `groups` claim with group names
2. In Archestra, create a team called "Development"
3. Click the link icon for the team
4. Enter `dev-team` as the external group identifier
5. Click **Add**

When users with the `dev-team` group log in via SSO, they will automatically be added to the Development team.

### Complex — roles as objects

If your IdP sends roles as objects (for example `roles: [{name: "admin"}, {name: "viewer"}]`):

1. Edit your SSO provider configuration
2. Expand **Team Sync Configuration**
3. Set **Groups Handlebars Template** to `{{#each roles}}{{this.name}},{{/each}}`
4. Save the provider
5. Link your teams to group identifiers like `admin` or `viewer`

## Troubleshooting

**Users not being added to teams:**

1. Check that **Enable Team Sync** is enabled in your SSO provider settings
2. Verify your Handlebars template extracts the expected groups from the ID token
3. Use a JWT decoder (like [jwt.io](https://jwt.io)) to inspect your ID token claims
4. Check that the group identifier in Archestra exactly matches the extracted group name
5. Ensure your IdP is configured to include group claims in the ID token (not just userinfo)
6. Check backend logs for sync errors

You can test Handlebars templates at [tryhandlebarsjs.com](http://tryhandlebarsjs.com/) using your actual ID token claims as input.

**Users not being removed from teams:**

- Only members with `syncedFromSso = true` are removed by sync
- Members added manually are never removed
- Verify the user's IdP groups have actually changed

**Checking ID token groups:**

Use a JWT decoder (like [jwt.io](https://jwt.io)) to inspect the ID token and verify the groups claim contains the expected values. Role mapping and team sync both use ID token claims exclusively.

## See also

- [Role Mapping](/docs/platform-sso-role-mapping) — map IdP claims to Archestra roles using Handlebars
- [Identity Providers](/docs/platform-identity-providers) — provider list and SSO setup

---
title: "Team Sync"
description: "Automatically add and remove users from Archestra teams based on IdP group membership"
order: 3
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->


Team Sync adds and removes team memberships at SSO sign-in using the user's identity-provider groups.

Sync creates direct membership in the mapped team. If that team is nested, the user also receives resource access inherited from its parent teams. Team roles and team administration are not inherited. See [Team Hierarchies](/docs/admin/access-control#team-hierarchies) for the complete access rules.

> **Enterprise feature** — see the [Licensing](/docs/get-started#licensing).

## How Team Sync Works

1. Admin configures an Archestra team and links it to one or more external IdP groups
2. When a user logs in via SSO, their group memberships are extracted from the SSO token
3. Archestra compares the user's IdP groups against the external groups linked to each team
4. **Added:** users in a linked group are automatically added to the team
5. **Removed:** users no longer in any linked group are automatically removed (if they were added via sync)
6. **Manual members preserved:** members added manually to a team are never removed by sync

## Configuring Team Sync

When creating or editing an SSO provider, select the **Team Sync** section.

1. **Enable Team Sync** — when enabled (default), users are automatically added or removed from Archestra teams based on their SSO group memberships.
2. **Groups Handlebars Template** — a [Handlebars](https://handlebarsjs.com/) template that extracts group identifiers from the ID token claims. Should render to a comma-separated list or JSON array. Leave empty to use default extraction.

### Default Group Extraction

If no custom Handlebars template is configured, Archestra automatically checks these common claim names in order:

`groups`, `group`, `memberOf`, `member_of`, `roles`, `role`, `teams`, `team`

The first claim that contains non-empty group data is used.

For OIDC providers, make sure the ID token actually includes group data before configuring extraction. Many IdPs do not include groups with the default `openid`, `email`, and `profile` scopes. If you sync from `groups`, add the provider's groups scope (often `groups`) and configure the IdP to emit that claim in the ID token.

### Custom Handlebars Templates

For identity providers with non-standard ID token formats, use Handlebars templates to extract group identifiers from complex claim structures. The template should render to either a comma-separated list or a JSON array.

**Available helpers:**

| Helper  | Description                                                  |
| ------- | ------------------------------------------------------------ |
| `json`  | Convert value to JSON string, or parse JSON string to object |
| `pluck` | Extract a property from each item in an array                |

For a flat `groups` array, use:

```handlebars
{{#each groups}}{{this}},{{/each}}
```

For an array of role objects, use `{{{json (pluck roles "name")}}}`.

### JSON String Claims

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

## Linking Teams to External Groups

After configuring how groups are extracted:

1. Navigate to **Settings > Teams**
2. Create a team or select an existing one
3. Click **Edit** next to the team
4. Select **External Group Sync**
5. Enter the external group identifier(s) to link:
   - The group name as extracted by your Handlebars template or default extraction
   - For LDAP-style groups: the full DN (for example `cn=admins,ou=groups,dc=example,dc=com`)
   - For Microsoft Entra ID: the group object ID or display name
6. Click **Add** to create the mapping
7. Repeat for additional groups if needed

Users with organization-level team management can configure any team. Team admins can configure their own external group mappings without access to identity-provider settings. Readers of identity-provider settings can use **View group sync** without editing mappings.

### Group Identifier Matching

- Group matching is **case-insensitive** (for example `Engineering` matches `engineering`)
- The identifier must exactly match what your Handlebars template extracts
- A single team can be linked to multiple external groups
- Multiple teams can share the same external group mapping

## Troubleshooting

**Users not being added to teams:**

1. Check that **Enable Team Sync** is enabled in your SSO provider settings
2. Verify your Handlebars template extracts the expected groups from the ID token
3. Check **Latest ID token claims** in the Team Sync section to inspect the decoded claims from your latest sign-in
4. Check that the group identifier in Archestra exactly matches the extracted group name
5. Ensure your IdP is configured to include group claims in the ID token, and that Archestra requests the groups scope required by your IdP
6. Check backend logs for sync errors

Use the built-in template tester in the Team Sync section to test the groups template against your latest decoded ID token claims.

**Users not being removed from teams:**

- Only memberships created by SSO sync are removed
- Members added manually are never removed
- Verify the user's IdP groups have actually changed

**Checking ID token groups:**

When editing an existing OIDC provider, check **Latest ID token claims** in the Team Sync section and verify the group claim contains the expected values. Role mapping and team sync both use ID token claims.

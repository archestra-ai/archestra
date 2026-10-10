---
title: Access Control
description: Assign roles and share resources with users, teams, and service accounts
order: 2
lastUpdated: 2026-10-09
---

Roles control which sections a person can open and which kinds of resources they can create. Resource grants control which individual agents, gateways, skills, apps, models, and credentials they can reach. Configure both when giving someone access.

## Predefined Roles

Built-in roles cannot be edited or deleted. **Admin** has every organization permission. **Platform Admin** manages the platform without organization-wide logs or user impersonation. **Editor** manages core resources without organization settings or user management. **Member** can create agents and chat, with read access to many other sections.

See the [complete role tables](/docs/reference/permissions#predefined-roles) before choosing a role.

## Custom Roles

With [`ac:create`](/docs/reference/permissions#ac:create), go to **Settings → Roles** and create a role. Select only the permissions needed for the job, then assign it to members, teams, or service accounts. Editing and deleting custom roles require [`ac:update`](/docs/reference/permissions#ac:update) and [`ac:delete`](/docs/reference/permissions#ac:delete) respectively. The [permission reference](/docs/reference/permissions#available-permissions) describes every action.

### Multiple Roles And Team Grants

An account receives the combined permissions of its assigned roles. Members also inherit organization roles assigned to their teams and ancestor teams. Removing one assignment removes its grants only if no other assignment provides them.

Organization roles assigned to teams are separate from [team membership roles](#team-roles). The account permissions page shows the sources of each granted action.

### No Privilege Escalation

You can grant only permissions you already hold. This applies when changing roles, inviting members, assigning roles to teams or service accounts, and changing team membership or hierarchy. Role pickers disable roles beyond your authority.

[SSO role mapping](/docs/admin/identity/sso#role-mapping) is configured by the identity provider and can assign roles independently of the signing-in user's permissions.

### Service Account Creators

Service accounts can create resources within their assigned permissions. Creator attribution does not grant team membership. Resources with personal human ownership, including projects, require a user account.

### Available Permissions

Look up every role action in the [permission reference](/docs/reference/permissions#available-permissions).

## Granular Access Control

A resource grant names a recipient and the actions they can perform. Recipients can be users, teams, service accounts, roles, or **Everyone in the organization**. A service account's access is independent of its creator. Disabling the account prevents it from using its grants.

Granular access control is an Enterprise feature, including the [small-team allowance](/docs/get-started/pricing-model). When entitlement ends, existing grants remain enforced. You can revoke or reduce grants. Adding or expanding them requires entitlement.

To share a resource, add recipients in its permissions, next to its other settings. One field adds everyone in the organization, a role, a team, a person, or a service account. Each recipient gets its own level: **Can view**, **Can use**, **Can edit**, or **Full access**. A new recipient starts at **Can use** when you may grant it. Save, then confirm the recipient appears with the intended level.

For grants covering every object of a kind, open the resource list's **More actions** menu beside **Create** or **Add**, then choose **Permissions**. Global policy administration requires [`accessPolicies:read`](/docs/reference/permissions#accessPolicies:read) to view or [`accessPolicies:update`](/docs/reference/permissions#accessPolicies:update) to edit. An individual resource requires `manage-permissions` on that resource.

At least one recipient must keep **Full access** in the permissions for every object of a kind. Without it, nobody can edit, delete, or share objects that other people created, so **Save** stays off until one recipient has it.

### Actions And Scopes

**Can view** permits reading. **Can use** permits execution. **Can edit** permits configuration changes. **Full access** also includes deletion and permission management. Editing does not imply execution or sharing.

MCP registry entries add **Full access + deploy**, which permits deployment specification, service account, and secret-source changes. Admin and Platform Admin receive this access by default. The creator's ordinary Full access does not include deployment changes. OAuth client registrations have no **Can use** preset.

A grant applies to one resource or to `*`: every current and future resource of that kind in the organization. Actions and scopes stay paired. Giving someone read access to all entries and edit access to one entry lets them edit only that entry.

### Sharing Level

Every shared resource shows how far it reaches: **Personal**, **Team-wide**, or **Org-wide**. A typical resource starts Personal while you build it, becomes Team-wide when you add a team, and Org-wide when you add everyone. The level follows the resource's own grants that include **Can view** or more:

| Level | Set by |
| --- | --- |
| **Org-wide** | A grant to everyone, or to any role |
| **Team-wide** | A grant to any team |
| **Personal** | Neither of the above |

What to know:

- Grants to people and service accounts do not change the level.
- Organization-wide grants on every resource of a kind do not count, such as Admin's full access.

### Find Resources by Access

Lists of shared resources filter by how you reach each item. These lists have the filters: agents, MCP gateways, Knowledge Bases, connectors, Knowledge Files, apps, plugins, projects, skills, the MCP registry, LLM provider credentials, virtual keys, models, and OAuth clients.

- **Access:** **Mine** for items you own. **Shared with me** for items shared with you, your team, your role, or everyone. **Admin access** for items nobody shared with you, visible through an organization-wide grant.
- **Shared with:** everyone, a role, a team, a person, or a service account.
- **Owner:** one or more owners.

Models have no owner, so their list has no **Mine** option and no **Owner** filter. On Knowledge Files, the filters narrow documents. Directories always show. The filters combine. The list API takes the same filters as `access`, `sharedWith`, and `owner` query parameters. `sharedWith` takes comma-separated `org`, `role:<id>`, `team:<id>`, `user:<id>`, or `serviceAccount:<id>`. `org` matches only grants to everyone. `owner` takes comma-separated user IDs.

### Inheritance And Revocation

Access combines direct grants, team grants, effective-role grants, and organization-wide grants. A team grant reaches every member regardless of membership role, including descendant teams. Removing a direct grant does not remove inherited access. Change that grant at its source.

The Permissions editor displays inherited grants separately. A read grant on all chats reaches chats in projects the recipient can open, never private chats.

### Delegation And Concurrent Edits

You can share only actions you hold. Team administration can change membership, but does not authorize editing the resources or grants shared with the team.

Assigning a role, or adding someone to a team, shares every grant the role or team carries, so you must hold those grants and `manage-permissions` on each object. Grants that members put on their own chats, agent runs, and personal provider keys do not count: only their owner holds those. [`accessPolicies:update`](/docs/reference/permissions#accessPolicies:update) skips this check, so it can assign any role or team.

When the check refuses an assignment, the form lists each object you cannot share. Hover over an object to see the actions you lack on it.

If another administrator saves first, the editor preserves your draft and asks you to reload. Review the latest permissions before saving again. Permission changes appear in the audit log.

### API Example

For API-based sharing, read the policy with [`GET /api/resource-permissions/mcpRegistry/<catalog-id>`](/docs/reference/api#/Permissions/getResourcePermissions). Replace direct grants with `PUT` to the same URL, using the returned revision:

```json
{
  "revision": 0,
  "grants": [
    {
      "subject": {"type": "serviceAccount", "id": "00000000-0000-4000-8000-000000000001"},
      "actions": ["read", "use"]
    }
  ]
}
```

Use the service account ID, not an API-key ID. `PUT` replaces all direct grants: include every existing direct grant you intend to retain. Inherited grants remain.

## Scoped Resources

Creation requires the kind's organization-level create permission. Most resources give their creator full direct access. That grant can be revoked. Ownership does not override revocation.

### Ownership

The owner is the person who created the resource. **Mine** and the **Owner** filter use it. The owner's grant shows as Full access and cannot be removed from the list.

To hand a resource to another person, use **Make owner** on their row:

- The new owner gets Full access.
- The previous owner keeps Full access. Remove them as a separate change.
- Other grants do not change.

Only someone with edit and Full access on the resource can make another person the owner. Plugins require edit access to every plugin.

### Team Roles

A team **member** receives shared access. A team **admin** can manage its members and settings without organization-wide [`team:update`](/docs/reference/permissions#team:update). The creator becomes the first team admin. This role does not authorize creating or deleting teams, managing other teams, or editing shared MCP connections.

### Team Hierarchies

Members inherit resource grants and organization roles from ancestor teams. Access does not flow from a child to its parent or to siblings. Team administrator roles are not inherited. Deleting a parent moves its direct children to the root.

[SSO Team Sync](/docs/admin/identity/sso#team-sync) creates direct membership in mapped teams. Normal inheritance then applies.

### Environments

Deploying into an [environment](/docs/admin/environments#deploy-permissions) requires a `use` grant there. New environments are shared with the organization. Remove that grant to restrict deployment to selected teams. Default is open to anyone who can create the resource.

### OAuth Clients

MCP and LLM OAuth clients have separate grants. **Can edit** permits reconfiguration and secret rotation. **Full access** also permits deletion and sharing. These grants govern client management. Tokens reach only what the client configuration allows.

### Visibility-Scoped Credentials

Provider keys and virtual keys can have personal, team, or organization scope. Personal records are limited to their owner. Team records require membership. Team admins can manage their team's records. Organization records require an update grant on `*` for that kind.

### Models

Read grants control model discovery. Use grants control invocation through the LLM Proxy. A wildcard use grant covers future models and uncatalogued model IDs. Refreshing the catalog preserves grants and revocations.

### Chat Access And Optional UI Controls

Chat requires [`chat:read`](/docs/reference/permissions#chat:read) and access to an agent context through [`agent:read`](/docs/reference/permissions#agent:read). [`chat:full-view`](/docs/reference/permissions#chat:full-view) shows the agent picker, model and API-key selectors, and expandable tool calls. It changes the interface without granting access to credentials or models.

### MCP Registry And Installation Records

Registry grants govern catalog entries. Installation permissions govern connections, credentials, and running servers. Team installations also depend on team membership. Organization-wide connections and administration of any team connection require an `update` grant on all MCP registry entries (`*`), alongside each operation's normal installation permission.

Deleting a team retains its connections. Callers with installation administration permission can still manage them.

## Team Access

Team grants reach direct members and descendant-team members. An empty direct-grant list does not make a resource public, and wildcard grants still apply.

### Agent Access vs MCP Server Access

Sharing an agent does not share its MCP servers. A person who can use an agent gets only the tools from servers they can access, in both [tool modes](/docs/agents#tool-access-modes). A tool assigned from any other server is hidden from them, and a call to it is refused.

What to know:

- Team tokens, organization tokens, and service accounts keep every tool assigned to the agent.
- [Credential resolution](/docs/mcp/authentication/servers#credential-resolution) picks the connection for a tool the person can use, including a connection pinned to the tool.

## Log Visibility

[`log:read`](/docs/reference/permissions#log:read) shows your LLM and MCP logs. Add [`log:admin`](/docs/reference/permissions#log:admin) for organization-wide logs. Audit events use [`auditLog:read`](/docs/reference/permissions#auditLog:read) and [`auditLog:admin`](/docs/reference/permissions#auditLog:admin). Guardrail consult logs use [`openappaDiagnostics:read`](/docs/reference/permissions#openappaDiagnostics:read) and [`openappaDiagnostics:admin`](/docs/reference/permissions#openappaDiagnostics:admin). Resource sharing does not determine log visibility.

## LLM API Permissions

The [LLM API permission table](/docs/reference/permissions#llm-api-permissions) lists access requirements for usage exports, costs, and logs, including service-account exports.

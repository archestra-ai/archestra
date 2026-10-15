---
title: Access Control
description: Choose roles, share individual resources, and diagnose inherited access
order: 2
lastUpdated: 2026-10-15
---

Let a support team use a triage agent without letting them edit it. Roles determine which areas people can open and what they can create; resource grants determine which items they can read, use, change, or share.

## Predefined Roles

Choose a built-in role for organization permissions, then share the resources the person needs.

| Role | Use it for |
| --- | --- |
| **Admin** | Organization administration, including organization-wide logs and impersonation. |
| **Platform Admin** | Platform administration without those two capabilities. |
| **Editor** | Managing core resources without organization settings or user management. |
| **Member** | Creating agents and using chat, with read access to many other areas. |

Built-in roles cannot be edited. The [complete role tables](/docs/reference/permissions#predefined-roles) list their exact permissions.

## Custom Roles

Create a custom role when the built-in roles grant more than the job needs.

1. With [`ac:create`](/docs/reference/permissions#ac:create), open **Settings → Roles** and create a role.
2. Select the [permissions](/docs/reference/permissions#available-permissions) needed for the job.
3. Assign the role to a member, team, or service account. Check the account's permissions to see which assignments provide each action.

Editing requires [`ac:update`](/docs/reference/permissions#ac:update); deleting requires [`ac:delete`](/docs/reference/permissions#ac:delete).

<span id="multiple-roles-and-team-grants"></span>
<span id="available-permissions"></span>
<span id="service-account-creators"></span>

Accounts combine permissions from all assigned roles. People also inherit organization roles from their teams and ancestor teams. A service account uses its own roles and grants, independently of its creator; disabling it stops its access.

## Granular Access Control

Share one item through its **Permissions** control. Granular access control is an Enterprise feature, including the [small-team allowance](/docs/get-started/pricing-model).

1. Open the resource's permissions beside its other settings.
2. Add a person, team, role, service account, or **Everyone in the organization**.
3. Choose a permission level for each recipient.
4. Save and confirm the recipient has the intended level.

Sharing with everyone, a role, or a team you do not belong to requires **Full access** on every resource of that kind, or [`accessPolicies:update`](/docs/reference/permissions#accessPolicies:update). Admin and Platform Admin have this authority for every kind by default; Editor has it for models and credentials. Without it, you can add people and your own teams, and retain, reduce, or remove existing grants. Adding a service account also requires [`serviceAccount:read`](/docs/reference/permissions#serviceAccount:read).

For every current and future item of a kind, use **Permissions** beside **Create** or **Add** on its list. Viewing these organization-wide policies requires [`accessPolicies:read`](/docs/reference/permissions#accessPolicies:read); editing requires [`accessPolicies:update`](/docs/reference/permissions#accessPolicies:update). Sharing one item requires **Manage access** on that item.

<span id="actions-and-scopes"></span>

| Level | Adds |
| --- | --- |
| **Can read** | Read the item. |
| **Can use** | Run or invoke it. |
| **Can update** | Change its configuration. |
| **Full access** | Delete it and manage other recipients' access. |

OAuth clients have no **Can use** level. MCP registry entries also offer **Full access + deploy** for deployment specifications, service accounts, and secret sources; ordinary **Full access** excludes these changes. Changing an entry's image, command, URL, or authentication requires **Full access + deploy** or [`mcpRegistry:create`](/docs/reference/permissions#mcpRegistry:create), alongside update access to the entry.

What to know:

- An organization-wide grant covers other people's resources too. Read access to all items plus update access to one item permits updates only to that item.
- Keep at least one recipient with **Manage access**. The editor blocks saving a policy that would remove the last one.
- When Enterprise entitlement ends, existing grants remain enforced. You can reduce or revoke them; expanding access requires entitlement.

### Sharing Level

The item's badge summarizes its own read grants, so you can distinguish personal work from shared resources.

| Badge | Direct grants include |
| --- | --- |
| **Org-wide** | Everyone, or any role. |
| **Team-wide** | A team, without an organization or role grant. |
| **Personal** | Only people or service accounts. |

Organization-wide policies covering every item do not affect this badge. Chat and agent-run owners can share their sessions with anyone, including everyone in the organization, without the organization-wide sharing authority above.

### Find Resources by Access

Use **Access** to find how a resource reaches you.

- **Mine** shows items you own.
- **Shared with me** shows grants to you, your teams, your roles, or everyone.
- **Admin access** includes items visible through organization-wide grants. It also exposes **Shared with** and **Owner** filters.

Models have no owner, so they omit **Mine** and **Owner**. Knowledge Files filters narrow documents while keeping directories visible. For scripts, see [API access filters](/docs/reference/api#resource-access-filters).

### Inheritance and Revocation

Remove access where it was granted: removing a direct grant leaves team, role, and organization grants in effect.

<span id="team-access"></span>
<span id="team-hierarchies"></span>

Team grants and assigned organization roles reach descendant-team members. They do not flow to parents or siblings. Team administrator status is separate and is not inherited.

The permissions editor shows inherited grants separately. [SSO team sync](/docs/admin/identity/sso#team-sync) adds direct membership in mapped teams; normal inheritance then applies.

### Delegation and Concurrent Edits

You can share only actions you hold. Assigning roles or changing team membership can share resource access as well as organization permissions.

<span id="no-privilege-escalation"></span>

For those assignments, you must hold the affected resource grants and **Manage access**. Private grants on another person's chats, runs, and personal provider keys do not count. [`accessPolicies:update`](/docs/reference/permissions#accessPolicies:update) permits organization-wide administration without this delegation check.

The form lists resources you cannot share and the missing actions. If someone else saves a policy first, reload the latest permissions and review your draft before saving again. Changes appear in the audit log.

<span id="api-example"></span>

For scripted changes, use the [resource permissions API](/docs/reference/api#resource-permissions). Its revision check prevents overwriting another editor's changes.

## Scoped Resources

Check these resource-specific rules when a grant alone does not explain access.

### Ownership

An owner keeps **Full access** until ownership is transferred. Their row cannot be removed in the permissions editor.

Use **Make owner** on another person's row to transfer ownership. The new owner receives Full access; the previous owner keeps Full access until you remove their grant separately. Other grants remain unchanged.

The action requires update and Full access on the item. Plugins require update access to every plugin. Resources requiring personal human ownership, such as projects, cannot be created by a service account.

### Team Roles

A team **admin** can manage its members and settings without organization-wide [`team:update`](/docs/reference/permissions#team:update). This does not grant permission to create or delete teams, manage other teams, or edit resources shared with the team.

The team creator becomes its first admin. Deleting a parent team moves its direct children to the root.

### Environments

A resource grant does not authorize deployment into an environment. See [Deploy Permissions](/docs/admin/environments#deploy-permissions).

### OAuth Clients

Client management and token access are separate. [`oauthClient:read`](/docs/reference/permissions#oauthClient:read) opens client registrations; [`oauthClient:create`](/docs/reference/permissions#oauthClient:create) creates them.

**Can update** permits reconfiguration and secret rotation. **Full access** adds deletion and sharing. API access still depends on the client's enabled capabilities, configured resources, token scopes, and acting identity. See [Gateway Access for Apps](/docs/mcp/authentication/applications).

### Credentials and Models

Saved credentials and provider keys have different sharing rules.

<span id="saved-credentials"></span>
<span id="visibility-scoped-credentials"></span>
<span id="models"></span>

- [Saved credentials](/docs/admin/security/credentials#who-can-manage-a-credential) use per-item grants. An organization credential attached to a resource can serve everyone who can use that resource; a personal credential requires each person's own connected value and access.
- Provider keys and virtual keys can be personal, team, or organization scoped. Team membership and the key's grants determine access.
- Model **Can read** permits discovery; **Can use** permits inference. A use grant on all models also covers future and uncatalogued model IDs. Catalog refreshes preserve grants and revocations.

### Chat Access and Optional UI Controls

Chat needs [`chat:read`](/docs/reference/permissions#chat:read) and an agent context accessible through [`agent:read`](/docs/reference/permissions#agent:read).

[`chat:full-view`](/docs/reference/permissions#chat:full-view) exposes agent, model, and key selectors and expandable tool calls. It grants no additional access to models or credentials. A read grant on all chats reaches chats in accessible projects, never private chats.

### MCP Registry and Installation Records

A registry grant shares the server definition; installation permissions govern connections, credentials, and running servers.

Team installations also depend on team membership. Organization-wide connections, and administration of any team's connections, require update access to all registry entries alongside the operation's installation permission. Deleting a team retains its connections for callers with installation administration permission.

<span id="agent-access-vs-mcp-server-access"></span>

Sharing an agent does not share its MCP servers. For a person using an agent, inaccessible servers' tools are hidden and calls are refused in both [tool modes](/docs/agents#tool-access-modes). Team tokens, organization tokens, and service accounts retain assigned tools; [credential resolution](/docs/mcp/authentication/servers#credential-resolution) determines the connection.

## Log Visibility

Logs have their own permissions; sharing a resource does not share its logs.

| Logs | Your activity | Organization activity also requires |
| --- | --- | --- |
| LLM and MCP | [`log:read`](/docs/reference/permissions#log:read) | [`log:admin`](/docs/reference/permissions#log:admin) |
| Audit | [`auditLog:read`](/docs/reference/permissions#auditLog:read) | [`auditLog:admin`](/docs/reference/permissions#auditLog:admin) |
| Guardrail consults | [`openappaDiagnostics:read`](/docs/reference/permissions#openappaDiagnostics:read) | [`openappaDiagnostics:admin`](/docs/reference/permissions#openappaDiagnostics:admin) |

<span id="llm-api-permissions"></span>

For costs, usage exports, and service-account access, use the [LLM API permission table](/docs/reference/permissions#llm-api-permissions).

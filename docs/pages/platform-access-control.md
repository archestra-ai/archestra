---
title: "Access Control"
category: Administration
description: "Role-based access control (RBAC) system for managing user permissions in Archestra"
order: 1
lastUpdated: 2026-09-10
---
<!--
GENERATED FILE — edit codegen-access-control-docs.ts, not this page.
Run `pnpm codegen:access-control-docs` to regenerate.
Renaming/deleting this page? Add a redirect in docs/redirects.json.
-->

Archestra uses a role-based access control (RBAC) system to manage user permissions. This system provides both predefined roles for common use cases and the flexibility to create custom roles with specific permission combinations.

Permissions in Archestra are defined using a `resource:action` format, where:

- **Resource**: The type of object or feature being accessed (e.g., `agent`, `mcpGateway`, `llmProxy`)
- **Action**: The operation being performed (`create`, `read`, `update`, `delete`, `admin`)

For example, `agent:create` allows creating agents, `mcpGateway:update` allows updating MCP gateways, and `llmProxy:read` allows viewing the LLM Proxy.

## Predefined Roles

The following roles are built into Archestra and cannot be modified or deleted:

### Admin

Full access to all resources including user management, roles, and platform settings

The admin role has **all permissions** on every resource.

### Platform Admin

Runs the platform — everything an admin can do, except reading other users' logs, reading the audit log, and impersonating users

Platform Admin holds **all permissions except** `log:admin`, `auditLog:admin`, and `member:impersonate` — so holders run the platform (users, roles, settings, resources) while other members' LLM/MCP logs, the org-wide audit trail, and impersonation stay out of reach. They keep `log:read` and `auditLog:read`, which show **their own** records only. Combined with the [no-privilege-escalation rule](#no-privilege-escalation), a Platform Admin cannot grant themselves or anyone else a role carrying the withheld permissions.

### Editor

Full access to core resources and settings, but cannot manage users, roles, or identity providers

| Resource | Actions |
|----------|--------|
| Agents | `read`, `create`, `update`, `delete`, `deploy-to-restricted` |
| Skills | `read`, `create`, `update`, `delete`, `deploy-to-restricted` |
| Plugins | `read`, `create`, `update`, `delete` |
| Apps | `read`, `create`, `update`, `delete`, `deploy-to-restricted` |
| Code Sandbox | `execute` |
| Agent Triggers | `read`, `create`, `update`, `delete` |
| Scheduled Tasks | `read`, `create`, `update`, `delete` |
| LLM Proxy | `read`, `update` |
| LLM Provider API Keys | `read`, `create`, `update`, `delete` |
| LLM Virtual Keys | `read`, `create`, `update`, `delete` |
| LLM OAuth Clients | `read`, `create`, `update`, `delete`, `team-admin` |
| LLM Models | `read`, `update` |
| LLM Limits | `read`, `create`, `update`, `delete` |
| LLM Cost Analytics | `read` |
| MCP Gateways | `read`, `create`, `update`, `delete`, `deploy-to-restricted` |
| MCP OAuth Clients | `read`, `create`, `update`, `delete`, `team-admin` |
| Tools & Policies | `read`, `create`, `update`, `delete` |
| MCP Registry | `read`, `create`, `update`, `delete`, `deploy-to-restricted` |
| MCP Server Installations | `read`, `create`, `update`, `delete` |
| Environments | `read`, `create`, `update`, `delete` |
| GitHub App Configurations | `read`, `create`, `update`, `delete` |
| Knowledge Sources | `read`, `create`, `update`, `delete`, `query`, `deploy-to-restricted` |
| Chats | `read`, `create`, `update`, `delete` |
| Projects | `read`, `create`, `update`, `delete`, `share-org` |
| Files | `manage` |
| LLM & MCP Logs | `read` |
| API Keys | `read`, `create`, `delete` |
| LLM Settings | `read`, `update` |
| MCP Settings | `read`, `update` |
| Skills Settings | `read`, `update` |
| Knowledge Settings | `read`, `update` |
| Users | `read` |
| Invitations | `read` |
| Roles | `read` |
| Teams | `read` |
| Identity Providers | `read` |
| Secrets | `read` |
| Organization Settings | `read`, `update` |
| Site Notifications | `read` |
| Chat Agent Picker | `enable` |
| Chat Provider Settings | `enable` |
| Chat Expand Tool Calls | `enable` |

### Member

Can manage agents, tools, and chat, with read-only access to most other resources

| Resource | Actions |
|----------|--------|
| Agents | `read`, `create`, `update`, `delete` |
| Skills | `read`, `create`, `update`, `delete` |
| Apps | `read`, `create`, `update`, `delete` |
| Code Sandbox | `execute` |
| Scheduled Tasks | `read`, `create`, `update`, `delete` |
| LLM Proxy | `read` |
| LLM Provider API Keys | `read` |
| LLM Virtual Keys | `read`, `create` |
| LLM OAuth Clients | `read` |
| LLM Models | `read` |
| MCP Gateways | `read`, `create`, `update`, `delete` |
| MCP OAuth Clients | `read` |
| Tools & Policies | `read` |
| MCP Registry | `read`, `update` |
| MCP Server Installations | `read`, `create`, `delete` |
| Environments | `read` |
| Knowledge Sources | `read`, `query` |
| Chats | `read`, `create`, `update`, `delete` |
| Projects | `read`, `create`, `update`, `delete`, `share-org` |
| Files | `manage` |
| API Keys | `read`, `create`, `delete` |
| Teams | `read` |
| Site Notifications | `read` |
| Simple View | `enable` |
| Chat Agent Picker | `enable` |
| Chat Provider Settings | `enable` |
| Chat Expand Tool Calls | `enable` |


## Custom Roles

Users with `ac:create` permission can create custom roles by selecting specific permission combinations. Custom roles allow fine-grained access control tailored to your needs.

### Multiple Roles And Team Grants

Users and service accounts can have multiple organization roles. Their permissions combine: a grant from any assigned role allows that action.

Teams can also hold organization roles. Members inherit these grants from their own teams and every ancestor in the [team hierarchy](#team-hierarchies). Removing a role or membership removes its grants, unless another assignment provides the same permissions.

The account permissions page shows each permission's sources when you hover over or focus its badge. Organization roles assigned to teams are separate from [team membership roles](#team-roles).

#### No privilege escalation

A role can only be granted by someone who already holds every permission it carries. This single rule is enforced server-side on **every** grant path:

- creating or editing a custom role's permissions,
- changing a member's role,
- inviting a user with a role,
- setting the organization's default member role,
- creating or updating a service account,
- assigning roles to teams, adding team members, or changing team parents.

The role pickers in the UI disable roles you cannot grant and explain which permissions you are missing. The rule is what makes deliberately-restricted admin roles trustworthy: an admin role created without, say, `log:read`, `auditLog:read`, and `member:impersonate` cannot be escaped by its holders — with `member:update` they can still manage users freely inside their own permission set, but any attempt to hand out (to themselves or anyone else) a role carrying the withheld permissions is rejected. Roles applied by an identity provider through [SSO role mapping](/docs/platform-sso-role-mapping) are the deliberate exception: they are granted by the IdP configuration, not by a platform user.

### Available Permissions

The following table lists all available permissions that can be assigned to custom roles:

| Permission | Description |
|------------|-------------|
| `ac:read` | View custom roles and their permissions |
| `ac:create` | Create new custom roles |
| `ac:update` | Modify custom role permissions |
| `ac:delete` | Delete custom roles |
| `agent:read` | View and list agents |
| `agent:create` | Create new agents |
| `agent:update` | Modify agent configuration and settings |
| `agent:delete` | Delete agents |
| `agent:deploy-to-restricted` | Assign agents to restricted deployment environments |
| `agentSettings:read` | View agent settings (default model, default agent, default tool guardrails, file uploads, Apps Hackathon recorder) |
| `agentSettings:update` | Modify agent settings (default model, default agent, default tool guardrails, file uploads, Apps Hackathon recorder) |
| `agentTrigger:read` | View agent trigger configurations (Slack, MS Teams, email) |
| `agentTrigger:create` | Set up new agent triggers |
| `agentTrigger:update` | Modify agent trigger configurations |
| `agentTrigger:delete` | Remove agent triggers |
| `apiKey:read` | View API keys |
| `apiKey:create` | Create API keys |
| `apiKey:delete` | Delete API keys |
| `app:read` | View MCP Apps allowed by your resource grants |
| `app:create` | Create new MCP Apps |
| `app:update` | Modify MCP Apps and their tools allowed by your resource grants |
| `app:delete` | Delete MCP Apps |
| `app:deploy-to-restricted` | Assign MCP Apps to restricted deployment environments |
| `auditLog:read` | View audit log records of your own administrative actions |
| `auditLog:admin` | View the organization-wide audit log of every member's administrative actions |
| `chat:read` | View and access chat conversations |
| `chat:create` | Start new chat conversations |
| `chat:update` | Edit chat messages and conversation settings |
| `chat:delete` | Delete chat conversations |
| `chatAgentPicker:enable` | Show agent picker in chat |
| `chatExpandToolCalls:enable` | Allow expanding tool call details in chat |
| `chatProviderSettings:enable` | Show model and API key selectors in chat |
| `environment:read` | View and list deployment environments |
| `environment:create` | Create deployment environments |
| `environment:update` | Modify deployment environments, including the org default environment |
| `environment:delete` | Delete deployment environments |
| `file:manage` | List, read, write, and delete files in chats and projects |
| `githubAppConfig:read` | View GitHub App configurations |
| `githubAppConfig:create` | Create GitHub App configurations |
| `githubAppConfig:update` | Modify GitHub App configurations |
| `githubAppConfig:delete` | Delete GitHub App configurations |
| `identityProvider:read` | View identity provider configurations (SSO) |
| `identityProvider:create` | Set up new identity providers |
| `identityProvider:update` | Modify identity provider settings |
| `identityProvider:delete` | Remove identity providers |
| `invitation:create` | Send invitations to new users |
| `invitation:cancel` | Cancel pending invitations |
| `knowledgeSettings:read` | View knowledge settings (embedding and reranking models) |
| `knowledgeSettings:update` | Modify knowledge settings (embedding and reranking models) |
| `knowledgeSource:read` | View Knowledge Bases and Connectors |
| `knowledgeSource:create` | Create Knowledge Bases and Connectors |
| `knowledgeSource:update` | Modify Knowledge Bases and Connectors |
| `knowledgeSource:delete` | Delete Knowledge Bases and Connectors, view the deleted ones, and restore them |
| `knowledgeSource:query` | Query knowledge sources for information retrieval |
| `knowledgeSource:admin` | View all org-wide and team-scoped Knowledge Bases and Connectors, bypassing team visibility restrictions |
| `knowledgeSource:deploy-to-restricted` | Assign Knowledge Bases and Connectors to restricted deployment environments |
| `knowledgeSourceAutoSync:read` | View auto-sync-permissions connectors: configuration, sync runs, user groups, and member mappings |
| `knowledgeSourceAutoSync:create` | Create connectors with auto-sync permissions (access mirrors the source system) |
| `knowledgeSourceAutoSync:update` | Modify auto-sync-permissions connectors: settings, member mappings, and manual permission syncs |
| `knowledgeSourceAutoSync:delete` | Delete auto-sync-permissions connectors |
| `llmCost:read` | View organization-wide LLM usage cost statistics and analytics |
| `llmLimit:read` | View token usage limits |
| `llmLimit:create` | Create new usage limits |
| `llmLimit:update` | Modify existing usage limits |
| `llmLimit:delete` | Remove usage limits |
| `llmModel:read` | View synced LLM models and capabilities |
| `llmModel:update` | Modify LLM model pricing, modality and generation-parameter settings |
| `llmOauthClient:read` | View LLM OAuth client registrations |
| `llmOauthClient:create` | Create LLM OAuth client registrations |
| `llmOauthClient:update` | Modify LLM OAuth client registrations |
| `llmOauthClient:delete` | Delete LLM OAuth client registrations |
| `llmOauthClient:team-admin` | Manage team assignments for LLM OAuth client registrations |
| `llmOauthClient:admin` | Manage all LLM OAuth client registrations, bypassing team restrictions |
| `llmProviderApiKey:read` | View LLM provider API keys |
| `llmProviderApiKey:create` | Add new LLM provider API keys |
| `llmProviderApiKey:update` | Modify LLM provider API key configuration and visibility |
| `llmProviderApiKey:delete` | Remove LLM provider API keys |
| `llmProviderApiKey:admin` | Manage all LLM provider API keys, including org-wide keys |
| `llmProxy:read` | View the LLM Proxy and its connection details |
| `llmProxy:update` | Modify LLM Proxy configuration |
| `llmSettings:read` | View LLM settings (compression, cleanup interval) |
| `llmSettings:update` | Modify LLM settings |
| `llmVirtualKey:read` | View LLM virtual keys |
| `llmVirtualKey:create` | Create LLM virtual keys |
| `llmVirtualKey:update` | Modify LLM virtual keys and their visibility |
| `llmVirtualKey:delete` | Delete LLM virtual keys |
| `llmVirtualKey:admin` | Manage all LLM virtual keys and view every scope |
| `log:read` | View your own LLM proxy and MCP tool call logs in the active organization |
| `log:admin` | View every LLM proxy and MCP tool call log in the active organization |
| `mcpGateway:read` | View and list MCP gateways |
| `mcpGateway:create` | Create new MCP gateways |
| `mcpGateway:update` | Modify MCP gateway configuration |
| `mcpGateway:delete` | Delete MCP gateways |
| `mcpGateway:deploy-to-restricted` | Assign MCP gateways to restricted deployment environments |
| `mcpOauthClient:read` | View MCP OAuth client registrations |
| `mcpOauthClient:create` | Create MCP OAuth client registrations |
| `mcpOauthClient:update` | Modify MCP OAuth client registrations |
| `mcpOauthClient:delete` | Delete MCP OAuth client registrations |
| `mcpOauthClient:team-admin` | Manage team assignments for MCP OAuth client registrations |
| `mcpOauthClient:admin` | Manage all MCP OAuth client registrations, bypassing team restrictions |
| `mcpRegistry:read` | Browse the MCP server registry |
| `mcpRegistry:create` | Add servers to the MCP registry |
| `mcpRegistry:update` | Modify MCP registry entries |
| `mcpRegistry:delete` | Remove servers from the MCP registry |
| `mcpRegistry:manage-deleted` | View and restore soft-deleted MCP registry entries |
| `mcpRegistry:deploy-to-restricted` | Deploy MCP servers (catalog items) to restricted environments |
| `mcpServerInstallation:read` | View installed MCP servers and their status |
| `mcpServerInstallation:create` | Install MCP servers from the registry |
| `mcpServerInstallation:update` | Modify installed MCP server configuration |
| `mcpServerInstallation:delete` | Uninstall MCP servers |
| `mcpServerInstallation:manage-deleted` | View and restore soft-deleted (uninstalled) MCP servers |
| `mcpServerInstallation:admin` | Approve or manage all MCP server installations |
| `mcpSettings:read` | View MCP settings (online catalog availability) |
| `mcpSettings:update` | Modify MCP settings |
| `member:read` | View organization members and their roles |
| `member:create` | Add new members to the organization |
| `member:update` | Change member roles and settings |
| `member:delete` | Remove members from the organization |
| `member:impersonate` | Temporarily sign in as another member to see the app with their access (role debugging) |
| `organizationSettings:read` | View organization settings (appearance, authentication, etc) |
| `organizationSettings:update` | Customize organization appearance, authentication, etc |
| `plugin:read` | View plugins and their file metadata |
| `plugin:create` | Create plugins |
| `plugin:update` | Modify plugin metadata and files |
| `plugin:delete` | Delete plugins |
| `plugin:admin` | Publish executable plugins through connection marketplaces |
| `project:read` | View projects and your own sessions inside them |
| `project:create` | Create projects |
| `project:update` | Edit project descriptions, instructions, and sharing |
| `project:delete` | Delete projects |
| `project:share-org` | Share projects with the entire organization, and change the sharing of or delete a project that is already org-wide. Without it, projects can still be shared with teams. Additive: sharing still requires project:update and deleting still requires project:delete. |
| `project:admin` | Oversee projects owned by other members: discover them, view/edit/delete the project and its sharing, and view, download, or delete their files — but not read their chats. Additive: edit/delete still require project:update/delete, and schedule management rides scheduledTask:admin (all included in the Admin role). |
| `project:read-all` | View chats and Agent Runtime runs that other members started in any project you can access. Without this, you only see the sessions you started yourself — including in projects you own. |
| `sandbox:execute` | Run commands and upload/download files in code execution sandboxes |
| `scheduledTask:read` | View scheduled tasks and their run history |
| `scheduledTask:create` | Create new scheduled tasks and trigger runs |
| `scheduledTask:update` | Modify scheduled task configuration |
| `scheduledTask:delete` | Delete scheduled tasks |
| `scheduledTask:admin` | View and manage all scheduled tasks, not just your own |
| `secret:read` | View secrets manager configuration |
| `secret:update` | Modify secrets manager settings and test connectivity |
| `serviceAccount:read` | View service accounts |
| `serviceAccount:create` | Create service accounts |
| `serviceAccount:update` | Modify service accounts |
| `serviceAccount:delete` | Delete service accounts |
| `simpleView:enable` | Sidebar is collapsed by default on page load |
| `siteNotification:read` | View site-wide notifications |
| `siteNotification:create` | Create new site notifications |
| `siteNotification:update` | Modify site notifications |
| `siteNotification:delete` | Delete site notifications |
| `skill:read` | View agent skills allowed by your resource grants |
| `skill:create` | Create new agent skills |
| `skill:update` | Modify agent skill content allowed by your resource grants |
| `skill:delete` | Delete agent skills |
| `skill:deploy-to-restricted` | Assign agent skills to restricted deployment environments |
| `skillsSettings:read` | View Skills settings (online catalog availability) |
| `skillsSettings:update` | Modify Skills settings |
| `team:read` | View teams and their members |
| `team:create` | Create new teams |
| `team:update` | Modify team settings |
| `team:delete` | Delete teams |
| `toolPolicy:read` | View tools, tool invocation policies, and trusted data policies |
| `toolPolicy:create` | Register tools and create security policies |
| `toolPolicy:update` | Modify tools, tool configuration, and security policies |
| `toolPolicy:delete` | Remove tools and security policies |


## LLM API Permissions

| API data | Required permissions | Visibility |
|----------|----------------------|------------|
| View LLM Proxy configuration | `llmProxy:read` | The active organization's proxy and connection details |
| Update LLM Proxy configuration | `llmProxy:update` | The active organization's proxy configuration |
| Personal usage (`/api/statistics/me*`) | None | The caller's usage |
| Cost totals, teams, agents, models, and savings | `llmCost:read` | All matching usage in the active organization |
| User cost statistics (`/api/statistics/users`) | `llmCost:read` | The caller's usage |
| User cost statistics for all users | `llmCost:read` and `member:read` | Identified users in the active organization |
| App cost statistics | `llmCost:read` and `app:read` | Apps allowed by the caller’s read grants |
| Skill cost statistics | `llmCost:read` and `skill:read` | Skills allowed by the caller’s read grants |
| LLM and MCP logs for the caller | `log:read` | Records attributed to the caller |
| All LLM and MCP logs | `log:read` and `log:admin` | All records in the active organization, including unattributed traffic |

Service accounts use their assigned role for these APIs. A service account has no personal usage or caller-attributed log rows. Grant `llmCost:read` for organization-wide cost exports. Grant both `log:read` and `log:admin` for organization-wide log exports. Add `member:read` to include per-user cost statistics.


## Resource Permission Grants

Agents, MCP gateways, MCP registry entries, skills, apps, and models support grants for individual resources. A grant identifies a recipient and the actions they may perform on that resource.

| Where you are | Manage permissions |
| --- | --- |
| Creating an agent, MCP registry entry, skill, or app | Add recipients in **Permissions** before saving |
| Agent, MCP gateway, MCP registry entry, or skill detail page | Open the **Permissions** tab |
| App settings | Open **Permissions** in the settings dialog |
| Models list | Choose **Permissions** from the model's actions |
| All objects of a resource type | Open **Settings > Roles > Resource grants** and select the resource type |

Initial grants are validated before creation and persisted with the resource. Invalid recipients or grants beyond your authority reject the creation. Creation APIs and their matching MCP authoring tools accept an optional `initialGrants` array with the same recipient/action entries used below. Models are discovered from providers, so their permissions are configured after discovery.

Resource grants are an Enterprise feature, available under the small-team allowance described in [Pricing Model](/docs/platform-pricing-model). When that entitlement ends, existing grants continue to be enforced and you can revoke or reduce them; adding or expanding grants requires an active entitlement.

Recipients can be users, teams, service accounts, roles, or everyone in the organization. A service account is an independent recipient; its grants do not depend on the person who created it. Disabled service accounts cannot use their grants. Their assigned roles and organization-wide grants also contribute to access, so removing one direct grant does not necessarily remove all access.

### Actions And Scopes

Each permission is evaluated as one complete action-and-scope pair. The scope identifies one resource, all resources, or resources shared with the recipient’s teams. A wildcard for agents does not grant access to MCP servers, and a wildcard never crosses the organization boundary.

| Scope | Applies To |
| --- | --- |
| Resource ID | One resource |
| `*` | Every current and future resource of that type in the organization |
| `teams:*` | Resources with a direct grant to one of the recipient's current teams |

Team-relative scopes follow current membership, including ancestor teams. They do not depend on team membership roles. Service accounts have no team membership, so team-relative grants do not apply to them.

| Action | Allows |
| --- | --- |
| `read` | View the resource |
| `use` | Use or execute the resource |
| `update` | Edit its configuration |
| `delete` | Delete the resource |
| `manage-permissions` | Change its direct grants, within the caller's own authority |

Viewing a resource does not by itself grant execution. Uncatalogued model IDs require a model `use` grant on `*`. For example, a model read grant does not bypass its invocation restrictions; use a model use grant to permit invocation. Disabled apps remain private to their author, even when another recipient has a grant. Editing configuration does not grant permission to share the resource. Creation continues to require the resource's organization-level `create` permission because the object does not exist yet.

For example, a service account can have `read` on all MCP registry entries and `update` on one entry. Those grants allow it to view every entry and edit only that one. The evaluator does not combine the wildcard from the first grant with the update action from the second.

The editor offers **Can view**, **Can use**, **Can edit**, and **Full access** presets. Full access includes deletion and permission management. Inspect the action list below each recipient before saving.

Public marketplace link management remains organization-wide. Creating, listing, rotating, or revoking skill marketplace links requires skill `read`, `use`, and `manage-permissions` on `*`. Editing a skill alone does not authorize public distribution. A link contains the skills selected when it is created; it does not automatically include future skills.

### Inheritance And Revocation

A recipient receives the union of its applicable grants: direct user or service-account grants, team grants, grants to its effective roles, and organization-wide grants. Team grants follow the team hierarchy described below. Grants to roles follow role composition.

The Permissions editor shows direct grants and inherited grants with their source scopes. Removing a direct grant does not remove access supplied by another grant. Change an inherited grant at its source. List views omit personal, team, and organization visibility categories. Built-in origin and labels remain separate filters.

### Migration From Visibility

The migration converts existing sharing into resource grants. Organization-wide sharing becomes an organization grant. Personal ownership becomes an explicit full-access grant. Team use shares become read and use grants. Team write shares additionally grant update. Every team member receives those actions, regardless of their membership role.

Resource-level `:admin` scopes become `*` grants with their associated actions. Resource-level `:team-admin` scopes become `teams:*` grants. These legacy scope flags are distinct from the team's membership admin role.

Existing explicit grants, including service-account grants, survive migration. Migrated policies replace legacy sharing checks. Revoking a grant cannot restore access through an old ownership or visibility setting. Other applicable grants can still provide access.

Creation with `initialGrants` also records the creator's full access explicitly. An empty array creates a creator-only direct policy. Inherited grants still apply. Resources outside this conversion retain the rules described under **Scoped Resources** below.

### Delegation And Concurrent Edits

To change a policy, you need `manage-permissions` on that scope. You can grant only actions that you also hold on that same scope. Authority over one object does not authorize a wildcard grant. Assigning a role or changing team inheritance also checks its scoped grants, including ancestor teams. Team membership administrators can add and remove their team’s members. This changes recipients of existing team grants; it does not let administrators edit those grants or resources. Other callers adding members must also hold the authority they delegate. Role assignment cannot bypass the grant-delegation check.

Saving includes the policy revision. If someone else changes the policy first, the API returns `409` and the editor preserves your draft. Reload the latest policy before saving again. Changes to grants are recorded in the audit log. Unsaved permission edits are kept separate from ordinary configuration saves; use **Save permissions** to apply them.

### API Example

Read a policy with `GET /api/resource-permissions/mcpRegistry/<catalog-id>`. Replace its direct grants with `PUT` to the same URL, passing the revision returned by the read:

```json
{
  "revision": 0,
  "grants": [
    {
      "subject": {
        "type": "serviceAccount",
        "id": "00000000-0000-4000-8000-000000000001"
      },
      "actions": ["read", "use"]
    }
  ]
}
```

Use the service account's ID, not an API-key ID. The recipient must belong to the organization and be active. `PUT` replaces the complete direct-grant list; include any existing direct grants you intend to retain. It does not replace inherited grants.

## Scoped Resources

Agents, MCP gateways, registry entries, apps, skills, and models use the grants described above.
Each grant pairs actions with a resource scope. Creation uses the resource's create permission.
Legacy visibility fields do not authorize access after migration.

### Team Roles

Team membership has its own role, separate from organization RBAC:

- `member`: belongs to the team and can access resources shared with that team
- `admin`: can add and remove members, rename the team, edit its description and metadata, and manage team-scoped settings such as external group sync mappings

Whoever creates a team joins it as that team's first admin, so they can manage its members straight away.

Team admins can edit their own team without organization-wide `team:update`. This does not let them edit other teams, create teams, or delete teams; those operations require their own authorization. A team membership admin role does not grant MCP catalog editing, installation management, or connection reauthentication. Team members receive the same resource grants regardless of their membership role.

Team administration does not grant access to resources shared with the team.
Resource access comes from grants and inherited organization roles.

### Team Hierarchies

Teams can be nested to match an organization structure. A resource assigned to a team is available to direct members of that team and members of every descendant team, at any depth. Access does not flow upward from a child to its parent or sideways to sibling teams.

Hierarchy expands resource visibility and inherits organization roles assigned to ancestor teams. Team membership roles are not inherited. Being a child team admin does not make you its parent's team admin. Deleting a parent moves its direct children to the root.

External group sync continues to create direct memberships on the mapped team. Those members receive inherited resource access from its ancestors; see [SSO Team Sync](/docs/platform-sso-team-sync).

### Agents, MCP Gateways, Apps, and Skills

Object grants control reading, execution, editing, deletion, and permission management independently.
An update grant does not include execution or permission management.
Creation adds a full grant for the creator. That grant can be revoked.
Ownership and team administration do not override revocation.

### Visibility-Scoped Credentials

`llmProviderApiKey` and `llmVirtualKey` also support `personal`, `team`, and `org` scope, but they use different elevated permissions:

- Personal records are limited to their owner
- Team records require membership in the selected team, with team member admins able to manage their own team
- Organization-wide records require the resource-specific admin permission such as `llmProviderApiKey:admin` or `llmVirtualKey:admin`

These resources do **not** use `:team-admin`.

### Models

Model read grants control discovery. Model use grants control invocation through the LLM Proxy.
Sharing a model with a team does not grant editing.
A wildcard use grant includes future models of that organization.
Provider catalog refreshes preserve existing grants and revocations.

### Chat Access And Optional UI Controls

Chat access is controlled separately from optional chat UI controls:

- `chat:read` allows access to chat itself
- `agent:read` is also required because chat is agent-backed and a user must be able to access at least one agent/profile context to start or use chat
- `chatAgentPicker:enable` controls whether the agent picker is visible
- `chatProviderSettings:enable` controls whether model and API key selectors are visible

The selector visibility permissions are UI toggles. They should be treated independently from core chat access and should not be assumed to grant access to provider credentials or model catalogs on their own.

### MCP Registry And Installation Records

Registry grants control access to the catalog entry.
Installation permissions separately control connections, credentials, and running servers.
Editing a team does not authorize installing or reauthenticating its connections.



## Team Access

Team grants apply to direct members and descendant-team members.
Every membership role receives the same resource grants.
An empty grant list does not make a resource public.
Wildcard grants remain effective when an object's direct grants are removed.

#### Agent Access vs MCP Server Access

The two team assignments gate different things. Agent access decides who can call the agent's tools. MCP server access decides who can see, install, and manage the server in the registry.

In **Custom** tool mode, sharing an agent shares its assigned tools. A user with agent access can call an assigned tool even when its MCP server is not shared with them. [Credential resolution](/docs/mcp-authentication#credential-resolution) decides whose connection serves each call: a pinned connection serves every caller, and resolve-at-call-time looks for a connection the caller can reach.

In **Auto** tool mode, each caller can only discover and run tools from MCP servers they can access themselves — plus any tools explicitly assigned to the agent. See [Tool Access Modes](/docs/platform-agents#tool-access-modes).

**Associated Artifacts:**

Policies and tool assignments follow their associated resources. LLM and MCP logs use the permissions in [LLM API Permissions](#llm-api-permissions).

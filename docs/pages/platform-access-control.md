---
title: "Access Control"
category: Administration
description: "Role-based access control (RBAC) system for managing user permissions in Archestra"
order: 1
lastUpdated: 2026-08-27
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

For example, the permission `agent:create` allows creating new agents, `mcpGateway:update` allows updating MCP gateways, whereas `llmProxy:read` would allow reading LLM proxies.

Two resources distinguish an own-records view from an organization-wide one: `log:read` shows only the caller's own LLM proxy and MCP tool-call records, while `log:admin` shows every user's; `auditLog:read` and `auditLog:admin` split the audit trail the same way. This is what makes a deliberately-restricted admin role practical — its holders keep full visibility into their own activity without seeing anyone else's.

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
| Agents | `read`, `create`, `update`, `delete`, `team-admin`, `deploy-to-restricted` |
| Skills | `read`, `create`, `update`, `delete`, `team-admin`, `deploy-to-restricted` |
| Plugins | `read`, `create`, `update`, `delete` |
| Apps | `read`, `create`, `update`, `delete`, `team-admin`, `deploy-to-restricted` |
| Code Sandbox | `execute` |
| Agent Triggers | `read`, `create`, `update`, `delete` |
| Scheduled Tasks | `read`, `create`, `update`, `delete` |
| LLM Proxy | `read`, `update` |
| LLM Provider API Keys | `read`, `create`, `update`, `delete` |
| LLM Virtual Keys | `read`, `create`, `update`, `delete` |
| LLM OAuth Clients | `read`, `create`, `update`, `delete`, `team-admin` |
| LLM Models | `read`, `update` |
| LLM Limits | `read`, `create`, `update`, `delete` |
| LLM Costs | `read` |
| MCP Gateways | `read`, `create`, `update`, `delete`, `team-admin`, `deploy-to-restricted` |
| MCP OAuth Clients | `read`, `create`, `update`, `delete`, `team-admin` |
| Tools & Policies | `read`, `create`, `update`, `delete` |
| MCP Registry | `read`, `create`, `update`, `delete`, `team-admin`, `deploy-to-restricted` |
| MCP Server Installations | `read`, `create`, `update`, `delete` |
| Environments | `read`, `create`, `update`, `delete` |
| GitHub App Configurations | `read`, `create`, `update`, `delete` |
| Knowledge Sources | `read`, `create`, `update`, `delete`, `query`, `deploy-to-restricted` |
| Chats | `read`, `create`, `update`, `delete` |
| Projects | `read`, `create`, `update`, `delete`, `share-org` |
| Files | `manage` |
| Logs | `read` |
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

#### No privilege escalation

A role can only be granted by someone who already holds every permission it carries. This single rule is enforced server-side on **every** grant path:

- creating or editing a custom role's permissions,
- changing a member's role,
- inviting a user with a role,
- setting the organization's default member role,
- creating or updating a service account.

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
| `agent:team-admin` | Manage team assignments for agents |
| `agent:admin` | Full administrative control over all agents, bypassing team restrictions |
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
| `app:read` | View and run MCP Apps within your scope (org, your teams, your own) |
| `app:create` | Create new MCP Apps |
| `app:update` | Modify MCP Apps, their tools, and their team assignments |
| `app:delete` | Delete MCP Apps |
| `app:team-admin` | Manage team assignments for MCP Apps |
| `app:admin` | Full administrative control over all MCP Apps, bypassing team restrictions |
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
| `llmCost:read` | View LLM usage cost statistics and analytics |
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
| `log:read` | View your own LLM proxy and MCP tool call logs |
| `log:admin` | View every user's LLM proxy and MCP tool call logs |
| `mcpGateway:read` | View and list MCP gateways |
| `mcpGateway:create` | Create new MCP gateways |
| `mcpGateway:update` | Modify MCP gateway configuration |
| `mcpGateway:delete` | Delete MCP gateways |
| `mcpGateway:team-admin` | Manage team assignments for MCP gateways |
| `mcpGateway:admin` | Full administrative control over all MCP gateways, bypassing team restrictions |
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
| `mcpRegistry:team-admin` | Manage team assignments for MCP registry entries |
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
| `project:read` | View projects and your own chats inside them |
| `project:create` | Create projects |
| `project:update` | Edit project descriptions, instructions, and sharing |
| `project:delete` | Delete projects |
| `project:share-org` | Share projects with the entire organization, and change the sharing of or delete a project that is already org-wide. Without it, projects can still be shared with teams. Additive: sharing still requires project:update and deleting still requires project:delete. |
| `project:admin` | Oversee projects owned by other members: discover them, view/edit/delete the project and its sharing, and view, download, or delete their files — but not read their chats. Additive: edit/delete still require project:update/delete, and schedule management rides scheduledTask:admin (all included in the Admin role). |
| `project:read-all` | View chats that other members started in any project you can access. Without this, you only see the chats you started yourself — including in projects you own. |
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
| `skill:read` | View and use agent skills within your scope (org, your teams, your own) |
| `skill:create` | Create new agent skills |
| `skill:update` | Modify agent skills and their team assignments |
| `skill:delete` | Delete agent skills |
| `skill:team-admin` | Manage team assignments for agent skills |
| `skill:admin` | Full administrative control over all agent skills, bypassing team restrictions |
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


## Scoped Resources

Some resources use a two-step authorization model:

1. RBAC grants a base action such as `read`, `create`, `update`, or `delete`
2. Runtime scope rules further restrict which records a user can see or modify

The most common scopes are:

- `personal`: owned by one user
- `team`: shared with one or more teams
- `org`: shared across the organization

The elevated actions `:admin` and `:team-admin` are not global shortcuts with identical meaning on every resource. Their effect depends on the resource's runtime authorization rules.

### Team Roles

Team membership has its own role, separate from organization RBAC:

- `member`: belongs to the team and can access resources shared with that team
- `admin`: can manage membership and team-scoped settings for that team, such as external group sync mappings

Whoever creates a team joins it as that team's first admin, so they can manage its members straight away.

Team admins do **not** automatically receive organization-level team permissions. Renaming a team, editing its description, creating teams, and deleting teams require the matching organization RBAC permission such as `team:update`, `team:create`, or `team:delete`.

Team roles are also separate from resource actions named `:team-admin`. For example, `agent:team-admin` controls team-scoped agent management; it does not make the user an admin member of every team.

### Agents, MCP Gateways, and LLM Proxies

`agent`, `mcpGateway`, and `llmProxy` share the same scope model:

- `personal`: the author can manage their own records
- `team`: requires `<resource>:team-admin` and membership in at least one assigned team
- `org`: requires `<resource>:admin`

Examples:

- `agent:delete` alone does **not** allow deleting every agent
- `agent:team-admin` allows managing team-scoped agents only in teams the user belongs to
- `agent:admin` bypasses those scope restrictions

### Visibility-Scoped Credentials

`llmProviderApiKey` and `llmVirtualKey` also support `personal`, `team`, and `org` scope, but they use different elevated permissions:

- Personal records are limited to their owner
- Team records require membership in the selected team, with team member admins able to manage their own team
- Organization-wide records require the resource-specific admin permission such as `llmProviderApiKey:admin` or `llmVirtualKey:admin`

These resources do **not** use `:team-admin`.

### Team-Restricted Models

You can limit an LLM model to specific teams. Open the model on the Models page and pick teams under "Limit to teams" — dev teams get frontier models while test teams use cheaper ones, for example.

A model with no teams selected stays available to everyone. A restricted model is hidden from model pickers and `/models` listings for users outside its teams, and the LLM Proxy rejects their requests to it with `403`. Users with `llmModel:update`, including organization admins, keep full access.

### Chat Access And Optional UI Controls

Chat access is controlled separately from optional chat UI controls:

- `chat:read` allows access to chat itself
- `agent:read` is also required because chat is agent-backed and a user must be able to access at least one agent/profile context to start or use chat
- `chatAgentPicker:enable` controls whether the agent picker is visible
- `chatProviderSettings:enable` controls whether model and API key selectors are visible

The selector visibility permissions are UI toggles. They should be treated independently from core chat access and should not be assumed to grant access to provider credentials or model catalogs on their own.

### MCP Registry And Installation Records

Some MCP-related resources also apply runtime scope checks in addition to RBAC, but their rules differ from agents, MCP gateways, and LLM proxies:

- Internal MCP catalog items can be `personal`, `team`, or `org`
- Organization-wide catalog items require `mcpServerInstallation:admin`
- Team MCP server installations depend on team membership, with broader control for organization-level team managers and admins of the selected team

When designing custom roles, treat the permission matrix as the first gate and the resource's scope rules as the second gate.


## Best Practices

### Principle of Least Privilege

Grant users only the minimum permissions necessary for their role. Start with the "Member" role and add specific permissions as needed.

### Team-Based Organization

Combine roles with team-based access control for fine-grained resource access:

1. **Create teams** for different groups (e.g., "Data Scientists", "Developers")
2. **Assign Agents, MCP Gateways, LLM Proxies, and MCP Servers** to specific teams
3. **Add users to teams** based on their role and responsibilities

#### Default Team

New users are automatically added to the "Default Team" when they accept an invitation. This ensures all users have immediate access to Archestra resources assigned to this team.

#### Team Access Control Rules

**For MCP Gateways, LLM Proxies, and Agents:**

- Users can only see agents assigned to teams they belong to
- Exception: Users with `agent:admin` permission can see all agents
- Exception: Agents with no team assignment are visible to all users

**For MCP Servers:**

- Users can only see, install, and manage MCP servers assigned to teams they belong to
- Exception: Users with `mcpServerInstallation:admin` permission can access all MCP servers
- Exception: MCP servers with no team assignment are accessible to all users

#### Agent Access vs MCP Server Access

The two team assignments gate different things. Agent access decides who can call the agent's tools. MCP server access decides who can see, install, and manage the server in the registry.

In **Custom** tool mode, sharing an agent shares its assigned tools. A user with agent access can call an assigned tool even when its MCP server is not shared with them. [Credential resolution](/docs/mcp-authentication#credential-resolution) decides whose connection serves each call: a pinned connection serves every caller, and resolve-at-call-time looks for a connection the caller can reach.

In **Auto** tool mode, each caller can only discover and run tools from MCP servers they can access themselves — plus any tools explicitly assigned to the agent. See [Tool Access Modes](/docs/platform-agents#tool-access-modes).

**Associated Artifacts:**

Team-based access extends to related resources like interaction logs, policies, and tool assignments. Members can only view these artifacts for agents and MCP servers they have access to.

### Regular Review

Periodically review custom roles and team membership assignments to ensure they align with current needs and security requirements.

### Role Naming

Use clear, descriptive names for custom roles that indicate their purpose (e.g., "Agent-Manager", "Read-Only-Analyst", "Tool-Developer").

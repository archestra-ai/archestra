---
title: "Permissions"
description: "What each built-in role can do, and every permission a custom role can hold"
order: 2
lastUpdated: 2026-10-22
---
<!--
GENERATED FILE — edit codegen-access-control-docs.ts, not this page.
Run `pnpm codegen:access-control-docs` to regenerate.
-->

Every permission is a `resource:action` pair, such as `agent:create`. A role is a set of these permissions. Docs pages link here by permission name. [Access Control](/docs/admin/access-control) explains how roles and per-item grants work together.

## Predefined Roles

Every organization has these four roles. You cannot edit or delete them.

### Admin

Admin holds every permission, including user management, roles, and organization settings.

### Platform Admin

Platform Admin holds every permission except `log:admin`, `auditLog:admin`, `member:impersonate`, and `sre:read`. It manages users, roles, settings, and resources, but sees only its own logs and audit records, cannot sign in as another member, and cannot call the SRE agent's Kubernetes tools. Because of [No Privilege Escalation](/docs/admin/access-control#no-privilege-escalation), it cannot grant a role that holds the withheld permissions.

### Editor

Full access to core resources, but cannot change organization settings or manage users, roles, or identity providers.

| Resource | Actions |
|----------|--------|
| Agents | `read`, `create`, `delete` |
| Skills | `read`, `create`, `delete` |
| Plugins | `read`, `create`, `update`, `delete` |
| Apps | `read`, `create` |
| Guardrails Policy | `read`, `update` |
| LLM Proxy | `read`, `update` |
| LLM Provider API Keys | `read`, `create` |
| LLM Virtual Keys | `read`, `create` |
| LLM Models | `read`, `update` |
| LLM Limits | `read`, `create`, `update`, `delete` |
| LLM Cost Analytics | `read` |
| MCP Gateways | `read`, `create`, `delete` |
| MCP Registry | `read`, `create` |
| MCP Server Installations | `read`, `create`, `update`, `delete` |
| Environments | `read`, `create`, `update`, `delete` |
| Credentials | `read`, `create` |
| Knowledge Sources | `read`, `create`, `update`, `delete`, `query` |
| Chats | `read`, `create`, `update`, `delete`, `full-view` |
| Projects | `read`, `create`, `update`, `delete` |
| LLM & MCP Logs | `read` |
| API Keys | `read`, `create`, `delete` |
| OAuth Clients | `read`, `create` |
| Users | `read` |
| Roles | `read` |
| Teams | `read` |
| Identity Providers | `read` |

### Member

Can manage agents, tools, and chat, with read-only access to most other resources.

| Resource | Actions |
|----------|--------|
| Agents | `read`, `create`, `delete` |
| Skills | `read`, `create`, `delete` |
| Apps | `read`, `create` |
| LLM Proxy | `read` |
| LLM Provider API Keys | `read` |
| LLM Virtual Keys | `read`, `create` |
| LLM Models | `read` |
| MCP Gateways | `read`, `create`, `delete` |
| MCP Registry | `read` |
| MCP Server Installations | `read`, `create`, `delete` |
| Environments | `read` |
| Credentials | `read` |
| Knowledge Sources | `read`, `query` |
| Chats | `read`, `create`, `update`, `delete`, `full-view` |
| Projects | `read`, `create`, `update`, `delete` |
| API Keys | `read`, `create`, `delete` |
| OAuth Clients | `read` |
| Teams | `read` |


<span id="llm-api-permissions"></span>

## Available Permissions

A [custom role](/docs/admin/access-control#custom-roles) can hold any of these permissions. To grant an action on a single item, such as one agent, see [Granular Access Control](/docs/admin/access-control#granular-access-control).

| Permission | Description |
|------------|-------------|
| <span id="ac:read"></span>`ac:read` | View custom roles and their permissions |
| <span id="ac:create"></span>`ac:create` | Create new custom roles |
| <span id="ac:update"></span>`ac:update` | Modify custom role permissions |
| <span id="ac:delete"></span>`ac:delete` | Delete custom roles |
| <span id="accessPolicies:read"></span>`accessPolicies:read` | View access policies for all resource types |
| <span id="accessPolicies:update"></span>`accessPolicies:update` | Edit access policies and grant access across all resource types |
| <span id="agent:read"></span>`agent:read` | Open Agents, and use the code sandboxes and files of agents you can use |
| <span id="agent:create"></span>`agent:create` | Create new agents |
| <span id="agent:delete"></span>`agent:delete` | Open the trash of deleted agents |
| <span id="apiKey:read"></span>`apiKey:read` | View API keys |
| <span id="apiKey:create"></span>`apiKey:create` | Create API keys |
| <span id="apiKey:delete"></span>`apiKey:delete` | Delete API keys |
| <span id="app:read"></span>`app:read` | Open Apps |
| <span id="app:create"></span>`app:create` | Create new MCP Apps |
| <span id="auditLog:read"></span>`auditLog:read` | View audit log records of your own administrative actions |
| <span id="auditLog:admin"></span>`auditLog:admin` | View every audit event in your organization (also requires Read) |
| <span id="chat:read"></span>`chat:read` | View and access chat conversations |
| <span id="chat:create"></span>`chat:create` | Start new chat conversations |
| <span id="chat:update"></span>`chat:update` | Edit chat messages and conversation settings |
| <span id="chat:delete"></span>`chat:delete` | Delete chat conversations |
| <span id="chat:full-view"></span>`chat:full-view` | Show the full chat: the agent picker, model and API key selectors, and expandable tool calls. Without it, chat shows a simpler view |
| <span id="credential:read"></span>`credential:read` | Open Credentials |
| <span id="credential:create"></span>`credential:create` | Create saved credentials |
| <span id="environment:read"></span>`environment:read` | View and list deployment environments |
| <span id="environment:create"></span>`environment:create` | Create deployment environments |
| <span id="environment:update"></span>`environment:update` | Modify deployment environments, including the org default environment |
| <span id="environment:delete"></span>`environment:delete` | Delete deployment environments |
| <span id="guardrailsPolicy:read"></span>`guardrailsPolicy:read` | View Guardrails policy, batteries, and coverage |
| <span id="guardrailsPolicy:update"></span>`guardrailsPolicy:update` | Validate and edit Guardrails policy and manage batteries |
| <span id="identityProvider:read"></span>`identityProvider:read` | View identity provider configurations (SSO) |
| <span id="identityProvider:create"></span>`identityProvider:create` | Set up new identity providers |
| <span id="identityProvider:update"></span>`identityProvider:update` | Modify identity provider settings |
| <span id="identityProvider:delete"></span>`identityProvider:delete` | Remove identity providers |
| <span id="knowledgeSource:read"></span>`knowledgeSource:read` | View Knowledge Bases and Connectors |
| <span id="knowledgeSource:create"></span>`knowledgeSource:create` | Create Knowledge Bases and Connectors |
| <span id="knowledgeSource:update"></span>`knowledgeSource:update` | Modify Knowledge Bases and Connectors |
| <span id="knowledgeSource:delete"></span>`knowledgeSource:delete` | Delete Knowledge Bases and Connectors, view the deleted ones, and restore them |
| <span id="knowledgeSource:query"></span>`knowledgeSource:query` | Query knowledge sources for information retrieval |
| <span id="llmCost:read"></span>`llmCost:read` | View organization-wide LLM usage cost statistics and analytics |
| <span id="llmLimit:read"></span>`llmLimit:read` | View token usage limits |
| <span id="llmLimit:create"></span>`llmLimit:create` | Create new usage limits |
| <span id="llmLimit:update"></span>`llmLimit:update` | Modify existing usage limits |
| <span id="llmLimit:delete"></span>`llmLimit:delete` | Remove usage limits |
| <span id="llmModel:read"></span>`llmModel:read` | View synced LLM models and capabilities |
| <span id="llmModel:update"></span>`llmModel:update` | Sync the model catalog and see every model, including ones not shared with you |
| <span id="llmProviderApiKey:read"></span>`llmProviderApiKey:read` | Open LLM provider API keys |
| <span id="llmProviderApiKey:create"></span>`llmProviderApiKey:create` | Add new LLM provider API keys |
| <span id="llmProxy:read"></span>`llmProxy:read` | View the LLM Proxy and its connection details |
| <span id="llmProxy:update"></span>`llmProxy:update` | Modify LLM Proxy configuration |
| <span id="llmVirtualKey:read"></span>`llmVirtualKey:read` | Open LLM virtual keys |
| <span id="llmVirtualKey:create"></span>`llmVirtualKey:create` | Create LLM virtual keys |
| <span id="log:read"></span>`log:read` | View your own LLM proxy, MCP tool call, and Guardrails consult logs in the active organization, and view and resolve Guardrails yells |
| <span id="log:admin"></span>`log:admin` | View every LLM, MCP, and Guardrails consult log in your organization (also requires Read) |
| <span id="mcpGateway:read"></span>`mcpGateway:read` | Open MCP Gateways |
| <span id="mcpGateway:create"></span>`mcpGateway:create` | Create new MCP gateways |
| <span id="mcpGateway:delete"></span>`mcpGateway:delete` | Open the trash of deleted MCP gateways |
| <span id="mcpRegistry:read"></span>`mcpRegistry:read` | Open the MCP registry and use its built-in servers |
| <span id="mcpRegistry:create"></span>`mcpRegistry:create` | Add servers to the MCP registry |
| <span id="mcpServerInstallation:read"></span>`mcpServerInstallation:read` | View installed MCP servers and their status |
| <span id="mcpServerInstallation:create"></span>`mcpServerInstallation:create` | Install MCP servers from the registry |
| <span id="mcpServerInstallation:update"></span>`mcpServerInstallation:update` | Modify installed MCP server configuration |
| <span id="mcpServerInstallation:delete"></span>`mcpServerInstallation:delete` | Uninstall, view deleted, and restore MCP servers within your access |
| <span id="member:read"></span>`member:read` | View organization members and their roles |
| <span id="member:create"></span>`member:create` | Add new members to the organization and manage invitations |
| <span id="member:update"></span>`member:update` | Change member roles and settings |
| <span id="member:delete"></span>`member:delete` | Remove members from the organization |
| <span id="member:impersonate"></span>`member:impersonate` | Temporarily sign in as another member to see the app with their access (role debugging) |
| <span id="mcpOauthClient:read"></span><span id="llmOauthClient:read"></span><span id="oauthClient:read"></span>`oauthClient:read` | Open OAuth client registrations |
| <span id="mcpOauthClient:create"></span><span id="llmOauthClient:create"></span><span id="oauthClient:create"></span>`oauthClient:create` | Create OAuth client registrations |
| <span id="organizationSettings:read"></span>`organizationSettings:read` | View every organization settings page, including messaging channels |
| <span id="organizationSettings:update"></span>`organizationSettings:update` | Change organization settings, messaging channels, and site notifications |
| <span id="plugin:read"></span>`plugin:read` | View plugins and their file metadata |
| <span id="plugin:create"></span>`plugin:create` | Create plugins |
| <span id="plugin:update"></span>`plugin:update` | Modify plugin metadata and files |
| <span id="plugin:delete"></span>`plugin:delete` | Delete plugins |
| <span id="scheduledTask:read"></span><span id="project:read"></span>`project:read` | View projects, their schedules, and your own sessions inside them |
| <span id="scheduledTask:create"></span><span id="project:create"></span>`project:create` | Create projects and schedules, and trigger schedule runs |
| <span id="scheduledTask:update"></span><span id="project:update"></span>`project:update` | Edit project descriptions, instructions, sharing, and schedules |
| <span id="scheduledTask:delete"></span><span id="project:delete"></span>`project:delete` | Delete projects and schedules |
| <span id="serviceAccount:read"></span>`serviceAccount:read` | Open Service Accounts |
| <span id="serviceAccount:create"></span>`serviceAccount:create` | Create service accounts |
| <span id="skill:read"></span>`skill:read` | Open Skills |
| <span id="skill:create"></span>`skill:create` | Create new agent skills |
| <span id="skill:delete"></span>`skill:delete` | Permanently delete skills from the trash |
| <span id="sre:read"></span>`sre:read` | Call the SRE agent's Kubernetes tools, which read this installation's pods, logs, and specs |
| <span id="team:read"></span>`team:read` | View teams and their members |
| <span id="team:create"></span>`team:create` | Create new teams |
| <span id="team:update"></span>`team:update` | Modify team settings |
| <span id="team:delete"></span>`team:delete` | Delete teams |

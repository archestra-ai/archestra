---
title: "Access Control"
category: Administration
description: "Role-based access control (RBAC) system for managing user permissions in Archestra"
order: 1
lastUpdated: 2026-03-15
---
<!--
Check ../docs_writer_prompt.md before changing this file.

This document is human-built, shouldn't be updated with AI. Don't change anything here.
-->

Archestra uses a role-based access control (RBAC) system to manage user permissions. This system provides both predefined roles for common use cases and the flexibility to create custom roles with specific permission combinations.

Permissions in Archestra are defined using a `resource:action` format, where:

- **Resource**: The type of object or feature being accessed (e.g., `agent`, `mcpGateway`, `llmProxy`)
- **Action**: The operation being performed (`create`, `read`, `update`, `delete`, `admin`)

For example, the permission `agent:create` allows creating new agents, `mcpGateway:update` allows updating MCP gateways, whereas `llmProxy:read` would allow reading LLM proxies.

## Predefined Roles

The following roles are built into Archestra and cannot be modified or deleted:

### Admin

Full access to all resources including user management, roles, and platform settings

The admin role has **all permissions** on every resource.

### Editor

Full access to core resources and settings, but cannot manage users, roles, or identity providers

| Resource | Actions |
|----------|--------|
| Agents | `read`, `create`, `update`, `delete`, `team-admin` |
| Agent Triggers | `read`, `create`, `update`, `delete` |
| LLM Proxies | `read`, `create`, `update`, `delete`, `team-admin` |
| LLM Providers | `read`, `create`, `update`, `delete` |
| LLM Limits | `read`, `create`, `update`, `delete` |
| Optimization Rules | `read`, `create`, `update`, `delete` |
| LLM Costs | `read` |
| MCP Gateways | `read`, `create`, `update`, `delete`, `team-admin` |
| Tools & Policies | `read`, `create`, `update`, `delete` |
| MCP Registry | `read`, `create`, `update`, `delete` |
| MCP Server Installations | `read`, `create`, `update`, `delete` |
| MCP Server Installation Requests | `read`, `create`, `update`, `delete` |
| Knowledge Bases | `read`, `create`, `update`, `delete` |
| Dual LLM Configs | `read` |
| Dual LLM Results | `read` |
| Chats | `read`, `create`, `update`, `delete` |
| Logs | `read` |
| API Keys | `read`, `create`, `delete` |
| LLM Settings | `read`, `update` |
| Knowledge Settings | `read`, `update` |
| Users | `read` |
| Invitations | `read` |
| Roles | `read` |
| Teams | `read` |
| Identity Providers | `read` |
| Secrets | `read` |
| Organization Settings | `read`, `update` |
| Chat Agent Picker | `enable` |
| Chat Provider Settings | `enable` |
| Chat Expand Tool Calls | `enable` |

### Member

Can manage agents, tools, and chat, with read-only access to most other resources

| Resource | Actions |
|----------|--------|
| Agents | `read`, `create`, `update`, `delete` |
| LLM Proxies | `read`, `create`, `update`, `delete` |
| LLM Providers | `read` |
| MCP Gateways | `read`, `create`, `update`, `delete` |
| Tools & Policies | `read`, `create`, `update`, `delete` |
| MCP Registry | `read` |
| MCP Server Installations | `read`, `create`, `delete` |
| MCP Server Installation Requests | `read`, `create`, `update` |
| Knowledge Bases | `read` |
| Dual LLM Results | `read` |
| Chats | `read`, `create`, `update`, `delete` |
| API Keys | `read`, `create`, `delete` |
| Teams | `read` |
| Simple View | `enable` |
| Chat Expand Tool Calls | `enable` |


## Custom Roles

Users with `ac:create` permission can create custom roles by selecting specific permission combinations. Custom roles allow fine-grained access control tailored to your needs. Note that you can only grant permissions that you already possess — this prevents privilege escalation.

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
| `agentSettings:read` | View agent settings (default model, default agent, security engine, file uploads) |
| `agentSettings:update` | Modify agent settings (default model, default agent, security engine, file uploads) |
| `agentTrigger:read` | View agent trigger configurations (Slack, MS Teams, email) |
| `agentTrigger:create` | Set up new agent triggers |
| `agentTrigger:update` | Modify agent trigger configurations |
| `agentTrigger:delete` | Remove agent triggers |
| `apiKey:read` | View API keys |
| `apiKey:create` | Create API keys |
| `apiKey:delete` | Delete API keys |
| `chat:read` | View and access chat conversations |
| `chat:create` | Start new chat conversations |
| `chat:update` | Edit chat messages and conversation settings |
| `chat:delete` | Delete chat conversations |
| `chatAgentPicker:enable` | Show agent picker in chat |
| `chatExpandToolCalls:enable` | Allow expanding tool call details in chat |
| `chatProviderSettings:enable` | Show model and API key selectors in chat |
| `dualLlmConfig:read` | View dual LLM security configurations |
| `dualLlmConfig:create` | Create new dual LLM configurations |
| `dualLlmConfig:update` | Modify dual LLM configurations |
| `dualLlmConfig:delete` | Remove dual LLM configurations |
| `dualLlmResult:read` | View dual LLM security validation results |
| `dualLlmResult:create` | Create dual LLM validation results |
| `dualLlmResult:update` | Modify dual LLM validation results |
| `dualLlmResult:delete` | Remove dual LLM validation results |
| `identityProvider:read` | View identity provider configurations (SSO) |
| `identityProvider:create` | Set up new identity providers |
| `identityProvider:update` | Modify identity provider settings |
| `identityProvider:delete` | Remove identity providers |
| `invitation:create` | Send invitations to new users |
| `invitation:cancel` | Cancel pending invitations |
| `knowledgeBase:read` | View knowledge bases and connectors |
| `knowledgeBase:create` | Create knowledge bases and connectors |
| `knowledgeBase:update` | Modify knowledge bases and connectors |
| `knowledgeBase:delete` | Delete knowledge bases and connectors |
| `knowledgeSettings:read` | View knowledge settings (embedding and reranking models) |
| `knowledgeSettings:update` | Modify knowledge settings (embedding and reranking models) |
| `llmCost:read` | View LLM usage cost statistics and analytics |
| `llmLimit:read` | View token usage limits |
| `llmLimit:create` | Create new usage limits |
| `llmLimit:update` | Modify existing usage limits |
| `llmLimit:delete` | Remove usage limits |
| `llmProvider:read` | View LLM provider API keys, virtual keys, and models |
| `llmProvider:create` | Add new LLM provider API keys or virtual keys |
| `llmProvider:update` | Modify LLM provider configuration and model pricing |
| `llmProvider:delete` | Remove LLM provider API keys or virtual keys |
| `llmProxy:read` | View and list LLM proxies |
| `llmProxy:create` | Create new LLM proxies |
| `llmProxy:update` | Modify LLM proxy configuration |
| `llmProxy:delete` | Delete LLM proxies |
| `llmProxy:team-admin` | Manage team assignments for LLM proxies |
| `llmProxy:admin` | Full administrative control over all LLM proxies, bypassing team restrictions |
| `llmSettings:read` | View LLM settings (compression, cleanup interval) |
| `llmSettings:update` | Modify LLM settings |
| `log:read` | View LLM proxy and MCP tool call logs |
| `mcpGateway:read` | View and list MCP gateways |
| `mcpGateway:create` | Create new MCP gateways |
| `mcpGateway:update` | Modify MCP gateway configuration |
| `mcpGateway:delete` | Delete MCP gateways |
| `mcpGateway:team-admin` | Manage team assignments for MCP gateways |
| `mcpGateway:admin` | Full administrative control over all MCP gateways, bypassing team restrictions |
| `mcpRegistry:read` | Browse the MCP server registry |
| `mcpRegistry:create` | Add servers to the MCP registry |
| `mcpRegistry:update` | Modify MCP registry entries |
| `mcpRegistry:delete` | Remove servers from the MCP registry |
| `mcpServerInstallation:read` | View installed MCP servers and their status |
| `mcpServerInstallation:create` | Install MCP servers from the registry |
| `mcpServerInstallation:update` | Modify installed MCP server configuration |
| `mcpServerInstallation:delete` | Uninstall MCP servers |
| `mcpServerInstallation:admin` | Approve or manage all MCP server installations |
| `mcpServerInstallationRequest:read` | View MCP server installation requests |
| `mcpServerInstallationRequest:create` | Submit requests to install MCP servers |
| `mcpServerInstallationRequest:update` | Add notes to installation requests |
| `mcpServerInstallationRequest:delete` | Delete installation requests |
| `mcpServerInstallationRequest:admin` | Approve or decline installation requests |
| `member:read` | View organization members and their roles |
| `member:create` | Add new members to the organization |
| `member:update` | Change member roles and settings |
| `member:delete` | Remove members from the organization |
| `optimizationRule:read` | View optimization rules |
| `optimizationRule:create` | Create new optimization rules |
| `optimizationRule:update` | Modify optimization rules |
| `optimizationRule:delete` | Remove optimization rules |
| `organizationSettings:read` | View organization settings (appearance, authentication, etc) |
| `organizationSettings:update` | Customize organization appearance, authentication, etc |
| `secret:read` | View secrets manager configuration |
| `secret:update` | Modify secrets manager settings and test connectivity |
| `simpleView:enable` | Sidebar is collapsed by default on page load |
| `team:read` | View teams and their members |
| `team:create` | Create new teams |
| `team:update` | Modify team settings |
| `team:delete` | Delete teams |
| `team:admin` | Manage team membership (add/remove members) |
| `toolPolicy:read` | View tools, tool invocation policies, and trusted data policies |
| `toolPolicy:create` | Register tools and create security policies |
| `toolPolicy:update` | Modify tools, tool configuration, and security policies |
| `toolPolicy:delete` | Remove tools and security policies |


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

- Users can only access MCP servers assigned to teams they belong to
- Exception: Users with `mcpServer:admin` permission can access all MCP servers
- Exception: MCP servers with no team assignment are accessible to all users

**Associated Artifacts:**

Team-based access extends to related resources like interaction logs, policies, and tool assignments. Members can only view these artifacts for agents and MCP servers they have access to.

### Regular Review

Periodically review custom roles and team membership assignments to ensure they align with current needs and security requirements.

### Role Naming

Use clear, descriptive names for custom roles that indicate their purpose (e.g., "Agent-Manager", "Read-Only-Analyst", "Tool-Developer").

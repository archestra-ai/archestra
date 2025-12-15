---
title: "Platform Access Control"
category: Archestra Platform
description: "Role-based access control (RBAC) system for managing user permissions in Archestra"
order: 4
lastUpdated: 2025-12-15
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This document is human-built, shouldn't be updated with AI. Don't change anything here.
-->

Archestra uses a role-based access control (RBAC) system to manage user permissions within organizations. This system provides both predefined roles for common use cases and the flexibility to create custom roles with specific permission combinations.

Permissions in Archestra are defined using a `resource:action` format, where:

- **Resource**: The type of object or feature being accessed (e.g., `profile`, `tool`, `organization`)
- **Action**: The operation being performed (`create`, `read`, `update`, `delete`, `admin`)

For example, the permission `profile:create` allows creating new profiles, while `organization:read` allows viewing organization information.

## Predefined Roles

The following roles are built into Archestra and cannot be modified or deleted:

| Role | Description | Granted Permissions |
|------|-------------|--------------------|
| **admin** | Full administrative access to all organization resources | `organization:read`<br /><br />`organization:update`<br /><br />`organization:delete`<br /><br />`member:create`<br /><br />`member:update`<br /><br />`member:delete`<br /><br />`invitation:create`<br /><br />`invitation:cancel`<br /><br />`team:create`<br /><br />`team:read`<br /><br />`team:update`<br /><br />`team:delete`<br /><br />`team:admin`<br /><br />`ac:create`<br /><br />`ac:read`<br /><br />`ac:update`<br /><br />`ac:delete`<br /><br />`profile:create`<br /><br />`profile:read`<br /><br />`profile:update`<br /><br />`profile:delete`<br /><br />`profile:admin`<br /><br />`tool:create`<br /><br />`tool:read`<br /><br />`tool:update`<br /><br />`tool:delete`<br /><br />`policy:create`<br /><br />`policy:read`<br /><br />`policy:update`<br /><br />`policy:delete`<br /><br />`dualLlmConfig:create`<br /><br />`dualLlmConfig:read`<br /><br />`dualLlmConfig:update`<br /><br />`dualLlmConfig:delete`<br /><br />`dualLlmResult:create`<br /><br />`dualLlmResult:read`<br /><br />`dualLlmResult:update`<br /><br />`dualLlmResult:delete`<br /><br />`interaction:create`<br /><br />`interaction:read`<br /><br />`interaction:update`<br /><br />`interaction:delete`<br /><br />`ssoProvider:create`<br /><br />`ssoProvider:read`<br /><br />`ssoProvider:update`<br /><br />`ssoProvider:delete`<br /><br />`internalMcpCatalog:create`<br /><br />`internalMcpCatalog:read`<br /><br />`internalMcpCatalog:update`<br /><br />`internalMcpCatalog:delete`<br /><br />`mcpServer:create`<br /><br />`mcpServer:read`<br /><br />`mcpServer:update`<br /><br />`mcpServer:delete`<br /><br />`mcpServer:admin`<br /><br />`mcpServerInstallationRequest:create`<br /><br />`mcpServerInstallationRequest:read`<br /><br />`mcpServerInstallationRequest:update`<br /><br />`mcpServerInstallationRequest:delete`<br /><br />`mcpServerInstallationRequest:admin`<br /><br />`mcpToolCall:read`<br /><br />`conversation:create`<br /><br />`conversation:read`<br /><br />`conversation:update`<br /><br />`conversation:delete`<br /><br />`limit:create`<br /><br />`limit:read`<br /><br />`limit:update`<br /><br />`limit:delete`<br /><br />`tokenPrice:create`<br /><br />`tokenPrice:read`<br /><br />`tokenPrice:update`<br /><br />`tokenPrice:delete`<br /><br />`chatSettings:create`<br /><br />`chatSettings:read`<br /><br />`chatSettings:update`<br /><br />`chatSettings:delete`<br /><br />`prompt:create`<br /><br />`prompt:read`<br /><br />`prompt:update`<br /><br />`prompt:delete` |
| **editor** | Power user with full CRUD access to most resources but no admin privileges | `profile:create`<br /><br />`profile:read`<br /><br />`profile:update`<br /><br />`profile:delete`<br /><br />`tool:create`<br /><br />`tool:read`<br /><br />`tool:update`<br /><br />`tool:delete`<br /><br />`policy:create`<br /><br />`policy:read`<br /><br />`policy:update`<br /><br />`policy:delete`<br /><br />`interaction:create`<br /><br />`interaction:read`<br /><br />`interaction:update`<br /><br />`interaction:delete`<br /><br />`dualLlmConfig:create`<br /><br />`dualLlmConfig:read`<br /><br />`dualLlmConfig:update`<br /><br />`dualLlmConfig:delete`<br /><br />`dualLlmResult:create`<br /><br />`dualLlmResult:read`<br /><br />`dualLlmResult:update`<br /><br />`dualLlmResult:delete`<br /><br />`internalMcpCatalog:create`<br /><br />`internalMcpCatalog:read`<br /><br />`internalMcpCatalog:update`<br /><br />`internalMcpCatalog:delete`<br /><br />`mcpServer:create`<br /><br />`mcpServer:read`<br /><br />`mcpServer:update`<br /><br />`mcpServer:delete`<br /><br />`mcpServerInstallationRequest:create`<br /><br />`mcpServerInstallationRequest:read`<br /><br />`mcpServerInstallationRequest:update`<br /><br />`mcpServerInstallationRequest:delete`<br /><br />`organization:read`<br /><br />`team:read`<br /><br />`mcpToolCall:read`<br /><br />`conversation:create`<br /><br />`conversation:read`<br /><br />`conversation:update`<br /><br />`conversation:delete`<br /><br />`limit:create`<br /><br />`limit:read`<br /><br />`limit:update`<br /><br />`limit:delete`<br /><br />`tokenPrice:create`<br /><br />`tokenPrice:read`<br /><br />`tokenPrice:update`<br /><br />`tokenPrice:delete`<br /><br />`chatSettings:create`<br /><br />`chatSettings:read`<br /><br />`chatSettings:update`<br /><br />`chatSettings:delete`<br /><br />`prompt:create`<br /><br />`prompt:read`<br /><br />`prompt:update`<br /><br />`prompt:delete` |
| **member** | Standard user with limited access to organization resources | `profile:read`<br /><br />`tool:create`<br /><br />`tool:read`<br /><br />`tool:update`<br /><br />`tool:delete`<br /><br />`policy:create`<br /><br />`policy:read`<br /><br />`policy:update`<br /><br />`policy:delete`<br /><br />`interaction:create`<br /><br />`interaction:read`<br /><br />`interaction:update`<br /><br />`interaction:delete`<br /><br />`dualLlmConfig:read`<br /><br />`dualLlmResult:read`<br /><br />`internalMcpCatalog:read`<br /><br />`mcpServer:create`<br /><br />`mcpServer:read`<br /><br />`mcpServer:delete`<br /><br />`mcpServerInstallationRequest:create`<br /><br />`mcpServerInstallationRequest:read`<br /><br />`mcpServerInstallationRequest:update`<br /><br />`organization:read`<br /><br />`team:read`<br /><br />`mcpToolCall:read`<br /><br />`conversation:create`<br /><br />`conversation:read`<br /><br />`conversation:update`<br /><br />`conversation:delete`<br /><br />`limit:read`<br /><br />`tokenPrice:read`<br /><br />`chatSettings:read`<br /><br />`prompt:read` |


## Custom Roles

Organization administrators can create custom roles by selecting specific permission combinations. Custom roles allow fine-grained access control tailored to your organization's needs.

### Permission Requirements

- **Role Creation**: Only users with `organization:update` permission can create custom roles
- **Permission Granting**: You can only grant permissions that you already possess
- **Role Limits**: Up to 50 custom roles per organization

### Available Permissions

The following table lists all available permissions that can be assigned to custom roles:

| Permission | Description |
|------------|-------------|
| `ac:create` | Create new RBAC roles |
| `ac:read` | View and list RBAC roles |
| `ac:update` | Modify existing RBAC roles |
| `ac:delete` | Remove existing RBAC roles |
| `chatSettings:create` | Create new chat feature configuration and settings |
| `chatSettings:read` | View and list chat feature configuration and settings |
| `chatSettings:update` | Modify existing chat feature configuration and settings |
| `chatSettings:delete` | Remove existing chat feature configuration and settings |
| `conversation:create` | Create new chat conversations with automation experts |
| `conversation:read` | View and list chat conversations with automation experts |
| `conversation:update` | Modify existing chat conversations with automation experts |
| `conversation:delete` | Remove existing chat conversations with automation experts |
| `dualLlmConfig:create` | Create new dual llm security configuration settings |
| `dualLlmConfig:read` | View and list dual llm security configuration settings |
| `dualLlmConfig:update` | Modify existing dual llm security configuration settings |
| `dualLlmConfig:delete` | Remove existing dual llm security configuration settings |
| `dualLlmResult:create` | Create new results from dual llm security validation |
| `dualLlmResult:read` | View and list results from dual llm security validation |
| `dualLlmResult:update` | Modify existing results from dual llm security validation |
| `dualLlmResult:delete` | Remove existing results from dual llm security validation |
| `interaction:create` | Create new conversation history and profile interactions |
| `interaction:read` | View and list conversation history and profile interactions |
| `interaction:update` | Modify existing conversation history and profile interactions |
| `interaction:delete` | Remove existing conversation history and profile interactions |
| `internalMcpCatalog:create` | Create new internal mcp server catalog management |
| `internalMcpCatalog:read` | View and list internal mcp server catalog management |
| `internalMcpCatalog:update` | Modify existing internal mcp server catalog management |
| `internalMcpCatalog:delete` | Remove existing internal mcp server catalog management |
| `invitation:create` | Create new member invitations and onboarding |
| `invitation:cancel` | Cancel member invitations and onboarding |
| `limit:create` | Create new usage limits and quotas |
| `limit:read` | View and list usage limits and quotas |
| `limit:update` | Modify existing usage limits and quotas |
| `limit:delete` | Remove existing usage limits and quotas |
| `mcpServer:create` | Create new mcp servers for tool integration |
| `mcpServer:read` | View and list mcp servers for tool integration |
| `mcpServer:update` | Modify existing mcp servers for tool integration |
| `mcpServer:delete` | Remove existing mcp servers for tool integration |
| `mcpServer:admin` | Administrative control over mcp servers for tool integration |
| `mcpServerInstallationRequest:create` | Create new requests for new mcp server installations |
| `mcpServerInstallationRequest:read` | View and list requests for new mcp server installations |
| `mcpServerInstallationRequest:update` | Modify existing requests for new mcp server installations |
| `mcpServerInstallationRequest:delete` | Remove existing requests for new mcp server installations |
| `mcpServerInstallationRequest:admin` | Administrative control over requests for new mcp server installations |
| `mcpToolCall:read` | View and list tool execution logs and results |
| `member:create` | Create new organization members and their roles |
| `member:update` | Modify existing organization members and their roles |
| `member:delete` | Remove existing organization members and their roles |
| `organization:read` | View and list organization settings |
| `organization:update` | Modify existing organization settings |
| `organization:delete` | Remove existing organization settings |
| `policy:create` | Create new tool invocation and trusted data policies for security |
| `policy:read` | View and list tool invocation and trusted data policies for security |
| `policy:update` | Modify existing tool invocation and trusted data policies for security |
| `policy:delete` | Remove existing tool invocation and trusted data policies for security |
| `profile:create` | Create new profiles that can use tools and interact with users |
| `profile:read` | View and list profiles that can use tools and interact with users |
| `profile:update` | Modify existing profiles that can use tools and interact with users |
| `profile:delete` | Remove existing profiles that can use tools and interact with users |
| `profile:admin` | Administrative control over profiles that can use tools and interact with users |
| `prompt:create` | Create new reusable prompt templates and system prompts |
| `prompt:read` | View and list reusable prompt templates and system prompts |
| `prompt:update` | Modify existing reusable prompt templates and system prompts |
| `prompt:delete` | Remove existing reusable prompt templates and system prompts |
| `ssoProvider:create` | Create new sso providers for authentication |
| `ssoProvider:read` | View and list sso providers for authentication |
| `ssoProvider:update` | Modify existing sso providers for authentication |
| `ssoProvider:delete` | Remove existing sso providers for authentication |
| `team:create` | Create new teams for organizing members and access control |
| `team:read` | View and list teams for organizing members and access control |
| `team:update` | Modify existing teams for organizing members and access control |
| `team:delete` | Remove existing teams for organizing members and access control |
| `team:admin` | Administrative control over teams for organizing members and access control |
| `tokenPrice:create` | Create new token pricing configuration |
| `tokenPrice:read` | View and list token pricing configuration |
| `tokenPrice:update` | Modify existing token pricing configuration |
| `tokenPrice:delete` | Remove existing token pricing configuration |
| `tool:create` | Create new individual tools that can be assigned to profiles |
| `tool:read` | View and list individual tools that can be assigned to profiles |
| `tool:update` | Modify existing individual tools that can be assigned to profiles |
| `tool:delete` | Remove existing individual tools that can be assigned to profiles |


## Best Practices

### Principle of Least Privilege

Grant users only the minimum permissions necessary for their role. Start with the member role and add specific permissions as needed.

### Team-Based Organization

Combine roles with team-based access control for fine-grained resource access:

1. **Create teams** for different groups (e.g., "Data Scientists", "Developers")
2. **Assign profiles and MCP servers** to specific teams
3. **Add members to teams** based on their role and responsibilities

#### Team Access Control Rules

**For Profiles:**

- Team members can only see profiles assigned to teams they belong to
- Exception: Users with `profile:admin` permission can see all profiles
- Exception: Profiles with no team assignment are visible to all organization members

**For MCP Servers:**

- Team members can only access MCP servers assigned to teams they belong to
- Exception: Users with `mcpServer:admin` permission can access all MCP servers
- Exception: MCP servers with no team assignment are accessible to all organization members

**Associated Artifacts:**

Team-based access extends to related resources like interaction logs, policies, and tool assignments. Members can only view these artifacts for profiles and MCP servers they have access to.

### Regular Review

Periodically review custom roles and member assignments to ensure they align with current organizational needs and security requirements.

### Role Naming

Use clear, descriptive names for custom roles that indicate their purpose (e.g., "Profile-Manager", "Read-Only-Analyst", "Tool-Developer").

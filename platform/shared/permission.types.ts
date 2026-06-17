/**
 * Permission type definitions for compile-time type safety.
 *
 * This file is necessary for both free and EE builds to provide type safety
 * for permission-related code, even though the non-EE version has no RBAC logic.
 *
 * - non-EE version: Uses these types but runtime logic always allows everything
 * - EE version: Uses these types with actual permission enforcement
 */
import { z } from "zod";

export const actions = [
  "create",
  "read",
  "update",
  "delete",
  "team-admin",
  "admin",
  "cancel",
  "enable",
  "query",
  "execute",
  "deploy-to-restricted",
] as const;

export const resources = [
  "agent",
  "skill",
  "app",
  "sandbox",
  "mcpGateway",
  "mcpOauthClient",
  "llmProxy",
  "toolPolicy",
  "log",
  "identityProvider",
  "mcpRegistry",
  "mcpServerInstallation",
  "knowledgeFile",
  "knowledgeSource",
  "knowledgeSettings",
  "mcpServerInstallationRequest",
  "environment",
  "githubAppConfig",
  "chat",
  "project",
  "llmCost",
  "llmLimit",
  "optimizationRule",
  "llmProviderApiKey",
  "llmVirtualKey",
  "llmOauthClient",
  "llmModel",
  "secret",
  "organizationSettings",
  "llmSettings",
  "agentSettings",
  "agentTrigger",
  "scheduledTask",
  /**
   * Better-auth access control resource - needed for organization role management
   * See: https://github.com/better-auth/better-auth/issues/2336#issuecomment-2820620809
   *
   * The "ac" resource is part of better-auth's defaultStatements from organization plugin
   * and is required for dynamic access control to work correctly with custom roles
   */
  "ac",
  /**
   * NOTE: similar to "ac", these resources are also part of better-auth's defaultStatements from organization plugin
   * and are required for dynamic access control to work correctly with custom roles
   *
   * These names can't be changed (they're checked in some of the internal ACL checks of better-auth) but we can
   * present them to users with better names
   */
  "organization",
  "member",
  "invitation",
  "team",
  "apiKey",
  "serviceAccount",
  "auditLog",
  "simpleView",
  "chatAgentPicker",
  "chatProviderSettings",
  "chatExpandToolCalls",
  "siteNotification",
] as const;

export const resourceLabels: Record<Resource, string> = {
  agent: "Agents",
  skill: "Skills",
  app: "Apps",
  sandbox: "Code Sandbox",
  mcpGateway: "MCP Gateways",
  mcpOauthClient: "MCP OAuth Clients",
  llmProxy: "LLM Proxies",
  toolPolicy: "Tools & Policies",
  log: "Logs",
  organization: "Organization",
  identityProvider: "Identity Providers",
  member: "Users",
  invitation: "Invitations",
  mcpRegistry: "MCP Registry",
  mcpServerInstallation: "MCP Server Installations",
  knowledgeFile: "Knowledge Files",
  knowledgeSource: "Knowledge Sources",
  knowledgeSettings: "Knowledge Settings",
  mcpServerInstallationRequest: "MCP Server Installation Requests",
  environment: "Environments",
  githubAppConfig: "GitHub App Configurations",
  team: "Teams",
  ac: "Roles",
  chat: "Chats",
  project: "Projects",
  llmCost: "LLM Costs",
  llmLimit: "LLM Limits",
  optimizationRule: "Optimization Rules",
  llmProviderApiKey: "LLM Provider API Keys",
  llmVirtualKey: "LLM Virtual Keys",
  llmOauthClient: "LLM OAuth Clients",
  llmModel: "LLM Models",
  secret: "Secrets",
  apiKey: "API Keys",
  serviceAccount: "Service Accounts",
  auditLog: "Audit Log",
  organizationSettings: "Organization Settings",
  llmSettings: "LLM Settings",
  agentSettings: "Agent Settings",
  agentTrigger: "Agent Triggers",
  scheduledTask: "Scheduled Tasks",
  simpleView: "Simple View",
  chatAgentPicker: "Chat Agent Picker",
  chatProviderSettings: "Chat Provider Settings",
  chatExpandToolCalls: "Chat Expand Tool Calls",
  siteNotification: "Site Notifications",
};

export const resourceDescriptions: Record<Resource, string> = {
  agent: "Agents with prompts and tool assignments",
  skill: "Agent skills — reusable SKILL.md instruction bundles",
  app: "User-authored MCP Apps — interactive apps with their own data store and tools",
  sandbox:
    "Code execution sandboxes — run commands, upload/download files, run activated skills",
  mcpGateway: "Unified MCP endpoints that aggregate tools for clients",
  mcpOauthClient:
    "OAuth clients (service accounts) authorized to call MCP gateways",
  llmProxy: "LLM proxy endpoints with security policies and observability",
  toolPolicy: "Tools, tool invocation policies, and trusted data policies",
  log: "LLM proxy and MCP tool call logs",
  chat: "Chat conversations",
  project: "Projects — shared collections of chats with a result folder",
  agentTrigger: "Agent triggers (Slack, MS Teams, incoming emails)",
  scheduledTask: "Scheduled agent tasks that run on a schedule",
  llmProviderApiKey: "LLM provider API keys and their visibility",
  llmVirtualKey: "LLM virtual keys and their visibility",
  llmOauthClient: "OAuth clients authorized to call LLM proxies",
  llmModel: "LLM model catalog entries and chat capabilities",
  llmLimit: "LLM usage limits",
  llmSettings: "LLM settings (compression, cleanup interval)",
  agentSettings:
    "Agent settings (default model, default agent, security engine, chat file uploads)",
  llmCost: "LLM usage and cost analytics",
  mcpRegistry: "MCP server registry management",
  mcpServerInstallation: "Installed MCP servers and their runtime",
  knowledgeFile: "Uploaded files available for knowledge retrieval",
  mcpServerInstallationRequest: "Requests for new MCP server installations",
  environment: "Deployment environments (namespace) for catalog items",
  githubAppConfig:
    "GitHub App credentials for authenticating skill imports and knowledge connectors",
  optimizationRule: "LLM optimization rules for routing to cheaper models",
  member: "Users and role assignments",
  ac: "Custom RBAC roles",
  team: "Teams for organizing users and access control",
  invitation: "User invitations",
  identityProvider: "Identity providers for authentication",
  secret: "Secrets manager configuration and connectivity",
  apiKey: "User API keys for programmatic access",
  serviceAccount: "Service accounts and tokens for programmatic access",
  auditLog:
    "Organization-wide audit trail of administrative actions and auth events",
  organizationSettings:
    "Organization settings (appearance, authentication, etc)",
  knowledgeSource:
    "Knowledge sources including knowledge bases and connectors for RAG-based document retrieval",
  knowledgeSettings:
    "Knowledge settings (embedding and reranking models configuration)",
  simpleView: "Controls if the simple view of the app is enabled",
  chatAgentPicker: "Controls visibility of the agent picker in chat",
  chatProviderSettings:
    "Controls visibility of model and API key selectors in chat",
  chatExpandToolCalls:
    "Controls ability to expand and view tool call details in chat",
  organization: "Organization (internal, used by authentication system)",
  siteNotification: "Site-wide notification banners and announcements",
};

/**
 * Resources that are internal to better-auth and should not be shown
 * in user-facing documentation or the RBAC UI.
 */
export const internalResources: Resource[] = ["organization"];

/**
 * Groups resources by category for the RBAC UI (role builder and permissions card).
 * Used in both the create/edit role dialog and the account permissions display.
 */
export const resourceCategories: Record<string, Resource[]> = {
  Agents: [
    "agent",
    "skill",
    "app",
    "sandbox",
    "agentTrigger",
    "scheduledTask",
    "agentSettings",
  ],
  MCP: [
    "mcpGateway",
    "mcpOauthClient",
    "toolPolicy",
    "mcpRegistry",
    "mcpServerInstallation",
    "mcpServerInstallationRequest",
    "environment",
  ],
  LLM: [
    "llmProxy",
    "llmProviderApiKey",
    "llmVirtualKey",
    "llmOauthClient",
    "llmModel",
    "llmLimit",
    "optimizationRule",
    "llmSettings",
    "llmCost",
  ],
  Knowledge: ["knowledgeFile", "knowledgeSource", "knowledgeSettings"],
  Other: [
    "chat",
    "project",
    "log",
    "simpleView",
    "chatAgentPicker",
    "chatProviderSettings",
    "chatExpandToolCalls",
  ],
  Administration: [
    "member",
    "ac",
    "team",
    "invitation",
    "identityProvider",
    "secret",
    "apiKey",
    "serviceAccount",
    "auditLog",
    "githubAppConfig",
    "organizationSettings",
    "siteNotification",
  ],
};

export type Resource = (typeof resources)[number];
export type Action = (typeof actions)[number];
export type Permission = { resource: Resource; action: Action };
export type Permissions = Partial<Record<Resource, Action[]>>;

export const PermissionsSchema = z.partialRecord(
  z.enum(resources),
  z.array(z.enum(actions)),
);

/** Database-level agent type discriminator values */
export type AgentType = "profile" | "mcp_gateway" | "llm_proxy" | "agent";

/** Database-level agent scope values */
export type AgentScope = "personal" | "team" | "org";

/**
 * Maps an agent's `agentType` to the corresponding RBAC resource.
 *
 * - "agent" → "agent"
 * - "mcp_gateway" → "mcpGateway"
 * - "llm_proxy" → "llmProxy"
 * - "profile" → "agent" (legacy profiles use the "agent" resource)
 */
export function getResourceForAgentType(agentType: AgentType): Resource {
  switch (agentType) {
    case "mcp_gateway":
      return "mcpGateway";
    case "llm_proxy":
      return "llmProxy";
    case "agent":
    case "profile":
      return "agent";
  }
}

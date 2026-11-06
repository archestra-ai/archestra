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
  "cancel",
  "query",
  "impersonate",
  "full-view",
  "admin",
  "configure-runtime",
] as const;

export const resources = [
  "agent",
  "skill",
  "plugin",
  "app",
  "guardrailsPolicy",
  "mcpGateway",
  "llmProxy",
  "log",
  "identityProvider",
  "mcpRegistry",
  "mcpServerInstallation",
  "knowledgeSource",
  "environment",
  "credential",
  "chat",
  "project",
  "llmCost",
  "llmLimit",
  "llmProviderApiKey",
  "llmVirtualKey",
  "llmModel",
  "organizationSettings",
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
  "oauthClient",
  "serviceAccount",
  "auditLog",
  "accessPolicies",
] as const;

export const resourceLabels: Record<Resource, string> = {
  agent: "Agents",
  skill: "Skills",
  plugin: "Plugins",
  app: "Apps",
  guardrailsPolicy: "Guardrails Policy",
  mcpGateway: "MCP Gateways",
  llmProxy: "LLM Proxy",
  log: "LLM & MCP Logs",
  organization: "Organization",
  identityProvider: "Identity Providers",
  member: "Users",
  invitation: "Invitations",
  mcpRegistry: "MCP Registry",
  mcpServerInstallation: "MCP Server Installations",
  knowledgeSource: "Knowledge Sources",
  environment: "Environments",
  credential: "Credentials",
  team: "Teams",
  ac: "Roles",
  chat: "Chats",
  project: "Projects",
  llmCost: "LLM Cost Analytics",
  llmLimit: "LLM Limits",
  llmProviderApiKey: "LLM Provider API Keys",
  llmVirtualKey: "LLM Virtual Keys",
  llmModel: "LLM Models",
  apiKey: "API Keys",
  oauthClient: "OAuth Clients",
  serviceAccount: "Service Accounts",
  auditLog: "Audit Log",
  accessPolicies: "Access Policies",
  organizationSettings: "Organization Settings",
};

export const resourceDescriptions: Record<Resource, string> = {
  agent: "AI agents configured with prompts, models, and tools",
  skill: "Reusable instructions and workflows that can be attached to agents",
  plugin: "Extensions that run hooks on connected developer machines",
  app: "Interactive MCP apps with their own data store and tools",
  mcpGateway:
    "Unified endpoints that expose tools from multiple MCP servers to clients",
  llmProxy:
    "Proxy endpoint that routes LLM requests with security policies and logging",
  guardrailsPolicy:
    "Guardrails (OpenAPPA) policies that inspect and filter prompts and tool calls",
  log: "Request logs and alerts from the LLM Proxy, MCP tool calls, and Guardrails",
  chat: "Conversations with agents and models in the chat interface",
  project:
    "Shared workspaces containing chats, files, schedules, and agent runs",
  llmProviderApiKey: "Upstream API keys used to connect external LLM providers",
  llmVirtualKey:
    "Keys issued by the platform for accessing models through the LLM Proxy",
  llmModel: "Models listed in the model catalog for chat and agent use",
  llmLimit: "Rate, token, and spend limits for LLM usage",
  llmCost: "Organization-wide LLM token usage and cost reports",
  mcpRegistry:
    "Catalog of approved MCP servers available to install and deploy",
  mcpServerInstallation:
    "Installed MCP server instances and their runtime state",
  environment:
    "Target environments where installed MCP servers and workloads run",
  credential:
    "Stored secrets, GitHub tokens, and GitHub Apps used across the platform",
  member:
    "User accounts, invitations, and role assignments in the organization",
  ac: "Custom roles and their organization-wide permission sets",
  team: "User groups for assigning roles and sharing access to resources",
  invitation: "User invitations",
  identityProvider:
    "Single sign-on (SSO) and external identity provider connections",
  apiKey: "Personal API keys for authenticating to the platform API",
  oauthClient:
    "External apps authorized to access MCP Gateways, Agents, and the LLM Proxy",
  serviceAccount:
    "Non-human accounts and tokens for automated API and CI/CD access",
  auditLog: "Record of administrative changes, sign-ins, and security events",
  accessPolicies:
    "Organization-wide policies that govern access across all resource types",
  organizationSettings:
    "Global settings for authentication, security, notifications, and secrets",
  knowledgeSource:
    "Knowledge bases and connectors that supply documents and data to agents",
  organization: "Organization (internal, used by authentication system)",
};

/**
 * Resources that are internal to better-auth and should not be shown
 * in user-facing documentation or the RBAC UI.
 */
export const internalResources: Resource[] = ["organization", "invitation"];

/**
 * Groups resources by category for the RBAC UI (role builder and permissions card).
 * Used in both the create/edit role dialog and the account permissions display.
 */
export const resourceCategories: Record<string, Resource[]> = {
  Agents: ["agent", "skill", "plugin", "app", "guardrailsPolicy"],
  MCP: ["mcpGateway", "mcpRegistry", "mcpServerInstallation"],
  LLM: [
    "llmProxy",
    "llmProviderApiKey",
    "llmVirtualKey",
    "llmModel",
    "llmLimit",
    "llmCost",
  ],
  Other: ["chat", "project", "knowledgeSource", "log", "auditLog"],
  Administration: [
    "accessPolicies",
    "member",
    "ac",
    "team",
    "identityProvider",
    "apiKey",
    "oauthClient",
    "serviceAccount",
    "credential",
    "environment",
    "organizationSettings",
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
export function getResourceForAgentType(
  agentType: AgentType,
): Extract<Resource, "agent" | "mcpGateway" | "llmProxy"> {
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

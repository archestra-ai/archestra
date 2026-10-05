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
] as const;

export const resources = [
  "agent",
  "skill",
  "plugin",
  "app",
  "mcpGateway",
  "mcpOauthClient",
  "llmProxy",
  "toolPolicy",
  "openappaPolicy",
  "openappaDiagnostics",
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
  "llmOauthClient",
  "llmModel",
  "organizationSettings",
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
  "accessPolicies",
] as const;

export const resourceLabels: Record<Resource, string> = {
  agent: "Agents",
  skill: "Skills",
  plugin: "Plugins",
  app: "Apps",
  mcpGateway: "MCP Gateways",
  mcpOauthClient: "MCP OAuth Clients",
  llmProxy: "LLM Proxy",
  toolPolicy: "Tools & Policies",
  log: "LLM & MCP Logs",
  openappaPolicy: "OpenAPPA Policy",
  openappaDiagnostics: "OpenAPPA Diagnostics",
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
  llmOauthClient: "LLM OAuth Clients",
  llmModel: "LLM Models",
  apiKey: "API Keys",
  serviceAccount: "Service Accounts",
  auditLog: "Audit Log",
  accessPolicies: "Access Policies",
  organizationSettings: "Organization Settings",
  scheduledTask: "Scheduled Tasks",
};

export const resourceDescriptions: Record<Resource, string> = {
  agent: "Agents with prompts and tool assignments",
  skill: "Agent skills — reusable SKILL.md instruction plugins",
  plugin: "Opaque plugins that execute hooks on connected developer machines",
  app: "User-authored MCP Apps — interactive apps with their own data store and tools",
  mcpGateway: "Unified MCP endpoints that aggregate tools for clients",
  mcpOauthClient:
    "OAuth clients (service accounts) authorized to call MCP gateways",
  llmProxy: "The LLM Proxy endpoint with security policies and observability",
  toolPolicy: "Tools, tool invocation policies, and trusted data policies",
  openappaPolicy: "OpenAPPA policy, batteries, and coverage",
  openappaDiagnostics: "Agent yells and OpenAPPA consult logs",
  log: "LLM proxy and MCP tool-call logs, with separate own and organization-wide visibility",
  chat: "Chat conversations",
  project:
    "Projects — shared collections of chats, Agent Runtime runs, and files",
  scheduledTask: "Scheduled agent tasks that run on a schedule",
  llmProviderApiKey: "LLM provider API keys and their visibility",
  llmVirtualKey: "LLM virtual keys and their visibility",
  llmOauthClient: "OAuth clients authorized to call the LLM Proxy",
  llmModel: "LLM model catalog entries and chat capabilities",
  llmLimit: "LLM usage limits",
  llmCost: "Organization-wide LLM usage and cost analytics",
  mcpRegistry:
    "MCP server registry management. Deployment settings are granted per entry, on the entry's Permissions tab.",
  mcpServerInstallation: "Installed MCP servers and their runtime",
  environment: "Deployment environments (namespace) for catalog items",
  credential:
    "Reusable custom secrets, GitHub tokens, and GitHub Apps across the platform",
  member:
    "People in the organization: inviting them, changing their roles, and removing them",
  ac: "Custom RBAC roles",
  team: "Teams for organizing users and access control",
  invitation: "User invitations",
  identityProvider: "Identity providers for authentication",
  apiKey: "User API keys for programmatic access",
  serviceAccount: "Service accounts and tokens for programmatic access",
  auditLog: "Audit events, with separate own and organization-wide visibility",
  accessPolicies:
    "View and edit organization-wide access policies for every resource type",
  organizationSettings:
    "Organization-wide settings: appearance, authentication, agents and security, LLM, MCP, skills, knowledge, OpenAPPA enforcement, messaging channels, site notifications, and the secrets backend",
  knowledgeSource:
    "Knowledge sources including knowledge bases and connectors for RAG-based document retrieval",
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
  Agents: ["agent", "skill", "plugin", "app", "scheduledTask"],
  MCP: [
    "mcpGateway",
    "mcpOauthClient",
    "toolPolicy",
    "mcpRegistry",
    "mcpServerInstallation",
  ],
  LLM: [
    "llmProxy",
    "llmProviderApiKey",
    "llmVirtualKey",
    "llmOauthClient",
    "llmModel",
    "llmLimit",
    "llmCost",
  ],
  OpenAPPA: ["openappaPolicy", "openappaDiagnostics"],
  Other: ["chat", "project", "knowledgeSource", "log", "auditLog"],
  Administration: [
    "accessPolicies",
    "member",
    "ac",
    "team",
    "identityProvider",
    "apiKey",
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

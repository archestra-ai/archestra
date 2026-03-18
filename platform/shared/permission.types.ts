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
] as const;

export const resources = [
  "agent",
  "mcpGateway",
  "llmProxy",
  "toolPolicy",
  "log",
  "dualLlmConfig",
  "dualLlmResult",
  "identityProvider",
  "mcpRegistry",
  "mcpServerInstallation",
  "knowledgeBase",
  "knowledgeSettings",
  "mcpServerInstallationRequest",
  "chat",
  "llmCost",
  "llmLimit",
  "optimizationRule",
  "llmProvider",
  "secret",
  "organizationSettings",
  "llmSettings",
  "agentSettings",
  "agentTrigger",
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
  "simpleView",
  "chatAgentPicker",
  "chatProviderSettings",
  "chatExpandToolCalls",
] as const;

export const resourceLabels: Record<Resource, string> = {
  agent: "Agents",
  mcpGateway: "MCP Gateways",
  llmProxy: "LLM Proxies",
  toolPolicy: "Tools & Policies",
  log: "Logs",
  dualLlmConfig: "Dual LLM Configs",
  dualLlmResult: "Dual LLM Results",
  organization: "Organization",
  identityProvider: "Identity Providers",
  member: "Users",
  invitation: "Invitations",
  mcpRegistry: "MCP Registry",
  mcpServerInstallation: "MCP Server Installations",
  knowledgeBase: "Knowledge Bases",
  knowledgeSettings: "Knowledge Settings",
  mcpServerInstallationRequest: "MCP Server Installation Requests",
  team: "Teams",
  ac: "Roles",
  chat: "Chats",
  llmCost: "LLM Costs",
  llmLimit: "LLM Limits",
  optimizationRule: "Optimization Rules",
  llmProvider: "LLM Providers",
  secret: "Secrets",
  apiKey: "API Keys",
  organizationSettings: "Organization Settings",
  llmSettings: "LLM Settings",
  agentSettings: "Agent Settings",
  agentTrigger: "Agent Triggers",
  simpleView: "Simple View",
  chatAgentPicker: "Chat Agent Picker",
  chatProviderSettings: "Chat Provider Settings",
  chatExpandToolCalls: "Chat Expand Tool Calls",
};

export const resourceDescriptions: Record<Resource, string> = {
  agent: "Agents with prompts and tool assignments",
  mcpGateway: "Unified MCP endpoints that aggregate tools for clients",
  llmProxy: "LLM proxy endpoints with security policies and observability",
  toolPolicy: "Tools, tool invocation policies, and trusted data policies",
  log: "LLM proxy and MCP tool call logs",
  chat: "Chat conversations",
  agentTrigger: "Agent triggers (Slack, MS Teams, incoming emails)",
  llmProvider: "LLM provider API keys, virtual keys, and models",
  llmLimit: "LLM usage limits",
  llmSettings: "LLM settings (compression, cleanup interval)",
  agentSettings:
    "Agent settings (default model, default agent, security engine, chat file uploads)",
  llmCost: "LLM usage and cost analytics",
  mcpRegistry: "MCP server registry management",
  mcpServerInstallation: "Installed MCP servers and their runtime",
  mcpServerInstallationRequest: "Requests for new MCP server installations",
  optimizationRule: "LLM optimization rules for routing to cheaper models",
  dualLlmConfig: "Dual LLM security configurations",
  dualLlmResult: "Dual LLM security validation results",
  member: "Users and role assignments",
  ac: "Custom RBAC roles",
  team: "Teams for organizing users and access control",
  invitation: "User invitations",
  identityProvider: "Identity providers for authentication",
  secret: "Secrets manager configuration and connectivity",
  apiKey: "User API keys for programmatic access",
  organizationSettings:
    "Organization settings (appearance, authentication, etc)",
  knowledgeBase:
    "Knowledge bases and connectors for RAG-based document retrieval",
  knowledgeSettings:
    "Knowledge settings (embedding and reranking models configuration)",
  simpleView: "Controls if the simple view of the app is enabled",
  chatAgentPicker: "Controls visibility of the agent picker in chat",
  chatProviderSettings:
    "Controls visibility of model and API key selectors in chat",
  chatExpandToolCalls:
    "Controls ability to expand and view tool call details in chat",
  organization: "Organization (internal, used by authentication system)",
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
  Agents: ["agent", "agentTrigger", "agentSettings"],
  MCP: [
    "mcpGateway",
    "toolPolicy",
    "mcpRegistry",
    "mcpServerInstallation",
    "mcpServerInstallationRequest",
  ],
  LLM: [
    "llmProxy",
    "llmProvider",
    "llmLimit",
    "optimizationRule",
    "llmSettings",
    "llmCost",
  ],
  Knowledge: ["knowledgeBase", "knowledgeSettings"],
  Other: [
    "chat",
    "log",
    "dualLlmConfig",
    "dualLlmResult",
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

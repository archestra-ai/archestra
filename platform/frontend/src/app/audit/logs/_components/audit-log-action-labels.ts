import type { ComponentProps } from "react";
import type { Badge } from "@/components/ui/badge";
import type { AuditAction } from "@/lib/audit-log/audit-log.query";

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>["variant"]>;

export const ACTION_LABEL: Record<AuditAction, string> = {
  create: "Create",
  update: "Update",
  delete: "Delete",
  sign_in: "Sign in",
  sign_out: "Sign out",
  sign_up: "Sign up",
  sso_callback: "SSO callback",
};

export const ACTION_BADGE_VARIANT: Record<AuditAction, BadgeVariant> = {
  create: "default",
  update: "secondary",
  delete: "destructive",
  sign_in: "outline",
  sign_out: "outline",
  sign_up: "outline",
  sso_callback: "outline",
};

export const ALL_ACTIONS: AuditAction[] = [
  "create",
  "update",
  "delete",
  "sign_in",
  "sign_out",
  "sign_up",
  "sso_callback",
];

export function formatAction(action: AuditAction): string {
  return ACTION_LABEL[action];
}

/**
 * Curated set of resource types surfaced in the audit log filter. Mirrors the
 * backend's auditable route registry; unrecognised resource types still appear
 * in rows but are not selectable from the filter dropdown.
 */
export const KNOWN_RESOURCE_TYPES: readonly string[] = [
  "agent",
  "agentTool",
  "apiKey",
  "auth",
  "chatOpsBinding",
  "chatOpsConfig",
  "connector",
  "identityProvider",
  "internalMcpCatalog",
  "invitation",
  "knowledgeBase",
  "limit",
  "llmModel",
  "llmOauthClient",
  "llmProviderApiKey",
  "mcpServer",
  "mcpServerInstallationRequest",
  "member",
  "optimizationRule",
  "organization",
  "role",
  "scheduleTrigger",
  "skill",
  "team",
  "teamToken",
  "tool",
  "toolInvocationPolicy",
  "trustedDataPolicy",
  "userToken",
  "virtualApiKey",
];

const RESOURCE_LABEL_OVERRIDES: Record<string, string> = {
  agentTool: "Agent tool assignment",
  apiKey: "API key",
  auth: "Auth",
  chatOpsBinding: "ChatOps channel binding",
  chatOpsConfig: "ChatOps configuration",
  internalMcpCatalog: "Internal MCP catalog",
  llmModel: "LLM model",
  llmOauthClient: "LLM OAuth client",
  llmProviderApiKey: "LLM provider key",
  member: "Member",
  mcpServer: "MCP server",
  mcpServerInstallationRequest: "MCP install request",
  identityProvider: "Identity provider",
  knowledgeBase: "Knowledge base",
  optimizationRule: "Optimization rule",
  organization: "Organization",
  scheduleTrigger: "Scheduled task",
  skill: "Agent skill",
  teamToken: "Team / org token",
  tool: "Discovered tool",
  toolInvocationPolicy: "Tool invocation policy",
  trustedDataPolicy: "Trusted data policy",
  userToken: "Personal token",
  virtualApiKey: "Virtual API key",
};

export function formatResourceType(resourceType: string): string {
  if (RESOURCE_LABEL_OVERRIDES[resourceType]) {
    return RESOURCE_LABEL_OVERRIDES[resourceType];
  }
  // Split camelCase / snake_case into spaced words and capitalize the first.
  const spaced = resourceType
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

import type { ComponentProps } from "react";
import type { Badge } from "@/components/ui/badge";
import type {
  AuditActorType,
  AuditEventName,
  AuditOutcome,
} from "@/lib/audit-log/audit-log.query";

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>["variant"]>;

// === Action labels and badge variants

/**
 * Human-readable label for every audit event in the closed vocabulary.
 * Adding a new event to the backend enum requires a matching entry here —
 * the `Record<AuditEventName, string>` type enforces completeness at
 * compile time.
 */
export const ACTION_LABEL: Record<AuditEventName, string> = {
  // Agent
  "agent.created": "Agent created",
  "agent.updated": "Agent updated",
  "agent.deleted": "Agent deleted",
  "agent.restored": "Agent restored",
  // Agent tool assignment
  "agentTool.created": "Agent tool added",
  "agentTool.updated": "Agent tool updated",
  "agentTool.deleted": "Agent tool removed",
  "agentTool.bulk_assigned": "Agent tools bulk assigned",
  // API key
  "apiKey.created": "API key created",
  "apiKey.deleted": "API key deleted",
  // ChatOps binding
  "chatOpsBinding.created": "ChatOps binding created",
  "chatOpsBinding.updated": "ChatOps binding updated",
  "chatOpsBinding.deleted": "ChatOps binding deleted",
  "chatOpsBinding.refreshed": "ChatOps binding refreshed",
  // ChatOps config
  "chatOpsConfig.updated": "ChatOps config updated",
  // Connector
  "connector.created": "Connector created",
  "connector.updated": "Connector updated",
  "connector.deleted": "Connector deleted",
  // Environment
  "environment.created": "Environment created",
  "environment.updated": "Environment updated",
  "environment.deleted": "Environment deleted",
  // Identity provider
  "identityProvider.created": "Identity provider created",
  "identityProvider.updated": "Identity provider updated",
  "identityProvider.deleted": "Identity provider deleted",
  // Internal MCP catalog
  "internalMcpCatalog.created": "Internal catalog created",
  "internalMcpCatalog.updated": "Internal catalog updated",
  "internalMcpCatalog.deleted": "Internal catalog deleted",
  // Invitation
  "invitation.created": "Invitation sent",
  "invitation.deleted": "Invitation canceled",
  // Knowledge base
  "knowledgeBase.created": "Knowledge base created",
  "knowledgeBase.updated": "Knowledge base updated",
  "knowledgeBase.deleted": "Knowledge base deleted",
  // Limit
  "limit.created": "Limit created",
  "limit.updated": "Limit updated",
  "limit.deleted": "Limit deleted",
  // LLM model
  "llmModel.updated": "LLM model updated",
  "llmModel.synced": "LLM model catalog synced",
  // LLM OAuth client
  "llmOauthClient.created": "LLM OAuth client created",
  "llmOauthClient.updated": "LLM OAuth client updated",
  "llmOauthClient.deleted": "LLM OAuth client deleted",
  // LLM provider key
  "llmProviderApiKey.created": "LLM provider key created",
  "llmProviderApiKey.deleted": "LLM provider key deleted",
  // MCP server
  "mcpServer.created": "MCP server created",
  "mcpServer.updated": "MCP server updated",
  "mcpServer.deleted": "MCP server deleted",
  "mcpServer.reinstalled": "MCP server reinstalled",
  // MCP install request
  "mcpServerInstallationRequest.created": "MCP install request created",
  "mcpServerInstallationRequest.updated": "MCP install request updated",
  // Member
  "member.created": "Member added",
  "member.role_updated": "Member role changed",
  "member.deleted": "Member removed",
  // Optimization rule
  "optimizationRule.created": "Optimization rule created",
  "optimizationRule.updated": "Optimization rule updated",
  "optimizationRule.deleted": "Optimization rule deleted",
  // Organization
  "organization.updated": "Organization updated",
  // Role
  "role.created": "Role created",
  "role.updated": "Role updated",
  "role.deleted": "Role deleted",
  // Schedule trigger
  "scheduleTrigger.created": "Schedule trigger created",
  "scheduleTrigger.updated": "Schedule trigger updated",
  "scheduleTrigger.deleted": "Schedule trigger deleted",
  // Service account
  "serviceAccount.created": "Service account created",
  "serviceAccount.updated": "Service account updated",
  "serviceAccount.deleted": "Service account deleted",
  // Skill
  "skill.created": "Skill created",
  "skill.updated": "Skill updated",
  "skill.deleted": "Skill deleted",
  "skill.imported": "Skill imported",
  // Team
  "team.created": "Team created",
  "team.updated": "Team updated",
  "team.deleted": "Team deleted",
  // Team / org token
  "teamToken.rotated": "Team token rotated",
  // Tool
  "tool.deleted": "Tool deleted",
  // Tool invocation policy
  "toolInvocationPolicy.created": "Tool policy created",
  "toolInvocationPolicy.updated": "Tool policy updated",
  "toolInvocationPolicy.deleted": "Tool policy deleted",
  "toolInvocationPolicy.bulk_defaulted": "Tool policies bulk defaulted",
  "toolInvocationPolicy.auto_configured": "Tool policies auto-configured",
  // Trusted data policy
  "trustedDataPolicy.created": "Trusted data policy created",
  "trustedDataPolicy.updated": "Trusted data policy updated",
  "trustedDataPolicy.deleted": "Trusted data policy deleted",
  "trustedDataPolicy.bulk_defaulted": "Trusted data policies bulk defaulted",
  // User token
  "userToken.rotated": "Personal token rotated",
  // Virtual API key
  "virtualApiKey.created": "Virtual API key created",
  "virtualApiKey.deleted": "Virtual API key deleted",
  // Auth surface
  "auth.signed_in": "Sign in",
  "auth.signed_out": "Sign out",
  "auth.signed_up": "Sign up",
  "auth.sso_callback": "SSO callback",
  // Catch-all fallbacks
  "unknown.created": "Unknown create",
  "unknown.updated": "Unknown update",
  "unknown.deleted": "Unknown delete",
};

/**
 * Derive a badge variant from the event name's verb suffix. Auth and unknown
 * events use `outline`; created → `default`; deleted → `destructive`;
 * everything else (updates, rotations, syncs, etc.) → `secondary`.
 */
function verbVariant(eventName: AuditEventName): BadgeVariant {
  if (eventName.startsWith("auth.") || eventName.startsWith("unknown.")) {
    return "outline";
  }
  const verb = eventName.split(".")[1] ?? "";
  if (verb === "created") return "default";
  if (verb === "deleted") return "destructive";
  return "secondary";
}

/**
 * Proxy that derives a badge variant on-demand for any event name, including
 * future events not yet in ACTION_LABEL.
 */
export const ACTION_BADGE_VARIANT = new Proxy(
  {} as Record<AuditEventName, BadgeVariant>,
  {
    get: (_, key) => verbVariant(key as AuditEventName),
  },
);

/** All known event names, in label-alphabetical order derived from ACTION_LABEL. */
export const ALL_ACTIONS = Object.keys(ACTION_LABEL) as AuditEventName[];

/**
 * Human-readable action label with a fallback for unrecognized dotted names so
 * the UI never crashes on future events before the frontend is updated.
 */
export function formatAction(action: AuditEventName | string): string {
  return ACTION_LABEL[action as AuditEventName] ?? humanizeDottedName(action);
}

function humanizeDottedName(name: string): string {
  return name.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// === Outcome labels and badge variants

export const OUTCOME_LABEL: Record<AuditOutcome, string> = {
  success: "Success",
  failure: "Failure",
  denied: "Denied",
};

export const OUTCOME_BADGE_VARIANT: Record<AuditOutcome, BadgeVariant> = {
  success: "default",
  failure: "destructive",
  denied: "outline",
};

export const ALL_OUTCOMES: AuditOutcome[] = ["success", "failure", "denied"];

// === Actor type labels

export const ACTOR_TYPE_LABEL: Record<AuditActorType, string> = {
  user: "User",
  api_key: "API key",
  service_account: "Service account",
  sso: "SSO",
  system: "System",
};

export const ALL_ACTOR_TYPES: AuditActorType[] = [
  "user",
  "api_key",
  "service_account",
  "sso",
  "system",
];

// === Resource type helpers (unchanged)

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
  "environment",
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

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
  "agent.bulk_updated": "Agents bulk updated",
  "agent.bulk_deleted": "Agents bulk deleted",
  "agent.restored": "Agent restored",
  "agent.purged": "Agent permanently deleted",
  "agent.imported": "Agent imported",
  // Agent execution
  "agentExecution.created": "Agent execution started",
  "agentExecution.canceled": "Agent execution canceled",
  "agentExecution.updated": "Agent execution renamed",
  "agentExecution.deleted": "Agent execution deleted",
  // Execution credential
  "executionCredential.created": "Execution credential created",
  "executionCredential.updated": "Execution credential updated",
  "executionCredential.deleted": "Execution credential deleted",
  // Agent tool assignment
  "agentTool.created": "Agent tool added",
  "agentTool.updated": "Agent tool updated",
  "agentTool.deleted": "Agent tool removed",
  "agentTool.bulk_assigned": "Agent tools bulk assigned",
  "agentTool.bulk_removed": "Agent tools bulk removed",
  "agentTool.bulk_updated": "Agent tools bulk updated",
  // API key
  "apiKey.created": "API key created",
  "apiKey.deleted": "API key deleted",
  // App
  "app.created": "App created",
  "app.updated": "App updated",
  "app.deleted": "App deleted",
  "app.bulk_updated": "Apps bulk updated",
  "app.bulk_deleted": "Apps bulk deleted",
  // ChatOps binding
  "chatOpsBinding.created": "ChatOps binding created",
  "chatOpsBinding.updated": "ChatOps binding updated",
  "chatOpsBinding.deleted": "ChatOps binding deleted",
  "chatOpsBinding.refreshed": "ChatOps binding refreshed",
  // ChatOps config
  "chatOpsConfig.updated": "ChatOps config updated",
  // Plugin
  "plugin.created": "Plugin created",
  "plugin.updated": "Plugin updated",
  "plugin.deleted": "Plugin deleted",
  "plugin.syncTriggered": "Plugin sync check triggered",
  // Connector
  "connector.created": "Connector created",
  "connector.updated": "Connector updated",
  "connector.deleted": "Connector deleted",
  "connector.purged": "Connector permanently deleted",
  "connector.restored": "Connector restored",
  "connector.permission_sync_triggered": "Connector permission sync triggered",
  "connector.synced": "Connector synced",
  // Default user limit
  "defaultUserLimit.created": "Default user limit created",
  "defaultUserLimit.updated": "Default user limit updated",
  "defaultUserLimit.deleted": "Default user limit deleted",
  // Environment
  "environment.created": "Environment created",
  "environment.updated": "Environment updated",
  "environment.deleted": "Environment deleted",
  // GitHub App configuration
  "githubAppConfig.created": "GitHub App configuration created",
  "githubAppConfig.updated": "GitHub App configuration updated",
  "githubAppConfig.deleted": "GitHub App configuration deleted",
  "githubPat.created": "GitHub token saved",
  "githubPat.updated": "GitHub token updated",
  "githubPat.deleted": "GitHub token deleted",
  // Identity provider
  "identityProvider.created": "Identity provider created",
  "identityProvider.updated": "Identity provider updated",
  "identityProvider.deleted": "Identity provider deleted",
  // Internal MCP catalog
  "internalMcpCatalog.created": "Internal catalog created",
  "internalMcpCatalog.updated": "Internal catalog updated",
  "internalMcpCatalog.deleted": "Internal catalog deleted",
  "internalMcpCatalog.restored": "Internal catalog restored",
  "internalMcpCatalog.reinstalled": "Internal catalog reinstalled",
  // Invitation
  "invitation.created": "Invitation sent",
  "invitation.deleted": "Invitation canceled",
  // Knowledge base
  "knowledgeBase.created": "Knowledge base created",
  "knowledgeBase.updated": "Knowledge base updated",
  "knowledgeBase.deleted": "Knowledge base deleted",
  "knowledgeBase.purged": "Knowledge base permanently deleted",
  "knowledgeBase.restored": "Knowledge base restored",
  "knowledgeDirectory.created": "Knowledge directory created",
  "knowledgeDirectory.updated": "Knowledge directory updated",
  "knowledgeDirectory.deleted": "Knowledge directory deleted",
  "knowledgeFile.created": "Knowledge file created",
  "knowledgeFile.updated": "Knowledge file updated",
  "knowledgeFile.deleted": "Knowledge file deleted",
  // Limit
  "limit.created": "Limit created",
  "limit.updated": "Limit updated",
  "limit.deleted": "Limit deleted",
  "limit.bulk_deleted": "Limits deleted",
  // LLM model
  "llmModel.updated": "LLM model updated",
  "llmModel.synced": "LLM model catalog synced",
  // LLM OAuth client
  "llmOauthClient.created": "LLM OAuth client created",
  "llmOauthClient.updated": "LLM OAuth client updated",
  "llmOauthClient.deleted": "LLM OAuth client deleted",
  "llmOauthClient.rotated": "LLM OAuth client secret rotated",
  "llmOauthClient.bulk_deleted": "LLM OAuth clients bulk deleted",
  // LLM provider key
  "llmProviderApiKey.created": "LLM provider key created",
  "llmProviderApiKey.deleted": "LLM provider key deleted",
  // LLM Proxy
  "llmProxy.updated": "LLM Proxy updated",
  "llmProviderApiKey.bulk_deleted": "LLM provider keys deleted",
  // MCP OAuth client
  "mcpOauthClient.created": "MCP OAuth client created",
  "mcpOauthClient.updated": "MCP OAuth client updated",
  "mcpOauthClient.deleted": "MCP OAuth client deleted",
  "mcpOauthClient.rotated": "MCP OAuth client secret rotated",
  // MCP server
  "mcpServer.created": "MCP server created",
  "mcpServer.updated": "MCP server updated",
  "mcpServer.deleted": "MCP server deleted",
  "mcpServer.restored": "MCP server restored",
  "mcpServer.reinstalled": "MCP server reinstalled",
  "mcpServer.hardReset": "MCP server hard reset",
  // MCP install request
  // Retired with the installation-request feature; retained so audit rows
  // written before its removal still render with a readable label.
  "mcpServerInstallationRequest.created": "MCP install request created",
  "mcpServerInstallationRequest.updated": "MCP install request updated",
  // Member
  "member.created": "Member added",
  "member.role_updated": "Member role changed",
  "member.deleted": "Member removed",
  "member.bulk_deleted": "Members removed",
  // Optimization rule
  // Retired with the LLM optimization rules feature; retained so audit rows
  // written before its removal still render with a readable label.
  "optimizationRule.created": "Optimization rule created",
  "optimizationRule.updated": "Optimization rule updated",
  "optimizationRule.deleted": "Optimization rule deleted",
  // Organization
  "organization.updated": "Organization updated",
  // Project
  "project.created": "Project created",
  "project.updated": "Project updated",
  "project.deleted": "Project deleted",
  "project.bulk_updated": "Projects bulk updated",
  "project.bulk_deleted": "Projects bulk deleted",
  "project.restored": "Project restored",
  "project.purged": "Project permanently deleted",
  // Role
  "role.created": "Role created",
  "role.updated": "Role updated",
  "role.deleted": "Role deleted",
  // Schedule trigger
  "scheduleTrigger.created": "Schedule trigger created",
  "scheduleTrigger.updated": "Schedule trigger updated",
  "scheduleTrigger.deleted": "Schedule trigger deleted",
  "scheduleTrigger.triggered": "Schedule trigger run now",
  // Service account
  "serviceAccount.created": "Service account created",
  "serviceAccount.updated": "Service account updated",
  "serviceAccount.deleted": "Service account deleted",
  // Skill
  "skill.created": "Skill created",
  "skill.updated": "Skill updated",
  "skill.bulk_updated": "Skills bulk updated",
  "skill.deleted": "Skill deleted",
  "skill.bulk_deleted": "Skills bulk deleted",
  "skill.restored": "Skill restored",
  "skill.purged": "Skill permanently deleted",
  "skill.imported": "Skill imported",
  "skillShareLink.created": "Marketplace link created",
  "skillShareLink.rotated": "Marketplace link rotated",
  "skillShareLink.revoked": "Marketplace link revoked",
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
  // User
  "user.password_reset": "Password reset",
  // User token
  "userToken.rotated": "Personal token rotated",
  // Virtual API key
  "virtualApiKey.created": "Virtual API key created",
  "virtualApiKey.deleted": "Virtual API key deleted",
  "virtualApiKey.bulk_deleted": "Virtual API keys bulk deleted",
  // Auth surface
  "auth.impersonation_started": "Impersonation started",
  "auth.impersonation_stopped": "Impersonation stopped",
  "auth.signed_in": "Sign in",
  "auth.signed_out": "Sign out",
  "auth.signed_up": "Sign up",
  "auth.sso_callback": "SSO callback",
  "auth.sessions_revoked": "Sessions revoked",
  // Catch-all fallbacks
  "unknown.created": "Unknown create",
  "unknown.updated": "Unknown update",
  "apiKey.bulk_deleted": "API keys bulk deleted",
  "connector.bulk_updated": "Connectors bulk updated",
  "connector.bulk_deleted": "Connectors bulk deleted",
  "environment.bulk_deleted": "Environments bulk deleted",
  "knowledgeBase.bulk_deleted": "Knowledge bases bulk deleted",
  "knowledgeDirectory.bulk_updated": "Knowledge directories bulk updated",
  "knowledgeDirectory.bulk_deleted": "Knowledge directories bulk deleted",
  "knowledgeFile.bulk_updated": "Knowledge documents bulk updated",
  "knowledgeFile.bulk_deleted": "Knowledge documents bulk deleted",
  "llmModel.bulk_updated": "LLM models bulk updated",
  "mcpServer.bulk_deleted": "MCP servers bulk deleted",
  "role.bulk_deleted": "Roles bulk deleted",
  "serviceAccount.bulk_deleted": "Service accounts bulk deleted",
  "serviceAccount.bulk_updated": "Service accounts bulk updated",
  "team.bulk_deleted": "Teams bulk deleted",
  "unknown.deleted": "Unknown delete",
};

/**
 * Derive a badge variant from the event name's verb suffix. Auth and unknown
 * events use `outline`; created → `default`; deleted and purged →
 * `destructive`; everything else (updates, rotations, syncs, etc.) →
 * `secondary`.
 */
function verbVariant(eventName: AuditEventName): BadgeVariant {
  if (eventName.startsWith("auth.") || eventName.startsWith("unknown.")) {
    return "outline";
  }
  const verb = eventName.split(".")[1] ?? "";
  if (verb === "created") return "default";
  // `purged` is permanent deletion — the one action nothing recovers from, so
  // it must not read as quieter than the soft delete it follows.
  if (verb === "deleted" || verb === "purged") return "destructive";
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
  "app",
  "auth",
  "chatOpsBinding",
  "chatOpsConfig",
  "plugin",
  "connector",
  "defaultUserLimit",
  "environment",
  "githubAppConfig",
  "githubPat",
  "identityProvider",
  "internalMcpCatalog",
  "invitation",
  "knowledgeBase",
  "knowledgeDirectory",
  "knowledgeFile",
  "limit",
  "llmModel",
  "llmOauthClient",
  "llmProviderApiKey",
  "llmProxy",
  "mcpOauthClient",
  "mcpServer",
  "mcpServerInstallationRequest",
  "member",
  "optimizationRule",
  "organization",
  "role",
  "scheduleTrigger",
  "serviceAccount",
  "skill",
  "skillShareLink",
  "team",
  "teamToken",
  "tool",
  "toolInvocationPolicy",
  "trustedDataPolicy",
  "user",
  "userToken",
  "virtualApiKey",
];

const RESOURCE_LABEL_OVERRIDES: Record<string, string> = {
  agentTool: "Agent tool assignment",
  apiKey: "API key",
  auth: "Auth",
  chatOpsBinding: "ChatOps channel binding",
  chatOpsConfig: "ChatOps configuration",
  plugin: "Plugin",
  githubAppConfig: "GitHub App configuration",
  githubPat: "GitHub PAT",
  internalMcpCatalog: "Internal MCP catalog",
  mcpOauthClient: "MCP OAuth client",
  llmModel: "LLM model",
  llmOauthClient: "LLM OAuth client",
  llmProviderApiKey: "LLM provider key",
  llmProxy: "LLM Proxy",
  member: "Member",
  mcpServer: "MCP server",
  mcpServerInstallationRequest: "MCP install request",
  identityProvider: "Identity provider",
  knowledgeBase: "Knowledge base",
  knowledgeDirectory: "Knowledge directory",
  knowledgeFile: "Knowledge file",
  optimizationRule: "Optimization rule",
  organization: "Organization",
  scheduleTrigger: "Scheduled task",
  skill: "Agent skill",
  skillShareLink: "Marketplace link",
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

/**
 * Human-readable identity of the audited resource. Prefers the denormalized
 * event-time `resourceName`; rows written before that column existed fall back
 * to the identity captured inside the before/after snapshots. Keep the
 * key/snapshot precedence in sync with the backend's write-time
 * `extractAuditResourceName` (backend/src/middleware/audit-log-hook.ts).
 */
export function resourceDisplayName(event: {
  resourceName?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}): string | null {
  if (event.resourceName) return event.resourceName;
  for (const key of ["name", "email"]) {
    for (const snapshot of [event.after, event.before]) {
      const value = snapshot?.[key];
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

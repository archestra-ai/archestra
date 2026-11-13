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
export const ACTION_LABEL: Record<AuditEventName, string> & {
  "agentRun.reviewDecided": string;
} = {
  "hook.created": "Hook created",
  "hook.updated": "Hook updated",
  "hook.deleted": "Hook deleted",
  "resourcePermissions.updated": "Access updated",
  // Agent
  "agent.created": "Agent created",
  "agent.updated": "Agent updated",
  "agent.deleted": "Agent deleted",
  "agent.bulk_deleted": "Agents bulk deleted",
  "agent.restored": "Agent restored",
  "agent.purged": "Agent permanently deleted",
  "agent.imported": "Agent imported",
  // Agent run
  "agentRun.created": "Agent run started",
  "agentRun.canceled": "Agent run stopped",
  "agentRun.updated": "Agent run updated",
  "agentRun.deleted": "Agent run deleted",
  "agentRun.reviewDecided": "Agent run tool call reviewed",
  "browserStorageState.deleted": "Browser saved login removed",
  // Runtime credential
  "credential.created": "Credential created",
  "credential.updated": "Credential updated",
  "credential.deleted": "Credential deleted",
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
  "app.bulk_deleted": "Apps bulk deleted",
  // Messaging channel binding
  "chatOpsBinding.created": "Messaging channel binding created",
  "chatOpsBinding.updated": "Messaging channel binding updated",
  "chatOpsBinding.deleted": "Messaging channel binding deleted",
  "chatOpsBinding.refreshed": "Messaging channel list refreshed",
  // Messaging channel settings
  "chatOpsConfig.updated": "Messaging channel settings updated",
  // Plugin
  "plugin.created": "Plugin created",
  "plugin.updated": "Plugin updated",
  "plugin.deleted": "Plugin deleted",
  "plugin.syncTriggered": "Plugin update check started",
  // Connector
  "clientConnection.updated": "Client connection request reviewed",
  "connectedClient.disconnected": "Connected client disconnected",
  "connector.created": "Connector created",
  "connector.updated": "Connector updated",
  "connector.deleted": "Connector deleted",
  "connector.purged": "Connector permanently deleted",
  "connector.restored": "Connector restored",
  "connector.permission_sync_triggered": "Connector permission sync started",
  "connector.synced": "Connector sync started",
  // Default user limit
  "defaultUserLimit.created": "Default user limit created",
  "defaultUserLimit.updated": "Default user limit updated",
  "defaultUserLimit.deleted": "Default user limit deleted",
  // Environment
  "environment.created": "Environment created",
  "environment.updated": "Environment updated",
  "environment.deleted": "Environment deleted",
  // GitHub App configuration
  // Identity provider
  "identityProvider.created": "Identity provider created",
  "identityProvider.updated": "Identity provider updated",
  "identityProvider.deleted": "Identity provider deleted",
  // MCP registry entry
  "internalMcpCatalog.created": "MCP registry entry created",
  "internalMcpCatalog.updated": "MCP registry entry updated",
  "internalMcpCatalog.deleted": "MCP registry entry deleted",
  "internalMcpCatalog.restored": "MCP registry entry restored",
  "internalMcpCatalog.reinstalled": "MCP registry entry reinstalled",
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
  "knowledgeFile.content_upserted": "Knowledge file content saved",
  "knowledgeFile.deleted": "Knowledge file deleted",
  // Limit
  "limit.created": "Limit created",
  "limit.updated": "Limit updated",
  "limit.reset": "Limit usage reset",
  "limit.deleted": "Limit deleted",
  "limit.bulk_deleted": "Limits bulk deleted",
  // LLM model
  "llmModel.updated": "LLM model updated",
  "llmModel.synced": "LLM model catalog synced",
  "oauthClient.created": "OAuth client created",
  "oauthClient.updated": "OAuth client updated",
  "oauthClient.deleted": "OAuth client deleted",
  "oauthClient.rotated": "OAuth client secret rotated",
  "oauthClient.bulk_deleted": "OAuth clients bulk deleted",
  // LLM OAuth client
  // Provider API key
  "llmProviderApiKey.created": "Provider API key created",
  "llmProviderApiKey.updated": "Provider API key updated",
  "llmProviderApiKey.deleted": "Provider API key deleted",
  // LLM Proxy
  "llmProxy.updated": "LLM Proxy updated",
  "llmProviderApiKey.bulk_deleted": "Provider API keys bulk deleted",
  // MCP OAuth client
  // MCP server
  "mcpServer.created": "MCP server installed",
  "mcpServer.updated": "MCP server updated",
  "mcpServer.deleted": "MCP server uninstalled",
  "mcpServer.restored": "MCP server restored",
  "mcpServer.reinstalled": "MCP server reinstalled",
  "mcpServer.hardReset": "MCP server hard reset",
  // MCP install request
  // Retired with the installation-request feature; retained so audit rows
  // written before its removal still render with a readable label.
  // User (organization member)
  "member.created": "User added",
  "member.role_updated": "User role changed",
  "member.deleted": "User removed",
  "member.bulk_deleted": "Users bulk removed",
  // Optimization rule
  // Retired with the LLM optimization rules feature; retained so audit rows
  // written before its removal still render with a readable label.
  // Organization
  "organization.updated": "Organization updated",
  // Project
  "project.created": "Project created",
  "project.updated": "Project updated",
  "project.deleted": "Project deleted",
  "project.bulk_deleted": "Projects bulk deleted",
  "project.restored": "Project restored",
  "project.purged": "Project permanently deleted",
  // Role
  "role.created": "Role created",
  "role.updated": "Role updated",
  "role.deleted": "Role deleted",
  // Schedule
  "scheduleTrigger.created": "Schedule created",
  "scheduleTrigger.updated": "Schedule updated",
  "scheduleTrigger.deleted": "Schedule deleted",
  "scheduleTrigger.triggered": "Schedule run manually",
  // Service account
  "serviceAccount.created": "Service account created",
  "serviceAccount.updated": "Service account updated",
  "serviceAccount.deleted": "Service account deleted",
  // Skill
  "skill.created": "Skill created",
  "skill.updated": "Skill updated",
  "skill.deleted": "Skill deleted",
  "skill.bulk_deleted": "Skills bulk deleted",
  "skill.restored": "Skill restored",
  "skill.purged": "Skill permanently deleted",
  "skill.imported": "Skill imported",
  "skillShareLink.created": "Skill snapshot link created",
  "skillShareLink.rotated": "Skill snapshot link refreshed",
  "skillShareLink.revoked": "Skill snapshot link revoked",
  // Team
  "team.created": "Team created",
  "team.updated": "Team updated",
  "team.deleted": "Team deleted",
  // Team / org token
  // Guardrails
  "openappaYell.updated": "Guardrails yell status updated",
  "guardrailsPolicy.updated": "Guardrails policy updated",
  // Guardrails batteries
  "openappaBatteryInstall.created": "Guardrails battery attached",
  "openappaBatteryInstall.updated": "Guardrails battery updated",
  "openappaBatteryInstall.deleted": "Guardrails battery detached",
  "openappaBatteryPackage.updated": "Guardrails battery package uploaded",
  "openappaBatteryPackage.deleted": "Guardrails battery package deleted",
  "openappaCredentialBinding.updated": "Guardrails battery credential set",
  // User
  "user.password_reset": "User password reset",
  // User token
  "userToken.rotated": "Personal token rotated",
  // Virtual key
  "virtualApiKey.created": "Virtual key created",
  "virtualApiKey.deleted": "Virtual key deleted",
  "virtualApiKey.bulk_deleted": "Virtual keys bulk deleted",
  // Auth surface
  "auth.impersonation_started": "Impersonation started",
  "auth.impersonation_stopped": "Impersonation stopped",
  "auth.signed_in": "Signed in",
  "auth.signed_out": "Signed out",
  "auth.signed_up": "Signed up",
  "auth.sso_callback": "Signed in with SSO",
  "auth.sessions_revoked": "Sessions revoked",
  // Catch-all fallbacks
  "unknown.created": "Unknown create",
  "unknown.updated": "Unknown update",
  "apiKey.bulk_deleted": "API keys bulk deleted",
  "connector.bulk_updated": "Connectors bulk updated",
  "connector.bulk_deleted": "Connectors bulk deleted",
  "environment.bulk_deleted": "Environments bulk deleted",
  "knowledgeBase.bulk_deleted": "Knowledge bases bulk deleted",
  "knowledgeDirectory.bulk_deleted": "Knowledge directories bulk deleted",
  "knowledgeFile.bulk_deleted": "Knowledge files bulk deleted",
  "llmModel.bulk_updated": "LLM models bulk updated",
  "mcpServer.bulk_deleted": "MCP servers bulk uninstalled",
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

/** `optimizationRule.created` → "Optimization rule created". */
function humanizeDottedName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
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

// === Resource type helpers

const RESOURCE_LABEL_OVERRIDES: Record<string, string> = {
  agentTool: "Agent tool",
  apiKey: "API key",
  auth: "Sign-in",
  browserStorageState: "Browser saved login",
  chatOpsBinding: "Messaging channel binding",
  chatOpsConfig: "Messaging channel settings",
  clientConnection: "Client connection request",
  // The Grok CLI changing xAI's coding-data retention through the LLM Proxy.
  clientPrivacy: "Grok data retention",
  desktopDevice: "Device",
  desktopDeviceSignIn: "Device sign-in",
  guardrailsPolicy: "Guardrails policy",
  identityProvider: "Identity provider",
  internalMcpCatalog: "MCP registry entry",
  knowledgeBase: "Knowledge base",
  knowledgeDirectory: "Knowledge directory",
  knowledgeFile: "Knowledge file",
  llmModel: "LLM model",
  llmProviderApiKey: "Provider API key",
  llmProxy: "LLM Proxy",
  mcpServer: "MCP server",
  member: "User",
  oauthClient: "OAuth client",
  // Who can use an object: the list Permissions button and the item's Access section.
  resourcePermissions: "Access",
  openappaBatteryInstall: "Guardrails battery",
  openappaBatteryPackage: "Guardrails battery package",
  openappaCredentialBinding: "Guardrails battery credential",
  openappaYell: "Guardrails yell",
  scheduleTrigger: "Schedule",
  serviceAccountFederatedCredential: "Federated credential",
  skill: "Skill",
  skillShareLink: "Skill snapshot link",
  userLimitUsage: "User spend",
  userToken: "Personal token",
  virtualApiKey: "Virtual key",
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

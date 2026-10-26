/**
 * Defines the RBAC (Role-Based Access Control) for the platform
 */

import { defaultStatements } from "better-auth/plugins/organization/access";
import type { Action, Permissions, Resource } from "./permission.types";
import type { ScopedResource } from "./resource-permissions";
import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
  PLATFORM_ADMIN_ROLE_NAME,
  type PredefinedRoleName,
  PredefinedRoleNameSchema,
} from "./roles";
import { RouteId } from "./routes";

export const allAvailableActions: Record<Resource, Action[]> = {
  /*
   * Spread better-auth's defaultStatements first, then define all Archestra resources.
   * defaultStatements provides base actions for better-auth's internal resources
   * (organization, member, invitation, team, ac). We override some of these below
   * to add "read" or extra actions that better-auth doesn't include by default.
   *
   * "organization" is explicitly listed at the bottom for type safety but is a
   * better-auth internal resource not exposed to users.
   */
  ...(defaultStatements as unknown as Record<string, Action[]>),

  // Agents
  agent: ["read", "create", "delete"],
  skill: ["read", "create", "delete"],
  plugin: ["read", "create", "update", "delete"],
  app: ["read", "create"],
  guardrailsPolicy: ["read", "update"],

  // LLM
  llmProxy: ["read", "update"],
  llmProviderApiKey: ["read", "create"],
  llmVirtualKey: ["read", "create"],
  // "update" covers the whole model row, generation parameters included. An
  // extra "admin" action once gated `configuredParameters` on the grounds that
  // model rows are global, but pricing and `ignored` are equally global and
  // equally editor-writable — so it drew a line the rest of the row does not,
  // while permanently locking out custom roles, whose permission snapshots are
  // frozen at creation and never gained the new action.
  llmModel: ["read", "update"],
  llmLimit: ["read", "create", "update", "delete"],
  llmCost: ["read"],

  // MCP
  mcpGateway: ["read", "create", "delete"],
  mcpRegistry: ["read", "create"],
  mcpServerInstallation: ["read", "create", "update", "delete"],
  environment: ["read", "create", "update", "delete"],
  credential: ["read", "create"],

  // Knowledge
  knowledgeSource: ["read", "create", "update", "delete", "query"],

  // Other
  chat: ["read", "create", "update", "delete", "full-view"],
  project: ["read", "create", "update", "delete"],
  log: ["read", "admin"],

  // Administration (overrides better-auth defaults to add "read" where needed)
  apiKey: ["read", "create", "delete"],
  oauthClient: ["read", "create"],
  serviceAccount: ["read", "create"],
  auditLog: ["read", "admin"],
  accessPolicies: ["read", "update"],
  member: ["read", "create", "update", "delete", "impersonate"],
  // Never granted directly: Better Auth checks it when inviting or
  // cancelling, and `withDerivedPermissions` fills it in from member:create.
  invitation: ["create", "cancel"],
  ac: ["read", "create", "update", "delete"],
  team: ["read", "create", "update", "delete"],
  identityProvider: ["read", "create", "update", "delete"],
  organizationSettings: ["read", "update"],

  // UI behavior resources

  // Administration

  // better-auth internal resource — not exposed to users, kept for ACL compatibility
  organization: ["update", "delete"],
};

export const editorPermissions: Record<Resource, Action[]> = {
  // Agents
  agent: ["read", "create", "delete"],
  skill: ["read", "create", "delete"],
  plugin: ["read", "create", "update", "delete"],
  app: ["read", "create"],
  guardrailsPolicy: ["read", "update"],

  // LLM
  llmProxy: ["read", "update"],
  llmProviderApiKey: ["read", "create"],
  llmVirtualKey: ["read", "create"],
  llmModel: ["read", "update"],
  llmLimit: ["read", "create", "update", "delete"],
  llmCost: ["read"],

  // MCP
  mcpGateway: ["read", "create", "delete"],
  mcpRegistry: ["read", "create"],
  mcpServerInstallation: ["read", "create", "update", "delete"],
  environment: ["read", "create", "update", "delete"],
  credential: ["read", "create"],

  // Knowledge
  knowledgeSource: ["read", "create", "update", "delete", "query"],

  // Other
  chat: ["read", "create", "update", "delete", "full-view"],
  project: ["read", "create", "update", "delete"],
  // Editors see only their own logs; org-wide visibility is log:admin,
  // reserved for admin-tier roles.
  log: ["read"],

  // Administration (overrides better-auth defaults to add "read" where needed)
  apiKey: ["read", "create", "delete"],
  oauthClient: ["read", "create"],
  serviceAccount: [],
  auditLog: [],
  accessPolicies: [],
  member: ["read"],
  invitation: [],
  ac: ["read"],
  team: ["read"],
  identityProvider: ["read"],
  organizationSettings: [],

  // Administration

  // UI behavior resources

  // better-auth internal resource — not exposed to users, kept for ACL compatibility
  organization: [],
};

export const memberPermissions: Record<Resource, Action[]> = {
  // Agents
  agent: ["read", "create", "delete"],
  skill: ["read", "create", "delete"],
  plugin: [],
  app: ["read", "create"],
  // Members do not see the Guardrails pages or read the policy. Enforcement,
  // yells, and remedies do not depend on this permission.
  guardrailsPolicy: [],

  // LLM
  llmProxy: ["read"],
  llmProviderApiKey: ["read"],
  // Members mint personal virtual keys to route through the LLM Proxy (e.g.
  // the /connection auto-provisioning flow). Granting "create" only enables
  // personal-scope keys; org-scoped keys still require llmVirtualKey:admin
  // (enforced in the virtual-api-key create route).
  llmVirtualKey: ["read", "create"],
  llmModel: ["read"],
  llmLimit: [],
  llmCost: [],

  // MCP
  mcpGateway: ["read", "create", "delete"],
  mcpRegistry: ["read"],
  mcpServerInstallation: ["read", "create", "delete"],
  environment: ["read"],
  // Opening the Credentials page. Which credentials a member sees, connects
  // or changes is decided by grants on each one.
  credential: ["read"],

  // Knowledge
  knowledgeSource: ["read", "query"],
  // Members can see analyses and their results, but dispatching a run
  // spends LLM budget across a whole grid, so running is an editor action.

  // Other
  chat: ["read", "create", "update", "delete", "full-view"],
  project: ["read", "create", "update", "delete"],
  log: [],

  // Administration (overrides better-auth defaults to add "read" where needed)
  apiKey: ["read", "create", "delete"],
  oauthClient: ["read"],
  serviceAccount: [],
  auditLog: [],
  accessPolicies: [],
  member: [],
  invitation: [],
  ac: [],
  team: ["read"],
  identityProvider: [],
  organizationSettings: [],

  // Administration

  // UI behavior resources

  // better-auth internal resource — not exposed to users, kept for ACL compatibility
  organization: [],
};

/**
 * The no-privilege-escalation rule, shared by every server-side grant path
 * (role authoring, member role assignment, invitations, service-account
 * roles, the org default role) and by the UI that previews it: a role may
 * only be granted by someone who already holds every permission it carries.
 * Returns the `resource:action` pairs the granter is missing (empty = OK).
 */
export function findUngrantablePermissions(
  granterPermissions: Permissions,
  rolePermissions: Permissions,
): string[] {
  const missing: string[] = [];
  for (const [resource, actions] of Object.entries(rolePermissions)) {
    const granterActions = granterPermissions[resource as Resource] || [];
    const realActions = allAvailableActions[resource as Resource] || [];
    for (const action of actions ?? []) {
      // Actions outside the permission universe grant nothing (RBAC checks
      // resolve against allAvailableActions), so they cannot be escalation.
      // Without this filter a stale action in a stored role could never be
      // granted by anyone.
      if (!realActions.includes(action)) continue;
      if (!granterActions.includes(action)) {
        missing.push(`${resource}:${action}`);
      }
    }
  }
  return missing;
}

/**
 * Fills in the permissions no one grants directly. Inviting people is part of
 * adding members, so a role's `invitation` actions always follow
 * `member:create` — Better Auth still checks `invitation` itself, which is why
 * the stored role carries it.
 */
export function withDerivedPermissions(permissions: Permissions): Permissions {
  const { invitation: _invitation, ...granted } = permissions;
  return granted.member?.includes("create")
    ? { ...granted, invitation: [...allAvailableActions.invitation] }
    : granted;
}

export const adminPermissions: Record<Resource, Action[]> = {
  ...allAvailableActions,
};

/**
 * Platform Admin: runs the deployment — full user, role, and settings
 * management — while org-wide log visibility and impersonation stay withheld.
 * They keep log:read / auditLog:read, so their OWN activity stays visible to
 * them. Combined with the no-escalation rule (a role can only be granted by
 * someone holding every permission it carries), holders cannot hand
 * themselves or anyone else a role that would widen their visibility.
 */
export const platformAdminPermissions: Record<Resource, Action[]> = {
  ...allAvailableActions,
  log: ["read"],
  auditLog: ["read"],
  member: allAvailableActions.member.filter((a) => a !== "impersonate"),
};

/**
 * The predefined roles whose permissions carry a resource's read action.
 *
 * Legacy visibility was one half of a pair: a resource shared with the whole
 * organization was still invisible to a member whose role withheld that
 * resource's read action. Granting "everyone in the organization" would drop
 * that half, so the upgrade maps organization-wide visibility onto these roles
 * instead and access stays exactly as it was. Choosing everyone remains
 * available afterwards as a deliberate act in the permissions editor.
 */
export function predefinedRolesWithReadAccess(
  resource: ScopedResource,
): PredefinedRoleName[] {
  const gate = roleActionResourceFor(resource);
  return PredefinedRoleNameSchema.options.filter((role) =>
    predefinedPermissionsMap[role][gate]?.includes("read"),
  );
}

/**
 * The role action that used to gate a scoped resource.
 *
 * Mostly the names agree. Knowledge is the exception: bases, connectors and
 * files are three kinds of object with three audiences, so they are three
 * grant namespaces — a base id and a file id must not decide each other — but
 * one role action, `knowledgeSource`, governed reading all three.
 *
 * @public — read by the conversion and by ResourcePermissionPolicyModel
 */
export function roleActionResourceFor(
  resource: ScopedResource | Resource,
): Resource {
  return (
    SCOPED_RESOURCE_ROLE_ACTIONS[resource as ScopedResource] ??
    (resource as Resource)
  );
}

const SCOPED_RESOURCE_ROLE_ACTIONS: Partial<Record<ScopedResource, Resource>> =
  {
    mcpOauthClient: "oauthClient",
    llmOauthClient: "oauthClient",
    conversation: "chat",
    agentRun: "agent",
    knowledgeBase: "knowledgeSource",
    knowledgeConnector: "knowledgeSource",
    knowledgeFile: "knowledgeSource",
    mcpGateway: "mcpGateway",
    externalAgent: "agent",
  };

export const predefinedPermissionsMap: Record<PredefinedRoleName, Permissions> =
  {
    [ADMIN_ROLE_NAME]: adminPermissions,
    [PLATFORM_ADMIN_ROLE_NAME]: platformAdminPermissions,
    [EDITOR_ROLE_NAME]: editorPermissions,
    [MEMBER_ROLE_NAME]: memberPermissions,
  };

/**
 * Human-readable descriptions for each resource:action permission combination.
 * Used in documentation generation and potentially in UI tooltips.
 *
 * A runtime check in the codegen script validates that every combination
 * in allAvailableActions has a corresponding entry here.
 */
export const permissionDescriptions: Record<string, string> = {
  // Agents
  "agent:read":
    "Open Agents, and use the code sandboxes and files of agents you can use",
  "agent:create": "Create new agents",
  "agent:delete": "Open the trash of deleted agents",
  "skill:read": "Open Skills",
  "skill:create": "Create new agent skills",
  "skill:delete": "Permanently delete skills from the trash",
  "plugin:read": "View plugins and their file metadata",
  "plugin:create": "Create plugins",
  "plugin:update": "Modify plugin metadata and files",
  "plugin:delete": "Delete plugins",
  "app:read": "Open Apps",
  "app:create": "Create new MCP Apps",
  "guardrailsPolicy:read": "View Guardrails policy, batteries, and coverage",
  "guardrailsPolicy:update":
    "Validate and edit Guardrails policy and manage batteries",

  // MCP
  "oauthClient:read": "Open OAuth client registrations",
  "oauthClient:create": "Create OAuth client registrations",
  "mcpGateway:read": "Open MCP Gateways",
  "mcpGateway:create": "Create new MCP gateways",
  "mcpGateway:delete": "Open the trash of deleted MCP gateways",
  "mcpRegistry:read": "Open the MCP registry and use its built-in servers",
  "mcpRegistry:create": "Add servers to the MCP registry",
  "mcpServerInstallation:read": "View installed MCP servers and their status",
  "mcpServerInstallation:create": "Install MCP servers from the registry",
  "mcpServerInstallation:update": "Modify installed MCP server configuration",
  "mcpServerInstallation:delete":
    "Uninstall, view deleted, and restore MCP servers within your access",
  "environment:read": "View and list deployment environments",
  "environment:create": "Create deployment environments",
  "environment:update":
    "Modify deployment environments, including the org default environment",
  "environment:delete": "Delete deployment environments",
  "credential:read": "Open Credentials",
  "credential:create": "Create saved credentials",

  // LLM
  "llmProxy:read": "View the LLM Proxy and its connection details",
  "llmProxy:update": "Modify LLM Proxy configuration",
  "llmProviderApiKey:read": "Open LLM provider API keys",
  "llmProviderApiKey:create": "Add new LLM provider API keys",
  "llmVirtualKey:read": "Open LLM virtual keys",
  "llmVirtualKey:create": "Create LLM virtual keys",
  "llmModel:read": "View synced LLM models and capabilities",
  "llmModel:update":
    "Sync the model catalog and see every model, including ones not shared with you",
  "llmLimit:read": "View token usage limits",
  "llmLimit:create": "Create new usage limits",
  "llmLimit:update": "Modify existing usage limits",
  "llmLimit:delete": "Remove usage limits",
  "llmCost:read":
    "View organization-wide LLM usage cost statistics and analytics",

  // Other
  "chat:read": "View and access chat conversations",
  "chat:create": "Start new chat conversations",
  "chat:update": "Edit chat messages and conversation settings",
  "chat:delete": "Delete chat conversations",
  "chat:full-view":
    "Show the full chat: the agent picker, model and API key selectors, and expandable tool calls. Without it, chat shows a simpler view",
  "project:read":
    "View projects, their schedules, and your own sessions inside them",
  "project:create": "Create projects and schedules, and trigger schedule runs",
  "project:update":
    "Edit project descriptions, instructions, sharing, and schedules",
  "project:delete": "Delete projects and schedules",
  "log:read":
    "View your own LLM proxy, MCP tool call, and Guardrails consult logs in the active organization, and view and resolve Guardrails yells",

  // Administration
  "member:read": "View organization members and their roles",
  "member:create": "Add new members to the organization and manage invitations",
  "member:update": "Change member roles and settings",
  "member:delete": "Remove members from the organization",
  "member:impersonate":
    "Temporarily sign in as another member to see the app with their access (role debugging)",
  "ac:read": "View custom roles and their permissions",
  "ac:create": "Create new custom roles",
  "ac:update": "Modify custom role permissions",
  "ac:delete": "Delete custom roles",
  "team:read": "View teams and their members",
  "team:create": "Create new teams",
  "team:update": "Modify team settings",
  "team:delete": "Delete teams",
  "identityProvider:read": "View identity provider configurations (SSO)",
  "identityProvider:create": "Set up new identity providers",
  "identityProvider:update": "Modify identity provider settings",
  "identityProvider:delete": "Remove identity providers",
  "apiKey:read": "View API keys",
  "apiKey:create": "Create API keys",
  "apiKey:delete": "Delete API keys",
  "serviceAccount:read": "Open Service Accounts",
  "serviceAccount:create": "Create service accounts",
  "auditLog:read": "View audit log records of your own administrative actions",
  "auditLog:admin":
    "View every audit event in your organization (also requires Read)",
  "log:admin":
    "View every LLM, MCP, and Guardrails consult log in your organization (also requires Read)",
  "accessPolicies:read": "View access policies for all resource types",
  "accessPolicies:update":
    "Edit access policies and grant access across all resource types",
  "organizationSettings:read":
    "View every organization settings page, including messaging channels",
  "organizationSettings:update":
    "Change organization settings, messaging channels, and site notifications",
  "knowledgeSource:read": "View Knowledge Bases and Connectors",
  "knowledgeSource:create": "Create Knowledge Bases and Connectors",
  "knowledgeSource:update": "Modify Knowledge Bases and Connectors",
  "knowledgeSource:delete":
    "Delete Knowledge Bases and Connectors, view the deleted ones, and restore them",
  "knowledgeSource:query": "Query knowledge sources for information retrieval",

  // UI behavior

  // Administration
};

/**
 * Routes not configured throws 403.
 * If a route should bypass the check, it should be configured in shouldSkipAuthCheck() method.
 * Each config has structure: { [routeId]: { [resource1]: [action1, action2], [resource2]: [action1] } }
 * That would mean that the route (routeId) requires all the permissions to pass the check:
 * `resource1:action1` AND `resource1:action2` AND `resource2:action1`
 */
export const requiredEndpointPermissionsMap: Partial<
  Record<RouteId, Permissions>
> = {
  [RouteId.AzureRealtimeTurnWithDefaultAgent]: {},
  [RouteId.AzureRealtimeTurnWithAgent]: {},
  [RouteId.AzureAudioSpeechWithDefaultAgent]: {},
  [RouteId.AzureAudioSpeechWithAgent]: {},
  [RouteId.AzureAudioTranscriptionsWithDefaultAgent]: {},
  [RouteId.AzureAudioTranscriptionsWithAgent]: {},
  [RouteId.AzureAudioTranslationsWithDefaultAgent]: {},
  [RouteId.AzureAudioTranslationsWithAgent]: {},
  [RouteId.OpenAiAudioSpeechWithDefaultAgent]: {},
  [RouteId.OpenAiAudioSpeechWithAgent]: {},
  [RouteId.OpenAiAudioTranscriptionsWithDefaultAgent]: {},
  [RouteId.OpenAiAudioTranscriptionsWithAgent]: {},
  [RouteId.OpenAiAudioTranslationsWithDefaultAgent]: {},
  [RouteId.OpenAiAudioTranslationsWithAgent]: {},
  [RouteId.AzureImagesWithDefaultAgent]: {},
  [RouteId.AzureImagesWithAgent]: {},
  [RouteId.AzureImageEditsWithDefaultAgent]: {},
  [RouteId.AzureImageEditsWithAgent]: {},
  [RouteId.AzureCreateFile]: {},
  [RouteId.AzureCreateFileWithAgent]: {},
  [RouteId.AzureListFiles]: {},
  [RouteId.AzureListFilesWithAgent]: {},
  [RouteId.AzureRetrieveFile]: {},
  [RouteId.AzureRetrieveFileWithAgent]: {},
  [RouteId.AzureFileContent]: {},
  [RouteId.AzureFileContentWithAgent]: {},
  [RouteId.AzureDeleteFile]: {},
  [RouteId.AzureDeleteFileWithAgent]: {},
  // Public, stateless APPA endpoint. Returns only an empty annotation.
  [RouteId.AnnotateGuardrailsTool]: {},
  [RouteId.GetOpenAppaPolicyTests]: { guardrailsPolicy: ["read"] },
  [RouteId.InspectOpenAppaPolicyTests]: { guardrailsPolicy: ["read"] },
  [RouteId.UpdateOpenAppaPolicyTests]: { guardrailsPolicy: ["update"] },
  [RouteId.RunOpenAppaPolicyTests]: { guardrailsPolicy: ["update"] },
  [RouteId.PreviewOpenAppaPolicyTest]: { guardrailsPolicy: ["update"] },
  [RouteId.GetOpenAppaPolicyTestRuns]: { guardrailsPolicy: ["read"] },
  [RouteId.GetGuardrailsPolicy]: { guardrailsPolicy: ["read"] },
  [RouteId.ValidateGuardrailsPolicy]: { guardrailsPolicy: ["read"] },
  [RouteId.UpdateGuardrailsPolicy]: { guardrailsPolicy: ["update"] },
  // Connecting an external agent, and inspecting a URL before connecting it,
  // needs Agent create, like building any other agent. The list and detail
  // reads need Agent read and return only the external agents the caller can
  // see. Run history needs the same: the caller must see that external agent,
  // and then gets its recent runs from everyone in the organization.
  // Each external agent's own permission policy decides who may change it.
  [RouteId.InspectA2aRemoteAgent]: { agent: ["create"] },
  [RouteId.ListA2aRemoteAgents]: { agent: ["read"] },
  [RouteId.GetA2aRemoteAgent]: { agent: ["read"] },
  [RouteId.ListA2aRemoteAgentRuns]: { agent: ["read"] },
  [RouteId.CreateA2aRemoteAgent]: { agent: ["create"] },
  [RouteId.UpdateA2aRemoteAgent]: { agent: ["read"] },
  [RouteId.DeleteA2aRemoteAgent]: { agent: ["read"] },

  /**
   * Getting basic info about the organization requires the user to be
   * authenticated but no specific permission.
   */
  [RouteId.GetOrganization]: {},

  // Agent Runtime belongs to Agents. Read access is enough to view
  // runs and manage one's own declared credentials; shared credential writes
  // additionally enforce Agent update + scope ownership inside the route.
  // Saved credentials: the routes below without a role action check the
  // caller's grant on the one credential they name.
  [RouteId.GetAgentRuntimePreflight]: {},
  [RouteId.GetClaudeCodeAccount]: {},
  [RouteId.StartClaudeCodeSignIn]: {},
  [RouteId.CompleteClaudeCodeSignIn]: {},
  [RouteId.DisconnectClaudeCodeAccount]: {},
  [RouteId.GetClaudeCodeModels]: {},
  [RouteId.SetAgentRuntimeCredential]: {},
  [RouteId.DeleteAgentRuntimeCredential]: {},
  [RouteId.ListRuntimeCredentials]: { credential: ["read"] },
  [RouteId.StartGitHubUserConnection]: {},
  [RouteId.CompleteGitHubUserConnection]: { credential: ["read"] },
  // A credential just for you is self-service; the route requires
  // credential:create for organization and shared ones.
  [RouteId.CreateRuntimeCredential]: {},
  [RouteId.GetRuntimeCredentialUsage]: {},
  [RouteId.UpdateRuntimeCredential]: {},
  [RouteId.DeleteRuntimeCredential]: {},
  [RouteId.SetPersonalRuntimeCredentialConnection]: {},
  [RouteId.DeletePersonalRuntimeCredentialConnection]: {},
  [RouteId.SetOrganizationRuntimeCredentialConnection]: {},
  [RouteId.DeleteOrganizationRuntimeCredentialConnection]: {},
  [RouteId.GetAgentRuns]: {},
  [RouteId.StartAgentRun]: {},
  [RouteId.GetMyAgentRuns]: {},
  [RouteId.GetMyAgentRun]: {},
  [RouteId.UpdateAgentRun]: {},
  [RouteId.CancelAgentRun]: {},
  [RouteId.ContinueAgentRun]: {},
  [RouteId.DeleteAgentWorkspace]: {},
  [RouteId.ReadAgentWorkspaceFile]: {},
  [RouteId.WriteAgentWorkspaceFile]: {},
  [RouteId.StartAgentWorkspaceTransfer]: {},
  // The content endpoints carry a transfer ticket instead of a session, so the
  // authnz layer exempts them. These entries keep the map exhaustive.
  [RouteId.DownloadAgentWorkspaceTransfer]: {},
  [RouteId.UploadAgentWorkspaceTransfer]: {},
  [RouteId.DeleteAgentRun]: {},
  // Completing onboarding flips an org-wide flag, so gate it on admin-level
  // organization-settings update, like the other org-settings routes.
  [RouteId.CompleteOnboarding]: { organizationSettings: ["update"] },

  // Connection setup: resource-level checks (mcpGateway/llmProxy read access,
  // skill admin) are conditional on what the setup includes and enforced in
  // the route handler. The script GET is public (token-authenticated).
  [RouteId.GetClientConnectionInstaller]: {},
  [RouteId.StartClientConnection]: {},
  [RouteId.PollClientConnection]: {},
  // Any signed-in user may review a request and approve their own setup.
  // The decision service verifies setup ownership and revalidates its scope.
  [RouteId.GetClientConnection]: {},
  [RouteId.DecideClientConnection]: {},
  [RouteId.CreateConnectionSetup]: {},
  // A signed-in member may start a short connection window for their own user.
  // Reports whether a pre-built VAF Add On package exists for this
  // installation, so the connector form can offer a download link that is
  // never a known 404. Reads nothing protected — the answer is the same for
  // every caller — so any authenticated member may ask.
  [RouteId.GetMfilesVafAddOnDistribution]: {},
  // Provisions a personal virtual key for the manual /connection flow. The
  // llmVirtualKey:create check is enforced in the handler (mirrors the
  // virtual-key branch of CreateConnectionSetup).
  [RouteId.CreateConnectionVirtualKey]: {},
  // Provisions a personal passthrough key for the manual /connection flow
  // (X-Archestra-Virtual-Key attribution). llmVirtualKey:create + llmProxy read
  // access are enforced in the handler.
  [RouteId.CreateConnectionPassthroughKey]: {},
  // A signed-in member lists and disconnects only their own connected clients.
  [RouteId.GetConnectedClients]: {},
  [RouteId.DisconnectConnectedClient]: {},
  // Who connected which agent is per-employee activity, so the org-wide log
  // of it takes org-wide log visibility (admin tier) plus reading members.
  [RouteId.GetConnectedClientLog]: { log: ["admin"], member: ["read"] },
  // The same per-employee activity, summarized per member.
  [RouteId.GetAgentAdoption]: { log: ["admin"], member: ["read"] },
  [RouteId.GetAgentAdoptionUsage]: { log: ["admin"], member: ["read"] },
  /**
   * Existence check for a connected remote, used by the Claude Code startup
   * guard on machines with no session. Returns only ok/missing.
   * Note: Auth is skipped in middleware for this route.
   */
  [RouteId.GetConnectionHealth]: {},
  [RouteId.RenderStartupGuard]: {},
  // Installation credential and live access are checked by the refresh handler.
  [RouteId.GetConnectionInstructions]: {},
  [RouteId.GetConnectionRuntime]: {},

  // Generic agent CRUD routes - enforcement is handled dynamically in route handlers
  // based on agentType (agent, mcp_gateway, llm_proxy map to agent, mcpGateway, llmProxy resources)
  [RouteId.GetAgents]: {},
  [RouteId.GetAgentCatalog]: {},
  [RouteId.GetAgentOptions]: {},
  [RouteId.GetAgentOptionsPage]: {},
  [RouteId.GetAgentOptionIds]: {},
  [RouteId.GetChatAgentRoster]: {},
  [RouteId.GetChatAgentRosterPage]: {},
  [RouteId.GetAgentCredentialReadiness]: {},
  [RouteId.GetAgent]: {},
  // Agent read access is checked in the handler (requireReadableAgent).
  [RouteId.GetAgentDefaultSuggestedPrompts]: {},
  // Agent type and instance visibility are dynamic and checked by PinAgent's
  // handler. Unpin is deliberately ungated beyond authentication so a stale
  // pin can be cleared after access is lost.
  [RouteId.PinAgent]: {},
  [RouteId.UnpinAgent]: {},
  [RouteId.CreateAgent]: {},
  [RouteId.CloneAgent]: {},
  // Ownership transfers on per-entry resources need update and
  // manage-permissions grants on the entry itself (authorizeOwnershipTransfer).
  [RouteId.TransferSkillOwnership]: {},
  [RouteId.TransferPluginOwnership]: { plugin: ["update"] },
  [RouteId.TransferProjectOwnership]: { project: ["update"] },
  [RouteId.TransferAppOwnership]: {},
  [RouteId.TransferMcpCatalogOwnership]: {},
  // The external agent's own permission policy decides who may transfer it.
  [RouteId.TransferRemoteAgentOwnership]: { agent: ["read"] },
  [RouteId.TransferAgentOwnership]: {},
  [RouteId.UpdateAgent]: {},
  [RouteId.BulkDeleteAgents]: {},
  [RouteId.DeleteAgent]: {},
  [RouteId.RestoreAgent]: {},
  [RouteId.PermanentlyDeleteAgent]: {},
  // Version history: agent-type read permission checked dynamically in handler
  [RouteId.GetAgentVersions]: {},
  [RouteId.GetAgentVersion]: {},
  [RouteId.RestoreAgentVersion]: {},
  // Export/Import: agent-type permission checked dynamically in handler
  [RouteId.ExportAgent]: {},
  [RouteId.ImportAgent]: {},
  // Tool previews/exclusions: agent-type read/update permission checked in handler
  [RouteId.GetAgentToolExclusions]: {},
  [RouteId.GetAgentMcpToolPreview]: {},
  [RouteId.UpdateAgentToolExclusions]: {},
  // Subagent (delegation-target) exclusions: agent-type read/update permission checked dynamically in handler
  [RouteId.GetAgentSubagentExclusions]: {},
  [RouteId.UpdateAgentSubagentExclusions]: {},
  // Knowledge-source exclusions (which knowledge connectors the agent's Auto
  // surface may search): agent-type read/update permission checked dynamically
  // in handler, on top of this floor. `knowledgeSource:read` is the floor
  // rather than `{}` because these routes name knowledge connectors by id —
  // the same disclosure the connector list endpoint gates on that permission.
  [RouteId.GetAgentKnowledgeSourceExclusions]: { knowledgeSource: ["read"] },
  [RouteId.UpdateAgentKnowledgeSourceExclusions]: { knowledgeSource: ["read"] },
  // Caller-relative skills an internal agent can activate. Agent-type
  // create/read/update permissions and environment checks are conditional and
  // stay in the route.
  [RouteId.GetAgentActivationSkills]: { skill: ["read"] },
  [RouteId.GetAgentActivationSkillPolicy]: { skill: ["read"] },
  [RouteId.PatchAgentActivationSkillPolicy]: { skill: ["read"] },
  // Skill assignments/exclusions (what the gateway publishes over skill://):
  // agent-type read/update permission checked dynamically in handler, on top
  // of this floor. `skill:read` is the floor rather than `{}` because these
  // routes both disclose skills (name, description, scope, author) and decide
  // which ones a gateway hands to every holder of its token — neither belongs
  // to a caller whose role was deliberately stripped of the skill resource.
  // Visibility of each named skill is checked per id in the assignment
  // service; this is the capability half, and both are load-bearing.
  [RouteId.GetAgentSkills]: { skill: ["read"] },
  [RouteId.UpdateAgentSkills]: { skill: ["read"] },
  [RouteId.GetAgentSkillExclusions]: { skill: ["read"] },
  [RouteId.UpdateAgentSkillExclusions]: { skill: ["read"] },
  [RouteId.GetDefaultMcpGateway]: {
    mcpGateway: ["read"],
  },
  [RouteId.GetLlmProxy]: {
    llmProxy: ["read"],
  },
  [RouteId.UpdateLlmProxy]: {
    llmProxy: ["update"],
  },
  // Agent-tool routes: agent-type and scope checks are handled dynamically in the route handlers
  [RouteId.GetAgentTools]: {},
  [RouteId.GetAllAgentTools]: {},
  [RouteId.GetAgentAvailableTokens]: {},
  // Tool-assignment routes: agent-type update checked dynamically in handler
  [RouteId.AssignToolToAgent]: {},
  [RouteId.BulkAssignTools]: {},
  [RouteId.BulkUpdateAgentTools]: {},
  [RouteId.UnassignToolFromAgent]: {},
  [RouteId.UpdateAgentTool]: {},
  // Labels are cross-type — any agent-type read permission suffices (checked in handler)
  [RouteId.GetLabelKeys]: {},
  [RouteId.GetLabelValues]: {},
  [RouteId.GetTools]: {
    mcpRegistry: ["read"],
  },
  [RouteId.GetToolsWithAssignments]: {
    mcpRegistry: ["read"],
  },
  [RouteId.GetInteractions]: {
    log: ["read"],
  },
  [RouteId.GetInteractionSummaries]: {
    log: ["read"],
  },
  [RouteId.GetInteraction]: {
    log: ["read"],
  },
  [RouteId.GetUniqueExternalAgentIds]: {
    log: ["read"],
  },
  [RouteId.GetUniqueUserIds]: {
    log: ["read"],
  },
  [RouteId.GetInteractionSessions]: {
    log: ["read"],
  },
  [RouteId.GetInteractionSessionLineage]: {
    log: ["read"],
  },
  [RouteId.GetInternalMcpCatalog]: {},
  // Like the full list: the handlers read only what the caller may list.
  [RouteId.SearchMcpRegistry]: {},
  [RouteId.SearchMcpRegistryIds]: {},
  [RouteId.GetMcpRegistryIssueIndex]: {},
  [RouteId.GetInternalMcpCatalogIcon]: {},
  [RouteId.CreateInternalMcpCatalogItem]: {
    mcpRegistry: ["create"],
  },
  [RouteId.GetInternalMcpCatalogItem]: {},
  [RouteId.GetInternalMcpCatalogCredentialPreflight]: {},
  [RouteId.GetInternalMcpCatalogTools]: {},
  [RouteId.GetInternalMcpCatalogToolsBatch]: {},
  // These handlers authorize the action against the resolved catalog object.
  // A global action gate would incorrectly reject object-specific grants.
  [RouteId.UpdateInternalMcpCatalogItem]: {},
  [RouteId.ReinstallInternalMcpCatalogItem]: {},
  [RouteId.RefreshInternalMcpCatalogImage]: {},
  [RouteId.DeleteInternalMcpCatalogItem]: {},
  [RouteId.DeleteInternalMcpCatalogItemByName]: {},
  [RouteId.RestoreInternalMcpCatalogItem]: {},
  [RouteId.GetInternalMcpCatalogLabelKeys]: {
    mcpRegistry: ["read"],
  },
  [RouteId.GetInternalMcpCatalogLabelValues]: {
    mcpRegistry: ["read"],
  },
  // Both handlers further require `update` on every registry entry (a grant
  // at `*`), which is what the retired installation admin action became.
  [RouteId.ListPendingImageApprovalCatalogItems]: {
    mcpServerInstallation: ["update"],
  },
  [RouteId.ApproveCatalogItemImage]: {
    mcpServerInstallation: ["update"],
  },
  [RouteId.GetDeploymentYamlPreview]: {
    mcpRegistry: ["read"],
  },
  [RouteId.ValidateDeploymentYaml]: { mcpRegistry: ["read"] },
  // Like preview and validate: the handler requires configure-deployment-spec
  // on the entry itself.
  [RouteId.ResetDeploymentYaml]: { mcpRegistry: ["read"] },
  [RouteId.GetK8sImagePullSecrets]: {
    mcpRegistry: ["read"],
  },
  [RouteId.GetMcpServers]: {
    mcpServerInstallation: ["read"],
  },
  [RouteId.GetMcpServerAutoModeAgentPage]: {
    mcpServerInstallation: ["read"],
  },
  [RouteId.GetMcpServerAutoModeAgents]: {
    mcpServerInstallation: ["read"],
  },
  [RouteId.GetMcpServer]: {
    mcpServerInstallation: ["read"],
  },
  [RouteId.GetMcpServerTools]: {
    mcpServerInstallation: ["read"],
  },
  [RouteId.InspectMcpServer]: {
    mcpServerInstallation: ["read"],
  },
  [RouteId.InstallMcpServer]: {
    mcpServerInstallation: ["create"],
  },
  [RouteId.BulkDeleteMcpServers]: { mcpServerInstallation: ["delete"] },
  [RouteId.DeleteMcpServer]: {
    mcpServerInstallation: ["delete"],
  },
  [RouteId.RestoreMcpServer]: {
    mcpServerInstallation: ["delete"],
  },
  [RouteId.ReauthenticateMcpServer]: {
    // Re-authentication re-supplies credentials for a connection the caller can
    // already install, so it is gated like installation (:create), not :update.
    // Installation admin subsumes CRUD through the shared permission hierarchy;
    // the handler then applies ownership/team scope rules to non-admins.
    mcpServerInstallation: ["create"],
  },
  [RouteId.ReinstallMcpServer]: {
    // Reinstall uses the same create-or-installation-admin hierarchy as
    // re-authentication, followed by the same scope-aware lifecycle check.
    mcpServerInstallation: ["create"],
  },
  [RouteId.HardResetMcpServer]: {
    // The recovery escape hatch for a wedged deployment: it destroys and
    // recreates the pod for EVERY install sharing it, so the handler further
    // requires `update` on every registry entry (a grant at `*`) rather than
    // the per-connection rules the other lifecycle routes use. A connection's
    // own owner must not be able to reset a shared multitenant deployment out
    // from under the other installs on it.
    mcpServerInstallation: ["update"],
  },
  [RouteId.ReloadMcpServerTools]: {
    // Reloading tools is a strict subset of reinstalling, so it is gated and
    // scope-checked identically.
    mcpServerInstallation: ["create"],
  },
  [RouteId.GetMcpServerInstallationStatus]: {
    mcpServerInstallation: ["read"],
  },
  // Muting is a per-viewer display preference: it hides an alert from the
  // caller's own registry and from nobody else's, so it is gated on the same
  // :read that let them see the connection in the first place. The handler
  // re-checks visibility of the specific install.
  [RouteId.MuteMcpServerAlert]: {
    mcpServerInstallation: ["read"],
  },
  [RouteId.UnmuteMcpServerAlert]: {
    mcpServerInstallation: ["read"],
  },
  [RouteId.MuteMcpCatalogAlert]: {
    mcpRegistry: ["read"],
  },
  [RouteId.UnmuteMcpCatalogAlert]: {
    mcpRegistry: ["read"],
  },
  [RouteId.InitiateOAuth]: {
    mcpServerInstallation: ["create"],
  },
  [RouteId.HandleOAuthCallback]: {
    mcpServerInstallation: ["create"],
  },
  [RouteId.GetTeams]: {
    team: ["read"],
  },
  [RouteId.GetTeam]: {
    team: ["read"],
  },
  [RouteId.CreateTeam]: {
    team: ["create"],
  },
  // The handler accepts organization team managers or this team's own admins.
  [RouteId.UpdateTeam]: {},
  [RouteId.BulkDeleteTeams]: { team: ["delete"] },
  [RouteId.DeleteTeam]: {
    team: ["delete"],
  },
  [RouteId.GetTeamMembers]: {
    team: ["read"],
  },
  [RouteId.GetTeamMembersPage]: {
    team: ["read"],
  },
  [RouteId.AddTeamMember]: {
    team: ["read"],
  },
  [RouteId.UpdateTeamMember]: {
    team: ["read"],
  },
  [RouteId.RemoveTeamMember]: {
    team: ["read"],
  },
  [RouteId.GetTeamLabelKeys]: {
    team: ["read"],
  },
  [RouteId.GetTeamLabelValues]: {
    team: ["read"],
  },
  // Team External Group Routes (SSO Team Sync) - requires team admin permission
  [RouteId.GetTeamExternalGroups]: {
    team: ["read"],
  },
  [RouteId.AddTeamExternalGroup]: {
    team: ["read"],
  },
  [RouteId.RemoveTeamExternalGroup]: {
    team: ["read"],
  },
  // Team Vault Folder Routes (BYOS - Bring Your Own Secrets)
  // Note: Route handlers check team membership for non-admin users
  [RouteId.GetTeamVaultFolder]: {
    team: ["read"],
  },
  [RouteId.SetTeamVaultFolder]: {
    team: ["update"],
  },
  [RouteId.DeleteTeamVaultFolder]: {
    team: ["update"],
  },
  [RouteId.CheckTeamVaultFolderConnectivity]: {
    team: ["update"],
  },
  [RouteId.ListTeamVaultFolderSecrets]: {
    team: ["read"],
  },
  [RouteId.GetTeamVaultSecretKeys]: {
    team: ["read"],
  },
  // Resource actions and delegation authority are checked against the target.
  [RouteId.SearchInitialPermissionSubjects]: {},
  [RouteId.GetScopedCapabilities]: {},
  [RouteId.GetResourcePermissions]: {},
  [RouteId.SearchResourcePermissionSubjects]: {},
  [RouteId.UpdateResourcePermissions]: {},
  [RouteId.GetRoles]: {
    ac: ["read"],
  },
  [RouteId.CreateRole]: {
    ac: ["create"],
  },
  [RouteId.GetRole]: {
    ac: ["read"],
  },
  [RouteId.UpdateRole]: {
    ac: ["update"],
  },
  [RouteId.BulkDeleteRoles]: { ac: ["delete"] },
  [RouteId.DeleteRole]: {
    ac: ["delete"],
  },
  [RouteId.GetMcpToolCalls]: {
    log: ["read"],
  },
  [RouteId.GetMcpToolCall]: {
    log: ["read"],
  },
  [RouteId.StreamChat]: {
    chat: ["read"],
  },
  [RouteId.ResolveChatMcpElicitation]: {
    chat: ["read"],
  },
  [RouteId.StopChatStream]: {
    chat: ["read"],
  },
  [RouteId.CancelChatMcpTask]: {
    chat: ["read"],
  },
  [RouteId.GetActiveChatRun]: {
    chat: ["read"],
  },
  [RouteId.GetChatConversations]: {
    chat: ["read"],
  },
  // Listing soft-deleted conversations (the "Trash" view) is gated on delete,
  // not read: seeing which chats were trashed is part of the delete/restore
  // lifecycle, so a chat:read-only role sees active chats but not the trash.
  [RouteId.GetDeletedChatConversations]: {
    chat: ["delete"],
  },
  [RouteId.GetChatConversation]: {
    chat: ["read"],
  },
  [RouteId.GetChatOpenappaStatus]: {
    chat: ["read"],
  },
  [RouteId.GetChatConversationFiles]: {
    chat: ["read"],
  },
  [RouteId.GetChatAttachmentContent]: {
    chat: ["read"],
  },
  [RouteId.DeleteChatAttachment]: {
    chat: ["update"],
  },
  [RouteId.GetChatAgentMcpTools]: {},
  [RouteId.CreateChatConversation]: {
    chat: ["create"],
  },
  [RouteId.ForkChatConversation]: {
    chat: ["create"],
  },
  [RouteId.UpdateChatConversation]: {
    chat: ["update"],
  },
  // Coarse gate only; the handler further requires agent-type admin to flip
  // the per-conversation hook debug flag.
  [RouteId.SetConversationHooksDebug]: {
    chat: ["update"],
  },
  // Marking your own conversation read clears its sidebar new-messages dot —
  // a chat-state edit, same gate as the other conversation mutations.
  [RouteId.MarkChatConversationRead]: {
    chat: ["update"],
  },
  [RouteId.DeleteChatConversation]: {
    chat: ["delete"],
  },
  // Restore is the inverse of delete — same gate.
  [RouteId.RestoreChatConversation]: {
    chat: ["delete"],
  },
  // Clearing a conversation's recorded chat errors is a chat-content edit, not a
  // conversation deletion — same gate as compact / message edit.
  [RouteId.ClearChatConversationErrors]: {
    chat: ["update"],
  },
  [RouteId.CompactChatConversation]: {
    chat: ["update"],
  },
  [RouteId.GenerateChatConversationTitle]: {
    chat: ["update"],
  },
  [RouteId.GetChatMcpTools]: {
    chat: ["read"],
  },
  [RouteId.GetLlmModels]: {},
  [RouteId.GetModelPools]: { llmModel: ["read"] },
  [RouteId.CreateModelPool]: { llmModel: ["update"] },
  [RouteId.UpdateModelPool]: { llmModel: ["update"] },
  [RouteId.DeleteModelPool]: { llmModel: ["update"] },
  [RouteId.GetLlmProviderModelLabelKeys]: { llmModel: ["read"] },
  [RouteId.GetLlmProviderModelLabelValues]: { llmModel: ["read"] },
  [RouteId.SyncLlmModels]: {
    llmModel: ["update"],
  },
  [RouteId.UpdateChatMessage]: {
    chat: ["update"],
  },
  [RouteId.SetChatMessageFeedback]: {
    chat: ["update"],
  },
  [RouteId.GetConversationEnabledTools]: {
    chat: ["read"],
  },
  [RouteId.UpdateConversationEnabledTools]: {
    chat: ["update"],
  },
  [RouteId.DeleteConversationEnabledTools]: {
    chat: ["update"],
  },
  [RouteId.GetLlmProviderApiKeys]: {},
  [RouteId.GetLlmProviderApiKeyLabelKeys]: { llmProviderApiKey: ["read"] },
  [RouteId.GetLlmProviderApiKeyLabelValues]: { llmProviderApiKey: ["read"] },
  [RouteId.GetAvailableLlmProviderApiKeys]: {
    llmProviderApiKey: ["read"],
  },
  // Personal-scoped keys are self-service (any authenticated user can connect
  // their own account / create a key only they can use); the handler requires
  // llmProviderApiKey:create for team scope and :admin for org scope. Gating
  // the route on :create would block "basic users" from linking their own
  // GitHub Copilot account.
  [RouteId.CreateLlmProviderApiKey]: {},
  // Device-flow sign-in exists solely to obtain the GitHub token for a new
  // personal github-copilot key, so it's self-service like the create route.
  [RouteId.GithubCopilotDeviceAuthStart]: {},
  [RouteId.GithubCopilotDeviceAuthPoll]: {},
  // Same self-service rationale for Microsoft 365 Copilot's Entra device flow.
  [RouteId.Microsoft365CopilotDeviceAuthStart]: {},
  [RouteId.Microsoft365CopilotDeviceAuthPoll]: {},
  // Same self-service rationale for the ChatGPT/Codex subscription device flow:
  // it only obtains the caller's own OAuth credential for a new personal
  // OpenAI (ChatGPT subscription) key.
  [RouteId.OpenaiCodexDeviceAuthStart]: {},
  [RouteId.OpenaiCodexDeviceAuthPoll]: {},
  // Same self-service rationale for the SuperGrok device flow: it
  // only obtains the caller's own OAuth credential for a new personal xAI
  // (SuperGrok subscription) key.
  [RouteId.XaiSubscriptionDeviceAuthStart]: {},
  [RouteId.XaiSubscriptionDeviceAuthPoll]: {},
  [RouteId.GetLlmProviderApiKey]: {},
  [RouteId.UpdateLlmProviderApiKey]: {},
  // Self-service like the create route and the device flows: reconnecting your
  // OWN personal subscription key after its sign-in expires must not require
  // llmProviderApiKey:update, or default members complete the device flow and
  // then can't save the refreshed credential. The handler restricts it to the
  // caller's own personal key holding subscription material.
  [RouteId.ReconnectLlmProviderApiKey]: {},
  [RouteId.DeleteLlmProviderApiKey]: {},
  [RouteId.BulkDeleteLlmProviderApiKeys]: {},
  [RouteId.GetApiKeys]: {
    apiKey: ["read"],
  },
  [RouteId.GetApiKey]: {
    apiKey: ["read"],
  },
  [RouteId.CreateApiKey]: {
    apiKey: ["create"],
  },
  [RouteId.BulkDeleteApiKeys]: { apiKey: ["delete"] },
  [RouteId.DeleteApiKey]: {
    apiKey: ["delete"],
  },
  // Which service accounts a caller reaches, and what they may do to each, is
  // a grant on the account itself now, so these carry no resource-wide action
  // and the handlers ask `ResourcePermissions`. Creating one still does: there
  // is no object to hold a grant yet, and minting an account is the act that
  // decides who its first grants name.
  [RouteId.GetServiceAccounts]: {},
  [RouteId.GetServiceAccountLabelKeys]: { serviceAccount: ["read"] },
  [RouteId.GetServiceAccountLabelValues]: { serviceAccount: ["read"] },
  [RouteId.GetServiceAccount]: {},
  [RouteId.CreateServiceAccount]: {
    serviceAccount: ["create"],
  },
  [RouteId.UpdateServiceAccount]: {},
  [RouteId.BulkDeleteServiceAccounts]: {},
  [RouteId.BulkSetServiceAccountsDisabled]: {},
  [RouteId.DeleteServiceAccount]: {},
  // A key authenticates as the account with the account's full role set, so
  // minting, renaming or revoking one is editing the account.
  [RouteId.CreateServiceAccountToken]: {},
  [RouteId.UpdateServiceAccountToken]: {},
  [RouteId.DeleteServiceAccountToken]: {},
  [RouteId.GetAllVirtualApiKeys]: {},
  [RouteId.GetVirtualApiKeyLabelKeys]: { llmVirtualKey: ["read"] },
  [RouteId.GetVirtualApiKeyLabelValues]: { llmVirtualKey: ["read"] },
  [RouteId.GetVirtualApiKey]: {},
  // Reveals the raw key value; restricted to the key's author in the handler.
  [RouteId.GetVirtualApiKeyValue]: {},
  [RouteId.CreateVirtualApiKey]: {
    llmVirtualKey: ["create"],
  },
  [RouteId.UpdateVirtualApiKey]: {},
  [RouteId.DeleteVirtualApiKey]: {},
  [RouteId.BulkDeleteVirtualApiKeys]: {},
  // Which OAuth clients a caller reaches, and what they may do to each, is a
  // grant on the client. Creating one still takes the role action: there is
  // no client to hold a grant yet.
  [RouteId.GetOauthClients]: {},
  [RouteId.GetOauthClientLabelKeys]: { oauthClient: ["read"] },
  [RouteId.GetOauthClientLabelValues]: { oauthClient: ["read"] },
  [RouteId.CreateOauthClient]: { oauthClient: ["create"] },
  [RouteId.UpdateOauthClient]: {},
  [RouteId.RotateOauthClientSecret]: {},
  [RouteId.DeleteOauthClient]: {},
  [RouteId.BulkDeleteOauthClients]: {},
  [RouteId.GetLlmOauthClients]: {},
  [RouteId.GetLlmOauthClientLabelKeys]: { oauthClient: ["read"] },
  [RouteId.GetLlmOauthClientLabelValues]: { oauthClient: ["read"] },
  [RouteId.CreateLlmOauthClient]: {
    oauthClient: ["create"],
  },
  [RouteId.UpdateLlmOauthClient]: {},
  [RouteId.RotateLlmOauthClientSecret]: {},
  [RouteId.DeleteLlmOauthClient]: {},
  [RouteId.BulkDeleteLlmOauthClients]: {},
  [RouteId.GetMcpOauthClients]: {},
  [RouteId.GetMcpOauthClientLabelKeys]: { oauthClient: ["read"] },
  [RouteId.GetMcpOauthClientLabelValues]: { oauthClient: ["read"] },
  [RouteId.CreateMcpOauthClient]: {
    oauthClient: ["create"],
  },
  [RouteId.UpdateMcpOauthClient]: {},
  [RouteId.RotateMcpOauthClientSecret]: {},
  [RouteId.DeleteMcpOauthClient]: {},
  [RouteId.GetModelsWithApiKeys]: {},
  [RouteId.GetLlmModelIdsByKey]: {},
  [RouteId.GetLlmModelOptions]: {},
  [RouteId.BulkUpdateModels]: {},
  [RouteId.UpdateModel]: {},
  // Delegation routes: agent-type permission checked dynamically in handler
  [RouteId.GetAgentDelegations]: {},
  [RouteId.SyncAgentDelegations]: {},
  [RouteId.CreateAgentDelegation]: {},
  [RouteId.DeleteAgentDelegation]: {},
  [RouteId.GetAgentA2aDelegations]: {},
  [RouteId.SyncAgentA2aDelegations]: {},
  [RouteId.GetAllDelegationConnections]: {},
  [RouteId.GetLimits]: {
    llmLimit: ["read"],
  },
  [RouteId.GetLimitLabelKeys]: { llmLimit: ["read"] },
  [RouteId.GetLimitLabelValues]: { llmLimit: ["read"] },
  [RouteId.CreateLimit]: {
    llmLimit: ["create"],
  },
  [RouteId.GetLimit]: {
    llmLimit: ["read"],
  },
  [RouteId.UpdateLimit]: {
    llmLimit: ["update"],
  },
  [RouteId.DeleteLimit]: {
    llmLimit: ["delete"],
  },
  [RouteId.BulkDeleteLimits]: {
    llmLimit: ["delete"],
  },
  [RouteId.ListDefaultUserLimits]: {
    llmLimit: ["read"],
  },
  [RouteId.CreateDefaultUserLimit]: {
    llmLimit: ["create"],
  },
  [RouteId.UpdateDefaultUserLimit]: {
    llmLimit: ["update"],
  },
  [RouteId.ListUserLimitUsage]: {
    llmLimit: ["read"],
  },
  [RouteId.ResetUserLimitUsage]: {
    llmLimit: ["update"],
  },
  [RouteId.DeleteDefaultUserLimit]: {
    llmLimit: ["delete"],
  },
  [RouteId.UpdateAppearanceSettings]: {
    organizationSettings: ["update"],
  },
  [RouteId.UpdateSecuritySettings]: {
    organizationSettings: ["update"],
  },
  [RouteId.UpdateMcpSettings]: {
    organizationSettings: ["update"],
  },
  [RouteId.UpdateSkillsSettings]: {
    organizationSettings: ["update"],
  },
  [RouteId.UpdateAgentSettings]: {
    organizationSettings: ["update"],
  },
  [RouteId.UpdateAuthSettings]: {
    organizationSettings: ["update"],
  },
  [RouteId.UpdateConnectionSettings]: {
    organizationSettings: ["update"],
  },
  [RouteId.UpdateIntegrationSettings]: {
    organizationSettings: ["update"],
  },
  // Listing environments is available to any authenticated user (read is ungated).
  [RouteId.ListEnvironments]: {
    environment: ["read"],
  },
  [RouteId.GetEnvironment]: { environment: ["read"] },
  [RouteId.GetEnvironmentLabelKeys]: { environment: ["read"] },
  [RouteId.GetEnvironmentLabelValues]: { environment: ["read"] },
  [RouteId.CreateEnvironment]: {
    environment: ["create"],
  },
  [RouteId.UpdateEnvironment]: {
    environment: ["update"],
  },
  [RouteId.BulkDeleteEnvironments]: { environment: ["delete"] },
  [RouteId.DeleteEnvironment]: {
    environment: ["delete"],
  },
  [RouteId.UpdateDefaultEnvironment]: {
    environment: ["update"],
  },
  [RouteId.UpdateEnvironmentResourceDefaults]: {
    environment: ["update"],
  },
  [RouteId.GetK8sCapabilities]: {
    environment: ["update"],
  },
  [RouteId.ListGithubAppConfigs]: {
    credential: ["read"],
  },
  [RouteId.GetGithubAppConfig]: {},
  [RouteId.CreateGithubAppConfig]: {
    credential: ["create"],
  },
  [RouteId.UpdateGithubAppConfig]: {},
  [RouteId.DeleteGithubAppConfig]: {},
  // stored PATs share the githubAppConfig resource: both are org GitHub
  // credentials managed on the same settings page by the same audience
  [RouteId.ListGitCredentials]: {
    credential: ["read"],
  },
  [RouteId.CreateGitlabToken]: {
    credential: ["create"],
  },
  [RouteId.ListGitCredentialRepositories]: {
    credential: ["read"],
  },
  [RouteId.ListGitCredentialNamespaces]: {
    credential: ["read"],
  },
  [RouteId.ListGithubPats]: {
    credential: ["read"],
  },
  [RouteId.CreateGithubPat]: {
    credential: ["create"],
  },
  [RouteId.UpdateGithubPat]: {},
  [RouteId.DeleteGithubPat]: {},
  [RouteId.UpdateKnowledgeSettings]: {
    organizationSettings: ["update"],
  },
  [RouteId.DropEmbeddingConfig]: {
    organizationSettings: ["update"],
  },
  [RouteId.TestEmbeddingConnection]: {
    organizationSettings: ["update"],
  },
  [RouteId.TestRerankerConnection]: {
    organizationSettings: ["update"],
  },
  [RouteId.TestOcrConnection]: {
    organizationSettings: ["update"],
  },
  [RouteId.GetKeywordRankingStatus]: {
    organizationSettings: ["read"],
  },

  /**
   * Get public identity providers route (minimal info for login page)
   * Available to unauthenticated users - only returns providerId, no secrets
   * Note: Auth is skipped in middleware for this route
   */
  [RouteId.GetPublicIdentityProviders]: {},
  /**
   * Get public config for login and invitation UI
   * Available to unauthenticated users
   * Note: Auth is skipped in middleware for this route
   */
  [RouteId.GetPublicConfig]: {},
  /**
   * Ingest product-usage (RUM) events from the web client.
   * Any authenticated user — every signed-in browser session reports usage.
   */
  [RouteId.IngestRumEvents]: {},
  // Public: reports only whether a two-factor sign-in challenge is pending,
  // so the auth pages can redirect when they don't apply. Auth is skipped in
  // middleware for this path.
  [RouteId.GetAuthState]: {},
  [RouteId.BulkRevokeSessions]: {},
  /**
   * Get public appearance settings (theme, logo, font) for login page
   * Available to unauthenticated users
   * Note: Auth is skipped in middleware for this route
   */
  [RouteId.GetAppearanceSettings]: {},
  /**
   * Get all identity providers with full config (admin only)
   * Returns sensitive data including client secrets
   */
  [RouteId.GetIdentityProviders]: {
    identityProvider: ["read"],
  },
  // Minimal projection (id, name, groups expression) for the team External
  // Group Sync section: team admins link groups to their team without holding
  // identityProvider:read. No configuration or secrets are exposed.
  [RouteId.GetIdentityProviderTeamSyncOptions]: {
    team: ["read"],
  },
  [RouteId.GetIdentityProvider]: {
    identityProvider: ["read"],
  },
  // Returns only the CALLER'S own decoded token claims (never another user's,
  // never provider configuration), so team admins can find their group value
  // while configuring external group sync.
  [RouteId.GetIdentityProviderLatestIdTokenClaims]: {
    team: ["read"],
  },
  // Installers need to know whether they must link a downstream IdP, but this
  // endpoint does not expose identity-provider configuration or secrets.
  [RouteId.GetIdentityProviderLinkStatus]: {
    mcpServerInstallation: ["create"],
  },
  [RouteId.CreateIdentityProvider]: {
    identityProvider: ["create"],
  },
  [RouteId.UpdateIdentityProvider]: {
    identityProvider: ["update"],
  },
  [RouteId.DeleteIdentityProvider]: {
    identityProvider: ["delete"],
  },
  [RouteId.GetIdentityProviderIdpLogoutUrl]: {},

  [RouteId.GetOnboardingStatus]: {}, // Onboarding status route - available to all authenticated users (no specific permissions required)
  [RouteId.GetOnboardingSeenNavItems]: {}, // Per-user onboarding red-dot state - available to all authenticated users
  [RouteId.MarkOnboardingNavItemsSeen]: {}, // Per-user onboarding red-dot state - available to all authenticated users
  [RouteId.GetOnboardingSurveyEligibility]: {
    organizationSettings: ["update"],
  }, // First-login survey - admins only (same gate as appearance settings)
  [RouteId.SubmitOnboardingSurvey]: { organizationSettings: ["update"] }, // First-login survey - admins only
  [RouteId.GetMemberSignupStatus]: {}, // Member signup status - available to all authenticated users
  [RouteId.GetMembers]: { member: ["read"] }, // List organization members (paginated)
  [RouteId.BulkDeleteMembers]: { member: ["delete"] },
  // Visibility is scoped in the handler: member:read sees every member,
  // everyone else only the users they share a team with, so the route itself
  // is open to any authenticated user.
  [RouteId.GetOrganizationMemberOptions]: {},
  [RouteId.GetOrganizationMember]: { member: ["read"] }, // Get organization member by ID or email
  [RouteId.DeletePendingSignupMember]: { member: ["delete"] }, // Delete auto-provisioned member who hasn't signed up
  [RouteId.GetUserPermissionSources]: {},
  [RouteId.GetUserPermissions]: {}, // User permissions route - available to all authenticated users (no specific permissions required)
  // Other members' saved browser logins: managing someone else's sessions is a
  // member-management action, so admins only
  [RouteId.GetBrowserStorageStates]: { member: ["update"] },
  [RouteId.DeleteBrowserStorageState]: { member: ["update"] },
  [RouteId.GetImpersonableUsers]: { member: ["impersonate"] }, // Role debugger picker (the impersonate-user call itself is also gated on member:impersonate in the auth before-hook)

  // Member default routes - available to all authenticated users (manages their own defaults)
  [RouteId.GetMemberDefaultAgent]: {},
  [RouteId.UpdateMemberDefaultAgent]: {},

  // User token routes - available to all authenticated users (manages their own personal token)
  [RouteId.GetUserToken]: {},
  [RouteId.GetUserTokenValue]: {},
  [RouteId.RotateUserToken]: {},
  [RouteId.GetTeamStatistics]: {
    llmCost: ["read"],
  },
  [RouteId.GetProxyCostStatistics]: { llmCost: ["read"] },
  [RouteId.GetAgentStatistics]: {
    llmCost: ["read"],
  },
  [RouteId.GetModelStatistics]: {
    llmCost: ["read"],
  },
  // Per-user usage is employee-level data, so the route additionally checks
  // `member:read` at request time: callers without it see only their own usage
  // rather than the whole org (see the GetUserStatistics handler).
  [RouteId.GetUserStatistics]: {
    llmCost: ["read"],
  },
  // Deliberately open to any authenticated user: it reports only the caller's
  // own usage, so it needs no permission over other people's data. This is what
  // keeps the Costs page useful to someone without `llmCost:read`, who sees the
  // personal summary and none of the organization-wide charts.
  [RouteId.GetMyStatistics]: {},
  // Open for the same reason as GetMyStatistics: it explains the caller's own
  // usage and names no one else's activity, no agent they cannot see, and no
  // organization total.
  [RouteId.GetMyUsageBreakdown]: {},
  // Per-app and per-skill cost additionally narrow to what the caller can see:
  // the routes resolve the same visibility the Apps page and the skills list use,
  // so cost reporting never lists an app or skill the caller has no access to.
  [RouteId.GetAppStatistics]: {
    llmCost: ["read"],
    app: ["read"],
  },
  [RouteId.GetSkillStatistics]: {
    llmCost: ["read"],
    skill: ["read"],
  },
  [RouteId.GetOverviewStatistics]: {
    llmCost: ["read"],
  },
  [RouteId.GetCostStatistics]: {
    llmCost: ["read"],
  },
  [RouteId.GetCostSavingsStatistics]: {
    llmCost: ["read"],
  },
  // Grouped usage reporting. Like GetUserStatistics, the routes additionally
  // require member:read before returning anyone else's usage, and app/skill
  // usage narrow to the apps and skills the caller can see.
  [RouteId.GetMcpToolCallUsage]: {
    llmCost: ["read"],
  },
  [RouteId.GetAppUsage]: {
    llmCost: ["read"],
    app: ["read"],
  },
  [RouteId.GetSkillUsage]: {
    llmCost: ["read"],
    skill: ["read"],
  },
  // Secrets Routes
  [RouteId.GetSecretsType]: {
    organizationSettings: ["read"],
  },
  [RouteId.CheckSecretsConnectivity]: {
    organizationSettings: ["update"],
  },
  // Only returns Vault references (never values), for prefilling the MCP
  // catalog form in BYOS mode. The handler requires an update grant on the
  // registry entry whose configuration the secret is.
  [RouteId.GetSecret]: {},

  // Incoming Email Routes
  [RouteId.GetIncomingEmailStatus]: {
    organizationSettings: ["read"],
  },
  [RouteId.SetupIncomingEmailWebhook]: {
    organizationSettings: ["update"],
  },
  [RouteId.RenewIncomingEmailSubscription]: {
    organizationSettings: ["update"],
  },
  [RouteId.DeleteIncomingEmailSubscription]: {
    organizationSettings: ["update"],
  },
  [RouteId.GetAgentEmailAddress]: {}, // Any authenticated user can view agent email addresses

  // ChatOps Routes
  [RouteId.GetChatOpsStatus]: {
    organizationSettings: ["read"],
  },
  [RouteId.ListChatOpsBindings]: {
    organizationSettings: ["read"],
  },
  [RouteId.DeleteChatOpsBinding]: {
    organizationSettings: ["update"],
  },
  [RouteId.UpdateChatOpsBinding]: {
    organizationSettings: ["update"],
  },
  [RouteId.BulkUpdateChatOpsBindings]: {
    organizationSettings: ["update"],
  },
  [RouteId.ApplyChatOpsBindingPlan]: {
    agent: ["read"],
    organizationSettings: ["update"],
  },
  [RouteId.CreateChatOpsDmBinding]: {
    organizationSettings: ["update"],
  },
  [RouteId.UpdateChatOpsConfigInQuickstart]: {
    organizationSettings: ["update"],
  },
  [RouteId.UpdateSlackChatOpsConfig]: {
    organizationSettings: ["update"],
  },
  // Config reads return no secret, only what GetChatOpsStatus shows at read.
  [RouteId.GetSlackChatOpsConfig]: {
    organizationSettings: ["read"],
  },
  [RouteId.GetMsTeamsChatOpsConfig]: {
    organizationSettings: ["read"],
  },
  [RouteId.ListSlackAgentBots]: {
    organizationSettings: ["read"],
  },
  [RouteId.UpdateSlackAgentBot]: {
    organizationSettings: ["update"],
  },
  [RouteId.DeleteSlackAgentBot]: {
    organizationSettings: ["update"],
  },
  [RouteId.UpdateSlackAppConfigToken]: {
    organizationSettings: ["update"],
  },
  [RouteId.CreateSlackAgentBotApp]: {
    organizationSettings: ["update"],
  },
  [RouteId.CreateSlackRouterBotApp]: {
    organizationSettings: ["update"],
  },
  [RouteId.MigrateSlackApps]: {
    organizationSettings: ["update"],
  },
  [RouteId.ConvertSlackAppToAgentBot]: {
    organizationSettings: ["update"],
  },
  [RouteId.ListSlackAgentBotChannels]: {
    organizationSettings: ["read"],
  },
  [RouteId.JoinSlackAgentBotChannel]: {
    organizationSettings: ["update"],
  },
  [RouteId.ListSlackRouterBotChannels]: {
    organizationSettings: ["read"],
  },
  [RouteId.JoinSlackRouterBotChannel]: {
    organizationSettings: ["update"],
  },
  [RouteId.UpdateTelegramChatOpsConfig]: {
    organizationSettings: ["update"],
  },
  [RouteId.GetTelegramChatOpsConfig]: {
    organizationSettings: ["read"],
  },
  // Any authenticated user can link or unlink their own Telegram account
  [RouteId.LinkTelegramChatOpsAccount]: {},
  [RouteId.UnlinkTelegramChatOpsAccount]: {},
  [RouteId.GenerateTelegramLinkCode]: {},
  [RouteId.ConnectNgrok]: {
    organizationSettings: ["update"],
  },
  [RouteId.DisconnectNgrok]: {
    organizationSettings: ["update"],
  },
  [RouteId.GetNgrokConfig]: {
    organizationSettings: ["read"],
  },
  [RouteId.RefreshChatOpsChannelDiscovery]: {
    organizationSettings: ["read"],
  },
  // Schedule Trigger Routes
  [RouteId.GetScheduleTriggers]: {
    project: ["read"],
  },
  [RouteId.CreateScheduleTrigger]: {
    project: ["create"],
  },
  [RouteId.GetScheduleTrigger]: {
    project: ["read"],
  },
  [RouteId.UpdateScheduleTrigger]: {
    project: ["update"],
  },
  [RouteId.DeleteScheduleTrigger]: {
    project: ["delete"],
  },
  [RouteId.EnableScheduleTrigger]: {
    project: ["update"],
  },
  [RouteId.DisableScheduleTrigger]: {
    project: ["update"],
  },
  [RouteId.RunScheduleTriggerNow]: {
    project: ["create"],
  },
  [RouteId.GetScheduleTriggerRuns]: {
    project: ["read"],
  },
  [RouteId.GetScheduleTriggerRun]: {
    project: ["read"],
  },
  [RouteId.CreateScheduleTriggerRunConversation]: {
    project: ["create"],
  },

  // Knowledge Base Routes
  [RouteId.GetKnowledgeBases]: { knowledgeSource: ["read"] },
  [RouteId.GetKnowledgeBaseLabelKeys]: { knowledgeSource: ["read"] },
  [RouteId.GetKnowledgeBaseLabelValues]: { knowledgeSource: ["read"] },
  [RouteId.CreateKnowledgeBase]: { knowledgeSource: ["create"] },
  [RouteId.GetKnowledgeBase]: { knowledgeSource: ["read"] },
  [RouteId.UpdateKnowledgeBase]: { knowledgeSource: ["update"] },
  [RouteId.BulkDeleteKnowledgeBases]: { knowledgeSource: ["delete"] },
  [RouteId.DeleteKnowledgeBase]: { knowledgeSource: ["delete"] },
  // Restore is the inverse of delete — same gate, as for skills and projects.
  [RouteId.RestoreKnowledgeBase]: { knowledgeSource: ["delete"] },
  // Permanent deletion is irreversible, so the handler narrows this further to
  // a built-in admin ROLE — no knowledgeSource permission, `admin` included,
  // gets you past the trash.
  [RouteId.PermanentlyDeleteKnowledgeBase]: { knowledgeSource: ["delete"] },
  [RouteId.GetKnowledgeBaseHealth]: { knowledgeSource: ["read"] },

  // Knowledge Base Connector Routes
  [RouteId.GetConnectors]: { knowledgeSource: ["read"] },
  [RouteId.GetConnectorLabelKeys]: { knowledgeSource: ["read"] },
  [RouteId.GetConnectorLabelValues]: { knowledgeSource: ["read"] },
  [RouteId.CreateConnector]: { knowledgeSource: ["create"] },
  [RouteId.GetConnector]: { knowledgeSource: ["read"] },
  [RouteId.GetConnectorDocuments]: { knowledgeSource: ["read"] },
  [RouteId.GetConnectorDocument]: { knowledgeSource: ["read"] },
  [RouteId.UpdateConnector]: { knowledgeSource: ["update"] },
  [RouteId.BulkUpdateConnectors]: { knowledgeSource: ["update"] },
  [RouteId.BulkDeleteConnectors]: { knowledgeSource: ["delete"] },
  [RouteId.DeleteConnector]: { knowledgeSource: ["delete"] },
  // Same gates as the knowledge-base pair above.
  [RouteId.RestoreConnector]: { knowledgeSource: ["delete"] },
  [RouteId.PermanentlyDeleteConnector]: { knowledgeSource: ["delete"] },
  [RouteId.BulkDeleteConnectorDocuments]: { knowledgeSource: ["delete"] },
  [RouteId.DeleteConnectorDocument]: { knowledgeSource: ["delete"] },
  [RouteId.SyncConnector]: { knowledgeSource: ["update"] },
  [RouteId.TriggerPermissionSync]: { knowledgeSource: ["update"] },
  [RouteId.GetPermissionSyncCoverage]: { knowledgeSource: ["read"] },
  [RouteId.GetConnectorUserGroups]: { knowledgeSource: ["read"] },
  [RouteId.UpsertConnectorMemberOverride]: {
    knowledgeSource: ["update"],
  },
  [RouteId.DeleteConnectorMemberOverride]: {
    knowledgeSource: ["update"],
  },
  [RouteId.ForceResyncConnector]: { knowledgeSource: ["update"] },
  [RouteId.TestConnectorConnection]: { knowledgeSource: ["read"] },
  // Starting an authorization ends in a credential being written onto the
  // connector, so it takes the same grant as any other edit.
  [RouteId.StartGoogleDriveConnectorOAuth]: { knowledgeSource: ["update"] },
  // Google redirects the browser here, and the session rides along (the
  // cookie is SameSite=Lax, which a top-level GET navigation carries). The
  // handler additionally requires that session to be the one that started the
  // flow, so an authorization cannot be redeemed onto someone else's
  // connector.
  [RouteId.CompleteGoogleDriveConnectorOAuth]: { knowledgeSource: ["update"] },

  // Connector Knowledge Base Assignment Routes
  [RouteId.AssignConnectorToKnowledgeBases]: { knowledgeSource: ["update"] },
  [RouteId.UnassignConnectorFromKnowledgeBase]: {
    knowledgeSource: ["update"],
  },
  [RouteId.GetConnectorKnowledgeBases]: { knowledgeSource: ["read"] },

  // Connector Run Routes
  [RouteId.GetConnectorRuns]: { knowledgeSource: ["read"] },
  [RouteId.GetConnectorRun]: { knowledgeSource: ["read"] },
  [RouteId.CancelConnectorRun]: { knowledgeSource: ["update"] },

  // Agent Skill Routes - per-instance scope is enforced in the handlers
  [RouteId.GetSkills]: {},
  [RouteId.GetSkillLabelKeys]: { skill: ["read"] },
  [RouteId.GetSkillLabelValues]: { skill: ["read"] },
  [RouteId.GetExternalMcpSkills]: {
    skill: ["read"],
    mcpServerInstallation: ["read"],
  },
  [RouteId.GetExternalMcpSkill]: {
    skill: ["read"],
    mcpServerInstallation: ["read"],
  },
  [RouteId.GetExternalMcpSkillUsageStatistics]: {
    skill: ["read"],
    mcpServerInstallation: ["read"],
  },
  [RouteId.CreateSkill]: { skill: ["create"] },
  [RouteId.GetSkill]: {},
  [RouteId.UpdateSkill]: {},
  [RouteId.DeleteSkill]: {},
  [RouteId.BulkDeleteSkills]: {},
  [RouteId.RestoreSkill]: {},
  // Permanent deletion is irreversible, so the handler narrows this further to
  // a built-in admin ROLE — no skill permission, `skill:admin` included, gets
  // you past the trash.
  [RouteId.PermanentlyDeleteSkill]: { skill: ["delete"] },
  [RouteId.ResetSkill]: {},
  // Any member: the Connect page shows whether guardrails apply to their
  // agent. It reveals only the on/off switch and the unrecognized-client
  // action, not the policy.
  [RouteId.GetGuardrailsDeployment]: {},
  [RouteId.UpdateGuardrailsDeployment]: { organizationSettings: ["update"] },
  [RouteId.GetAppaGithubSync]: { organizationSettings: ["read"] },
  [RouteId.ConfigureAppaGithubSync]: { organizationSettings: ["update"] },
  [RouteId.CreateAppaGithubRepository]: { organizationSettings: ["update"] },
  [RouteId.StartAppaGithubApp]: { organizationSettings: ["update"] },
  [RouteId.CompleteAppaGithubApp]: { organizationSettings: ["update"] },
  [RouteId.GetPendingAppaGithubApp]: { organizationSettings: ["update"] },
  [RouteId.DiscardAppaGithubApp]: { organizationSettings: ["update"] },
  [RouteId.InstallAppaGithubApp]: { organizationSettings: ["update"] },
  [RouteId.GetAppaGithubAppAccounts]: { credential: ["read"] },
  [RouteId.GetAppaGithubAppRepositories]: { organizationSettings: ["update"] },
  [RouteId.GetAppaGithubRepositoryStatus]: { organizationSettings: ["update"] },
  [RouteId.UpdateAppaGithubSync]: { organizationSettings: ["update"] },
  [RouteId.GetOpenappaBatteries]: { guardrailsPolicy: ["read"] },
  [RouteId.GetOpenappaBatteryPolicySource]: { guardrailsPolicy: ["read"] },
  [RouteId.GetOpenappaEffectivePolicy]: { guardrailsPolicy: ["read"] },
  [RouteId.GetOpenappaBatteryMatches]: { guardrailsPolicy: ["read"] },
  [RouteId.GetOpenappaBatteryInstall]: { guardrailsPolicy: ["read"] },
  [RouteId.CreateOpenappaBatteryInstall]: { guardrailsPolicy: ["update"] },
  [RouteId.UpdateOpenappaBatteryInstall]: { guardrailsPolicy: ["update"] },
  [RouteId.DeleteOpenappaBatteryInstall]: { guardrailsPolicy: ["update"] },
  [RouteId.DeleteOpenappaBatteryInclude]: { guardrailsPolicy: ["update"] },
  [RouteId.UploadOpenappaBatteryPackage]: { guardrailsPolicy: ["update"] },
  [RouteId.DeleteOpenappaBatteryPackage]: { guardrailsPolicy: ["update"] },
  // Binding hands an organization credential's value to helper code, so the
  // route also requires `use` on that credential.
  [RouteId.SetOpenappaCredentialBinding]: {
    guardrailsPolicy: ["update"],
  },
  // The variable -> key pairs are readable through GetOpenappaPolicyDeclarations too.
  [RouteId.GetOpenappaCredentialBindings]: { guardrailsPolicy: ["read"] },
  [RouteId.GetOpenappaCredentialBinding]: { guardrailsPolicy: ["read"] },
  [RouteId.GetOpenappaPolicyDeclarations]: { guardrailsPolicy: ["read"] },
  // Publishing a held pull is a policy write; each reason it names carries its
  // own permission on top, checked where the pull's changes are known.
  // Loopback-only helper bridge for the APPA runtime; authenticated by the
  // per-process bridge bearer inside the route, not by a session.
  [RouteId.ConsultOpenappaBatteryHelper]: {},
  // Loopback-only `builtin = "archestra"` annotator; authenticated by the same
  // per-process bridge bearer inside the route.
  [RouteId.AnnotateOpenappaToolWithArchestra]: {},
  // Log readers see and resolve all yells and read their own consults;
  // log:admin widens consult visibility to the whole organization.
  [RouteId.GetOpenAppaYells]: { log: ["read"] },
  [RouteId.GetOpenAppaYellsSummary]: { log: ["read"] },
  [RouteId.DownloadOpenAppaYell]: { log: ["read"] },
  [RouteId.GetOpenAppaYell]: { log: ["read"] },
  [RouteId.UpdateOpenAppaYell]: { log: ["read"] },
  [RouteId.GetOpenappaExternalConsults]: { log: ["read"] },
  [RouteId.GetOpenappaExternalConsult]: { log: ["read"] },
  [RouteId.GetOpenappaLabelChanges]: { log: ["read"] },
  // Read-only views of what the policy covers; nothing here changes state.
  [RouteId.GetOpenappaCoverageEntities]: { guardrailsPolicy: ["read"] },
  [RouteId.GetOpenappaCoverageTools]: { guardrailsPolicy: ["read"] },
  [RouteId.GetOpenappaCoverageSummary]: { guardrailsPolicy: ["read"] },
  [RouteId.GetOpenappaTrustAudience]: { guardrailsPolicy: ["read"] },
  [RouteId.GetOpenappaRemedies]: { guardrailsPolicy: ["read"] },
  [RouteId.GetOpenappaRemediesActivity]: { guardrailsPolicy: ["read"] },
  [RouteId.UpdateSkillGithubSync]: {},
  [RouteId.GetPlugins]: { plugin: ["read"] },
  [RouteId.GetPluginLabelKeys]: { plugin: ["read"] },
  [RouteId.GetPluginLabelValues]: { plugin: ["read"] },
  [RouteId.CreatePlugin]: { plugin: ["create"] },
  [RouteId.GetPlugin]: { plugin: ["read"] },
  [RouteId.UpdatePlugin]: { plugin: ["update"] },
  [RouteId.DeletePlugin]: { plugin: ["delete"] },
  [RouteId.PreviewGithubPlugin]: { plugin: ["create"] },
  [RouteId.ImportGithubPlugin]: { plugin: ["create"] },
  [RouteId.PreviewGithubPluginUpdate]: { plugin: ["update"] },
  [RouteId.ApplyGithubPluginUpdate]: { plugin: ["update"] },
  [RouteId.DiscoverGithubPluginMarketplace]: {
    plugin: ["create"],
  },
  [RouteId.ImportGithubPluginMarketplace]: {
    plugin: ["create"],
  },
  [RouteId.UpdatePluginGithubSync]: { plugin: ["update"] },
  [RouteId.TriggerPluginGithubSync]: { plugin: ["update"] },
  // Skills projected from plugin file trees: a Skills surface over plugin
  // metadata, so it needs both floors — per-plugin visibility is enforced
  // in the handlers.
  [RouteId.GetPluginSkills]: { skill: ["read"], plugin: ["read"] },
  [RouteId.GetPluginSkill]: { skill: ["read"], plugin: ["read"] },
  [RouteId.GetPluginSkillUsageStatistics]: {
    skill: ["read"],
    plugin: ["read"],
  },
  [RouteId.DiscoverGithubSkills]: { skill: ["read"] },
  [RouteId.SearchSkillCatalog]: { skill: ["read"] },
  [RouteId.PreviewGithubSkill]: { skill: ["read"] },
  [RouteId.ImportGithubSkills]: { skill: ["create"] },
  [RouteId.GetSkillSourceRepos]: { skill: ["read"] },
  [RouteId.GetSkillNames]: { skill: ["read"] },
  [RouteId.GetSkillUsageStatistics]: {},
  [RouteId.GetSkillVersions]: {},
  [RouteId.GetSkillVersion]: {},
  [RouteId.EnableSkillToolDefaults]: { organizationSettings: ["update"] },
  // matches the `download_file` tool (agent:read) that hands out this
  // URL, so a role allowed to produce an artifact can also fetch it.
  [RouteId.GetSkillSandboxArtifact]: { agent: ["read"] },
  [RouteId.GetSkillSandboxConversationArtifacts]: { agent: ["read"] },
  [RouteId.CreateProject]: { project: ["create"] },
  // Owner-scoped: a caller may only convert their own chat, so `project:create`
  // is the capability gate (matching the create_project_from_conversation MCP
  // tool's RBAC). The owner can always read their own chat.
  [RouteId.CreateProjectFromConversation]: { project: ["create"] },
  [RouteId.GetProjects]: { project: ["read"] },
  [RouteId.GetProjectLabelKeys]: { project: ["read"] },
  [RouteId.GetProjectLabelValues]: { project: ["read"] },
  [RouteId.GetProject]: { project: ["read"] },
  [RouteId.UpdateProject]: { project: ["update"] },
  [RouteId.BulkDeleteProjects]: { project: ["delete"] },
  [RouteId.DeleteProject]: { project: ["delete"] },
  // Restore is the inverse of delete and, like the deleted-projects view, an
  // oversight action — the handler further narrows it to `project:admin`.
  [RouteId.RestoreProject]: { project: ["delete"] },
  // Irreversible, so the handler narrows to a built-in admin ROLE — further
  // than restore's `project:admin`, which a custom oversight role can hold.
  // That also settles the org-wide-share question delete/restore have to ask:
  // an admin role always holds `project:share-org`, so there is no separate
  // branch here to answer 403 and leak a trashed project's existence.
  [RouteId.PermanentlyDeleteProject]: { project: ["delete"] },
  [RouteId.GetProjectConversations]: { project: ["read"] },
  [RouteId.GetProjectRuns]: { project: ["read"], agent: ["read"] },
  // Project files follow project access; membership is enforced in the
  // handler (projectService.listFiles/uploadFile -> requireReadable). The
  // artifact byte endpoint that serves file contents (GetSkillSandboxArtifact)
  // stays on `agent:read`.
  [RouteId.GetProjectFiles]: { project: ["read"] },
  [RouteId.UploadProjectFiles]: { project: ["read"] },
  // Instructions are plain project metadata (not a sandbox byte surface), so the
  // GET needs only project read — every project reader can see the instructions
  // that steer the project's chats. Editing is owner-only, enforced in the
  // handler on top of project:update.
  [RouteId.GetProjectInstructions]: { project: ["read"] },
  [RouteId.SetProjectInstructions]: { project: ["update"] },
  [RouteId.PinProject]: { project: ["read"] },
  [RouteId.UnpinProject]: { project: ["read"] },
  // Linked apps: project membership plus app read. Each app is re-checked
  // against the caller's own app access in the handler, so a link never
  // widens who can open an app.
  [RouteId.GetProjectApps]: { project: ["read"], app: ["read"] },
  [RouteId.LinkProjectApp]: { project: ["read"], app: ["read"] },
  [RouteId.UnlinkProjectApp]: { project: ["read"], app: ["read"] },
  [RouteId.DeleteSkillSandboxArtifact]: { agent: ["read"] },
  // Editing a file's text content shares the delete path's authorization
  // (author / project access), enforced per-file in the store handler.
  [RouteId.UpdateSkillSandboxArtifactContent]: { agent: ["read"] },

  // Audit Log Routes
  [RouteId.GetAuditLogs]: {
    auditLog: ["read"],
  },
  [RouteId.GetAuditLog]: {
    auditLog: ["read"],
  },
  [RouteId.GetAuditLogResources]: {
    auditLog: ["read"],
  },

  // Skill Share Link Routes - admin-only. Per-skill org-isolation enforced in handlers.
  // The public marketplace git endpoint stays outside this map; it is allowlisted in
  // the auth middleware (`SKILL_MARKETPLACE_PREFIX`), mirroring `MCP_GATEWAY_PREFIX`.
  // The static marketplace's clone URL and name — what any user needs to
  // install the skills they can already read. Gated on the same permission as
  // listing skills, not on skill:admin.
  [RouteId.GetSkillMarketplace]: { skill: ["read"] },
  [RouteId.GetSkillShareLinks]: {},
  [RouteId.CreateSkillShareLink]: {},
  [RouteId.RevokeSkillShareLink]: {},
  [RouteId.RotateSkillShareLink]: {},

  // MCP App Routes - per-instance scope is enforced in the handlers
  [RouteId.GetApps]: {},
  [RouteId.GetExternalApp]: { app: ["read"] },
  [RouteId.GetExternalAppIcon]: { app: ["read"] },
  // Like GetApp: the handler serves only an app the caller may view.
  [RouteId.GetAppIcon]: {},
  [RouteId.CreateApp]: { app: ["create"] },
  [RouteId.GetApp]: {},
  [RouteId.UpdateApp]: {},
  // Enable/disable is a lifecycle transition, not a metadata edit; gated like
  // an update (the handler further requires scope-modify at the app's scope).
  [RouteId.EnableApp]: {},
  [RouteId.DisableApp]: {},
  [RouteId.LockApp]: {},
  [RouteId.UnlockApp]: {},
  [RouteId.BulkDeleteApps]: {},
  [RouteId.DeleteApp]: {},
  [RouteId.GetAppVersions]: {},
  [RouteId.GetAppVersionSummaries]: {},
  [RouteId.GetAppVersion]: {},
  [RouteId.RestoreAppVersion]: {},
  [RouteId.GetAppTools]: {},
  [RouteId.AssignToolToApp]: {},
  [RouteId.UnassignToolFromApp]: {},
  [RouteId.GetAppTemplates]: { app: ["read"] },
  [RouteId.GetAppLabelKeys]: { app: ["read"] },
  [RouteId.GetAppLabelValues]: { app: ["read"] },
  // Opens an app in chat: reads the app and creates a seeded conversation.
  [RouteId.OpenAppInChat]: { chat: ["create"] },
  [RouteId.OpenExternalAppInChat]: { app: ["read"], chat: ["create"] },
  // Per-user app pins (mirrors PinProject/UnpinProject): any viewer may pin —
  // the handlers gate per-instance visibility; unpin is intentionally
  // unchecked there so stale pins can always be cleared.
  [RouteId.PinApp]: {},
  [RouteId.UnpinApp]: {},
  [RouteId.PinExternalApp]: { app: ["read"] },
  [RouteId.UnpinExternalApp]: { app: ["read"] },
  // The trusted host page reports a viewer's render diagnostics; the handler
  // re-checks app-visibility, so app:read is the right coarse gate.
  [RouteId.PostAppRenderDiagnostics]: {},
  // Same trust model as diagnostics: the host page posts the viewer's render
  // screenshot, the handler re-checks app-visibility.
  [RouteId.PostAppRenderScreenshot]: {},
  // Internal UI feedback overlay: any signed-in user, and only on deployments
  // that turn it on (the handlers 404 otherwise). Picking its Slack bot and
  // channel is the same permission as configuring chatops Slack itself.
  [RouteId.GetDevFeedbackSetup]: {},
  [RouteId.ListDevFeedbackBots]: { organizationSettings: ["update"] },
  [RouteId.ListDevFeedbackChannels]: { organizationSettings: ["update"] },
  [RouteId.SaveDevFeedbackSetup]: { organizationSettings: ["update"] },
  [RouteId.GetDevFeedbackComments]: {},
  [RouteId.CreateDevFeedbackComment]: {},
  [RouteId.GetDevFeedbackReplies]: {},
  [RouteId.CreateDevFeedbackReply]: {},
  [RouteId.ResolveDevFeedbackComment]: {},
  // Config endpoint - any authenticated user can access
  [RouteId.GetConfig]: {},
  // Bundles the signed-in user's own startup reads; each part is self-scoped.
  [RouteId.GetBootstrap]: {},
  // Bundles the new-chat composer's reads; each part keeps its own
  // endpoint's checks.
  [RouteId.GetNewChatBootstrap]: {},
  // The conversation part is the conversation read with its own checks.
  [RouteId.GetConversationBootstrap]: {},

  // Site Notification Routes
  // Every signed-in user sees the active banner.
  [RouteId.GetSiteNotification]: {},
  [RouteId.GetSiteNotificationSettings]: { organizationSettings: ["read"] },
  [RouteId.CreateSiteNotification]: { organizationSettings: ["update"] },
  [RouteId.UpdateSiteNotification]: { organizationSettings: ["update"] },
  [RouteId.DeleteSiteNotification]: { organizationSettings: ["update"] },

  // Hook File Routes
  [RouteId.GetHooks]: {},
  [RouteId.CreateHook]: {},
  [RouteId.UpdateHook]: {},
  [RouteId.DeleteHook]: {},

  // MCP Gateway Routes - available to all authenticated users
  [RouteId.McpGatewayGet]: {}, // MCP transport probe; authenticates gateway credentials
  [RouteId.McpGatewayPost]: {}, // JSON-RPC endpoint for resources/read and tools/call
  [RouteId.McpGatewayDelete]: {}, // Session cleanup; validates gateway credentials and signed session ownership
  [RouteId.McpGatewaySseMessage]: {}, // Legacy HTTP+SSE message endpoint; authenticates gateway credentials
  [RouteId.McpProxyPost]: {}, // Frontend proxy to MCP Gateway with session auth
  [RouteId.McpServerProxyPost]: {}, // Server-scoped Apps proxy; access enforced in-handler
  // App-bound MCP proxy: app access + visibility/allowlist gate enforced in the handler
  [RouteId.McpAppProxyPost]: {},

  // Knowledge files. Reads are `knowledgeSource:read` like every other
  // knowledge surface; indexing a file into a base changes what agents can
  // retrieve, so it is an `update` rather than a read.
  [RouteId.GetKnowledgeFiles]: { knowledgeSource: ["read"] },
  [RouteId.GetKnowledgeFileLabelKeys]: { knowledgeSource: ["read"] },
  [RouteId.GetKnowledgeFileLabelValues]: { knowledgeSource: ["read"] },
  [RouteId.GetKnowledgeFileContent]: { knowledgeSource: ["read"] },
  [RouteId.GetKnowledgeDirectories]: { knowledgeSource: ["read"] },
  [RouteId.UpsertKnowledgeFile]: { knowledgeSource: ["create", "update"] },
  [RouteId.UploadKnowledgeFile]: { knowledgeSource: ["create"] },
  [RouteId.PromoteAttachmentToKnowledgeFile]: { knowledgeSource: ["create"] },
  [RouteId.CreateKnowledgeDirectory]: { knowledgeSource: ["create"] },
  [RouteId.IndexKnowledgeFiles]: { knowledgeSource: ["update"] },
  [RouteId.UpdateKnowledgeFile]: { knowledgeSource: ["update"] },
  [RouteId.UpdateKnowledgeDirectory]: { knowledgeSource: ["update"] },
  [RouteId.DeleteKnowledgeFile]: { knowledgeSource: ["delete"] },
  [RouteId.BulkDeleteKnowledgeFiles]: { knowledgeSource: ["delete"] },
  [RouteId.BulkDeleteKnowledgeDirectories]: { knowledgeSource: ["delete"] },
  [RouteId.DeleteKnowledgeDirectory]: { knowledgeSource: ["delete"] },
};

/**
 * Build the user-facing message for a 403 response: what was blocked (derived
 * from the route id) and why (the missing `resource:action` permissions, with
 * their human-readable descriptions). Used by the backend auth middleware and
 * by permission helpers that deny a specific resource/action, so every
 * Forbidden error reads the same way.
 */
export function buildForbiddenErrorMessage(params: {
  routeId?: string;
  missingPermissions?: Permissions;
}): string {
  const activity = params.routeId ? humanizeRouteId(params.routeId) : undefined;
  let message = activity
    ? `You don't have permission to ${activity}.`
    : "You don't have permission to perform this action.";

  const permissionKeys = flattenPermissionKeys(params.missingPermissions);
  if (permissionKeys.length > 0) {
    const details = permissionKeys.map((key) => {
      const description = permissionDescriptions[key];
      return description ? `${key} (${description})` : key;
    });
    message += ` Missing permission${permissionKeys.length > 1 ? "s" : ""}: ${details.join("; ")}.`;
  }

  return message;
}

/**
 * Maps frontend routes to their required permissions.
 * Used to control page-level access and UI element visibility.
 */

export const requiredPagePermissionsMap: Record<string, Permissions> = {
  // Chat
  "/chat": { chat: ["read"] },
  "/chat/[conversationId]": { chat: ["read"] },

  // Projects
  "/projects": { project: ["read"] },
  "/projects/[id]": { project: ["read"] },

  // Knowledge files
  "/knowledge/files": { knowledgeSource: ["read"] },

  // Agents
  "/agents": { agent: ["read"] },
  // Every choice on the chooser, connecting an external agent included, creates
  // an agent.
  "/agents/new": { agent: ["create"] },
  "/agents/a2a": { agent: ["read"] },
  "/agents/a2a/new": { agent: ["read"] },
  "/agents/a2a/[id]": { agent: ["read"] },
  "/messaging-channels": { organizationSettings: ["read"] },
  "/messaging-channels/slack": { organizationSettings: ["read"] },
  "/messaging-channels/ms-teams": { organizationSettings: ["read"] },
  "/messaging-channels/email": { organizationSettings: ["read"] },
  "/skills": { skill: ["read"] },
  "/skills/new": { skill: ["create"] },
  "/plugins": { plugin: ["read"] },
  "/plugins/new": { plugin: ["create"] },
  "/plugins/import": { plugin: ["create"] },
  "/plugins/[id]": { plugin: ["read"] },
  "/scheduled-tasks": { project: ["read"] },

  // Apps
  "/apps": { app: ["read"] },
  "/apps/[id]": { app: ["read"] },
  "/apps/[id]/run": { app: ["read"] },
  "/apps/server/[mcpServerId]/run": { app: ["read"] },

  // LLM
  "/llm/proxy": { llmProxy: ["read"] },
  "/llm/proxy/virtual-keys": { llmVirtualKey: ["read"] },
  "/llm/model-providers": { llmProviderApiKey: ["read"] },
  "/llm/models": { llmModel: ["read"] },
  "/llm/model-pools": { llmModel: ["read"] },
  // Intentionally ungated: this page is fixed to the caller's own usage.
  "/llm/usage": {},
  "/llm/costs": { llmCost: ["read"] },
  "/llm/limits": { llmLimit: ["read"] },

  // MCP
  "/mcp/registry": { mcpRegistry: ["read"] },
  "/mcp/registry/new": { mcpRegistry: ["create"] },
  "/mcp/gateways": { mcpGateway: ["read"] },
  "/mcp/gateways/new": { mcpGateway: ["create"] },

  "/openappa": { guardrailsPolicy: ["read"] },
  "/openappa/policy": { guardrailsPolicy: ["read"] },
  "/openappa/batteries": { guardrailsPolicy: ["read"] },
  "/openappa/yells": { log: ["read"] },

  // Logs
  "/llm/logs": { log: ["read"] },
  "/mcp/logs": { log: ["read"] },
  "/audit/logs": { auditLog: ["read"] },
  "/consults/logs": { log: ["read"] },
  "/consults/logs/[id]": { log: ["read"] },
  "/connections/logs": { log: ["admin"], member: ["read"] },

  // Knowledge
  "/knowledge/knowledge-bases": { knowledgeSource: ["read"] },
  "/knowledge/connectors": { knowledgeSource: ["read"] },

  // Settings
  "/settings/service-accounts": { serviceAccount: ["read"] },
  // Every OAuth client in one place — LLM proxy, MCP gateways and agents
  // alike — so the reader is not asked which product a credential belongs to
  // before they can find it.
  //
  // One page and role resource covers every managed OAuth capability.
  "/settings/oauth-clients": { oauthClient: ["read"] },
  "/settings/llm": { organizationSettings: ["read"] },
  "/settings/mcp": { organizationSettings: ["read"] },
  "/settings/skills": { organizationSettings: ["read"] },
  "/settings/agents": { organizationSettings: ["read"] },
  "/settings/messaging-channels": { organizationSettings: ["read"] },
  "/settings/messaging-channels/slack": { organizationSettings: ["read"] },
  "/settings/messaging-channels/ms-teams": { organizationSettings: ["read"] },
  "/settings/messaging-channels/telegram": { organizationSettings: ["read"] },
  "/settings/messaging-channels/email": { organizationSettings: ["read"] },
  "/settings/apps": { organizationSettings: ["read"] },
  "/settings/environments": { environment: ["update"] },
  "/settings/knowledge": { organizationSettings: ["read"] },
  "/settings/users": { member: ["read"] },
  "/settings/teams": { team: ["read"] },
  "/settings/roles": { ac: ["read"] },
  // Type-wide grants are an access decision, not a role definition, so the
  // page answers to the same permission that opens the roles screen.
  "/settings/identity-providers": { identityProvider: ["read"] },
  "/settings/secrets": { organizationSettings: ["read"] },
  "/settings/credentials": { credential: ["read"] },
  "/settings/guardrails": { organizationSettings: ["read"] },
  "/settings/appearance": { organizationSettings: ["read"] },
  "/settings/appearance/[section]": { organizationSettings: ["read"] },
  "/settings/auth": { organizationSettings: ["read"] },
  "/settings/connection": { organizationSettings: ["read"] },
};

// === Internal helpers

/**
 * Words in a camelCase route id that must keep their canonical casing when the
 * id is turned into a human-readable phrase (e.g. "getMcpServerLogs" →
 * "get MCP server logs").
 */
const ROUTE_WORD_CASING_OVERRIDES: Record<string, string> = {
  a2a: "A2A",
  acme: "ACME",
  ai: "AI",
  api: "API",
  id: "ID",
  idp: "IdP",
  k8s: "K8s",
  llm: "LLM",
  llms: "LLMs",
  mcp: "MCP",
  oauth: "OAuth",
  sso: "SSO",
  url: "URL",
};

/** Turn a camelCase route id like "uploadProjectFiles" into "upload project files". */
function humanizeRouteId(routeId: string): string {
  return routeId
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => {
      const lower = word.toLowerCase();
      return ROUTE_WORD_CASING_OVERRIDES[lower] ?? lower;
    })
    .join(" ");
}

/** Flatten a Permissions object into "resource:action" keys, sorted for stable output. */
function flattenPermissionKeys(permissions: Permissions | undefined): string[] {
  if (!permissions) return [];
  return Object.entries(permissions)
    .flatMap(([resource, actions]) =>
      (actions ?? []).map((action) => `${resource}:${action}`),
    )
    .sort();
}

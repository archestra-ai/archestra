/**
 * Defines the RBAC (Role-Based Access Control) for the platform
 */

import { defaultStatements } from "better-auth/plugins/organization/access";
import type { Action, Permissions, Resource } from "./permission.types";
import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
  PLATFORM_ADMIN_ROLE_NAME,
  type PredefinedRoleName,
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
  agent: [
    "read",
    "create",
    "update",
    "delete",
    "team-admin",
    "admin",
    "deploy-to-restricted",
  ],
  skill: [
    "read",
    "create",
    "update",
    "delete",
    "team-admin",
    "admin",
    "deploy-to-restricted",
  ],
  plugin: ["read", "create", "update", "delete", "admin"],
  app: [
    "read",
    "create",
    "update",
    "delete",
    "team-admin",
    "admin",
    "deploy-to-restricted",
  ],
  sandbox: ["execute"],
  agentTrigger: ["read", "create", "update", "delete"],
  scheduledTask: ["read", "create", "update", "delete", "admin"],

  // LLM
  llmProxy: ["read", "update"],
  llmProviderApiKey: ["read", "create", "update", "delete", "admin"],
  llmVirtualKey: ["read", "create", "update", "delete", "admin"],
  llmOauthClient: ["read", "create", "update", "delete", "team-admin", "admin"],
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
  mcpGateway: [
    "read",
    "create",
    "update",
    "delete",
    "team-admin",
    "admin",
    "deploy-to-restricted",
  ],
  mcpOauthClient: ["read", "create", "update", "delete", "team-admin", "admin"],
  toolPolicy: ["read", "create", "update", "delete"],
  mcpRegistry: [
    "read",
    "create",
    "update",
    "delete",
    "manage-deleted",
    "team-admin",
    "deploy-to-restricted",
  ],
  mcpServerInstallation: [
    "read",
    "create",
    "update",
    "delete",
    "manage-deleted",
    "admin",
  ],
  environment: ["read", "create", "update", "delete"],
  githubAppConfig: ["read", "create", "update", "delete"],

  // Knowledge
  knowledgeSource: [
    "read",
    "create",
    "update",
    "delete",
    "query",
    "admin",
    "deploy-to-restricted",
  ],
  knowledgeSourceAutoSync: ["read", "create", "update", "delete"],

  // Other
  chat: ["read", "create", "update", "delete"],
  project: [
    "read",
    "create",
    "update",
    "delete",
    "share-org",
    "admin",
    "read-all",
  ],
  file: ["manage"],
  log: ["read", "admin"],

  // Administration (overrides better-auth defaults to add "read" where needed)
  apiKey: ["read", "create", "delete"],
  serviceAccount: ["read", "create", "update", "delete"],
  auditLog: ["read", "admin"],
  agentSettings: ["read", "update"],
  llmSettings: ["read", "update"],
  mcpSettings: ["read", "update"],
  skillsSettings: ["read", "update"],
  knowledgeSettings: ["read", "update"],
  member: ["read", "create", "update", "delete", "impersonate"],
  invitation: ["create", "cancel"],
  ac: ["read", "create", "update", "delete"],
  team: ["read", "create", "update", "delete"],
  identityProvider: ["read", "create", "update", "delete"],
  secret: ["read", "update"],
  organizationSettings: ["read", "update"],

  // UI behavior resources
  simpleView: ["enable"],
  chatAgentPicker: ["enable"],
  chatProviderSettings: ["enable"],
  chatExpandToolCalls: ["enable"],

  // Administration
  siteNotification: ["read", "create", "update", "delete"],

  // better-auth internal resource — not exposed to users, kept for ACL compatibility
  organization: ["update", "delete"],
};

export const editorPermissions: Record<Resource, Action[]> = {
  // Agents
  agent: [
    "read",
    "create",
    "update",
    "delete",
    "team-admin",
    "deploy-to-restricted",
  ],
  skill: [
    "read",
    "create",
    "update",
    "delete",
    "team-admin",
    "deploy-to-restricted",
  ],
  plugin: ["read", "create", "update", "delete"],
  app: [
    "read",
    "create",
    "update",
    "delete",
    "team-admin",
    "deploy-to-restricted",
  ],
  sandbox: ["execute"],
  agentTrigger: ["read", "create", "update", "delete"],
  scheduledTask: ["read", "create", "update", "delete"],

  // LLM
  llmProxy: ["read", "update"],
  llmProviderApiKey: ["read", "create", "update", "delete"],
  llmVirtualKey: ["read", "create", "update", "delete"],
  llmOauthClient: ["read", "create", "update", "delete", "team-admin"],
  llmModel: ["read", "update"],
  llmLimit: ["read", "create", "update", "delete"],
  llmCost: ["read"],

  // MCP
  mcpGateway: [
    "read",
    "create",
    "update",
    "delete",
    "team-admin",
    "deploy-to-restricted",
  ],
  mcpOauthClient: ["read", "create", "update", "delete", "team-admin"],
  toolPolicy: ["read", "create", "update", "delete"],
  mcpRegistry: [
    "read",
    "create",
    "update",
    "delete",
    "team-admin",
    "deploy-to-restricted",
  ],
  mcpServerInstallation: ["read", "create", "update", "delete"],
  environment: ["read", "create", "update", "delete"],
  githubAppConfig: ["read", "create", "update", "delete"],

  // Knowledge
  knowledgeSource: [
    "read",
    "create",
    "update",
    "delete",
    "query",
    "deploy-to-restricted",
  ],
  knowledgeSourceAutoSync: [],

  // Other
  chat: ["read", "create", "update", "delete"],
  project: ["read", "create", "update", "delete", "share-org"],
  file: ["manage"],
  // Editors see only their own logs; org-wide visibility is log:admin,
  // reserved for admin-tier roles.
  log: ["read"],

  // Administration (overrides better-auth defaults to add "read" where needed)
  apiKey: ["read", "create", "delete"],
  serviceAccount: [],
  auditLog: [],
  agentSettings: [],
  llmSettings: ["read", "update"],
  mcpSettings: ["read", "update"],
  skillsSettings: ["read", "update"],
  knowledgeSettings: ["read", "update"],
  member: ["read"],
  invitation: ["read"],
  ac: ["read"],
  team: ["read"],
  identityProvider: ["read"],
  secret: ["read"],
  organizationSettings: ["read", "update"],

  // Administration
  siteNotification: ["read"],

  // UI behavior resources
  simpleView: [],
  chatAgentPicker: ["enable"],
  chatProviderSettings: ["enable"],
  chatExpandToolCalls: ["enable"],

  // better-auth internal resource — not exposed to users, kept for ACL compatibility
  organization: [],
};

export const memberPermissions: Record<Resource, Action[]> = {
  // Agents
  agent: ["read", "create", "update", "delete"],
  skill: ["read", "create", "update", "delete"],
  plugin: [],
  app: ["read", "create", "update", "delete"],
  sandbox: ["execute"],
  agentTrigger: [],
  scheduledTask: ["read", "create", "update", "delete"],

  // LLM
  llmProxy: ["read"],
  llmProviderApiKey: ["read"],
  // Members mint personal virtual keys to route through the LLM Proxy (e.g.
  // the /connection auto-provisioning flow). Granting "create" only enables
  // personal-scope keys; org-scoped keys still require llmVirtualKey:admin
  // (enforced in the virtual-api-key create route).
  llmVirtualKey: ["read", "create"],
  llmOauthClient: ["read"],
  llmModel: ["read"],
  llmLimit: [],
  llmCost: [],

  // MCP
  mcpGateway: ["read", "create", "update", "delete"],
  mcpOauthClient: ["read"],
  toolPolicy: ["read"],
  mcpRegistry: ["read", "update"],
  mcpServerInstallation: ["read", "create", "delete"],
  environment: ["read"],
  // minting installation tokens from a stored App credential is privileged;
  // default members get no access — editors and admins manage/use App configs
  githubAppConfig: [],

  // Knowledge
  knowledgeSource: ["read", "query"],
  knowledgeSourceAutoSync: [],
  // Members can see analyses and their results, but dispatching a run
  // spends LLM budget across a whole grid, so running is an editor action.

  // Other
  chat: ["read", "create", "update", "delete"],
  project: ["read", "create", "update", "delete", "share-org"],
  file: ["manage"],
  log: [],

  // Administration (overrides better-auth defaults to add "read" where needed)
  apiKey: ["read", "create", "delete"],
  serviceAccount: [],
  auditLog: [],
  agentSettings: [],
  llmSettings: [],
  mcpSettings: [],
  skillsSettings: [],
  knowledgeSettings: [],
  member: [],
  invitation: [],
  ac: [],
  team: ["read"],
  identityProvider: [],
  secret: [],
  organizationSettings: [],

  // Administration
  siteNotification: ["read"],

  // UI behavior resources
  simpleView: ["enable"],
  chatAgentPicker: ["enable"],
  chatProviderSettings: ["enable"],
  chatExpandToolCalls: ["enable"],

  // better-auth internal resource — not exposed to users, kept for ACL compatibility
  organization: [],
};

/**
 * The no-privilege-escalation rule, shared by every server-side grant path
 * (role authoring, member role assignment, invitations, service-account
 * roles, the org default role) and by the UI that previews it: a role may
 * only be granted by someone who already holds every permission it carries.
 * Returns the `resource:action` pairs the granter is missing (empty = OK).
 *
 * UI-behavior resources are exempt — predefined admin deliberately holds
 * LESS than member on those (e.g. `simpleView`), so including them would
 * make ordinary grants impossible.
 */
export function findUngrantablePermissions(
  granterPermissions: Permissions,
  rolePermissions: Permissions,
): string[] {
  const exemptUiResources: Resource[] = [
    "simpleView",
    "chatAgentPicker",
    "chatProviderSettings",
  ];

  const missing: string[] = [];
  for (const [resource, actions] of Object.entries(rolePermissions)) {
    if (exemptUiResources.includes(resource as Resource)) continue;
    const granterActions = granterPermissions[resource as Resource] || [];
    const realActions = allAvailableActions[resource as Resource] || [];
    for (const action of actions ?? []) {
      // Actions outside the permission universe grant nothing (RBAC checks
      // resolve against allAvailableActions), so they cannot be escalation.
      // Predefined sets carry a few such vestigial actions (e.g. the editor
      // role's invitation:read); without this filter no one could grant them.
      if (!realActions.includes(action)) continue;
      if (!granterActions.includes(action)) {
        missing.push(`${resource}:${action}`);
      }
    }
  }
  return missing;
}

export const adminPermissions: Record<Resource, Action[]> = {
  ...allAvailableActions,
  simpleView: [],
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
  simpleView: [],
  log: ["read"],
  auditLog: ["read"],
  member: allAvailableActions.member.filter((a) => a !== "impersonate"),
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
  "agent:read": "View and list agents",
  "agent:create": "Create new agents",
  "agent:update": "Modify agent configuration and settings",
  "agent:delete": "Delete agents",
  "agent:team-admin": "Manage team assignments for agents",
  "agent:admin":
    "Full administrative control over all agents, bypassing team restrictions",
  "agent:deploy-to-restricted":
    "Assign agents to restricted deployment environments",
  "skill:read":
    "View and use agent skills within your scope (org, your teams, your own)",
  "skill:create": "Create new agent skills",
  "skill:update": "Modify agent skills and their team assignments",
  "skill:delete": "Delete agent skills",
  "skill:team-admin": "Manage team assignments for agent skills",
  "skill:admin":
    "Full administrative control over all agent skills, bypassing team restrictions",
  "skill:deploy-to-restricted":
    "Assign agent skills to restricted deployment environments",
  "plugin:read": "View plugins and their file metadata",
  "plugin:create": "Create plugins",
  "plugin:update": "Modify plugin metadata and files",
  "plugin:delete": "Delete plugins",
  "plugin:admin": "Publish executable plugins through connection marketplaces",
  "app:read":
    "View and run MCP Apps within your scope (org, your teams, your own)",
  "app:create": "Create new MCP Apps",
  "app:update": "Modify MCP Apps, their tools, and their team assignments",
  "app:delete": "Delete MCP Apps",
  "app:team-admin": "Manage team assignments for MCP Apps",
  "app:admin":
    "Full administrative control over all MCP Apps, bypassing team restrictions",
  "app:deploy-to-restricted":
    "Assign MCP Apps to restricted deployment environments",
  "sandbox:execute":
    "Run commands and upload/download files in code execution sandboxes",
  "agentTrigger:read":
    "View agent trigger configurations (Slack, MS Teams, email)",
  "agentTrigger:create": "Set up new agent triggers",
  "agentTrigger:update": "Modify agent trigger configurations",
  "agentTrigger:delete": "Remove agent triggers",
  "scheduledTask:read": "View scheduled tasks and their run history",
  "scheduledTask:create": "Create new scheduled tasks and trigger runs",
  "scheduledTask:update": "Modify scheduled task configuration",
  "scheduledTask:delete": "Delete scheduled tasks",
  "scheduledTask:admin":
    "View and manage all scheduled tasks, not just your own",

  // MCP
  "mcpGateway:read": "View and list MCP gateways",
  "mcpGateway:create": "Create new MCP gateways",
  "mcpGateway:update": "Modify MCP gateway configuration",
  "mcpGateway:delete": "Delete MCP gateways",
  "mcpGateway:team-admin": "Manage team assignments for MCP gateways",
  "mcpOauthClient:read": "View MCP OAuth client registrations",
  "mcpOauthClient:create": "Create MCP OAuth client registrations",
  "mcpOauthClient:update": "Modify MCP OAuth client registrations",
  "mcpOauthClient:delete": "Delete MCP OAuth client registrations",
  "mcpOauthClient:team-admin":
    "Manage team assignments for MCP OAuth client registrations",
  "mcpOauthClient:admin":
    "Manage all MCP OAuth client registrations, bypassing team restrictions",
  "mcpGateway:admin":
    "Full administrative control over all MCP gateways, bypassing team restrictions",
  "mcpGateway:deploy-to-restricted":
    "Assign MCP gateways to restricted deployment environments",
  "toolPolicy:read":
    "View tools, tool invocation policies, and trusted data policies",
  "toolPolicy:create": "Register tools and create security policies",
  "toolPolicy:update":
    "Modify tools, tool configuration, and security policies",
  "toolPolicy:delete": "Remove tools and security policies",
  "mcpRegistry:read": "Browse the MCP server registry",
  "mcpRegistry:create": "Add servers to the MCP registry",
  "mcpRegistry:update": "Modify MCP registry entries",
  "mcpRegistry:delete": "Remove servers from the MCP registry",
  "mcpRegistry:manage-deleted":
    "View and restore soft-deleted MCP registry entries",
  "mcpRegistry:team-admin": "Manage team assignments for MCP registry entries",
  "mcpRegistry:deploy-to-restricted":
    "Deploy MCP servers (catalog items) to restricted environments",
  "mcpServerInstallation:read": "View installed MCP servers and their status",
  "mcpServerInstallation:create": "Install MCP servers from the registry",
  "mcpServerInstallation:update": "Modify installed MCP server configuration",
  "mcpServerInstallation:delete": "Uninstall MCP servers",
  "mcpServerInstallation:manage-deleted":
    "View and restore soft-deleted (uninstalled) MCP servers",
  "mcpServerInstallation:admin":
    "Approve or manage all MCP server installations",
  "environment:read": "View and list deployment environments",
  "environment:create": "Create deployment environments",
  "environment:update":
    "Modify deployment environments, including the org default environment",
  "environment:delete": "Delete deployment environments",
  "githubAppConfig:read": "View GitHub App configurations",
  "githubAppConfig:create": "Create GitHub App configurations",
  "githubAppConfig:update": "Modify GitHub App configurations",
  "githubAppConfig:delete": "Delete GitHub App configurations",

  // LLM
  "llmProxy:read": "View the LLM Proxy and its connection details",
  "llmProxy:update": "Modify LLM Proxy configuration",
  "llmProviderApiKey:read": "View LLM provider API keys",
  "llmProviderApiKey:create": "Add new LLM provider API keys",
  "llmProviderApiKey:update":
    "Modify LLM provider API key configuration and visibility",
  "llmProviderApiKey:delete": "Remove LLM provider API keys",
  "llmProviderApiKey:admin":
    "Manage all LLM provider API keys, including org-wide keys",
  "llmVirtualKey:read": "View LLM virtual keys",
  "llmVirtualKey:create": "Create LLM virtual keys",
  "llmVirtualKey:update": "Modify LLM virtual keys and their visibility",
  "llmVirtualKey:delete": "Delete LLM virtual keys",
  "llmVirtualKey:admin": "Manage all LLM virtual keys and view every scope",
  "llmOauthClient:read": "View LLM OAuth client registrations",
  "llmOauthClient:create": "Create LLM OAuth client registrations",
  "llmOauthClient:update": "Modify LLM OAuth client registrations",
  "llmOauthClient:delete": "Delete LLM OAuth client registrations",
  "llmOauthClient:team-admin":
    "Manage team assignments for LLM OAuth client registrations",
  "llmOauthClient:admin":
    "Manage all LLM OAuth client registrations, bypassing team restrictions",
  "llmModel:read": "View synced LLM models and capabilities",
  "llmModel:update":
    "Modify LLM model pricing, modality and generation-parameter settings",
  "llmLimit:read": "View token usage limits",
  "llmLimit:create": "Create new usage limits",
  "llmLimit:update": "Modify existing usage limits",
  "llmLimit:delete": "Remove usage limits",
  "llmSettings:read": "View LLM settings (compression, cleanup interval)",
  "llmSettings:update": "Modify LLM settings",
  "mcpSettings:read": "View MCP settings (online catalog availability)",
  "mcpSettings:update": "Modify MCP settings",
  "skillsSettings:read": "View Skills settings (online catalog availability)",
  "skillsSettings:update": "Modify Skills settings",
  "agentSettings:read":
    "View agent settings (default model, default agent, default tool guardrails, file uploads, Apps Hackathon recorder)",
  "agentSettings:update":
    "Modify agent settings (default model, default agent, default tool guardrails, file uploads, Apps Hackathon recorder)",
  "llmCost:read": "View LLM usage cost statistics and analytics",

  // Other
  "chat:read": "View and access chat conversations",
  "chat:create": "Start new chat conversations",
  "chat:update": "Edit chat messages and conversation settings",
  "chat:delete": "Delete chat conversations",
  "project:read": "View projects and your own chats inside them",
  "project:create": "Create projects",
  "project:update": "Edit project descriptions, instructions, and sharing",
  "project:delete": "Delete projects",
  "project:share-org":
    "Share projects with the entire organization, and change the sharing of or delete a project that is already org-wide. Without it, projects can still be shared with teams. Additive: sharing still requires project:update and deleting still requires project:delete.",
  "project:admin":
    "Oversee projects owned by other members: discover them, view/edit/delete the project and its sharing, and view, download, or delete their files — but not read their chats. Additive: edit/delete still require project:update/delete, and schedule management rides scheduledTask:admin (all included in the Admin role).",
  "project:read-all":
    "View chats that other members started in any project you can access. Without this, you only see the chats you started yourself — including in projects you own.",
  "file:manage": "List, read, write, and delete files in chats and projects",
  "log:read": "View your own LLM proxy and MCP tool call logs",
  "log:admin": "View every user's LLM proxy and MCP tool call logs",

  // Administration
  "member:read": "View organization members and their roles",
  "member:create": "Add new members to the organization",
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
  "invitation:create": "Send invitations to new users",
  "invitation:cancel": "Cancel pending invitations",
  "identityProvider:read": "View identity provider configurations (SSO)",
  "identityProvider:create": "Set up new identity providers",
  "identityProvider:update": "Modify identity provider settings",
  "identityProvider:delete": "Remove identity providers",
  "secret:read": "View secrets manager configuration",
  "secret:update": "Modify secrets manager settings and test connectivity",
  "apiKey:read": "View API keys",
  "apiKey:create": "Create API keys",
  "apiKey:delete": "Delete API keys",
  "serviceAccount:read": "View service accounts",
  "serviceAccount:create": "Create service accounts",
  "serviceAccount:update": "Modify service accounts",
  "serviceAccount:delete": "Delete service accounts",
  "auditLog:read": "View audit log records of your own administrative actions",
  "auditLog:admin":
    "View the organization-wide audit log of every member's administrative actions",
  "organizationSettings:read":
    "View organization settings (appearance, authentication, etc)",
  "organizationSettings:update":
    "Customize organization appearance, authentication, etc",
  "knowledgeSource:read": "View Knowledge Bases and Connectors",
  "knowledgeSource:create": "Create Knowledge Bases and Connectors",
  "knowledgeSource:update": "Modify Knowledge Bases and Connectors",
  "knowledgeSource:delete":
    "Delete Knowledge Bases and Connectors, view the deleted ones, and restore them",
  "knowledgeSource:query": "Query knowledge sources for information retrieval",
  "knowledgeSource:admin":
    "View all org-wide and team-scoped Knowledge Bases and Connectors, bypassing team visibility restrictions",
  "knowledgeSource:deploy-to-restricted":
    "Assign Knowledge Bases and Connectors to restricted deployment environments",
  "knowledgeSourceAutoSync:read":
    "View auto-sync-permissions connectors: configuration, sync runs, user groups, and member mappings",
  "knowledgeSourceAutoSync:create":
    "Create connectors with auto-sync permissions (access mirrors the source system)",
  "knowledgeSourceAutoSync:update":
    "Modify auto-sync-permissions connectors: settings, member mappings, and manual permission syncs",
  "knowledgeSourceAutoSync:delete": "Delete auto-sync-permissions connectors",
  "knowledgeSettings:read":
    "View knowledge settings (embedding and reranking models)",
  "knowledgeSettings:update":
    "Modify knowledge settings (embedding and reranking models)",

  // UI behavior
  "simpleView:enable": "Sidebar is collapsed by default on page load",
  "chatAgentPicker:enable": "Show agent picker in chat",
  "chatProviderSettings:enable": "Show model and API key selectors in chat",
  "chatExpandToolCalls:enable": "Allow expanding tool call details in chat",

  // Administration
  "siteNotification:read": "View site-wide notifications",
  "siteNotification:create": "Create new site notifications",
  "siteNotification:update": "Modify site notifications",
  "siteNotification:delete": "Delete site notifications",
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
  /**
   * Getting basic info about the organization requires the user to be
   * authenticated but no specific permission.
   */
  [RouteId.GetOrganization]: {},
  // Completing onboarding flips an org-wide flag, so gate it on admin-level
  // organization-settings update, like the other org-settings routes.
  [RouteId.CompleteOnboarding]: { organizationSettings: ["update"] },

  // Connection setup: resource-level checks (mcpGateway/llmProxy read access,
  // skill admin) are conditional on what the setup includes and enforced in
  // the route handler. The script GET is public (token-authenticated).
  [RouteId.CreateConnectionSetup]: {},
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
  /**
   * Existence check for a connected remote, used by the Claude Code startup
   * guard on machines with no session. Returns only ok/missing.
   * Note: Auth is skipped in middleware for this route.
   */
  [RouteId.GetConnectionHealth]: {},

  // Generic agent CRUD routes - enforcement is handled dynamically in route handlers
  // based on agentType (agent, mcp_gateway, llm_proxy map to agent, mcpGateway, llmProxy resources)
  [RouteId.GetAgents]: {},
  [RouteId.GetAllAgents]: {},
  [RouteId.GetAgentCredentialReadiness]: {},
  [RouteId.GetAgent]: {},
  [RouteId.CreateAgent]: {},
  [RouteId.CloneAgent]: {},
  [RouteId.UpdateAgent]: {},
  [RouteId.BulkUpdateAgents]: {},
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
  // Tool exclusions: agent-type read/update permission checked dynamically in handler
  [RouteId.GetAgentToolExclusions]: {},
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
  [RouteId.GetAllAgentTools]: {
    toolPolicy: ["read"],
  },
  [RouteId.GetAgentAvailableTokens]: {},
  [RouteId.GetUnassignedTools]: {
    toolPolicy: ["read"],
  },
  // Tool-assignment routes: agent-type update checked dynamically in handler
  [RouteId.AssignToolToAgent]: {},
  [RouteId.BulkAssignTools]: {},
  [RouteId.BulkUpdateAgentTools]: {},
  [RouteId.AutoConfigureAgentToolPolicies]: {
    toolPolicy: ["update"],
  },
  [RouteId.UnassignToolFromAgent]: {},
  [RouteId.UpdateAgentTool]: {
    toolPolicy: ["update"],
  },
  // Labels are cross-type — any agent-type read permission suffices (checked in handler)
  [RouteId.GetLabelKeys]: {},
  [RouteId.GetLabelValues]: {},
  [RouteId.GetTokens]: {
    team: ["read"],
  },
  [RouteId.GetTokenValue]: {
    team: ["read"],
  },
  [RouteId.RotateToken]: {
    team: ["read"],
  },
  [RouteId.GetTool]: {
    toolPolicy: ["read"],
  },
  [RouteId.GetTools]: {
    toolPolicy: ["read"],
  },
  [RouteId.GetToolsWithAssignments]: {
    toolPolicy: ["read"],
  },
  [RouteId.GetToolObservers]: {
    toolPolicy: ["read"],
  },
  [RouteId.DeleteTool]: {
    toolPolicy: ["delete"],
  },
  [RouteId.GetInteractions]: {
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
  [RouteId.GetOperators]: {
    toolPolicy: ["read"],
  },
  [RouteId.GetToolInvocationPolicies]: {
    toolPolicy: ["read"],
  },
  [RouteId.CreateToolInvocationPolicy]: {
    toolPolicy: ["create"],
  },
  [RouteId.GetToolInvocationPolicy]: {
    toolPolicy: ["read"],
  },
  [RouteId.UpdateToolInvocationPolicy]: {
    toolPolicy: ["update"],
  },
  [RouteId.DeleteToolInvocationPolicy]: {
    toolPolicy: ["delete"],
  },
  [RouteId.BulkUpsertDefaultCallPolicy]: {
    toolPolicy: ["update"],
  },
  [RouteId.GetTrustedDataPolicies]: {
    toolPolicy: ["read"],
  },
  [RouteId.CreateTrustedDataPolicy]: {
    toolPolicy: ["create"],
  },
  [RouteId.GetTrustedDataPolicy]: {
    toolPolicy: ["read"],
  },
  [RouteId.UpdateTrustedDataPolicy]: {
    toolPolicy: ["update"],
  },
  [RouteId.DeleteTrustedDataPolicy]: {
    toolPolicy: ["delete"],
  },
  [RouteId.BulkUpsertDefaultResultPolicy]: {
    toolPolicy: ["update"],
  },
  [RouteId.GetInternalMcpCatalog]: {
    mcpRegistry: ["read"],
  },
  [RouteId.CreateInternalMcpCatalogItem]: {
    mcpRegistry: ["create"],
  },
  [RouteId.GetInternalMcpCatalogItem]: {
    mcpRegistry: ["read"],
  },
  [RouteId.GetInternalMcpCatalogTools]: {
    mcpRegistry: ["read"],
  },
  [RouteId.GetInternalMcpCatalogToolsBatch]: {
    mcpRegistry: ["read"],
  },
  [RouteId.UpdateInternalMcpCatalogItem]: {
    mcpRegistry: ["update"],
  },
  [RouteId.ReinstallInternalMcpCatalogItem]: {
    mcpRegistry: ["update"],
  },
  [RouteId.RefreshInternalMcpCatalogImage]: {
    mcpRegistry: ["update"],
  },
  [RouteId.DeleteInternalMcpCatalogItem]: {
    mcpRegistry: ["delete"],
  },
  [RouteId.DeleteInternalMcpCatalogItemByName]: {
    mcpRegistry: ["delete"],
  },
  // Deleted-resource lifecycle is its own capability, granted by default to
  // admins only — delete does not imply the ability to see or revive tombstones.
  [RouteId.RestoreInternalMcpCatalogItem]: {
    mcpRegistry: ["manage-deleted"],
  },
  [RouteId.GetInternalMcpCatalogLabelKeys]: {
    mcpRegistry: ["read"],
  },
  [RouteId.GetInternalMcpCatalogLabelValues]: {
    mcpRegistry: ["read"],
  },
  [RouteId.ListPendingImageApprovalCatalogItems]: {
    mcpServerInstallation: ["admin"],
  },
  [RouteId.ApproveCatalogItemImage]: {
    mcpServerInstallation: ["admin"],
  },
  [RouteId.GetDeploymentYamlPreview]: {
    mcpRegistry: ["read"],
  },
  [RouteId.ValidateDeploymentYaml]: {
    mcpRegistry: ["read"],
  },
  [RouteId.ResetDeploymentYaml]: {
    mcpRegistry: ["update"],
  },
  [RouteId.GetK8sImagePullSecrets]: {
    mcpRegistry: ["read"],
  },
  [RouteId.GetMcpServers]: {
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
  // Deleted-resource lifecycle is its own capability, granted by default to
  // admins only — delete does not imply the ability to see or revive tombstones.
  [RouteId.RestoreMcpServer]: {
    mcpServerInstallation: ["manage-deleted"],
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
    // recreates the pod for EVERY install sharing it, so it is gated on the
    // org-wide :admin capability rather than the per-connection scope rules
    // the other lifecycle routes use. A connection's own owner must not be
    // able to reset a shared multitenant deployment out from under the other
    // installs on it.
    mcpServerInstallation: ["admin"],
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
  [RouteId.UpdateTeam]: {
    team: ["read"],
  },
  [RouteId.BulkDeleteTeams]: { team: ["delete"] },
  [RouteId.DeleteTeam]: {
    team: ["delete"],
  },
  [RouteId.GetTeamMembers]: {
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
  [RouteId.GetChatConversationFiles]: {
    chat: ["read"],
  },
  [RouteId.GetChatAttachmentContent]: {
    chat: ["read"],
  },
  [RouteId.DeleteChatAttachment]: {
    chat: ["update"],
  },
  [RouteId.GetChatAgentMcpTools]: {
    agent: ["read"],
  },
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
  [RouteId.GetLlmModels]: {
    llmModel: ["read"],
  },
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
  [RouteId.ShareConversation]: {
    chat: ["update"],
  },
  [RouteId.UnshareConversation]: {
    chat: ["update"],
  },
  [RouteId.GetConversationShare]: {
    chat: ["read"],
  },
  [RouteId.GetSharedConversation]: {
    chat: ["read"],
  },
  [RouteId.ForkSharedConversation]: {
    chat: ["create"],
  },
  [RouteId.GetLlmProviderApiKeys]: {
    llmProviderApiKey: ["read"],
  },
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
  // Same self-service rationale for the X Premium (SuperGrok) device flow: it
  // only obtains the caller's own OAuth credential for a new personal xAI
  // (X Premium subscription) key.
  [RouteId.XaiSubscriptionDeviceAuthStart]: {},
  [RouteId.XaiSubscriptionDeviceAuthPoll]: {},
  [RouteId.GetLlmProviderApiKey]: {
    llmProviderApiKey: ["read"],
  },
  [RouteId.UpdateLlmProviderApiKey]: {
    llmProviderApiKey: ["update"],
  },
  // Self-service like the create route and the device flows: reconnecting your
  // OWN personal subscription key after its sign-in expires must not require
  // llmProviderApiKey:update, or default members complete the device flow and
  // then can't save the refreshed credential. The handler restricts it to the
  // caller's own personal key holding subscription material.
  [RouteId.ReconnectLlmProviderApiKey]: {},
  [RouteId.DeleteLlmProviderApiKey]: {
    llmProviderApiKey: ["delete"],
  },
  [RouteId.BulkDeleteLlmProviderApiKeys]: {
    llmProviderApiKey: ["read", "delete"],
  },
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
  [RouteId.GetServiceAccounts]: {
    serviceAccount: ["read"],
  },
  [RouteId.GetServiceAccount]: {
    serviceAccount: ["read"],
  },
  [RouteId.CreateServiceAccount]: {
    serviceAccount: ["create"],
  },
  [RouteId.UpdateServiceAccount]: {
    serviceAccount: ["update"],
  },
  [RouteId.BulkDeleteServiceAccounts]: { serviceAccount: ["delete"] },
  [RouteId.BulkSetServiceAccountsDisabled]: { serviceAccount: ["update"] },
  [RouteId.DeleteServiceAccount]: {
    serviceAccount: ["delete"],
  },
  [RouteId.CreateServiceAccountToken]: {
    serviceAccount: ["update"],
  },
  [RouteId.UpdateServiceAccountToken]: {
    serviceAccount: ["update"],
  },
  [RouteId.DeleteServiceAccountToken]: {
    serviceAccount: ["update"],
  },
  [RouteId.GetAllVirtualApiKeys]: {
    llmVirtualKey: ["read"],
  },
  [RouteId.GetVirtualApiKey]: {
    llmVirtualKey: ["read"],
  },
  // Reveals the raw key value; restricted to the key's author in the handler.
  [RouteId.GetVirtualApiKeyValue]: {
    llmVirtualKey: ["read"],
  },
  [RouteId.CreateVirtualApiKey]: {
    llmVirtualKey: ["create"],
  },
  [RouteId.UpdateVirtualApiKey]: {
    llmVirtualKey: ["update"],
  },
  [RouteId.DeleteVirtualApiKey]: {
    llmVirtualKey: ["delete"],
  },
  [RouteId.BulkDeleteVirtualApiKeys]: {
    llmVirtualKey: ["delete"],
  },
  [RouteId.GetLlmOauthClients]: {
    llmOauthClient: ["read"],
  },
  [RouteId.CreateLlmOauthClient]: {
    llmOauthClient: ["create"],
  },
  [RouteId.UpdateLlmOauthClient]: {
    llmOauthClient: ["update"],
  },
  [RouteId.RotateLlmOauthClientSecret]: {
    llmOauthClient: ["update"],
  },
  [RouteId.DeleteLlmOauthClient]: {
    llmOauthClient: ["delete"],
  },
  [RouteId.BulkDeleteLlmOauthClients]: {
    llmOauthClient: ["delete"],
  },
  [RouteId.GetMcpOauthClients]: {
    mcpOauthClient: ["read"],
  },
  [RouteId.CreateMcpOauthClient]: {
    mcpOauthClient: ["create"],
  },
  [RouteId.UpdateMcpOauthClient]: {
    mcpOauthClient: ["update"],
  },
  [RouteId.RotateMcpOauthClientSecret]: {
    mcpOauthClient: ["update"],
  },
  [RouteId.DeleteMcpOauthClient]: {
    mcpOauthClient: ["delete"],
  },
  [RouteId.GetModelsWithApiKeys]: {
    llmModel: ["read"],
  },
  [RouteId.BulkUpdateModels]: { llmModel: ["update"] },
  [RouteId.UpdateModel]: {
    llmModel: ["update"],
  },
  // Delegation routes: agent-type permission checked dynamically in handler
  [RouteId.GetAgentDelegations]: {},
  [RouteId.SyncAgentDelegations]: {},
  [RouteId.DeleteAgentDelegation]: {},
  [RouteId.GetAllDelegationConnections]: {},
  [RouteId.GetLimits]: {
    llmLimit: ["read"],
  },
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
  [RouteId.DeleteDefaultUserLimit]: {
    llmLimit: ["delete"],
  },
  [RouteId.UpdateAppearanceSettings]: {
    organizationSettings: ["update"],
  },
  [RouteId.UpdateSecuritySettings]: {
    agentSettings: ["update"],
  },
  [RouteId.UpdateLlmSettings]: {
    llmSettings: ["update"],
  },
  [RouteId.UpdateMcpSettings]: {
    mcpSettings: ["update"],
  },
  [RouteId.UpdateSkillsSettings]: {
    skillsSettings: ["update"],
  },
  [RouteId.UpdateAgentSettings]: {
    agentSettings: ["update"],
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
    githubAppConfig: ["read"],
  },
  [RouteId.GetGithubAppConfig]: {
    githubAppConfig: ["read"],
  },
  [RouteId.CreateGithubAppConfig]: {
    githubAppConfig: ["create"],
  },
  [RouteId.UpdateGithubAppConfig]: {
    githubAppConfig: ["update"],
  },
  [RouteId.DeleteGithubAppConfig]: {
    githubAppConfig: ["delete"],
  },
  // stored PATs share the githubAppConfig resource: both are org GitHub
  // credentials managed on the same settings page by the same audience
  [RouteId.ListGithubPats]: {
    githubAppConfig: ["read"],
  },
  [RouteId.CreateGithubPat]: {
    githubAppConfig: ["create"],
  },
  [RouteId.UpdateGithubPat]: {
    githubAppConfig: ["update"],
  },
  [RouteId.DeleteGithubPat]: {
    githubAppConfig: ["delete"],
  },
  [RouteId.UpdateKnowledgeSettings]: {
    knowledgeSettings: ["update"],
  },
  [RouteId.DropEmbeddingConfig]: {
    knowledgeSettings: ["update"],
  },
  [RouteId.TestEmbeddingConnection]: {
    knowledgeSettings: ["update"],
  },
  [RouteId.TestRerankerConnection]: {
    knowledgeSettings: ["update"],
  },
  [RouteId.TestOcrConnection]: {
    knowledgeSettings: ["update"],
  },
  [RouteId.GetKeywordRankingStatus]: {
    knowledgeSettings: ["read"],
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
  [RouteId.GetFeedbackPopupActivation]: { organizationSettings: ["update"] }, // Feedback pop-up activation signal - admins only (the pop-up is admin-only)
  [RouteId.GetMemberSignupStatus]: {}, // Member signup status - available to all authenticated users
  [RouteId.GetMembers]: { member: ["read"] }, // List organization members (paginated)
  [RouteId.BulkDeleteMembers]: { member: ["delete"] },
  // Visibility is scoped in the handler: member:read sees the full roster,
  // everyone else only the users they share a team with (the chat share
  // recipient picker), so the route itself is open to any authenticated user.
  [RouteId.GetOrganizationMembers]: {},
  [RouteId.GetOrganizationMember]: { member: ["read"] }, // Get organization member by ID or email
  [RouteId.DeletePendingSignupMember]: { member: ["delete"] }, // Delete auto-provisioned member who hasn't signed up
  [RouteId.GetUserPermissions]: {}, // User permissions route - available to all authenticated users (no specific permissions required)
  [RouteId.GetImpersonableUsers]: { member: ["impersonate"] }, // Role debugger picker (the impersonate-user call itself is also gated on member:impersonate in the auth before-hook)

  // Member default routes - available to all authenticated users (manages their own defaults)
  [RouteId.GetMemberDefaultAgent]: {},
  [RouteId.UpdateMemberDefaultAgent]: {},
  [RouteId.GetMemberDefaultModel]: {},
  [RouteId.UpdateMemberDefaultModel]: {},

  // User token routes - available to all authenticated users (manages their own personal token)
  [RouteId.GetUserToken]: {},
  [RouteId.GetUserTokenValue]: {},
  [RouteId.RotateUserToken]: {},
  [RouteId.GetTeamStatistics]: {
    llmCost: ["read"],
  },
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
  [RouteId.GetCostSavingsStatistics]: {
    llmCost: ["read"],
  },
  // Secrets Routes
  [RouteId.GetSecretsType]: {
    secret: ["read"],
  },
  [RouteId.CheckSecretsConnectivity]: {
    secret: ["update"],
  },
  [RouteId.GetSecret]: {
    secret: ["read"],
  },

  // Incoming Email Routes
  [RouteId.GetIncomingEmailStatus]: {
    agentTrigger: ["read"],
  },
  [RouteId.SetupIncomingEmailWebhook]: {
    agentTrigger: ["create"],
  },
  [RouteId.RenewIncomingEmailSubscription]: {
    agentTrigger: ["update"],
  },
  [RouteId.DeleteIncomingEmailSubscription]: {
    agentTrigger: ["delete"],
  },
  [RouteId.GetAgentEmailAddress]: {}, // Any authenticated user can view agent email addresses

  // ChatOps Routes
  [RouteId.GetChatOpsStatus]: {
    agentTrigger: ["read"],
  },
  [RouteId.ListChatOpsBindings]: {
    agentTrigger: ["read"],
  },
  [RouteId.DeleteChatOpsBinding]: {
    agentTrigger: ["delete"],
  },
  [RouteId.UpdateChatOpsBinding]: {
    agentTrigger: ["update"],
  },
  [RouteId.BulkUpdateChatOpsBindings]: {
    agentTrigger: ["update"],
  },
  [RouteId.CreateChatOpsDmBinding]: {
    agentTrigger: ["create"],
  },
  [RouteId.UpdateChatOpsConfigInQuickstart]: {
    agentTrigger: ["update"],
  },
  [RouteId.UpdateSlackChatOpsConfig]: {
    agentTrigger: ["update"],
  },
  [RouteId.UpdateTelegramChatOpsConfig]: {
    agentTrigger: ["update"],
  },
  // Any authenticated user can link their own Telegram account
  [RouteId.LinkTelegramChatOpsAccount]: {},
  [RouteId.GenerateTelegramLinkCode]: {},
  [RouteId.ConnectNgrok]: {
    agentTrigger: ["update"],
  },
  [RouteId.DisconnectNgrok]: {
    agentTrigger: ["update"],
  },
  [RouteId.GetNgrokConfig]: {
    agentTrigger: ["read"],
  },
  [RouteId.RefreshChatOpsChannelDiscovery]: {
    agentTrigger: ["read"],
  },
  // Schedule Trigger Routes
  [RouteId.GetScheduleTriggers]: {
    scheduledTask: ["read"],
  },
  [RouteId.CreateScheduleTrigger]: {
    scheduledTask: ["create"],
  },
  [RouteId.GetScheduleTrigger]: {
    scheduledTask: ["read"],
  },
  [RouteId.UpdateScheduleTrigger]: {
    scheduledTask: ["update"],
  },
  [RouteId.DeleteScheduleTrigger]: {
    scheduledTask: ["delete"],
  },
  [RouteId.EnableScheduleTrigger]: {
    scheduledTask: ["update"],
  },
  [RouteId.DisableScheduleTrigger]: {
    scheduledTask: ["update"],
  },
  [RouteId.RunScheduleTriggerNow]: {
    scheduledTask: ["create"],
  },
  [RouteId.GetScheduleTriggerRuns]: {
    scheduledTask: ["read"],
  },
  [RouteId.GetScheduleTriggerRun]: {
    scheduledTask: ["read"],
  },
  [RouteId.CreateScheduleTriggerRunConversation]: {
    scheduledTask: ["create"],
  },

  // Knowledge Base Routes
  [RouteId.GetKnowledgeBases]: { knowledgeSource: ["read"] },
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
  [RouteId.TriggerPermissionSync]: { knowledgeSourceAutoSync: ["update"] },
  [RouteId.GetPermissionSyncCoverage]: { knowledgeSourceAutoSync: ["read"] },
  [RouteId.GetConnectorUserGroups]: { knowledgeSourceAutoSync: ["read"] },
  [RouteId.UpsertConnectorMemberOverride]: {
    knowledgeSourceAutoSync: ["update"],
  },
  [RouteId.DeleteConnectorMemberOverride]: {
    knowledgeSourceAutoSync: ["update"],
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
  [RouteId.GetSkills]: { skill: ["read"] },
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
  [RouteId.ConvertAgentToSkill]: { skill: ["create"], agent: ["read"] },
  // chat:read gates spending the agent's configured LLM key — the same gate
  // every other resolveAgentLlmOrDefault path (chat, compaction) sits behind.
  [RouteId.SuggestSkillDescription]: {
    skill: ["create"],
    agent: ["read"],
    chat: ["read"],
  },
  [RouteId.GetSkill]: { skill: ["read"] },
  [RouteId.UpdateSkill]: { skill: ["update"] },
  [RouteId.BulkUpdateSkillsVisibility]: { skill: ["update"] },
  [RouteId.DeleteSkill]: { skill: ["delete"] },
  [RouteId.BulkDeleteSkills]: { skill: ["delete"] },
  [RouteId.RestoreSkill]: { skill: ["delete"] },
  // Permanent deletion is irreversible, so the handler narrows this further to
  // a built-in admin ROLE — no skill permission, `skill:admin` included, gets
  // you past the trash.
  [RouteId.PermanentlyDeleteSkill]: { skill: ["delete"] },
  [RouteId.ResetSkill]: { skill: ["update"] },
  [RouteId.UpdateSkillGithubSync]: { skill: ["update"] },
  [RouteId.GetPlugins]: { plugin: ["read"] },
  [RouteId.CreatePlugin]: { plugin: ["create", "admin"] },
  [RouteId.GetPlugin]: { plugin: ["read", "admin"] },
  [RouteId.UpdatePlugin]: { plugin: ["update", "admin"] },
  [RouteId.DeletePlugin]: { plugin: ["delete", "admin"] },
  [RouteId.PreviewGithubPlugin]: { plugin: ["create", "admin"] },
  [RouteId.ImportGithubPlugin]: { plugin: ["create", "admin"] },
  [RouteId.PreviewGithubPluginUpdate]: { plugin: ["update", "admin"] },
  [RouteId.ApplyGithubPluginUpdate]: { plugin: ["update", "admin"] },
  [RouteId.DiscoverGithubPluginMarketplace]: {
    plugin: ["create", "admin"],
  },
  [RouteId.ImportGithubPluginMarketplace]: {
    plugin: ["create", "admin"],
  },
  [RouteId.UpdatePluginGithubSync]: { plugin: ["update", "admin"] },
  [RouteId.TriggerPluginGithubSync]: { plugin: ["update", "admin"] },
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
  [RouteId.GetSkillUsageStatistics]: { skill: ["read"] },
  [RouteId.GetSkillVersions]: { skill: ["read"] },
  [RouteId.GetSkillVersion]: { skill: ["read"] },
  [RouteId.EnableSkillToolDefaults]: { skill: ["admin"] },
  // matches the `download_file` tool (sandbox:execute) that hands out this
  // URL, so a role allowed to produce an artifact can also fetch it.
  [RouteId.GetSkillSandboxArtifact]: { sandbox: ["execute"] },
  [RouteId.GetSkillSandboxConversationArtifacts]: { sandbox: ["execute"] },
  [RouteId.CreateProject]: { project: ["create"] },
  // Owner-scoped: a caller may only convert their own chat, so `project:create`
  // is the capability gate (matching the create_project_from_conversation MCP
  // tool's RBAC). The owner can always read their own chat.
  [RouteId.CreateProjectFromConversation]: { project: ["create"] },
  [RouteId.GetProjects]: { project: ["read"] },
  [RouteId.GetProject]: { project: ["read"] },
  [RouteId.UpdateProject]: { project: ["update"] },
  [RouteId.SetProjectShare]: { project: ["update"] },
  [RouteId.BulkUpdateProjects]: { project: ["update"] },
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
  // Project file surfaces combine project-level access with the files gate:
  // `file:manage` covers the file operations, while project membership is
  // still enforced in the handler (projectService.listFiles/uploadFile ->
  // requireReadable). Note the artifact byte endpoint that serves file
  // contents (GetSkillSandboxArtifact) stays on `sandbox:execute`.
  [RouteId.GetProjectFiles]: { project: ["read"], file: ["manage"] },
  [RouteId.UploadProjectFiles]: { project: ["read"], file: ["manage"] },
  // Instructions are plain project metadata (not a sandbox byte surface), so the
  // GET needs only project read — every project reader can see the instructions
  // that steer the project's chats. Editing is owner-only, enforced in the
  // handler on top of project:update.
  [RouteId.GetProjectInstructions]: { project: ["read"] },
  [RouteId.SetProjectInstructions]: { project: ["update"] },
  [RouteId.PinProject]: { project: ["read"] },
  [RouteId.UnpinProject]: { project: ["read"] },
  [RouteId.DeleteSkillSandboxArtifact]: { sandbox: ["execute"] },
  // Editing a file's text content shares the delete path's authorization
  // (author / project access), enforced per-file in the store handler.
  [RouteId.UpdateSkillSandboxArtifactContent]: { sandbox: ["execute"] },

  // Audit Log Routes
  [RouteId.GetAuditLogs]: {
    auditLog: ["read"],
  },
  [RouteId.GetAuditLog]: {
    auditLog: ["read"],
  },

  // Skill Share Link Routes - admin-only. Per-skill org-isolation enforced in handlers.
  // The public marketplace git endpoint stays outside this map; it is allowlisted in
  // the auth middleware (`SKILL_MARKETPLACE_PREFIX`), mirroring `MCP_GATEWAY_PREFIX`.
  // The static marketplace's clone URL and name — what any user needs to
  // install the skills they can already read. Gated on the same permission as
  // listing skills, not on skill:admin.
  [RouteId.GetSkillMarketplace]: { skill: ["read"] },
  [RouteId.GetSkillShareLinks]: { skill: ["admin"] },
  [RouteId.CreateSkillShareLink]: { skill: ["admin"] },
  [RouteId.RevokeSkillShareLink]: { skill: ["admin"] },
  [RouteId.RotateSkillShareLink]: { skill: ["admin"] },

  // MCP App Routes - per-instance scope is enforced in the handlers
  [RouteId.GetApps]: { app: ["read"] },
  [RouteId.GetExternalApp]: { app: ["read"] },
  [RouteId.CreateApp]: { app: ["create"] },
  [RouteId.GetApp]: { app: ["read"] },
  [RouteId.UpdateApp]: { app: ["update"] },
  // Enable/disable is a lifecycle transition, not a metadata edit; gated like
  // an update (the handler further requires scope-modify at the app's scope).
  [RouteId.EnableApp]: { app: ["update"] },
  [RouteId.DisableApp]: { app: ["update"] },
  [RouteId.LockApp]: { app: ["update"] },
  [RouteId.UnlockApp]: { app: ["update"] },
  [RouteId.BulkUpdateApps]: { app: ["update"] },
  [RouteId.BulkDeleteApps]: { app: ["delete"] },
  [RouteId.DeleteApp]: { app: ["delete"] },
  [RouteId.GetAppVersions]: { app: ["read"] },
  [RouteId.GetAppVersion]: { app: ["read"] },
  [RouteId.GetAppTools]: { app: ["read"] },
  [RouteId.AssignToolToApp]: { app: ["update"] },
  [RouteId.UnassignToolFromApp]: { app: ["update"] },
  [RouteId.GetAppTemplates]: { app: ["read"] },
  [RouteId.GetAppLabelKeys]: { app: ["read"] },
  [RouteId.GetAppLabelValues]: { app: ["read"] },
  // Opens an app in chat: reads the app and creates a seeded conversation.
  [RouteId.OpenAppInChat]: { app: ["read"], chat: ["create"] },
  [RouteId.OpenExternalAppInChat]: { app: ["read"], chat: ["create"] },
  // Per-user app pins (mirrors PinProject/UnpinProject): any viewer may pin —
  // the handlers gate per-instance visibility; unpin is intentionally
  // unchecked there so stale pins can always be cleared.
  [RouteId.PinApp]: { app: ["read"] },
  [RouteId.UnpinApp]: { app: ["read"] },
  [RouteId.PinExternalApp]: { app: ["read"] },
  [RouteId.UnpinExternalApp]: { app: ["read"] },
  // The trusted host page reports a viewer's render diagnostics; the handler
  // re-checks app-visibility, so app:read is the right coarse gate.
  [RouteId.PostAppRenderDiagnostics]: { app: ["read"] },
  // Same trust model as diagnostics: the host page posts the viewer's render
  // screenshot, the handler re-checks app-visibility.
  [RouteId.PostAppRenderScreenshot]: { app: ["read"] },
  // App session recordings live client-side (IndexedDB); sharing forwards a
  // client-assembled plugin to the public demo catalog. Any viewer of an app
  // they can see may share their own recording; the handler re-checks app
  // visibility and the feature flag.
  // Reads the recording's conversation to draft the enhancement, so it takes
  // the same permission as the chat-scoped generation routes.
  [RouteId.EnhanceAppRecording]: { chat: ["update"] },
  [RouteId.RenderAppRecordingVideo]: { chat: ["update"] },
  [RouteId.GetAppRecordingRenderStatus]: { chat: ["update"] },
  [RouteId.DownloadAppRecordingVideo]: { chat: ["update"] },
  [RouteId.CancelAppRecordingRender]: { chat: ["update"] },
  // Reviewing a hackathon submission: any authenticated org member may open the
  // read-only review player. The plugin it serves is public GitHub data fetched
  // server-side, so no per-resource permission is required beyond being signed in.
  [RouteId.ReviewAppRecording]: {},
  // Same chat-scoped permission as the recording routes above: sharing starts
  // from the player inside a chat session; the handler re-checks the feature
  // gates.
  [RouteId.AppGalleryDeviceAuthStart]: { chat: ["update"] },
  [RouteId.AppGalleryDeviceAuthPoll]: { chat: ["update"] },

  // Config endpoint - any authenticated user can access
  [RouteId.GetConfig]: {},

  // Site Notification Routes
  [RouteId.GetSiteNotification]: { siteNotification: ["read"] },
  [RouteId.GetSiteNotificationSettings]: { siteNotification: ["read"] },
  [RouteId.CreateSiteNotification]: { siteNotification: ["create"] },
  [RouteId.UpdateSiteNotification]: { siteNotification: ["update"] },
  [RouteId.DeleteSiteNotification]: { siteNotification: ["delete"] },

  // Hook File Routes
  [RouteId.GetHooks]: {
    agent: ["read"],
  },
  [RouteId.CreateHook]: {
    agent: ["update"],
  },
  [RouteId.UpdateHook]: {
    agent: ["update"],
  },
  [RouteId.DeleteHook]: {
    agent: ["update"],
  },

  // MCP Gateway Routes - available to all authenticated users
  [RouteId.McpGatewayGet]: {}, // Server discovery endpoint
  [RouteId.McpGatewayPost]: {}, // JSON-RPC endpoint for resources/read and tools/call
  [RouteId.McpProxyPost]: {}, // Frontend proxy to MCP Gateway with session auth
  [RouteId.McpServerProxyPost]: {}, // Server-scoped Apps proxy; access enforced in-handler
  // App-bound MCP proxy: app access + visibility/allowlist gate enforced in the handler
  [RouteId.McpAppProxyPost]: {},

  // Knowledge files. Reads are `knowledgeSource:read` like every other
  // knowledge surface; indexing a file into a base changes what agents can
  // retrieve, so it is an `update` rather than a read.
  [RouteId.GetKnowledgeFiles]: { knowledgeSource: ["read"] },
  [RouteId.GetKnowledgeFileContent]: { knowledgeSource: ["read"] },
  [RouteId.GetKnowledgeDirectories]: { knowledgeSource: ["read"] },
  [RouteId.UploadKnowledgeFile]: { knowledgeSource: ["create"] },
  [RouteId.PromoteAttachmentToKnowledgeFile]: { knowledgeSource: ["create"] },
  [RouteId.CreateKnowledgeDirectory]: { knowledgeSource: ["create"] },
  [RouteId.IndexKnowledgeFiles]: { knowledgeSource: ["update"] },
  [RouteId.UpdateKnowledgeFile]: { knowledgeSource: ["update"] },
  [RouteId.UpdateKnowledgeDirectory]: { knowledgeSource: ["update"] },
  [RouteId.DeleteKnowledgeFile]: { knowledgeSource: ["delete"] },
  [RouteId.BulkUpdateKnowledgeFiles]: { knowledgeSource: ["update"] },
  [RouteId.BulkDeleteKnowledgeFiles]: { knowledgeSource: ["delete"] },
  [RouteId.BulkUpdateKnowledgeDirectories]: { knowledgeSource: ["update"] },
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
  "/agents/new": { agent: ["create"] },
  "/messaging-channels": { agentTrigger: ["read"] },
  "/messaging-channels/slack": { agentTrigger: ["read"] },
  "/messaging-channels/ms-teams": { agentTrigger: ["read"] },
  "/messaging-channels/email": { agentTrigger: ["read"] },
  "/skills": { skill: ["read"] },
  "/skills/new": { skill: ["create"] },
  "/plugins": { plugin: ["read"] },
  "/plugins/new": { plugin: ["create", "admin"] },
  "/plugins/import": { plugin: ["create", "admin"] },
  "/plugins/[id]": { plugin: ["read", "admin"] },
  "/scheduled-tasks": { scheduledTask: ["read"] },

  // Apps
  "/apps": { app: ["read"] },
  "/apps/[id]": { app: ["read"] },
  "/apps/[id]/run": { app: ["read"] },
  "/apps/server/[mcpServerId]/run": { app: ["read"] },

  // LLM
  "/llm/proxy": { llmProxy: ["read"] },
  "/llm/proxy/virtual-keys": { llmVirtualKey: ["read"] },
  "/llm/proxy/oauth-clients": { llmOauthClient: ["read"] },
  "/llm/model-providers": { llmProviderApiKey: ["read"] },
  "/llm/models": { llmModel: ["read"] },
  // Intentionally ungated: this page is fixed to the caller's own usage.
  "/llm/usage": {},
  "/llm/costs": { llmCost: ["read"] },
  "/llm/limits": { llmLimit: ["read"] },

  // MCP
  "/mcp/registry": { mcpRegistry: ["read"] },
  "/mcp/registry/new": { mcpRegistry: ["create"] },
  "/mcp/gateways": { mcpGateway: ["read"] },
  "/mcp/gateways/new": { mcpGateway: ["create"] },

  "/mcp/tool-policies": { toolPolicy: ["read"] },
  "/mcp/tool-guardrails": { toolPolicy: ["read"] },

  // Logs
  "/llm/logs": { log: ["read"] },
  "/mcp/logs": { log: ["read"] },
  "/audit/logs": { auditLog: ["read"] },

  // Knowledge
  "/knowledge/knowledge-bases": { knowledgeSource: ["read"] },
  "/knowledge/connectors": { knowledgeSource: ["read"] },

  // Settings
  "/settings/service-accounts": { serviceAccount: ["read"] },
  "/settings/llm": { llmSettings: ["read"] },
  "/settings/mcp": { mcpSettings: ["read"] },
  "/settings/skills": { skillsSettings: ["read"] },
  "/settings/agents": { agentSettings: ["read"] },
  "/settings/apps": { agentSettings: ["read"] },
  "/settings/security": { agentSettings: ["read"] },
  "/settings/environments": { environment: ["update"] },
  "/settings/knowledge": { knowledgeSettings: ["read"] },
  "/settings/users": { member: ["read"] },
  "/settings/teams": { team: ["read"] },
  "/settings/roles": { ac: ["read"] },
  "/settings/identity-providers": { identityProvider: ["read"] },
  "/settings/secrets": { secret: ["read"] },
  "/settings/github": { githubAppConfig: ["read"] },
  "/settings/appearance": { organizationSettings: ["read"] },
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

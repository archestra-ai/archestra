/**
 * Defines the RBAC (Role-Based Access Control) for the platform
 */

import { defaultStatements } from "better-auth/plugins/organization/access";
import type { Action, Permissions, Resource } from "./permission.types";
import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
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
  agent: ["read", "create", "update", "delete", "team-admin", "admin"],
  skill: ["read", "create", "update", "delete", "team-admin", "admin"],
  app: ["read", "create", "update", "delete", "team-admin", "admin"],
  sandbox: ["execute"],
  agentTrigger: ["read", "create", "update", "delete"],
  scheduledTask: ["read", "create", "update", "delete", "admin"],

  // LLM
  llmProxy: ["read", "create", "update", "delete", "team-admin", "admin"],
  llmProviderApiKey: ["read", "create", "update", "delete", "admin"],
  llmVirtualKey: ["read", "create", "update", "delete", "admin"],
  llmOauthClient: ["read", "create", "update", "delete", "admin"],
  llmModel: ["read", "update"],
  llmLimit: ["read", "create", "update", "delete"],
  optimizationRule: ["read", "create", "update", "delete"],
  llmCost: ["read"],

  // MCP
  mcpGateway: ["read", "create", "update", "delete", "team-admin", "admin"],
  mcpOauthClient: ["read", "create", "update", "delete", "admin"],
  toolPolicy: ["read", "create", "update", "delete"],
  mcpRegistry: ["read", "create", "update", "delete", "team-admin"],
  mcpServerInstallation: ["read", "create", "update", "delete", "admin"],
  mcpServerInstallationRequest: ["read", "create", "update", "delete", "admin"],
  environment: ["admin", "deploy-to-restricted"],
  githubAppConfig: ["read", "create", "update", "delete"],

  // Knowledge
  knowledgeFile: ["read", "create", "update", "delete", "admin"],
  knowledgeSource: ["read", "create", "update", "delete", "query", "admin"],

  // Other
  chat: ["read", "create", "update", "delete"],
  project: ["read", "create", "update", "delete"],
  log: ["read"],

  // Administration (overrides better-auth defaults to add "read" where needed)
  apiKey: ["read", "create", "delete"],
  serviceAccount: ["read", "create", "update", "delete"],
  auditLog: ["read"],
  agentSettings: ["read", "update"],
  llmSettings: ["read", "update"],
  knowledgeSettings: ["read", "update"],
  member: ["read", "create", "update", "delete"],
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
  agent: ["read", "create", "update", "delete", "team-admin"],
  skill: ["read", "create", "update", "delete", "team-admin"],
  app: ["read", "create", "update", "delete", "team-admin"],
  sandbox: ["execute"],
  agentTrigger: ["read", "create", "update", "delete"],
  scheduledTask: ["read", "create", "update", "delete"],

  // LLM
  llmProxy: ["read", "create", "update", "delete", "team-admin"],
  llmProviderApiKey: ["read", "create", "update", "delete"],
  llmVirtualKey: ["read", "create", "update", "delete"],
  llmOauthClient: ["read", "create", "update", "delete"],
  llmModel: ["read", "update"],
  llmLimit: ["read", "create", "update", "delete"],
  optimizationRule: ["read", "create", "update", "delete"],
  llmCost: ["read"],

  // MCP
  mcpGateway: ["read", "create", "update", "delete", "team-admin"],
  mcpOauthClient: ["read", "create", "update", "delete"],
  toolPolicy: ["read", "create", "update", "delete"],
  mcpRegistry: ["read", "create", "update", "delete", "team-admin"],
  mcpServerInstallation: ["read", "create", "update", "delete"],
  mcpServerInstallationRequest: ["read", "create", "update", "delete"],
  environment: ["admin"],
  githubAppConfig: ["read", "create", "update", "delete"],

  // Knowledge
  knowledgeFile: ["read", "create", "update", "delete"],
  knowledgeSource: ["read", "create", "update", "delete", "query"],

  // Other
  chat: ["read", "create", "update", "delete"],
  project: ["read", "create", "update", "delete"],
  log: ["read"],

  // Administration (overrides better-auth defaults to add "read" where needed)
  apiKey: ["read", "create", "delete"],
  serviceAccount: [],
  auditLog: [],
  agentSettings: [],
  llmSettings: ["read", "update"],
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
  app: ["read", "create", "update", "delete"],
  sandbox: ["execute"],
  agentTrigger: [],
  scheduledTask: ["read", "create", "update", "delete"],

  // LLM
  llmProxy: ["read", "create", "update", "delete"],
  llmProviderApiKey: ["read"],
  // Members can create LLM proxies and need to mint personal virtual keys to
  // route through them (e.g. the /connection auto-provisioning flow). Granting
  // "create" only enables personal-scope keys; org-scoped keys still require
  // llmVirtualKey:admin (enforced in the virtual-api-key create route).
  llmVirtualKey: ["read", "create"],
  llmOauthClient: ["read"],
  llmModel: ["read"],
  llmLimit: [],
  optimizationRule: [],
  llmCost: [],

  // MCP
  mcpGateway: ["read", "create", "update", "delete"],
  mcpOauthClient: ["read"],
  toolPolicy: ["read"],
  mcpRegistry: ["read"],
  mcpServerInstallation: ["read", "create", "delete"],
  mcpServerInstallationRequest: ["read", "create", "update"],
  environment: [],
  // minting installation tokens from a stored App credential is privileged;
  // default members get no access — editors and admins manage/use App configs
  githubAppConfig: [],

  // Knowledge
  knowledgeFile: ["read"],
  knowledgeSource: ["read", "query"],

  // Other
  chat: ["read", "create", "update", "delete"],
  project: ["read", "create", "update", "delete"],
  log: [],

  // Administration (overrides better-auth defaults to add "read" where needed)
  apiKey: ["read", "create", "delete"],
  serviceAccount: [],
  auditLog: [],
  agentSettings: [],
  llmSettings: [],
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

export const adminPermissions: Record<Resource, Action[]> = {
  ...allAvailableActions,
  simpleView: [],
};

export const predefinedPermissionsMap: Record<PredefinedRoleName, Permissions> =
  {
    [ADMIN_ROLE_NAME]: adminPermissions,
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
  "skill:read":
    "View and use agent skills within your scope (org, your teams, your own)",
  "skill:create": "Create new agent skills",
  "skill:update": "Modify agent skills and their team assignments",
  "skill:delete": "Delete agent skills",
  "skill:team-admin": "Manage team assignments for agent skills",
  "skill:admin":
    "Full administrative control over all agent skills, bypassing team restrictions",
  "app:read":
    "View and run MCP Apps within your scope (org, your teams, your own)",
  "app:create": "Create new MCP Apps",
  "app:update": "Modify MCP Apps, their tools, and their team assignments",
  "app:delete": "Delete MCP Apps",
  "app:team-admin": "Manage team assignments for MCP Apps",
  "app:admin":
    "Full administrative control over all MCP Apps, bypassing team restrictions",
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
  "mcpOauthClient:admin": "Manage all MCP OAuth client registrations",
  "mcpGateway:admin":
    "Full administrative control over all MCP gateways, bypassing team restrictions",
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
  "mcpRegistry:team-admin": "Manage team assignments for MCP registry entries",
  "mcpServerInstallation:read": "View installed MCP servers and their status",
  "mcpServerInstallation:create": "Install MCP servers from the registry",
  "mcpServerInstallation:update": "Modify installed MCP server configuration",
  "mcpServerInstallation:delete": "Uninstall MCP servers",
  "mcpServerInstallation:admin":
    "Approve or manage all MCP server installations",
  "mcpServerInstallationRequest:read": "View MCP server installation requests",
  "mcpServerInstallationRequest:create":
    "Submit requests to install MCP servers",
  "mcpServerInstallationRequest:update": "Add notes to installation requests",
  "mcpServerInstallationRequest:delete": "Delete installation requests",
  "mcpServerInstallationRequest:admin":
    "Approve or decline installation requests",
  "environment:admin":
    "Create, edit, and delete deployment environments (everyone can view them)",
  "environment:deploy-to-restricted":
    "Deploy catalog items to restricted environments",
  "githubAppConfig:read": "View GitHub App configurations",
  "githubAppConfig:create": "Create GitHub App configurations",
  "githubAppConfig:update": "Modify GitHub App configurations",
  "githubAppConfig:delete": "Delete GitHub App configurations",

  // LLM
  "llmProxy:read": "View and list LLM proxies",
  "llmProxy:create": "Create new LLM proxies",
  "llmProxy:update": "Modify LLM proxy configuration",
  "llmProxy:delete": "Delete LLM proxies",
  "llmProxy:team-admin": "Manage team assignments for LLM proxies",
  "llmProxy:admin":
    "Full administrative control over all LLM proxies, bypassing team restrictions",
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
  "llmOauthClient:admin": "Manage all LLM OAuth client registrations",
  "llmModel:read": "View synced LLM models and capabilities",
  "llmModel:update": "Modify LLM model pricing and modality settings",
  "llmLimit:read": "View token usage limits",
  "llmLimit:create": "Create new usage limits",
  "llmLimit:update": "Modify existing usage limits",
  "llmLimit:delete": "Remove usage limits",
  "optimizationRule:read": "View optimization rules",
  "optimizationRule:create": "Create new optimization rules",
  "optimizationRule:update": "Modify optimization rules",
  "optimizationRule:delete": "Remove optimization rules",
  "llmSettings:read": "View LLM settings (compression, cleanup interval)",
  "llmSettings:update": "Modify LLM settings",
  "agentSettings:read":
    "View agent settings (default model, default agent, security engine, file uploads)",
  "agentSettings:update":
    "Modify agent settings (default model, default agent, security engine, file uploads)",
  "llmCost:read": "View LLM usage cost statistics and analytics",

  // Other
  "chat:read": "View and access chat conversations",
  "chat:create": "Start new chat conversations",
  "chat:update": "Edit chat messages and conversation settings",
  "chat:delete": "Delete chat conversations",
  "project:read": "View projects and the chats inside them",
  "project:create": "Create projects",
  "project:update": "Edit project descriptions and sharing",
  "project:delete": "Delete projects",
  "log:read": "View LLM proxy and MCP tool call logs",

  // Administration
  "member:read": "View organization members and their roles",
  "member:create": "Add new members to the organization",
  "member:update": "Change member roles and settings",
  "member:delete": "Remove members from the organization",
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
  "auditLog:read":
    "View the organization-wide audit log of administrative actions",
  "organizationSettings:read":
    "View organization settings (appearance, authentication, etc)",
  "organizationSettings:update":
    "Customize organization appearance, authentication, etc",
  "knowledgeSource:read": "View Knowledge Bases and Connectors",
  "knowledgeSource:create": "Create Knowledge Bases and Connectors",
  "knowledgeSource:update": "Modify Knowledge Bases and Connectors",
  "knowledgeSource:delete": "Delete Knowledge Bases and Connectors",
  "knowledgeSource:query": "Query knowledge sources for information retrieval",
  "knowledgeSource:admin":
    "View all Knowledge Bases and Connectors, bypassing visibility restrictions",
  "knowledgeFile:read": "View uploaded Knowledge Files",
  "knowledgeFile:create": "Upload Knowledge Files",
  "knowledgeFile:update": "Modify Knowledge File visibility and agent access",
  "knowledgeFile:delete": "Delete Knowledge Files",
  "knowledgeFile:admin":
    "View all Knowledge Files, bypassing visibility restrictions",
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
   * Getting basic info about the organization and marking onboarding as complete
   * require the user to be authenticated but don't require any specific permissions.
   */
  [RouteId.GetOrganization]: {},
  [RouteId.CompleteOnboarding]: {},

  // Connection setup: resource-level checks (mcpGateway/llmProxy read access,
  // skill admin) are conditional on what the setup includes and enforced in
  // the route handler. The script GET is public (token-authenticated).
  [RouteId.CreateConnectionSetup]: {},
  // Provisions a personal virtual key for the manual /connection flow. The
  // llmVirtualKey:create check is enforced in the handler (mirrors the
  // virtual-key branch of CreateConnectionSetup).
  [RouteId.CreateConnectionVirtualKey]: {},

  // Generic agent CRUD routes - enforcement is handled dynamically in route handlers
  // based on agentType (agent, mcp_gateway, llm_proxy map to agent, mcpGateway, llmProxy resources)
  [RouteId.GetAgents]: {},
  [RouteId.GetAllAgents]: {},
  [RouteId.GetAgent]: {},
  [RouteId.CreateAgent]: {},
  [RouteId.CloneAgent]: {},
  [RouteId.UpdateAgent]: {},
  [RouteId.DeleteAgent]: {},
  [RouteId.RestoreAgent]: {},
  // Export/Import: agent-type permission checked dynamically in handler
  [RouteId.ExportAgent]: {},
  [RouteId.ImportAgent]: {},
  [RouteId.GetDefaultMcpGateway]: {
    mcpGateway: ["read"],
  },
  [RouteId.GetDefaultLlmProxy]: {
    llmProxy: ["read"],
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
  [RouteId.GrantToolToAgent]: {},
  [RouteId.BulkAssignTools]: {},
  [RouteId.BulkUpdateAgentTools]: {
    toolPolicy: ["update"],
  },
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
  [RouteId.GetTools]: {
    toolPolicy: ["read"],
  },
  [RouteId.GetToolsWithAssignments]: {
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
  [RouteId.GetInternalMcpCatalogLabelKeys]: {
    mcpRegistry: ["read"],
  },
  [RouteId.GetInternalMcpCatalogLabelValues]: {
    mcpRegistry: ["read"],
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
  [RouteId.DeleteMcpServer]: {
    mcpServerInstallation: ["delete"],
  },
  [RouteId.ReauthenticateMcpServer]: {
    mcpServerInstallation: ["update"],
  },
  [RouteId.ReinstallMcpServer]: {
    mcpServerInstallation: ["update"],
  },
  [RouteId.GetMcpServerInstallationStatus]: {
    mcpServerInstallation: ["read"],
  },
  [RouteId.GetMcpServerInstallationRequests]: {
    mcpServerInstallationRequest: ["read"],
  },
  [RouteId.CreateMcpServerInstallationRequest]: {
    mcpServerInstallationRequest: ["create"],
  },
  [RouteId.GetMcpServerInstallationRequest]: {
    mcpServerInstallationRequest: ["read"],
  },
  [RouteId.UpdateMcpServerInstallationRequest]: {
    mcpServerInstallationRequest: ["update"],
  },
  [RouteId.ApproveMcpServerInstallationRequest]: {
    mcpServerInstallationRequest: ["admin"],
  },
  [RouteId.DeclineMcpServerInstallationRequest]: {
    mcpServerInstallationRequest: ["admin"],
  },
  [RouteId.AddMcpServerInstallationRequestNote]: {
    mcpServerInstallationRequest: ["update"],
  },
  [RouteId.DeleteMcpServerInstallationRequest]: {
    mcpServerInstallationRequest: ["delete"],
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
  [RouteId.GetActiveChatRun]: {
    chat: ["read"],
  },
  [RouteId.GetChatConversations]: {
    chat: ["read"],
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
  [RouteId.PromoteChatAttachmentToKnowledgeFile]: {
    chat: ["read"],
    knowledgeFile: ["create"],
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
  [RouteId.DeleteChatConversation]: {
    chat: ["delete"],
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
  [RouteId.GetLlmProviderApiKey]: {
    llmProviderApiKey: ["read"],
  },
  [RouteId.UpdateLlmProviderApiKey]: {
    llmProviderApiKey: ["update"],
  },
  [RouteId.DeleteLlmProviderApiKey]: {
    llmProviderApiKey: ["delete"],
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
  [RouteId.CreateVirtualApiKey]: {
    llmVirtualKey: ["create"],
  },
  [RouteId.UpdateVirtualApiKey]: {
    llmVirtualKey: ["update"],
  },
  [RouteId.DeleteVirtualApiKey]: {
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
  [RouteId.GetOptimizationRules]: {
    optimizationRule: ["read"],
  },
  [RouteId.GetOptimizationRule]: {
    optimizationRule: ["read"],
  },
  [RouteId.CreateOptimizationRule]: {
    optimizationRule: ["create"],
  },
  [RouteId.UpdateOptimizationRule]: {
    optimizationRule: ["update"],
  },
  [RouteId.DeleteOptimizationRule]: {
    optimizationRule: ["delete"],
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
  [RouteId.UpdateAgentSettings]: {
    agentSettings: ["update"],
  },
  [RouteId.UpdateAuthSettings]: {
    organizationSettings: ["update"],
  },
  [RouteId.UpdateConnectionSettings]: {
    organizationSettings: ["update"],
  },
  // Listing environments is available to any authenticated user (read is ungated).
  [RouteId.ListEnvironments]: {},
  [RouteId.CreateEnvironment]: {
    environment: ["admin"],
  },
  [RouteId.UpdateEnvironment]: {
    environment: ["admin"],
  },
  [RouteId.DeleteEnvironment]: {
    environment: ["admin"],
  },
  [RouteId.UpdateDefaultEnvironment]: {
    environment: ["admin"],
  },
  [RouteId.GetK8sCapabilities]: {
    environment: ["admin"],
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
  [RouteId.UpdateKnowledgeSettings]: {
    knowledgeSettings: ["update"],
  },
  [RouteId.DropEmbeddingConfig]: {
    knowledgeSettings: ["update"],
  },
  [RouteId.TestEmbeddingConnection]: {
    knowledgeSettings: ["update"],
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
  [RouteId.GetIdentityProvider]: {
    identityProvider: ["read"],
  },
  [RouteId.GetIdentityProviderLatestIdTokenClaims]: {
    identityProvider: ["read"],
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
  [RouteId.GetMemberSignupStatus]: {}, // Member signup status - available to all authenticated users
  [RouteId.GetMembers]: { member: ["read"] }, // List organization members (paginated)
  [RouteId.GetOrganizationMembers]: { member: ["read"] }, // List organization members
  [RouteId.GetOrganizationMember]: { member: ["read"] }, // Get organization member by ID or email
  [RouteId.DeletePendingSignupMember]: { member: ["delete"] }, // Delete auto-provisioned member who hasn't signed up
  [RouteId.GetUserPermissions]: {}, // User permissions route - available to all authenticated users (no specific permissions required)
  [RouteId.GetImpersonableUsers]: { member: ["update"] }, // Role debugger picker — admin-only (better-auth still gates the actual impersonate-user call)

  // Member default routes - available to all authenticated users (manages their own defaults)
  [RouteId.GetMemberDefaultAgent]: {},
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
  [RouteId.DeleteKnowledgeBase]: { knowledgeSource: ["delete"] },
  [RouteId.GetKnowledgeBaseHealth]: { knowledgeSource: ["read"] },

  // Knowledge Base Connector Routes
  [RouteId.GetConnectors]: { knowledgeSource: ["read"] },
  [RouteId.CreateConnector]: { knowledgeSource: ["create"] },
  [RouteId.GetConnector]: { knowledgeSource: ["read"] },
  [RouteId.GetConnectorDocuments]: { knowledgeSource: ["read"] },
  [RouteId.GetConnectorDocument]: { knowledgeSource: ["read"] },
  [RouteId.UpdateConnector]: { knowledgeSource: ["update"] },
  [RouteId.DeleteConnector]: { knowledgeSource: ["delete"] },
  [RouteId.DeleteConnectorDocument]: { knowledgeSource: ["delete"] },
  [RouteId.SyncConnector]: { knowledgeSource: ["update"] },
  [RouteId.ForceResyncConnector]: { knowledgeSource: ["update"] },
  [RouteId.TestConnectorConnection]: { knowledgeSource: ["read"] },

  // Connector Knowledge Base Assignment Routes
  [RouteId.AssignConnectorToKnowledgeBases]: { knowledgeSource: ["update"] },
  [RouteId.UnassignConnectorFromKnowledgeBase]: {
    knowledgeSource: ["update"],
  },
  [RouteId.GetConnectorKnowledgeBases]: { knowledgeSource: ["read"] },

  // Connector Run Routes
  [RouteId.GetConnectorRuns]: { knowledgeSource: ["read"] },
  [RouteId.GetConnectorRun]: { knowledgeSource: ["read"] },

  // Knowledge File Routes
  [RouteId.GetKnowledgeFiles]: { knowledgeFile: ["read"] },
  [RouteId.UploadKnowledgeFiles]: { knowledgeFile: ["create"] },
  [RouteId.GetKnowledgeFile]: { knowledgeFile: ["read"] },
  [RouteId.GetKnowledgeFileContent]: { knowledgeFile: ["read"] },
  [RouteId.UpdateKnowledgeFile]: { knowledgeFile: ["update"] },
  [RouteId.DeleteKnowledgeFile]: { knowledgeFile: ["delete"] },
  [RouteId.GetKnowledgeFileUploadConfig]: { knowledgeFile: ["read"] },

  // Agent Skill Routes - per-instance scope is enforced in the handlers
  [RouteId.GetSkills]: { skill: ["read"] },
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
  [RouteId.DeleteSkill]: { skill: ["delete"] },
  [RouteId.ResetSkill]: { skill: ["update"] },
  [RouteId.DiscoverGithubSkills]: { skill: ["read"] },
  [RouteId.SearchSkillCatalog]: { skill: ["read"] },
  [RouteId.PreviewGithubSkill]: { skill: ["read"] },
  [RouteId.ImportGithubSkills]: { skill: ["create"] },
  [RouteId.GetSkillSourceRepos]: { skill: ["read"] },
  [RouteId.EnableSkillToolDefaults]: { skill: ["admin"] },
  // matches the `download_file` tool (sandbox:execute) that hands out this
  // URL, so a role allowed to produce an artifact can also fetch it.
  [RouteId.GetSkillSandboxArtifact]: { sandbox: ["execute"] },
  [RouteId.GetSkillSandboxConversationArtifacts]: { sandbox: ["execute"] },
  [RouteId.GetSkillSandboxFiles]: { sandbox: ["execute"] },
  [RouteId.CreateProject]: { project: ["create"] },
  [RouteId.GetProjects]: { project: ["read"] },
  [RouteId.GetProject]: { project: ["read"] },
  [RouteId.UpdateProject]: { project: ["update"] },
  [RouteId.SetProjectShare]: { project: ["update"] },
  [RouteId.DeleteProject]: { project: ["delete"] },
  [RouteId.GetProjectConversations]: { project: ["read"] },
  // The file list is part of the PFS surface, so it requires the same
  // `sandbox:execute` as the byte endpoint that serves these files
  // (GetSkillSandboxArtifact) — otherwise a role could list files marked
  // `downloadable` and then 403 on every fetch. Project membership is still
  // enforced in the handler (projectService.listFiles -> requireReadable).
  [RouteId.GetProjectFiles]: { project: ["read"], sandbox: ["execute"] },
  [RouteId.DeleteSkillSandboxArtifact]: { sandbox: ["execute"] },

  // Audit Log Routes
  [RouteId.GetAuditLogs]: {
    auditLog: ["read"],
  },

  // Skill Share Link Routes - admin-only. Per-skill org-isolation enforced in handlers.
  // The public marketplace git endpoint stays outside this map; it is allowlisted in
  // the auth middleware (`SKILL_MARKETPLACE_PREFIX`), mirroring `MCP_GATEWAY_PREFIX`.
  [RouteId.GetSkillShareLinks]: { skill: ["admin"] },
  [RouteId.CreateSkillShareLink]: { skill: ["admin"] },
  [RouteId.RevokeSkillShareLink]: { skill: ["admin"] },
  [RouteId.RotateSkillShareLink]: { skill: ["admin"] },

  // MCP App Routes - per-instance scope is enforced in the handlers
  [RouteId.GetApps]: { app: ["read"] },
  [RouteId.CreateApp]: { app: ["create"] },
  [RouteId.GetApp]: { app: ["read"] },
  [RouteId.UpdateApp]: { app: ["update"] },
  [RouteId.DeleteApp]: { app: ["delete"] },
  [RouteId.GetAppVersions]: { app: ["read"] },
  [RouteId.GetAppVersion]: { app: ["read"] },
  [RouteId.GetAppTools]: { app: ["read"] },
  [RouteId.AssignToolToApp]: { app: ["update"] },
  [RouteId.UnassignToolFromApp]: { app: ["update"] },
  [RouteId.GetAppTemplates]: { app: ["read"] },
  // The trusted host page reports a viewer's render diagnostics; the handler
  // re-checks app-visibility, so app:read is the right coarse gate.
  [RouteId.PostAppRenderDiagnostics]: { app: ["read"] },
  // Same trust model as diagnostics: the host page posts the viewer's render
  // screenshot, the handler re-checks app-visibility.
  [RouteId.PostAppRenderScreenshot]: { app: ["read"] },

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
  // App-bound MCP proxy: app access + visibility/allowlist gate enforced in the handler
  [RouteId.McpAppProxyPost]: {},
};

/**
 * Maps frontend routes to their required permissions.
 * Used to control page-level access and UI element visibility.
 */
export const requiredPagePermissionsMap: Record<string, Permissions> = {
  // Chat
  "/chat": { chat: ["read"] },
  "/chat/[conversationId]": { chat: ["read"] },

  // My Files
  "/my-files": { sandbox: ["execute"] },

  // Projects
  "/projects": { project: ["read"] },
  "/projects/[id]": { project: ["read"] },

  // Agents
  "/agents": { agent: ["read"] },
  "/agents/triggers": { agentTrigger: ["read"] },
  "/agents/triggers/slack": { agentTrigger: ["read"] },
  "/agents/triggers/ms-teams": { agentTrigger: ["read"] },
  "/agents/triggers/email": { agentTrigger: ["read"] },
  "/agents/skills": { skill: ["read"] },
  "/agents/skills/new": { skill: ["create"] },
  "/scheduled-tasks": { scheduledTask: ["read"] },

  // Apps
  "/apps": { app: ["read"] },
  "/apps/[id]": { app: ["read"] },
  "/apps/[id]/run": { app: ["read"] },

  // LLM
  "/llm/proxies": { llmProxy: ["read"] },
  "/llm/model-providers/api-keys": { llmProviderApiKey: ["read"] },
  "/llm/model-providers/models": { llmModel: ["read"] },
  "/llm/credentials/virtual-keys": {
    llmVirtualKey: ["read"],
    llmProviderApiKey: ["read"],
  },
  "/llm/credentials/oauth-clients": { llmOauthClient: ["read"] },
  "/llm/limits": { llmLimit: ["read"] },
  "/llm/costs": { llmCost: ["read"] },
  "/llm/optimization-rules": { optimizationRule: ["read"] },

  // MCP
  "/mcp/registry": { mcpRegistry: ["read"] },
  "/mcp/gateways": { mcpGateway: ["read"] },
  "/mcp/credentials/oauth-clients": { mcpOauthClient: ["read"] },
  "/mcp/tool-policies": { toolPolicy: ["read"] },
  "/mcp/tool-guardrails": { toolPolicy: ["read"] },
  "/mcp/registry/installation-requests": {
    mcpServerInstallationRequest: ["read"],
  },

  // Logs
  "/llm/logs": { log: ["read"] },
  "/mcp/logs": { log: ["read"] },
  "/audit/logs": { auditLog: ["read"] },

  // Knowledge
  "/knowledge/knowledge-bases": { knowledgeSource: ["read"] },
  "/knowledge/files": { knowledgeFile: ["read"] },
  "/knowledge/connectors": { knowledgeSource: ["read"] },

  // Settings
  "/settings/account": {},
  "/settings/api-keys": { apiKey: ["read"] },
  "/settings/service-accounts": { serviceAccount: ["read"] },
  "/settings/llm": { llmSettings: ["read"] },
  "/settings/agents": { agentSettings: ["read"] },
  "/settings/environments": { environment: ["admin"] },
  "/settings/knowledge": { knowledgeSettings: ["read"] },
  "/settings/users": { member: ["read"] },
  "/settings/teams": { team: ["read"] },
  "/settings/roles": { ac: ["read"] },
  "/settings/identity-providers": { identityProvider: ["read"] },
  "/settings/secrets": { secret: ["read"] },
  "/settings/github": { githubAppConfig: ["read"] },
  "/settings/organization": { organizationSettings: ["read"] },
};

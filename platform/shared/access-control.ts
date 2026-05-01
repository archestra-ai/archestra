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
  agentTrigger: ["read", "create", "update", "delete"],
  scheduledTask: ["read", "create", "update", "delete", "admin"],

  // LLM
  llmProxy: ["read", "create", "update", "delete", "team-admin", "admin"],
  llmProviderApiKey: ["read", "create", "update", "delete", "admin"],
  llmVirtualKey: ["read", "create", "update", "delete", "admin"],
  llmModel: ["read", "update"],
  llmLimit: ["read", "create", "update", "delete"],
  optimizationRule: ["read", "create", "update", "delete"],
  llmCost: ["read"],

  // MCP
  mcpGateway: ["read", "create", "update", "delete", "team-admin", "admin"],
  toolPolicy: ["read", "create", "update", "delete"],
  mcpRegistry: ["read", "create", "update", "delete"],
  mcpServerInstallation: ["read", "create", "update", "delete", "admin"],
  mcpServerInstallationRequest: ["read", "create", "update", "delete", "admin"],

  // Knowledge
  knowledgeSource: ["read", "create", "update", "delete", "query", "admin"],

  // Other
  chat: ["read", "create", "update", "delete"],
  log: ["read"],

  // Administration (overrides better-auth defaults to add "read" where needed)
  apiKey: ["read", "create", "delete"],
  agentSettings: ["read", "update"],
  llmSettings: ["read", "update"],
  knowledgeSettings: ["read", "update"],
  member: ["read", "create", "update", "delete"],
  invitation: ["create", "cancel"],
  ac: ["read", "create", "update", "delete"],
  team: ["read", "create", "update", "delete", "admin"],
  identityProvider: ["read", "create", "update", "delete"],
  secret: ["read", "update"],
  organizationSettings: ["read", "update"],

  // UI behavior resources
  simpleView: ["enable"],
  chatAgentPicker: ["enable"],
  chatProviderSettings: ["enable"],
  chatExpandToolCalls: ["enable"],

  // better-auth internal resource — not exposed to users, kept for ACL compatibility
  organization: ["update", "delete"],
};

export const editorPermissions: Record<Resource, Action[]> = {
  // Agents
  agent: ["read", "create", "update", "delete", "team-admin"],
  agentTrigger: ["read", "create", "update", "delete"],
  scheduledTask: ["read", "create", "update", "delete"],

  // LLM
  llmProxy: ["read", "create", "update", "delete", "team-admin"],
  llmProviderApiKey: ["read", "create", "update", "delete"],
  llmVirtualKey: ["read", "create", "update", "delete"],
  llmModel: ["read", "update"],
  llmLimit: ["read", "create", "update", "delete"],
  optimizationRule: ["read", "create", "update", "delete"],
  llmCost: ["read"],

  // MCP
  mcpGateway: ["read", "create", "update", "delete", "team-admin"],
  toolPolicy: ["read", "create", "update", "delete"],
  mcpRegistry: ["read", "create", "update", "delete"],
  mcpServerInstallation: ["read", "create", "update", "delete"],
  mcpServerInstallationRequest: ["read", "create", "update", "delete"],

  // Knowledge
  knowledgeSource: ["read", "create", "update", "delete", "query"],

  // Other
  chat: ["read", "create", "update", "delete"],
  log: ["read"],

  // Administration (overrides better-auth defaults to add "read" where needed)
  apiKey: ["read", "create", "delete"],
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
  agentTrigger: [],
  scheduledTask: ["read", "create", "update", "delete"],

  // LLM
  llmProxy: ["read", "create", "update", "delete"],
  llmProviderApiKey: ["read"],
  llmVirtualKey: ["read"],
  llmModel: ["read"],
  llmLimit: [],
  optimizationRule: [],
  llmCost: [],

  // MCP
  mcpGateway: ["read", "create", "update", "delete"],
  toolPolicy: ["read"],
  mcpRegistry: ["read"],
  mcpServerInstallation: ["read", "create", "delete"],
  mcpServerInstallationRequest: ["read", "create", "update"],

  // Knowledge
  knowledgeSource: ["read", "query"],

  // Other
  chat: ["read", "create", "update", "delete"],
  log: [],

  // Administration (overrides better-auth defaults to add "read" where needed)
  apiKey: ["read", "create", "delete"],
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
  "team:admin": "Manage team membership (add/remove members)",
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
  "knowledgeSettings:read":
    "View knowledge settings (embedding and reranking models)",
  "knowledgeSettings:update":
    "Modify knowledge settings (embedding and reranking models)",

  // UI behavior
  "simpleView:enable": "Sidebar is collapsed by default on page load",
  "chatAgentPicker:enable": "Show agent picker in chat",
  "chatProviderSettings:enable": "Show model and API key selectors in chat",
  "chatExpandToolCalls:enable": "Allow expanding tool call details in chat",
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

  // Generic agent CRUD routes - enforcement is handled dynamically in route handlers
  // based on agentType (agent, mcp_gateway, llm_proxy map to agent, mcpGateway, llmProxy resources)
  [RouteId.GetAgents]: {},
  [RouteId.GetAllAgents]: {},
  [RouteId.GetAgent]: {},
  [RouteId.CreateAgent]: {},
  [RouteId.UpdateAgent]: {},
  [RouteId.DeleteAgent]: {},
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
    team: ["update"],
  },
  [RouteId.RotateToken]: {
    team: ["update"],
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
    team: ["update"],
  },
  [RouteId.DeleteTeam]: {
    team: ["delete"],
  },
  [RouteId.GetTeamMembers]: {
    team: ["read"],
  },
  [RouteId.AddTeamMember]: {
    team: ["admin"],
  },
  [RouteId.RemoveTeamMember]: {
    team: ["admin"],
  },
  // Team External Group Routes (SSO Team Sync) - requires team admin permission
  [RouteId.GetTeamExternalGroups]: {
    team: ["read"],
  },
  [RouteId.AddTeamExternalGroup]: {
    team: ["admin"],
  },
  [RouteId.RemoveTeamExternalGroup]: {
    team: ["admin"],
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
  [RouteId.StopChatStream]: {
    chat: ["read"],
  },
  [RouteId.GetChatConversations]: {
    chat: ["read"],
  },
  [RouteId.GetChatConversation]: {
    chat: ["read"],
  },
  [RouteId.GetChatAgentMcpTools]: {
    agent: ["read"],
  },
  [RouteId.CreateChatConversation]: {
    chat: ["create"],
  },
  [RouteId.UpdateChatConversation]: {
    chat: ["update"],
  },
  [RouteId.DeleteChatConversation]: {
    chat: ["delete"],
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
  [RouteId.CreateLlmProviderApiKey]: {
    llmProviderApiKey: ["create"],
  },
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
  [RouteId.UpdateMcpSettings]: {
    organizationSettings: ["update"],
  },
  [RouteId.UpdateConnectionSettings]: {
    organizationSettings: ["update"],
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

  // Member default agent routes - available to all authenticated users (manages their own default agent)
  [RouteId.GetMemberDefaultAgent]: {},

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
  [RouteId.UpdateConnector]: { knowledgeSource: ["update"] },
  [RouteId.DeleteConnector]: { knowledgeSource: ["delete"] },
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

  // Config endpoint - any authenticated user can access
  [RouteId.GetConfig]: {},

  // MCP Gateway Routes - available to all authenticated users
  [RouteId.McpGatewayGet]: {}, // Server discovery endpoint
  [RouteId.McpGatewayPost]: {}, // JSON-RPC endpoint for resources/read and tools/call
  [RouteId.McpProxyPost]: {}, // Frontend proxy to MCP Gateway with session auth
};

/**
 * Maps frontend routes to their required permissions.
 * Used to control page-level access and UI element visibility.
 */
export const requiredPagePermissionsMap: Record<string, Permissions> = {
  // Chat
  "/chat": { chat: ["read"] },
  "/chat/[conversationId]": { chat: ["read"] },

  // Agents
  "/agents": { agent: ["read"] },
  "/agents/triggers": { agentTrigger: ["read"] },
  "/agents/triggers/slack": { agentTrigger: ["read"] },
  "/agents/triggers/ms-teams": { agentTrigger: ["read"] },
  "/agents/triggers/email": { agentTrigger: ["read"] },
  "/scheduled-tasks": { scheduledTask: ["read"] },

  // LLM
  "/llm/proxies": { llmProxy: ["read"] },
  "/llm/providers/api-keys": { llmProviderApiKey: ["read"] },
  "/llm/providers/virtual-keys": {
    llmVirtualKey: ["read"],
    llmProviderApiKey: ["read"],
  },
  "/llm/providers/models": { llmModel: ["read"] },
  "/llm/limits": { llmLimit: ["read"] },
  "/llm/costs": { llmCost: ["read"] },
  "/llm/optimization-rules": { optimizationRule: ["read"] },

  // MCP
  "/mcp/registry": { mcpRegistry: ["read"] },
  "/mcp/gateways": { mcpGateway: ["read"] },
  "/mcp/tool-policies": { toolPolicy: ["read"] },
  "/mcp/tool-guardrails": { toolPolicy: ["read"] },
  "/mcp/registry/installation-requests": {
    mcpServerInstallationRequest: ["read"],
  },

  // Logs
  "/llm/logs": { log: ["read"] },
  "/mcp/logs": { log: ["read"] },

  // Knowledge
  "/knowledge/knowledge-bases": { knowledgeSource: ["read"] },
  "/knowledge/connectors": { knowledgeSource: ["read"] },

  // Settings
  "/settings/account": {},
  "/settings/api-keys": { apiKey: ["read"] },
  "/settings/llm": { llmSettings: ["read"] },
  "/settings/agents": { agentSettings: ["read"] },
  "/settings/knowledge": { knowledgeSettings: ["read"] },
  "/settings/users": { member: ["read"] },
  "/settings/teams": { team: ["read"] },
  "/settings/roles": { ac: ["read"] },
  "/settings/identity-providers": { identityProvider: ["read"] },
  "/settings/mcp": { organizationSettings: ["read"] },
  "/settings/secrets": { secret: ["read"] },
  "/settings/organization": { organizationSettings: ["read"] },
  "/settings/connection": { organizationSettings: ["read"] },
};

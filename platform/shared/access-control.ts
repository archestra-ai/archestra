import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";
import { z } from "zod";

export const ADMIN_ROLE_NAME = "admin";
export const EDITOR_ROLE_NAME = "editor";
export const MEMBER_ROLE_NAME = "member";
export const PredefinedRoleNameSchema = z.enum([
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
]);
export const AnyRoleName = PredefinedRoleNameSchema.or(z.string());

export const ActionSchema = z.enum([
  "create",
  "read",
  "update",
  "delete",
  "admin",
  "cancel",
]);

export const ResourceSchema = z.enum([
  "profile",
  "tool",
  "policy",
  "interaction",
  "dualLlmConfig",
  "dualLlmResult",
  "organization",
  "ssoProvider",
  "member",
  "invitation",
  "internalMcpCatalog",
  "mcpServer",
  "mcpServerInstallationRequest",
  "mcpToolCall",
  "team",
  "conversation",
  "limit",
  "tokenPrice",
  "chatSettings",
  "prompt",
  /**
   * Better-auth access control resource - needed for organization role management
   * See: https://github.com/better-auth/better-auth/issues/2336#issuecomment-2820620809
   *
   * The "ac" resource is part of better-auth's defaultStatements from organization plugin
   * and is required for dynamic access control to work correctly with custom roles
   */
  "ac",
]);

export const PermissionsSchema = z.partialRecord(
  ResourceSchema,
  z.array(ActionSchema),
);

export const allAvailableActions: Record<Resource, Action[]> = {
  // Start with better-auth defaults
  ...defaultStatements,
  // Override with Archestra-specific actions
  profile: ["create", "read", "update", "delete", "admin"],
  tool: ["create", "read", "update", "delete"],
  policy: ["create", "read", "update", "delete"],
  dualLlmConfig: ["create", "read", "update", "delete"],
  dualLlmResult: ["create", "read", "update", "delete"],
  interaction: ["create", "read", "update", "delete"],
  organization: ["read", "update", "delete"],
  ssoProvider: ["create", "read", "update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  internalMcpCatalog: ["create", "read", "update", "delete"],
  mcpServer: ["create", "read", "update", "delete", "admin"],
  mcpServerInstallationRequest: ["create", "read", "update", "delete", "admin"],
  team: ["create", "read", "update", "delete"],
  mcpToolCall: ["read"],
  conversation: ["create", "read", "update", "delete"],
  limit: ["create", "read", "update", "delete"],
  tokenPrice: ["create", "read", "update", "delete"],
  chatSettings: ["read", "update"],
  prompt: ["create", "read", "update", "delete"],
  /**
   * Better-auth access control resource - needed for organization role management
   * See: https://github.com/better-auth/better-auth/issues/2336#issuecomment-2820620809
   *
   * The "ac" resource is part of better-auth's defaultStatements from organization plugin
   * and is required for dynamic access control to work correctly with custom roles
   */
  ac: ["create", "read", "update", "delete"],
};

export const ac = createAccessControl(allAvailableActions);

// all permissions granted
export const adminRole = ac.newRole({
  ...allAvailableActions,
});

export const editorRole = ac.newRole({
  profile: ["create", "read", "update", "delete"],
  tool: ["create", "read", "update", "delete"],
  policy: ["create", "read", "update", "delete"],
  interaction: ["create", "read", "update", "delete"],
  dualLlmConfig: ["create", "read", "update", "delete"],
  dualLlmResult: ["create", "read", "update", "delete"],
  internalMcpCatalog: ["create", "read", "update", "delete"],
  mcpServer: ["create", "read", "update", "delete"],
  mcpServerInstallationRequest: ["create", "read", "update", "delete"],
  organization: ["read"],
  team: ["read"],
  mcpToolCall: ["read"],
  conversation: ["create", "read", "update", "delete"],
  limit: ["create", "read", "update", "delete"],
  tokenPrice: ["create", "read", "update", "delete"],
  chatSettings: ["read", "update"],
  prompt: ["create", "read", "update", "delete"],
});

export const memberRole = ac.newRole({
  profile: ["read"],
  tool: ["create", "read", "update", "delete"],
  policy: ["create", "read", "update", "delete"],
  interaction: ["create", "read", "update", "delete"],
  dualLlmConfig: ["read"],
  dualLlmResult: ["read"],
  internalMcpCatalog: ["read"],
  mcpServer: ["create", "read", "delete"],
  mcpServerInstallationRequest: ["create", "read", "update"],
  organization: ["read"],
  team: ["read"],
  mcpToolCall: ["read"],
  conversation: ["create", "read", "update", "delete"],
  limit: ["read"],
  tokenPrice: ["read"],
  chatSettings: ["read"],
  prompt: ["read"],
});

export const predefinedPermissionsMap: Record<PredefinedRoleName, Permissions> =
  {
    [ADMIN_ROLE_NAME]: adminRole.statements,
    [EDITOR_ROLE_NAME]: editorRole.statements,
    [MEMBER_ROLE_NAME]: memberRole.statements,
  };

/**
 * Available resources and actions
 */
export type Resource = z.infer<typeof ResourceSchema>;
export type Action = z.infer<typeof ActionSchema>;

/**
 * Permission string format: "resource:action"
 * Examples: "profile:create", "tool:read", "org:delete", "profile:admin", "mcpServer:admin"
 *
 * Note: "admin" action is only valid for certain resources
 */
export type Permission =
  | `${Resource}:${"create" | "read" | "update" | "delete"}`
  | "profile:admin"
  | "mcpServer:admin"
  | "mcpServerInstallationRequest:admin"
  | "invitation:cancel";

export type Permissions = z.infer<typeof PermissionsSchema>;
export type PredefinedRoleName = z.infer<typeof PredefinedRoleNameSchema>;
export type AnyRoleName = z.infer<typeof AnyRoleName>;

export const RouteId = {
  // Agent Routes
  GetAgents: "getAgents",
  GetAllAgents: "getAllAgents",
  CreateAgent: "createAgent",
  GetAgent: "getAgent",
  GetDefaultAgent: "getDefaultAgent",
  UpdateAgent: "updateAgent",
  DeleteAgent: "deleteAgent",
  GetLabelKeys: "getLabelKeys",
  GetLabelValues: "getLabelValues",

  // Agent Tool Routes
  AssignToolToAgent: "assignToolToAgent",
  BulkAssignTools: "bulkAssignTools",
  BulkUpdateAgentTools: "bulkUpdateAgentTools",
  UnassignToolFromAgent: "unassignToolFromAgent",
  GetAgentTools: "getAgentTools",
  GetAllAgentTools: "getAllAgentTools",
  UpdateAgentTool: "updateAgentTool",
  GetAgentAvailableTokens: "getAgentAvailableTokens",

  // Features Routes
  GetFeatures: "getFeatures",

  // Auth Routes
  GetDefaultCredentialsStatus: "getDefaultCredentialsStatus",

  // MCP Catalog Routes
  GetInternalMcpCatalog: "getInternalMcpCatalog",
  CreateInternalMcpCatalogItem: "createInternalMcpCatalogItem",
  GetInternalMcpCatalogItem: "getInternalMcpCatalogItem",
  UpdateInternalMcpCatalogItem: "updateInternalMcpCatalogItem",
  DeleteInternalMcpCatalogItem: "deleteInternalMcpCatalogItem",

  // MCP Server Routes
  GetMcpServers: "getMcpServers",
  GetMcpServer: "getMcpServer",
  GetMcpServerTools: "getMcpServerTools",
  GetMcpServerLogs: "getMcpServerLogs",
  InstallMcpServer: "installMcpServer",
  DeleteMcpServer: "deleteMcpServer",
  RevokeUserMcpServerAccess: "revokeUserMcpServerAccess",
  GrantTeamMcpServerAccess: "grantTeamMcpServerAccess",
  RevokeTeamMcpServerAccess: "revokeTeamMcpServerAccess",
  RevokeAllTeamsMcpServerAccess: "revokeAllTeamsMcpServerAccess",
  RestartMcpServer: "restartMcpServer",
  GetMcpServerInstallationStatus: "getMcpServerInstallationStatus",
  McpProxy: "mcpProxy",

  // MCP Server Installation Request Routes
  GetMcpServerInstallationRequests: "getMcpServerInstallationRequests",
  CreateMcpServerInstallationRequest: "createMcpServerInstallationRequest",
  GetMcpServerInstallationRequest: "getMcpServerInstallationRequest",
  UpdateMcpServerInstallationRequest: "updateMcpServerInstallationRequest",
  ApproveMcpServerInstallationRequest: "approveMcpServerInstallationRequest",
  DeclineMcpServerInstallationRequest: "declineMcpServerInstallationRequest",
  AddMcpServerInstallationRequestNote: "addMcpServerInstallationRequestNote",
  DeleteMcpServerInstallationRequest: "deleteMcpServerInstallationRequest",

  // OAuth Routes
  InitiateOAuth: "initiateOAuth",
  HandleOAuthCallback: "handleOAuthCallback",

  // Team Routes
  GetTeams: "getTeams",
  CreateTeam: "createTeam",
  GetTeam: "getTeam",
  UpdateTeam: "updateTeam",
  DeleteTeam: "deleteTeam",
  GetTeamMembers: "getTeamMembers",
  AddTeamMember: "addTeamMember",
  RemoveTeamMember: "removeTeamMember",
  // Team External Group Routes (SSO Team Sync)
  GetTeamExternalGroups: "getTeamExternalGroups",
  AddTeamExternalGroup: "addTeamExternalGroup",
  RemoveTeamExternalGroup: "removeTeamExternalGroup",

  // Role Routes
  GetRoles: "getRoles",
  CreateRole: "createRole",
  GetRole: "getRole",
  UpdateRole: "updateRole",
  DeleteRole: "deleteRole",

  // Tool Routes
  GetTools: "getTools",
  GetUnassignedTools: "getUnassignedTools",

  // Interaction Routes
  GetInteractions: "getInteractions",
  GetInteraction: "getInteraction",

  // MCP Tool Call Routes
  GetMcpToolCalls: "getMcpToolCalls",
  GetMcpToolCall: "getMcpToolCall",

  // Autonomy Policy Routes
  GetOperators: "getOperators",
  GetToolInvocationPolicies: "getToolInvocationPolicies",
  CreateToolInvocationPolicy: "createToolInvocationPolicy",
  GetToolInvocationPolicy: "getToolInvocationPolicy",
  UpdateToolInvocationPolicy: "updateToolInvocationPolicy",
  DeleteToolInvocationPolicy: "deleteToolInvocationPolicy",
  GetTrustedDataPolicies: "getTrustedDataPolicies",
  CreateTrustedDataPolicy: "createTrustedDataPolicy",
  GetTrustedDataPolicy: "getTrustedDataPolicy",
  UpdateTrustedDataPolicy: "updateTrustedDataPolicy",
  DeleteTrustedDataPolicy: "deleteTrustedDataPolicy",

  // Dual LLM Config Routes
  GetDefaultDualLlmConfig: "getDefaultDualLlmConfig",
  GetDualLlmConfigs: "getDualLlmConfigs",
  CreateDualLlmConfig: "createDualLlmConfig",
  GetDualLlmConfig: "getDualLlmConfig",
  UpdateDualLlmConfig: "updateDualLlmConfig",
  DeleteDualLlmConfig: "deleteDualLlmConfig",

  // Dual LLM Result Routes
  GetDualLlmResultByToolCallId: "getDualLlmResultByToolCallId",
  GetDualLlmResultsByInteraction: "getDualLlmResultsByInteraction",

  // Proxy Routes - OpenAI
  OpenAiChatCompletionsWithDefaultAgent:
    "openAiChatCompletionsWithDefaultAgent",
  OpenAiChatCompletionsWithAgent: "openAiChatCompletionsWithAgent",

  // Proxy Routes - Anthropic
  AnthropicMessagesWithDefaultAgent: "anthropicMessagesWithDefaultAgent",
  AnthropicMessagesWithAgent: "anthropicMessagesWithAgent",

  // Chat Routes
  StreamChat: "streamChat",
  GetChatConversations: "getChatConversations",
  GetChatConversation: "getChatConversation",
  GetChatAgentMcpTools: "getChatAgentMcpTools",
  CreateChatConversation: "createChatConversation",
  UpdateChatConversation: "updateChatConversation",
  DeleteChatConversation: "deleteChatConversation",
  GenerateChatConversationTitle: "generateChatConversationTitle",
  GetChatMcpTools: "getChatMcpTools",

  // Chat Settings Routes
  GetChatSettings: "getChatSettings",
  UpdateChatSettings: "updateChatSettings",

  // Prompt Routes
  GetPrompts: "getPrompts",
  CreatePrompt: "createPrompt",
  GetPrompt: "getPrompt",
  GetPromptVersions: "getPromptVersions",
  RollbackPrompt: "rollbackPrompt",
  UpdatePrompt: "updatePrompt",
  DeletePrompt: "deletePrompt",

  // Agent Prompt Routes
  GetAgentPrompts: "getAgentPrompts",
  AssignAgentPrompts: "assignAgentPrompts",
  DeleteAgentPrompt: "deleteAgentPrompt",

  // Limits Routes
  GetLimits: "getLimits",
  CreateLimit: "createLimit",
  GetLimit: "getLimit",
  UpdateLimit: "updateLimit",
  DeleteLimit: "deleteLimit",

  // Organization Routes
  GetOrganization: "getOrganization",
  UpdateOrganization: "updateOrganization",
  GetOnboardingStatus: "getOnboardingStatus",

  // SSO Provider Routes
  GetPublicSsoProviders: "getPublicSsoProviders",
  GetSsoProviders: "getSsoProviders",
  GetSsoProvider: "getSsoProvider",
  CreateSsoProvider: "createSsoProvider",
  UpdateSsoProvider: "updateSsoProvider",
  DeleteSsoProvider: "deleteSsoProvider",

  // User Routes
  GetUserPermissions: "getUserPermissions",

  // Token Price Routes
  GetTokenPrices: "getTokenPrices",
  CreateTokenPrice: "createTokenPrice",
  GetTokenPrice: "getTokenPrice",
  UpdateTokenPrice: "updateTokenPrice",
  DeleteTokenPrice: "deleteTokenPrice",

  // Statistics Routes
  GetTeamStatistics: "getTeamStatistics",
  GetAgentStatistics: "getAgentStatistics",
  GetModelStatistics: "getModelStatistics",
  GetOverviewStatistics: "getOverviewStatistics",
  GetCostSavingsStatistics: "getCostSavingsStatistics",

  // Optimization Rule Routes
  GetOptimizationRules: "getOptimizationRules",
  CreateOptimizationRule: "createOptimizationRule",
  UpdateOptimizationRule: "updateOptimizationRule",
  DeleteOptimizationRule: "deleteOptimizationRule",

  // Secrets Routes
  GetSecretsType: "getSecretsType",
  CheckSecretsConnectivity: "checkSecretsConnectivity",
} as const;

export type RouteId = (typeof RouteId)[keyof typeof RouteId];

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
  [RouteId.GetAgents]: {
    profile: ["read"],
  },
  [RouteId.GetAllAgents]: {
    profile: ["read"],
  },
  [RouteId.GetAgent]: {
    profile: ["read"],
  },
  [RouteId.GetDefaultAgent]: {
    profile: ["read"],
  },
  [RouteId.CreateAgent]: {
    profile: ["create"],
  },
  [RouteId.UpdateAgent]: {
    profile: ["update"],
  },
  [RouteId.DeleteAgent]: {
    profile: ["delete"],
  },
  [RouteId.GetAgentTools]: {
    profile: ["read"],
    tool: ["read"],
  },
  [RouteId.GetAllAgentTools]: {
    profile: ["read"],
    tool: ["read"],
  },
  [RouteId.GetAgentAvailableTokens]: {
    profile: ["read"],
  },
  [RouteId.GetUnassignedTools]: {
    tool: ["read"],
  },
  [RouteId.AssignToolToAgent]: {
    profile: ["update"],
  },
  [RouteId.BulkAssignTools]: {
    profile: ["update"],
  },
  [RouteId.BulkUpdateAgentTools]: {
    profile: ["update"],
    tool: ["update"],
  },
  [RouteId.UnassignToolFromAgent]: {
    profile: ["update"],
  },
  [RouteId.UpdateAgentTool]: {
    profile: ["update"],
    tool: ["update"],
  },
  [RouteId.GetLabelKeys]: {
    profile: ["read"],
  },
  [RouteId.GetLabelValues]: {
    profile: ["read"],
  },
  [RouteId.GetTools]: {
    tool: ["read"],
  },
  [RouteId.GetInteractions]: {
    interaction: ["read"],
  },
  [RouteId.GetInteraction]: {
    interaction: ["read"],
  },
  [RouteId.GetOperators]: {
    policy: ["read"],
  },
  [RouteId.GetToolInvocationPolicies]: {
    policy: ["read"],
  },
  [RouteId.CreateToolInvocationPolicy]: {
    policy: ["create"],
  },
  [RouteId.GetToolInvocationPolicy]: {
    policy: ["read"],
  },
  [RouteId.UpdateToolInvocationPolicy]: {
    policy: ["update"],
  },
  [RouteId.DeleteToolInvocationPolicy]: {
    policy: ["delete"],
  },
  [RouteId.GetTrustedDataPolicies]: {
    policy: ["read"],
  },
  [RouteId.CreateTrustedDataPolicy]: {
    policy: ["create"],
  },
  [RouteId.GetTrustedDataPolicy]: {
    policy: ["read"],
  },
  [RouteId.UpdateTrustedDataPolicy]: {
    policy: ["update"],
  },
  [RouteId.DeleteTrustedDataPolicy]: {
    policy: ["delete"],
  },
  [RouteId.GetDefaultDualLlmConfig]: {
    dualLlmConfig: ["read"],
  },
  [RouteId.GetDualLlmConfigs]: {
    dualLlmConfig: ["read"],
  },
  [RouteId.GetDualLlmResultsByInteraction]: {
    dualLlmResult: ["read"],
  },
  [RouteId.CreateDualLlmConfig]: {
    dualLlmConfig: ["create"],
  },
  [RouteId.GetDualLlmConfig]: {
    dualLlmConfig: ["read"],
  },
  [RouteId.UpdateDualLlmConfig]: {
    dualLlmConfig: ["update"],
  },
  [RouteId.DeleteDualLlmConfig]: {
    dualLlmConfig: ["delete"],
  },
  [RouteId.GetDualLlmResultByToolCallId]: {
    dualLlmResult: ["read"],
  },
  [RouteId.GetInternalMcpCatalog]: {
    internalMcpCatalog: ["read"],
  },
  [RouteId.CreateInternalMcpCatalogItem]: {
    internalMcpCatalog: ["create"],
  },
  [RouteId.GetInternalMcpCatalogItem]: {
    internalMcpCatalog: ["read"],
  },
  [RouteId.UpdateInternalMcpCatalogItem]: {
    internalMcpCatalog: ["update"],
  },
  [RouteId.DeleteInternalMcpCatalogItem]: {
    internalMcpCatalog: ["delete"],
  },
  [RouteId.GetMcpServers]: {
    mcpServer: ["read"],
  },
  [RouteId.GetMcpServer]: {
    mcpServer: ["read"],
  },
  [RouteId.GetMcpServerTools]: {
    mcpServer: ["read"],
  },
  [RouteId.GetMcpServerLogs]: {
    mcpServer: ["read"],
  },
  [RouteId.InstallMcpServer]: {
    mcpServer: ["create"],
  },
  [RouteId.DeleteMcpServer]: {
    mcpServer: ["delete"],
  },
  [RouteId.RevokeUserMcpServerAccess]: {
    mcpServer: ["delete"],
  },
  [RouteId.GrantTeamMcpServerAccess]: {
    mcpServer: ["create"],
  },
  [RouteId.RevokeTeamMcpServerAccess]: {
    mcpServer: ["delete"],
  },
  [RouteId.RevokeAllTeamsMcpServerAccess]: {
    mcpServer: ["delete"],
  },
  [RouteId.GetMcpServerInstallationStatus]: {
    mcpServer: ["read"],
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
    mcpServer: ["create"],
  },
  [RouteId.HandleOAuthCallback]: {
    mcpServer: ["create"],
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
    team: ["update"],
  },
  [RouteId.RemoveTeamMember]: {
    team: ["update"],
  },
  // Team External Group Routes (SSO Team Sync) - requires team update permission
  [RouteId.GetTeamExternalGroups]: {
    team: ["read"],
  },
  [RouteId.AddTeamExternalGroup]: {
    team: ["update"],
  },
  [RouteId.RemoveTeamExternalGroup]: {
    team: ["update"],
  },
  [RouteId.GetRoles]: {
    organization: ["read"],
  },
  [RouteId.CreateRole]: {
    organization: ["update"],
  },
  [RouteId.GetRole]: {
    organization: ["read"],
  },
  [RouteId.UpdateRole]: {
    organization: ["update"],
  },
  [RouteId.DeleteRole]: {
    organization: ["update"],
  },
  [RouteId.GetMcpToolCalls]: {
    mcpToolCall: ["read"],
  },
  [RouteId.GetMcpToolCall]: {
    mcpToolCall: ["read"],
  },
  [RouteId.StreamChat]: {
    conversation: ["read"],
  },
  [RouteId.GetChatConversations]: {
    conversation: ["read"],
  },
  [RouteId.GetChatConversation]: {
    conversation: ["read"],
  },
  [RouteId.GetChatAgentMcpTools]: {
    profile: ["read"],
  },
  [RouteId.CreateChatConversation]: {
    conversation: ["create"],
  },
  [RouteId.UpdateChatConversation]: {
    conversation: ["update"],
  },
  [RouteId.DeleteChatConversation]: {
    conversation: ["delete"],
  },
  [RouteId.GenerateChatConversationTitle]: {
    conversation: ["update"],
  },
  [RouteId.GetChatMcpTools]: {
    conversation: ["read"],
  },
  [RouteId.GetChatSettings]: {
    chatSettings: ["read"],
  },
  [RouteId.UpdateChatSettings]: {
    chatSettings: ["update"],
  },
  [RouteId.GetPrompts]: {
    prompt: ["read"],
  },
  [RouteId.CreatePrompt]: {
    prompt: ["create"],
  },
  [RouteId.GetPrompt]: {
    prompt: ["read"],
  },
  [RouteId.GetPromptVersions]: {
    prompt: ["read"],
  },
  [RouteId.RollbackPrompt]: {
    prompt: ["update"],
  },
  [RouteId.UpdatePrompt]: {
    prompt: ["update"],
  },
  [RouteId.DeletePrompt]: {
    prompt: ["delete"],
  },
  [RouteId.GetAgentPrompts]: {
    profile: ["read"],
    prompt: ["read"],
  },
  [RouteId.AssignAgentPrompts]: {
    profile: ["update"],
    prompt: ["read"],
  },
  [RouteId.DeleteAgentPrompt]: {
    profile: ["update"],
    prompt: ["read"],
  },
  [RouteId.GetLimits]: {
    limit: ["read"],
  },
  [RouteId.CreateLimit]: {
    limit: ["create"],
  },
  [RouteId.GetLimit]: {
    limit: ["read"],
  },
  [RouteId.UpdateLimit]: {
    limit: ["update"],
  },
  [RouteId.DeleteLimit]: {
    limit: ["delete"],
  },
  [RouteId.GetOrganization]: {
    organization: ["read"],
  },
  [RouteId.UpdateOrganization]: {
    organization: ["update"],
  },

  /**
   * Get public SSO providers route (minimal info for login page)
   * Available to unauthenticated users - only returns providerId, no secrets
   * Note: Auth is skipped in middleware for this route
   */
  [RouteId.GetPublicSsoProviders]: {},
  /**
   * Get all SSO providers with full config (admin only)
   * Returns sensitive data including client secrets
   */
  [RouteId.GetSsoProviders]: {
    ssoProvider: ["read"],
  },
  [RouteId.GetSsoProvider]: {
    ssoProvider: ["read"],
  },
  [RouteId.CreateSsoProvider]: {
    ssoProvider: ["create"],
  },
  [RouteId.UpdateSsoProvider]: {
    ssoProvider: ["update"],
  },
  [RouteId.DeleteSsoProvider]: {
    ssoProvider: ["delete"],
  },

  [RouteId.GetOnboardingStatus]: {}, // Onboarding status route - available to all authenticated users (no specific permissions required)
  [RouteId.GetUserPermissions]: {}, // User permissions route - available to all authenticated users (no specific permissions required)
  [RouteId.GetTokenPrices]: {
    tokenPrice: ["read"],
  },
  [RouteId.CreateTokenPrice]: {
    tokenPrice: ["create"],
  },
  [RouteId.GetTokenPrice]: {
    tokenPrice: ["read"],
  },
  [RouteId.UpdateTokenPrice]: {
    tokenPrice: ["update"],
  },
  [RouteId.DeleteTokenPrice]: {
    tokenPrice: ["delete"],
  },
  [RouteId.GetTeamStatistics]: {
    interaction: ["read"],
  },
  [RouteId.GetAgentStatistics]: {
    interaction: ["read"],
  },
  [RouteId.GetModelStatistics]: {
    interaction: ["read"],
  },
  [RouteId.GetOverviewStatistics]: {
    interaction: ["read"],
  },
  [RouteId.GetCostSavingsStatistics]: {
    interaction: ["read"],
  },
  [RouteId.GetOptimizationRules]: {
    profile: ["read"],
  },
  [RouteId.CreateOptimizationRule]: {
    profile: ["create"],
  },
  [RouteId.UpdateOptimizationRule]: {
    profile: ["update"],
  },
  [RouteId.DeleteOptimizationRule]: {
    profile: ["delete"],
  },

  // Secrets Routes
  [RouteId.GetSecretsType]: {
    organization: ["read"],
  },
  [RouteId.CheckSecretsConnectivity]: {
    organization: ["update"],
  },
};

/**
 * Maps frontend routes to their required permissions.
 * Used to control page-level access and UI element visibility.
 */
export const requiredPagePermissionsMap: Record<string, Permissions> = {
  "/chat": {
    conversation: ["read"],
  },

  "/profiles": {
    profile: ["read"],
  },

  "/logs": {
    interaction: ["read"],
  },
  "/logs/llm-proxy": {
    interaction: ["read"],
  },
  "/logs/mcp-gateway": {
    mcpToolCall: ["read"],
  },

  "/tools": {
    tool: ["read"],
  },

  "/mcp-catalog": {
    internalMcpCatalog: ["read"],
  },
  "/mcp-catalog/registry": {
    internalMcpCatalog: ["read"],
  },
  "/mcp-catalog/installation-requests": {
    mcpServerInstallationRequest: ["read"],
  },

  "/settings": {
    organization: ["read"],
  },
  "/settings/gateways": {
    mcpServer: ["read"],
  },
  "/settings/dual-llm": {
    dualLlmConfig: ["read"],
  },
  "/settings/account": {
    organization: ["read"],
  },
  "/settings/members": {
    organization: ["read"],
  },
  "/settings/teams": {
    team: ["read"],
  },
  "/settings/roles": {
    organization: ["read"],
  },
  "/settings/appearance": {
    organization: ["update"],
  },
  "/settings/chat": {
    chatSettings: ["read"],
  },
  "/settings/sso-providers": {
    ssoProvider: ["read"],
  },
  "/settings/secrets": {
    organization: ["update"],
  },

  // Cost & Limits
  "/cost": {
    interaction: ["read"],
  },
  "/cost/statistics": {
    interaction: ["read"],
  },
  "/cost/limits": {
    limit: ["read"],
  },
  "/cost/token-price": {
    tokenPrice: ["read"],
  },
  "/cost/optimization-rules": {
    profile: ["read"],
  },
};

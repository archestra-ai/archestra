import { createAccessControl } from "better-auth/plugins/access";
import { z } from "zod";

export const ADMIN_ROLE_NAME = "admin";
export const MEMBER_ROLE_NAME = "member";
export const PredefinedRoleNameSchema = z.enum([
  ADMIN_ROLE_NAME,
  MEMBER_ROLE_NAME,
]);
export const AnyRoleName = PredefinedRoleNameSchema.or(z.string());

export const ActionSchema = z.enum([
  "create",
  "read",
  "update",
  "delete",
  "admin",
]);

export const ResourceSchema = z.enum([
  "agent",
  "tool",
  "policy",
  "interaction",
  "dualLlmConfig",
  "dualLlmResult",
  "organization",
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
]);

export const PermissionsSchema = z.partialRecord(
  ResourceSchema,
  z.array(ActionSchema),
);

export const allAvailableActions: Record<Resource, Action[]> = {
  agent: ["create", "read", "update", "delete", "admin"],
  tool: ["create", "read", "update", "delete"],
  policy: ["create", "read", "update", "delete"],
  dualLlmConfig: ["create", "read", "update", "delete"],
  dualLlmResult: ["create", "read", "update", "delete"],
  interaction: ["create", "read", "update", "delete"],
  organization: ["read", "update"],
  member: ["create", "update", "delete"],
  invitation: ["create"],
  internalMcpCatalog: ["create", "read", "update", "delete"],
  mcpServer: ["create", "read", "update", "delete", "admin"],
  mcpServerInstallationRequest: ["create", "read", "update", "delete", "admin"],
  team: ["create", "read", "update", "delete"],
  mcpToolCall: ["read"],
  conversation: ["create", "read", "update", "delete"],
  limit: ["create", "read", "update", "delete"],
  tokenPrice: ["create", "read", "update", "delete"],
};

export const ac = createAccessControl(allAvailableActions);

// all permissions granted
export const adminRole = ac.newRole({
  ...allAvailableActions,
});

export const memberRole = ac.newRole({
  agent: ["read"],
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
});

export const predefinedPermissionsMap: Record<PredefinedRoleName, Permissions> =
  {
    [ADMIN_ROLE_NAME]: adminRole.statements,
    [MEMBER_ROLE_NAME]: memberRole.statements,
  };

/**
 * Available resources and actions
 */
export type Resource = z.infer<typeof ResourceSchema>;
export type Action = z.infer<typeof ActionSchema>;

/**
 * Permission string format: "resource:action"
 * Examples: "agent:create", "tool:read", "org:delete", "agent:admin", "mcpServer:admin"
 *
 * Note: "admin" action is only valid for certain resources
 */
export type Permission =
  | `${Resource}:${"create" | "read" | "update" | "delete"}`
  | "agent:admin"
  | "mcpServer:admin"
  | "mcpServerInstallationRequest:admin";

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
  CreateChatConversation: "createChatConversation",
  UpdateChatConversation: "updateChatConversation",
  DeleteChatConversation: "deleteChatConversation",
  GetChatMcpTools: "getChatMcpTools",

  // Limits Routes
  GetLimits: "getLimits",
  CreateLimit: "createLimit",
  GetLimit: "getLimit",
  UpdateLimit: "updateLimit",
  DeleteLimit: "deleteLimit",

  // Organization Routes
  GetOrganization: "getOrganization",
  UpdateOrganization: "updateOrganization",

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

  // Onboarding Routes
  GetOnboardingLogsStatus: "getOnboardingLogsStatus",
  CompleteOnboarding: "completeOnboarding",
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
    agent: ["read"],
  },
  [RouteId.GetAllAgents]: {
    agent: ["read"],
  },
  [RouteId.GetAgent]: {
    agent: ["read"],
  },
  [RouteId.GetDefaultAgent]: {
    agent: ["read"],
  },
  [RouteId.CreateAgent]: {
    agent: ["create"],
  },
  [RouteId.UpdateAgent]: {
    agent: ["update"],
  },
  [RouteId.DeleteAgent]: {
    agent: ["delete"],
  },
  [RouteId.GetAgentTools]: {
    agent: ["read"],
    tool: ["read"],
  },
  [RouteId.GetAllAgentTools]: {
    agent: ["read"],
    tool: ["read"],
  },
  [RouteId.GetAgentAvailableTokens]: {
    agent: ["read"],
  },
  [RouteId.GetUnassignedTools]: {
    tool: ["read"],
  },
  [RouteId.AssignToolToAgent]: {
    agent: ["update"],
  },
  [RouteId.UnassignToolFromAgent]: {
    agent: ["update"],
  },
  [RouteId.UpdateAgentTool]: {
    agent: ["update"],
    tool: ["update"],
  },
  [RouteId.GetLabelKeys]: {
    agent: ["read"],
  },
  [RouteId.GetLabelValues]: {
    agent: ["read"],
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
  [RouteId.CreateChatConversation]: {
    conversation: ["create"],
  },
  [RouteId.UpdateChatConversation]: {
    conversation: ["update"],
  },
  [RouteId.DeleteChatConversation]: {
    conversation: ["delete"],
  },
  [RouteId.GetChatMcpTools]: {
    conversation: ["read"],
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
  // Onboarding routes - available to all authenticated users (no specific permissions required)
  [RouteId.GetOnboardingLogsStatus]: {},
  [RouteId.CompleteOnboarding]: {},
};

/**
 * TODO: flesh out all pages and their required permissions here
 */
export const requiredPagePermissionsMap: Record<string, Permissions> = {
  "/gateways": {
    mcpServer: ["read"],
  },
};

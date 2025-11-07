import type { Permissions } from "@shared";
import { RouteId } from "@/types";

/**
 * Routes not configured throws 403.
 * If a route should bypass the check, it should be configured in shouldSkipAuthCheck() method.
 * Each config has structure: { [routeId]: { [resource1]: [action1, action2], [resource2]: [action1] } }
 * That would mean that the route (routeId) requires all the permissions to pass the check:
 * `resource1:action1` AND `resource1:action2` AND `resource2:action1`
 */
const routePermissionsConfig: Partial<Record<RouteId, Permissions>> = {
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
  [RouteId.UpdateOrganizationCleanupInterval]: {
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
  [RouteId.GetOrganizationAppearance]: {
    organization: ["read"],
  },
  [RouteId.UpdateOrganizationAppearance]: {
    organization: ["update"],
  },
  [RouteId.UploadOrganizationLogo]: {
    organization: ["update"],
  },
  [RouteId.DeleteOrganizationLogo]: {
    organization: ["update"],
  },
};

export default routePermissionsConfig;

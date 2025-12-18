/**
 * This file contains access control stubs for the non-enterprise version of the app.
 *
 * Since there is no RBAC in non-enterprise version,
 * all exports are empty/permissive to allow all operations:
 *
 * - actions: Empty array (no actions defined)
 * - resources: Empty array (no resources defined)
 * - allAvailableActions: Empty object (no permissions)
 * - editorPermissions: Empty object (no permissions)
 * - memberPermissions: Empty object (no permissions)
 * - requiredEndpointPermissionsMap: Proxy that allows all endpoints (returns {} for any route)
 * - requiredPagePermissionsMap: Proxy that allows all pages (returns {} for any page)
 *
 * For the actual RBAC implementation with real permissions and access control,
 * see the enterprise edition: access-control.ee.ts
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
  team: ["create", "read", "update", "delete", "admin"],
  mcpToolCall: ["read"],
  conversation: ["create", "read", "update", "delete"],
  limit: ["create", "read", "update", "delete"],
  tokenPrice: ["create", "read", "update", "delete"],
  chatSettings: ["create", "read", "update", "delete"],
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

export const editorPermissions: Permissions = {
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
  chatSettings: ["create", "read", "update", "delete"],
  prompt: ["create", "read", "update", "delete"],
};

export const memberPermissions: Permissions = {
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
};

export const predefinedPermissionsMap: Record<PredefinedRoleName, Permissions> =
  {
    [ADMIN_ROLE_NAME]: allAvailableActions,
    [EDITOR_ROLE_NAME]: editorPermissions,
    [MEMBER_ROLE_NAME]: memberPermissions,
  };

/**
 * Available resources and actions
 */

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
  [RouteId.AutoConfigureAgentToolPolicies]: {
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
    tool: ["read"],
  },
  [RouteId.GetInteractions]: {
    interaction: ["read"],
  },
  [RouteId.GetInteraction]: {
    interaction: ["read"],
  },
  [RouteId.GetUniqueExternalAgentIds]: {
    interaction: ["read"],
  },
  [RouteId.GetUniqueUserIds]: {
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
  [RouteId.DeleteInternalMcpCatalogItemByName]: {
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
  [RouteId.GetChatModels]: {
    conversation: ["read"],
  },
  [RouteId.GetConversationEnabledTools]: {
    conversation: ["read"],
  },
  [RouteId.UpdateConversationEnabledTools]: {
    conversation: ["update"],
  },
  [RouteId.DeleteConversationEnabledTools]: {
    conversation: ["update"],
  },
  [RouteId.GetChatApiKeys]: {
    chatSettings: ["read"],
  },
  [RouteId.CreateChatApiKey]: {
    chatSettings: ["create"],
  },
  [RouteId.GetChatApiKey]: {
    chatSettings: ["read"],
  },
  [RouteId.UpdateChatApiKey]: {
    chatSettings: ["update"],
  },
  [RouteId.DeleteChatApiKey]: {
    chatSettings: ["delete"],
  },
  [RouteId.SetChatApiKeyDefault]: {
    chatSettings: ["update"],
  },
  [RouteId.UnsetChatApiKeyDefault]: {
    chatSettings: ["update"],
  },
  [RouteId.UpdateChatApiKeyProfiles]: {
    chatSettings: ["update"],
  },
  [RouteId.BulkAssignChatApiKeysToProfiles]: {
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
  [RouteId.InitializeSecretsManager]: {
    organization: ["update"],
  },
  [RouteId.GetSecret]: {
    organization: ["read"],
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

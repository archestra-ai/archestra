export const RouteId = {
  // Agent Routes
  GetAgents: "getAgents",
  GetAllAgents: "getAllAgents",
  CreateAgent: "createAgent",
  CloneAgent: "cloneAgent",
  GetAgent: "getAgent",
  GetDefaultMcpGateway: "getDefaultMcpGateway",
  GetDefaultLlmProxy: "getDefaultLlmProxy",
  UpdateAgent: "updateAgent",
  DeleteAgent: "deleteAgent",
  RestoreAgent: "restoreAgent",
  ExportAgent: "exportAgent",
  ImportAgent: "importAgent",
  GetLabelKeys: "getLabelKeys",
  GetLabelValues: "getLabelValues",

  // Schedule Trigger Routes
  GetScheduleTriggers: "getScheduleTriggers",
  CreateScheduleTrigger: "createScheduleTrigger",
  GetScheduleTrigger: "getScheduleTrigger",
  UpdateScheduleTrigger: "updateScheduleTrigger",
  DeleteScheduleTrigger: "deleteScheduleTrigger",
  EnableScheduleTrigger: "enableScheduleTrigger",
  DisableScheduleTrigger: "disableScheduleTrigger",
  RunScheduleTriggerNow: "runScheduleTriggerNow",
  GetScheduleTriggerRuns: "getScheduleTriggerRuns",
  GetScheduleTriggerRun: "getScheduleTriggerRun",
  CreateScheduleTriggerRunConversation: "createScheduleTriggerRunConversation",

  // Agent Tool Routes
  AssignToolToAgent: "assignToolToAgent",
  BulkAssignTools: "bulkAssignTools",
  BulkUpdateAgentTools: "bulkUpdateAgentTools",
  AutoConfigureAgentToolPolicies: "autoConfigureAgentToolPolicies",
  UnassignToolFromAgent: "unassignToolFromAgent",
  GetAgentTools: "getAgentTools",
  GetAllAgentTools: "getAllAgentTools",
  UpdateAgentTool: "updateAgentTool",
  GetAgentAvailableTokens: "getAgentAvailableTokens",

  // Agent Delegation Routes (internal agents only)
  GetAgentDelegations: "getAgentDelegations",
  SyncAgentDelegations: "syncAgentDelegations",
  DeleteAgentDelegation: "deleteAgentDelegation",
  GetAllDelegationConnections: "getAllDelegationConnections",

  // Config Routes
  GetConfig: "getConfig",
  GetPublicConfig: "getPublicConfig",

  // Auth Routes
  GetDefaultCredentialsStatus: "getDefaultCredentialsStatus",

  // MCP Catalog Routes
  GetInternalMcpCatalog: "getInternalMcpCatalog",
  CreateInternalMcpCatalogItem: "createInternalMcpCatalogItem",
  GetInternalMcpCatalogItem: "getInternalMcpCatalogItem",
  GetInternalMcpCatalogTools: "getInternalMcpCatalogTools",
  UpdateInternalMcpCatalogItem: "updateInternalMcpCatalogItem",
  ReinstallInternalMcpCatalogItem: "reinstallInternalMcpCatalogItem",
  RefreshInternalMcpCatalogImage: "refreshInternalMcpCatalogImage",
  DeleteInternalMcpCatalogItem: "deleteInternalMcpCatalogItem",
  DeleteInternalMcpCatalogItemByName: "deleteInternalMcpCatalogItemByName",
  GetInternalMcpCatalogLabelKeys: "getInternalMcpCatalogLabelKeys",
  GetInternalMcpCatalogLabelValues: "getInternalMcpCatalogLabelValues",
  GetDeploymentYamlPreview: "getDeploymentYamlPreview",
  ValidateDeploymentYaml: "validateDeploymentYaml",
  ResetDeploymentYaml: "resetDeploymentYaml",
  GetK8sImagePullSecrets: "getK8sImagePullSecrets",

  // MCP Server Routes
  GetMcpServers: "getMcpServers",
  GetMcpServer: "getMcpServer",
  GetMcpServerTools: "getMcpServerTools",
  InspectMcpServer: "inspectMcpServer",
  InstallMcpServer: "installMcpServer",
  DeleteMcpServer: "deleteMcpServer",
  ReauthenticateMcpServer: "reauthenticateMcpServer",
  ReinstallMcpServer: "reinstallMcpServer",
  GetMcpServerInstallationStatus: "getMcpServerInstallationStatus",
  // MCP Gateway Routes
  McpGatewayGet: "mcpGatewayGet",
  McpGatewayPost: "mcpGatewayPost",
  McpProxyPost: "mcpProxyPost", // Frontend session-based proxy to MCP Gateway

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
  GetOAuthClientInfo: "getOAuthClientInfo",
  SubmitOAuthConsent: "submitOAuthConsent",

  // Team Routes
  GetMembers: "getMembers",
  GetTeams: "getTeams",
  CreateTeam: "createTeam",
  GetTeam: "getTeam",
  UpdateTeam: "updateTeam",
  DeleteTeam: "deleteTeam",
  GetTeamMembers: "getTeamMembers",
  AddTeamMember: "addTeamMember",
  UpdateTeamMember: "updateTeamMember",
  RemoveTeamMember: "removeTeamMember",
  GetTeamLabelKeys: "getTeamLabelKeys",
  GetTeamLabelValues: "getTeamLabelValues",

  // Team External Group Routes (SSO Team Sync)
  GetTeamExternalGroups: "getTeamExternalGroups",
  AddTeamExternalGroup: "addTeamExternalGroup",
  RemoveTeamExternalGroup: "removeTeamExternalGroup",

  // Team Vault Folder Routes (BYOS - Bring Your Own Secrets)
  GetTeamVaultFolder: "getTeamVaultFolder",
  SetTeamVaultFolder: "setTeamVaultFolder",
  DeleteTeamVaultFolder: "deleteTeamVaultFolder",
  CheckTeamVaultFolderConnectivity: "checkTeamVaultFolderConnectivity",
  ListTeamVaultFolderSecrets: "listTeamVaultFolderSecrets",
  GetTeamVaultSecretKeys: "getTeamVaultSecretKeys",

  // Role Routes
  GetRoles: "getRoles",
  CreateRole: "createRole",
  GetRole: "getRole",
  UpdateRole: "updateRole",
  DeleteRole: "deleteRole",

  // Tool Routes
  GetTools: "getTools",
  GetToolsWithAssignments: "getToolsWithAssignments",
  GetUnassignedTools: "getUnassignedTools",
  DeleteTool: "deleteTool",

  // Interaction Routes
  GetInteractions: "getInteractions",
  GetInteraction: "getInteraction",
  GetInteractionSessions: "getInteractionSessions",
  GetUniqueExternalAgentIds: "getUniqueExternalAgentIds",
  GetUniqueUserIds: "getUniqueUserIds",

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
  BulkUpsertDefaultCallPolicy: "bulkUpsertDefaultCallPolicy",
  BulkUpsertDefaultResultPolicy: "bulkUpsertDefaultResultPolicy",

  // Proxy Routes - OpenAI
  OpenAiChatCompletionsWithDefaultAgent:
    "openAiChatCompletionsWithDefaultAgent",
  OpenAiChatCompletionsWithAgent: "openAiChatCompletionsWithAgent",
  OpenAiResponsesWithDefaultAgent: "openAiResponsesWithDefaultAgent",
  OpenAiResponsesWithAgent: "openAiResponsesWithAgent",
  OpenAiEmbeddingsWithDefaultAgent: "openAiEmbeddingsWithDefaultAgent",
  OpenAiEmbeddingsWithAgent: "openAiEmbeddingsWithAgent",
  OpenAiListModelsWithDefaultAgent: "openAiListModelsWithDefaultAgent",
  OpenAiListModelsWithAgent: "openAiListModelsWithAgent",

  // Proxy Routes - OpenAI-compatible model router
  ModelRouterChatCompletionsWithDefaultAgent:
    "modelRouterChatCompletionsWithDefaultAgent",
  ModelRouterChatCompletionsWithAgent: "modelRouterChatCompletionsWithAgent",
  ModelRouterListModelsWithDefaultAgent:
    "modelRouterListModelsWithDefaultAgent",
  ModelRouterListModelsWithAgent: "modelRouterListModelsWithAgent",
  ModelRouterResponsesWithDefaultAgent: "modelRouterResponsesWithDefaultAgent",
  ModelRouterResponsesWithAgent: "modelRouterResponsesWithAgent",
  ModelRouterEmbeddingsWithDefaultAgent:
    "modelRouterEmbeddingsWithDefaultAgent",
  ModelRouterEmbeddingsWithAgent: "modelRouterEmbeddingsWithAgent",

  // Proxy Routes - Anthropic
  AnthropicMessagesWithDefaultAgent: "anthropicMessagesWithDefaultAgent",
  AnthropicMessagesWithAgent: "anthropicMessagesWithAgent",
  AnthropicListModelsWithDefaultAgent: "anthropicListModelsWithDefaultAgent",
  AnthropicListModelsWithAgent: "anthropicListModelsWithAgent",

  // Proxy Routes - Cohere
  CohereChatWithDefaultAgent: "cohereChatWithDefaultAgent",
  CohereChatWithAgent: "cohereChatWithAgent",
  // Proxy Routes - Cerebras
  CerebrasChatCompletionsWithDefaultAgent:
    "cerebrasChatCompletionsWithDefaultAgent",
  CerebrasChatCompletionsWithAgent: "cerebrasChatCompletionsWithAgent",

  // Proxy Routes - Mistral
  MistralChatCompletionsWithDefaultAgent:
    "mistralChatCompletionsWithDefaultAgent",
  MistralChatCompletionsWithAgent: "mistralChatCompletionsWithAgent",

  // Proxy Routes - Perplexity
  PerplexityChatCompletionsWithDefaultAgent:
    "perplexityChatCompletionsWithDefaultAgent",
  PerplexityChatCompletionsWithAgent: "perplexityChatCompletionsWithAgent",

  // Proxy Routes - Groq
  GroqChatCompletionsWithDefaultAgent: "groqChatCompletionsWithDefaultAgent",
  GroqChatCompletionsWithAgent: "groqChatCompletionsWithAgent",

  // Proxy Routes - xAI
  XaiChatCompletionsWithDefaultAgent: "xaiChatCompletionsWithDefaultAgent",
  XaiChatCompletionsWithAgent: "xaiChatCompletionsWithAgent",

  // Proxy Routes - OpenRouter
  OpenrouterChatCompletionsWithDefaultAgent:
    "openrouterChatCompletionsWithDefaultAgent",
  OpenrouterChatCompletionsWithAgent: "openrouterChatCompletionsWithAgent",

  // Proxy Routes - vLLM
  VllmChatCompletionsWithDefaultAgent: "vllmChatCompletionsWithDefaultAgent",
  VllmChatCompletionsWithAgent: "vllmChatCompletionsWithAgent",

  // Proxy Routes - Ollama
  OllamaChatCompletionsWithDefaultAgent:
    "ollamaChatCompletionsWithDefaultAgent",
  OllamaChatCompletionsWithAgent: "ollamaChatCompletionsWithAgent",
  // Proxy Routes - Zhipu AI
  ZhipuaiChatCompletionsWithDefaultAgent:
    "zhipuaiChatCompletionsWithDefaultAgent",
  ZhipuaiChatCompletionsWithAgent: "zhipuaiChatCompletionsWithAgent",

  // Proxy Routes - DeepSeek
  DeepSeekChatCompletionsWithDefaultAgent:
    "deepseekChatCompletionsWithDefaultAgent",
  DeepSeekChatCompletionsWithAgent: "deepseekChatCompletionsWithAgent",

  // Proxy Routes - AWS Bedrock
  BedrockConverseWithDefaultAgent: "bedrockConverseWithDefaultAgent",
  BedrockConverseWithAgent: "bedrockConverseWithAgent",
  BedrockConverseStreamWithDefaultAgent:
    "bedrockConverseStreamWithDefaultAgent",
  BedrockConverseStreamWithAgent: "bedrockConverseStreamWithAgent",
  // AI SDK compatible routes (model ID in URL)
  BedrockConverseWithAgentAndModel: "bedrockConverseWithAgentAndModel",
  BedrockConverseStreamWithAgentAndModel:
    "bedrockConverseStreamWithAgentAndModel",
  // OpenAI-compatible routes (translate OpenAI chat/completions ↔ Converse)
  BedrockOpenaiChatCompletionsWithDefaultAgent:
    "bedrockOpenaiChatCompletionsWithDefaultAgent",
  BedrockOpenaiChatCompletionsWithAgent:
    "bedrockOpenaiChatCompletionsWithAgent",
  BedrockOpenaiListModelsWithDefaultAgent:
    "bedrockOpenaiListModelsWithDefaultAgent",
  BedrockOpenaiListModelsWithAgent: "bedrockOpenaiListModelsWithAgent",

  // Proxy Routes - MiniMax
  MinimaxChatCompletionsWithDefaultAgent:
    "minimaxChatCompletionsWithDefaultAgent",
  MinimaxChatCompletionsWithAgent: "minimaxChatCompletionsWithAgent",

  // Proxy Routes - GitHub Copilot
  GithubCopilotChatCompletionsWithDefaultAgent:
    "githubCopilotChatCompletionsWithDefaultAgent",
  GithubCopilotChatCompletionsWithAgent:
    "githubCopilotChatCompletionsWithAgent",
  GithubCopilotListModelsWithDefaultAgent:
    "githubCopilotListModelsWithDefaultAgent",
  GithubCopilotListModelsWithAgent: "githubCopilotListModelsWithAgent",

  // GitHub Copilot device-flow sign-in (creates personal provider keys)
  GithubCopilotDeviceAuthStart: "githubCopilotDeviceAuthStart",
  GithubCopilotDeviceAuthPoll: "githubCopilotDeviceAuthPoll",

  // Proxy Routes - Azure AI Foundry
  AzureChatCompletionsWithDefaultAgent: "azureChatCompletionsWithDefaultAgent",
  AzureChatCompletionsWithAgent: "azureChatCompletionsWithAgent",
  AzureResponsesWithDefaultAgent: "azureResponsesWithDefaultAgent",
  AzureResponsesWithAgent: "azureResponsesWithAgent",

  // Chat Routes
  StreamChat: "streamChat",
  ResolveChatMcpElicitation: "resolveChatMcpElicitation",
  StopChatStream: "stopChatStream",
  GetActiveChatRun: "getActiveChatRun",
  GetChatConversations: "getChatConversations",
  GetChatConversation: "getChatConversation",
  GetChatConversationFiles: "getChatConversationFiles",
  GetChatAgentMcpTools: "getChatAgentMcpTools",
  CreateChatConversation: "createChatConversation",
  ForkChatConversation: "forkChatConversation",
  UpdateChatConversation: "updateChatConversation",
  SetConversationHooksDebug: "setConversationHooksDebug",
  DeleteChatConversation: "deleteChatConversation",
  CompactChatConversation: "compactChatConversation",
  GenerateChatConversationTitle: "generateChatConversationTitle",
  GetChatMcpTools: "getChatMcpTools",
  UpdateChatMessage: "updateChatMessage",
  GetConversationEnabledTools: "getConversationEnabledTools",
  UpdateConversationEnabledTools: "updateConversationEnabledTools",
  DeleteConversationEnabledTools: "deleteConversationEnabledTools",
  ShareConversation: "shareConversation",
  UnshareConversation: "unshareConversation",
  GetConversationShare: "getConversationShare",
  GetSharedConversation: "getSharedConversation",
  ForkSharedConversation: "forkSharedConversation",
  GetChatAttachmentContent: "getChatAttachmentContent",
  PromoteChatAttachmentToKnowledgeFile: "promoteChatAttachmentToKnowledgeFile",
  GetLlmModels: "getLlmModels",
  SyncLlmModels: "syncLlmModels",

  // LLM Provider API Key Routes
  GetLlmProviderApiKeys: "getLlmProviderApiKeys",
  GetAvailableLlmProviderApiKeys: "getAvailableLlmProviderApiKeys",
  CreateLlmProviderApiKey: "createLlmProviderApiKey",
  GetLlmProviderApiKey: "getLlmProviderApiKey",
  UpdateLlmProviderApiKey: "updateLlmProviderApiKey",
  DeleteLlmProviderApiKey: "deleteLlmProviderApiKey",

  // User API Key Routes
  GetApiKeys: "getApiKeys",
  GetApiKey: "getApiKey",
  CreateApiKey: "createApiKey",
  DeleteApiKey: "deleteApiKey",

  // Service Account Routes
  GetServiceAccounts: "getServiceAccounts",
  GetServiceAccount: "getServiceAccount",
  CreateServiceAccount: "createServiceAccount",
  UpdateServiceAccount: "updateServiceAccount",
  DeleteServiceAccount: "deleteServiceAccount",
  CreateServiceAccountToken: "createServiceAccountToken",
  UpdateServiceAccountToken: "updateServiceAccountToken",
  DeleteServiceAccountToken: "deleteServiceAccountToken",

  // Virtual API Key Routes
  GetAllVirtualApiKeys: "getAllVirtualApiKeys",
  CreateVirtualApiKey: "createVirtualApiKey",
  UpdateVirtualApiKey: "updateVirtualApiKey",
  DeleteVirtualApiKey: "deleteVirtualApiKey",

  // LLM OAuth Client Routes
  GetLlmOauthClients: "getLlmOauthClients",
  CreateLlmOauthClient: "createLlmOauthClient",
  UpdateLlmOauthClient: "updateLlmOauthClient",
  RotateLlmOauthClientSecret: "rotateLlmOauthClientSecret",
  DeleteLlmOauthClient: "deleteLlmOauthClient",

  // MCP OAuth Client Routes
  GetMcpOauthClients: "getMcpOauthClients",
  CreateMcpOauthClient: "createMcpOauthClient",
  UpdateMcpOauthClient: "updateMcpOauthClient",
  RotateMcpOauthClientSecret: "rotateMcpOauthClientSecret",
  DeleteMcpOauthClient: "deleteMcpOauthClient",

  // Models with API Keys Routes
  GetModelsWithApiKeys: "getModelsWithApiKeys",
  UpdateModel: "updateModel",

  // Limits Routes
  GetLimits: "getLimits",
  CreateLimit: "createLimit",
  GetLimit: "getLimit",
  UpdateLimit: "updateLimit",
  DeleteLimit: "deleteLimit",

  // Organization Routes
  GetOrganization: "getOrganization",
  GetOnboardingStatus: "getOnboardingStatus",
  GetMemberSignupStatus: "getMemberSignupStatus",
  GetOrganizationMembers: "getOrganizationMembers",
  GetOrganizationMember: "getOrganizationMember",
  DeletePendingSignupMember: "deletePendingSignupMember",
  CompleteOnboarding: "completeOnboarding",

  // Appearance Settings Routes
  GetAppearanceSettings: "getAppearanceSettings",
  UpdateAppearanceSettings: "updateAppearanceSettings",

  // Security Settings Routes
  UpdateSecuritySettings: "updateSecuritySettings",

  // LLM Settings Routes (organization-level)
  UpdateLlmSettings: "updateLlmSettings",

  // Agent Settings Routes (organization-level)
  UpdateAgentSettings: "updateAgentSettings",

  // Auth Settings Routes (organization-level)
  UpdateAuthSettings: "updateAuthSettings",

  // Connection Settings Routes (organization-level)
  UpdateConnectionSettings: "updateConnectionSettings",

  // Org-level deployment environments
  ListEnvironments: "listEnvironments",
  CreateEnvironment: "createEnvironment",
  UpdateEnvironment: "updateEnvironment",
  DeleteEnvironment: "deleteEnvironment",
  UpdateDefaultEnvironment: "updateDefaultEnvironment",
  GetK8sCapabilities: "getK8sCapabilities",

  // GitHub App Configuration Routes
  ListGithubAppConfigs: "listGithubAppConfigs",
  CreateGithubAppConfig: "createGithubAppConfig",
  GetGithubAppConfig: "getGithubAppConfig",
  UpdateGithubAppConfig: "updateGithubAppConfig",
  DeleteGithubAppConfig: "deleteGithubAppConfig",

  // Knowledge Settings Routes (organization-level)
  UpdateKnowledgeSettings: "updateKnowledgeSettings",
  DropEmbeddingConfig: "dropEmbeddingConfig",
  TestEmbeddingConnection: "testEmbeddingConnection",

  // Identity Provider Routes
  GetPublicIdentityProviders: "getPublicIdentityProviders",
  GetIdentityProviders: "getIdentityProviders",
  GetIdentityProvider: "getIdentityProvider",
  GetIdentityProviderLatestIdTokenClaims:
    "getIdentityProviderLatestIdTokenClaims",
  GetIdentityProviderLinkStatus: "getIdentityProviderLinkStatus",
  CreateIdentityProvider: "createIdentityProvider",
  UpdateIdentityProvider: "updateIdentityProvider",
  DeleteIdentityProvider: "deleteIdentityProvider",
  GetIdentityProviderIdpLogoutUrl: "getIdentityProviderIdpLogoutUrl",

  // Member Routes
  GetMemberDefaultAgent: "getMemberDefaultAgent",
  GetMemberDefaultModel: "getMemberDefaultModel",
  UpdateMemberDefaultModel: "updateMemberDefaultModel",

  // User Routes
  GetUserPermissions: "getUserPermissions",
  GetImpersonableUsers: "getImpersonableUsers",

  // Team Token Routes
  GetTokens: "getTokens",
  GetTokenValue: "getTokenValue",
  RotateToken: "rotateToken",

  // User Token Routes (Personal Tokens)
  GetUserToken: "getUserToken",
  GetUserTokenValue: "getUserTokenValue",
  RotateUserToken: "rotateUserToken",

  // Statistics Routes
  GetTeamStatistics: "getTeamStatistics",
  GetAgentStatistics: "getAgentStatistics",
  GetModelStatistics: "getModelStatistics",
  GetOverviewStatistics: "getOverviewStatistics",
  GetCostSavingsStatistics: "getCostSavingsStatistics",

  // Optimization Rule Routes
  GetOptimizationRules: "getOptimizationRules",
  GetOptimizationRule: "getOptimizationRule",
  CreateOptimizationRule: "createOptimizationRule",
  UpdateOptimizationRule: "updateOptimizationRule",
  DeleteOptimizationRule: "deleteOptimizationRule",

  // Secrets Routes
  GetSecretsType: "getSecretsType",
  GetSecret: "getSecret",
  CheckSecretsConnectivity: "checkSecretsConnectivity",

  // Incoming Email Routes
  GetIncomingEmailStatus: "getIncomingEmailStatus",
  SetupIncomingEmailWebhook: "setupIncomingEmailWebhook",
  RenewIncomingEmailSubscription: "renewIncomingEmailSubscription",
  DeleteIncomingEmailSubscription: "deleteIncomingEmailSubscription",
  GetAgentEmailAddress: "getAgentEmailAddress",

  // ChatOps Routes
  GetChatOpsStatus: "getChatOpsStatus",
  ListChatOpsBindings: "listChatOpsBindings",
  DeleteChatOpsBinding: "deleteChatOpsBinding",
  UpdateChatOpsBinding: "updateChatOpsBinding",
  BulkUpdateChatOpsBindings: "bulkUpdateChatOpsBindings",
  CreateChatOpsDmBinding: "createChatOpsDmBinding",
  UpdateChatOpsConfigInQuickstart: "updateChatOpsConfigInQuickstart",
  UpdateSlackChatOpsConfig: "updateSlackChatOpsConfig",
  ConnectNgrok: "connectNgrok",
  DisconnectNgrok: "disconnectNgrok",
  GetNgrokConfig: "getNgrokConfig",
  RefreshChatOpsChannelDiscovery: "refreshChatOpsChannelDiscovery",

  // Knowledge Base Routes
  GetKnowledgeBases: "getKnowledgeBases",
  CreateKnowledgeBase: "createKnowledgeBase",
  GetKnowledgeBase: "getKnowledgeBase",
  UpdateKnowledgeBase: "updateKnowledgeBase",
  DeleteKnowledgeBase: "deleteKnowledgeBase",
  GetKnowledgeBaseHealth: "getKnowledgeBaseHealth",

  // Knowledge Base Connector Routes
  GetConnectors: "getConnectors",
  CreateConnector: "createConnector",
  GetConnector: "getConnector",
  GetConnectorDocuments: "getConnectorDocuments",
  GetConnectorDocument: "getConnectorDocument",
  UpdateConnector: "updateConnector",
  DeleteConnector: "deleteConnector",
  DeleteConnectorDocument: "deleteConnectorDocument",
  SyncConnector: "syncConnector",
  ForceResyncConnector: "forceResyncConnector",
  TestConnectorConnection: "testConnectorConnection",

  // Connector Knowledge Base Assignment Routes
  AssignConnectorToKnowledgeBases: "assignConnectorToKnowledgeBases",
  UnassignConnectorFromKnowledgeBase: "unassignConnectorFromKnowledgeBase",
  GetConnectorKnowledgeBases: "getConnectorKnowledgeBases",

  // Connector Run Routes
  GetConnectorRuns: "getConnectorRuns",
  GetConnectorRun: "getConnectorRun",

  // Knowledge File Routes
  GetKnowledgeFiles: "getKnowledgeFiles",
  UploadKnowledgeFiles: "uploadKnowledgeFiles",
  GetKnowledgeFile: "getKnowledgeFile",
  GetKnowledgeFileContent: "getKnowledgeFileContent",
  UpdateKnowledgeFile: "updateKnowledgeFile",
  DeleteKnowledgeFile: "deleteKnowledgeFile",
  GetKnowledgeFileUploadConfig: "getKnowledgeFileUploadConfig",

  // Invitation Routes
  CheckInvitation: "checkInvitation",

  // Site Notification Routes
  GetSiteNotification: "getSiteNotification",
  GetSiteNotificationSettings: "getSiteNotificationSettings",
  CreateSiteNotification: "createSiteNotification",
  UpdateSiteNotification: "updateSiteNotification",
  DeleteSiteNotification: "deleteSiteNotification",

  // Agent Skill Routes
  GetSkills: "getSkills",
  CreateSkill: "createSkill",
  ConvertAgentToSkill: "convertAgentToSkill",
  SuggestSkillDescription: "suggestSkillDescription",
  GetSkill: "getSkill",
  UpdateSkill: "updateSkill",
  DeleteSkill: "deleteSkill",
  ResetSkill: "resetSkill",
  DiscoverGithubSkills: "discoverGithubSkills",
  SearchSkillCatalog: "searchSkillCatalog",
  PreviewGithubSkill: "previewGithubSkill",
  ImportGithubSkills: "importGithubSkills",
  GetSkillSourceRepos: "getSkillSourceRepos",
  EnableSkillToolDefaults: "enableSkillToolDefaults",
  GetSkillSandboxArtifact: "getSkillSandboxArtifact",
  GetSkillSandboxConversationArtifacts: "getSkillSandboxConversationArtifacts",
  GetSkillSandboxFiles: "getSkillSandboxFiles",
  CreateProject: "createProject",
  GetProjects: "getProjects",
  GetProject: "getProject",
  UpdateProject: "updateProject",
  SetProjectShare: "setProjectShare",
  DeleteProject: "deleteProject",
  GetProjectConversations: "getProjectConversations",
  GetProjectFiles: "getProjectFiles",
  DeleteSkillSandboxArtifact: "deleteSkillSandboxArtifact",

  // Audit Log Routes
  GetAuditLogs: "getAuditLogs",

  // Hook File Routes
  GetHooks: "getHooks",
  CreateHook: "createHook",
  UpdateHook: "updateHook",
  DeleteHook: "deleteHook",

  // Skill Share Link Routes
  GetSkillShareLinks: "getSkillShareLinks",
  CreateSkillShareLink: "createSkillShareLink",
  RevokeSkillShareLink: "revokeSkillShareLink",
  RotateSkillShareLink: "rotateSkillShareLink",

  // Connection Setup Routes
  CreateConnectionSetup: "createConnectionSetup",
  GetConnectionSetupScript: "getConnectionSetupScript",
  CreateConnectionVirtualKey: "createConnectionVirtualKey",

  // MCP App Routes
  GetApps: "getApps",
  CreateApp: "createApp",
  GetApp: "getApp",
  UpdateApp: "updateApp",
  DeleteApp: "deleteApp",
  GetAppVersions: "getAppVersions",
  GetAppVersion: "getAppVersion",
  GetAppTools: "getAppTools",
  AssignToolToApp: "assignToolToApp",
  UnassignToolFromApp: "unassignToolFromApp",
  GetAppTemplates: "getAppTemplates",
  PostAppRenderDiagnostics: "postAppRenderDiagnostics",
  PostAppRenderScreenshot: "postAppRenderScreenshot",
  // Frontend session-based proxy to the app-bound MCP server (chat + standalone)
  McpAppProxyPost: "mcpAppProxyPost",
} as const;

export type RouteId = (typeof RouteId)[keyof typeof RouteId];

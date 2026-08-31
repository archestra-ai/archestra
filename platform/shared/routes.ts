export const RouteId = {
  // Agent Routes
  GetAgents: "getAgents",
  GetAllAgents: "getAllAgents",
  GetAgentCredentialReadiness: "getAgentCredentialReadiness",
  CreateAgent: "createAgent",
  CloneAgent: "cloneAgent",
  GetAgent: "getAgent",
  GetDefaultMcpGateway: "getDefaultMcpGateway",
  GetLlmProxy: "getLlmProxy",
  UpdateLlmProxy: "updateLlmProxy",
  UpdateAgent: "updateAgent",
  DeleteAgent: "deleteAgent",
  BulkUpdateAgents: "bulkUpdateAgents",
  BulkDeleteAgents: "bulkDeleteAgents",
  RestoreAgent: "restoreAgent",
  PermanentlyDeleteAgent: "permanentlyDeleteAgent",
  GetAgentVersions: "getAgentVersions",
  GetAgentVersion: "getAgentVersion",
  RestoreAgentVersion: "restoreAgentVersion",
  ExportAgent: "exportAgent",
  ImportAgent: "importAgent",
  GetAgentToolExclusions: "getAgentToolExclusions",
  UpdateAgentToolExclusions: "updateAgentToolExclusions",
  GetAgentSubagentExclusions: "getAgentSubagentExclusions",
  UpdateAgentSubagentExclusions: "updateAgentSubagentExclusions",
  GetAgentKnowledgeSourceExclusions: "getAgentKnowledgeSourceExclusions",
  UpdateAgentKnowledgeSourceExclusions: "updateAgentKnowledgeSourceExclusions",
  GetAgentSkills: "getAgentSkills",
  UpdateAgentSkills: "updateAgentSkills",
  GetAgentSkillExclusions: "getAgentSkillExclusions",
  UpdateAgentSkillExclusions: "updateAgentSkillExclusions",
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

  // RUM Routes
  IngestRumEvents: "ingestRumEvents",

  // Auth Routes
  GetDefaultCredentialsStatus: "getDefaultCredentialsStatus",
  GetAuthState: "getAuthState",
  BulkRevokeSessions: "bulkRevokeSessions",

  // MCP Catalog Routes
  GetInternalMcpCatalog: "getInternalMcpCatalog",
  CreateInternalMcpCatalogItem: "createInternalMcpCatalogItem",
  GetInternalMcpCatalogItem: "getInternalMcpCatalogItem",
  GetInternalMcpCatalogTools: "getInternalMcpCatalogTools",
  GetInternalMcpCatalogToolsBatch: "getInternalMcpCatalogToolsBatch",
  UpdateInternalMcpCatalogItem: "updateInternalMcpCatalogItem",
  ReinstallInternalMcpCatalogItem: "reinstallInternalMcpCatalogItem",
  RefreshInternalMcpCatalogImage: "refreshInternalMcpCatalogImage",
  DeleteInternalMcpCatalogItem: "deleteInternalMcpCatalogItem",
  DeleteInternalMcpCatalogItemByName: "deleteInternalMcpCatalogItemByName",
  RestoreInternalMcpCatalogItem: "restoreInternalMcpCatalogItem",
  GetInternalMcpCatalogLabelKeys: "getInternalMcpCatalogLabelKeys",
  GetInternalMcpCatalogLabelValues: "getInternalMcpCatalogLabelValues",
  ListPendingImageApprovalCatalogItems: "listPendingImageApprovalCatalogItems",
  ApproveCatalogItemImage: "approveCatalogItemImage",
  GetDeploymentYamlPreview: "getDeploymentYamlPreview",
  ValidateDeploymentYaml: "validateDeploymentYaml",
  ResetDeploymentYaml: "resetDeploymentYaml",
  GetK8sImagePullSecrets: "getK8sImagePullSecrets",

  // MCP Server Routes
  GetMcpServers: "getMcpServers",
  GetMcpServerAutoModeAgents: "getMcpServerAutoModeAgents",
  GetMcpServer: "getMcpServer",
  GetMcpServerTools: "getMcpServerTools",
  InspectMcpServer: "inspectMcpServer",
  InstallMcpServer: "installMcpServer",
  DeleteMcpServer: "deleteMcpServer",
  BulkDeleteMcpServers: "bulkDeleteMcpServers",
  RestoreMcpServer: "restoreMcpServer",
  ReauthenticateMcpServer: "reauthenticateMcpServer",
  ReinstallMcpServer: "reinstallMcpServer",
  HardResetMcpServer: "hardResetMcpServer",
  ReloadMcpServerTools: "reloadMcpServerTools",
  GetMcpServerInstallationStatus: "getMcpServerInstallationStatus",
  MuteMcpServerAlert: "muteMcpServerAlert",
  UnmuteMcpServerAlert: "unmuteMcpServerAlert",
  MuteMcpCatalogAlert: "muteMcpCatalogAlert",
  UnmuteMcpCatalogAlert: "unmuteMcpCatalogAlert",
  // MCP Gateway Routes
  McpGatewayGet: "mcpGatewayGet",
  McpGatewayPost: "mcpGatewayPost",
  McpProxyPost: "mcpProxyPost", // Frontend session-based proxy to MCP Gateway
  McpServerProxyPost: "mcpServerProxyPost", // Session-based proxy to one installed server's MCP App runtime

  // OAuth Routes
  InitiateOAuth: "initiateOAuth",
  HandleOAuthCallback: "handleOAuthCallback",
  GetOAuthClientInfo: "getOAuthClientInfo",
  SubmitOAuthConsent: "submitOAuthConsent",

  // Team Routes
  GetMembers: "getMembers",
  BulkDeleteMembers: "bulkDeleteMembers",
  GetTeams: "getTeams",
  CreateTeam: "createTeam",
  GetTeam: "getTeam",
  UpdateTeam: "updateTeam",
  DeleteTeam: "deleteTeam",
  BulkDeleteTeams: "bulkDeleteTeams",
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
  BulkDeleteRoles: "bulkDeleteRoles",

  // Tool Routes
  GetTool: "getTool",
  GetTools: "getTools",
  GetToolsWithAssignments: "getToolsWithAssignments",
  GetToolObservers: "getToolObservers",
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

  // Proxy Routes - Gemini
  GeminiEmbeddingsWithDefaultAgent: "geminiEmbeddingsWithDefaultAgent",
  GeminiEmbeddingsWithAgent: "geminiEmbeddingsWithAgent",

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
  MistralEmbeddingsWithDefaultAgent: "mistralEmbeddingsWithDefaultAgent",
  MistralEmbeddingsWithAgent: "mistralEmbeddingsWithAgent",

  // Proxy Routes - Perplexity
  PerplexityChatCompletionsWithDefaultAgent:
    "perplexityChatCompletionsWithDefaultAgent",
  PerplexityChatCompletionsWithAgent: "perplexityChatCompletionsWithAgent",

  // Proxy Routes - Perplexity Agent API (the provider's Responses-shaped surface)
  PerplexityResponsesWithDefaultAgent: "perplexityResponsesWithDefaultAgent",
  PerplexityResponsesWithAgent: "perplexityResponsesWithAgent",

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
  VllmEmbeddingsWithDefaultAgent: "vllmEmbeddingsWithDefaultAgent",
  VllmEmbeddingsWithAgent: "vllmEmbeddingsWithAgent",

  // Proxy Routes - Ollama
  OllamaChatCompletionsWithDefaultAgent:
    "ollamaChatCompletionsWithDefaultAgent",
  OllamaChatCompletionsWithAgent: "ollamaChatCompletionsWithAgent",
  OllamaEmbeddingsWithDefaultAgent: "ollamaEmbeddingsWithDefaultAgent",
  OllamaEmbeddingsWithAgent: "ollamaEmbeddingsWithAgent",
  // Proxy Routes - Ollama Native (/api/chat)
  OllamaNativeChatWithDefaultAgent: "ollamaNativeChatWithDefaultAgent",
  OllamaNativeChatWithAgent: "ollamaNativeChatWithAgent",
  // Proxy Routes - Zhipu AI
  ZhipuaiChatCompletionsWithDefaultAgent:
    "zhipuaiChatCompletionsWithDefaultAgent",
  ZhipuaiChatCompletionsWithAgent: "zhipuaiChatCompletionsWithAgent",
  ZhipuaiEmbeddingsWithDefaultAgent: "zhipuaiEmbeddingsWithDefaultAgent",
  ZhipuaiEmbeddingsWithAgent: "zhipuaiEmbeddingsWithAgent",

  // Proxy Routes - DeepSeek
  DeepSeekChatCompletionsWithDefaultAgent:
    "deepseekChatCompletionsWithDefaultAgent",
  DeepSeekChatCompletionsWithAgent: "deepseekChatCompletionsWithAgent",

  // Proxy Routes - Archestra
  ArchestraChatCompletionsWithDefaultAgent:
    "archestraChatCompletionsWithDefaultAgent",
  ArchestraChatCompletionsWithAgent: "archestraChatCompletionsWithAgent",

  // Proxy Routes - Kimi (Moonshot AI)
  KimiChatCompletionsWithDefaultAgent: "kimiChatCompletionsWithDefaultAgent",
  KimiChatCompletionsWithAgent: "kimiChatCompletionsWithAgent",

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
  // Native InvokeModel routes (Anthropic Messages wire format, model ID in URL)
  BedrockInvokeWithDefaultAgentAndModel:
    "bedrockInvokeWithDefaultAgentAndModel",
  BedrockInvokeWithAgentAndModel: "bedrockInvokeWithAgentAndModel",
  BedrockInvokeStreamWithDefaultAgentAndModel:
    "bedrockInvokeStreamWithDefaultAgentAndModel",
  BedrockInvokeStreamWithAgentAndModel: "bedrockInvokeStreamWithAgentAndModel",
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

  // Proxy Routes - GitHub Copilot Responses API (the surface Copilot's
  // Codex/GPT-5.x models are served on; they reject /chat/completions)
  GithubCopilotResponsesWithDefaultAgent:
    "githubCopilotResponsesWithDefaultAgent",
  GithubCopilotResponsesWithAgent: "githubCopilotResponsesWithAgent",

  // GitHub Copilot device-flow sign-in (creates personal provider keys)
  GithubCopilotDeviceAuthStart: "githubCopilotDeviceAuthStart",
  GithubCopilotDeviceAuthPoll: "githubCopilotDeviceAuthPoll",

  // Proxy Routes - Microsoft 365 Copilot
  Microsoft365CopilotChatCompletionsWithDefaultAgent:
    "microsoft365CopilotChatCompletionsWithDefaultAgent",
  Microsoft365CopilotChatCompletionsWithAgent:
    "microsoft365CopilotChatCompletionsWithAgent",
  Microsoft365CopilotListModelsWithDefaultAgent:
    "microsoft365CopilotListModelsWithDefaultAgent",
  Microsoft365CopilotListModelsWithAgent:
    "microsoft365CopilotListModelsWithAgent",

  // Microsoft 365 Copilot device-flow sign-in (creates personal provider keys)
  Microsoft365CopilotDeviceAuthStart: "microsoft365CopilotDeviceAuthStart",
  Microsoft365CopilotDeviceAuthPoll: "microsoft365CopilotDeviceAuthPoll",

  // OpenAI "ChatGPT subscription" (Codex) device-flow sign-in — connects a
  // ChatGPT/Codex subscription as an OpenAI provider credential
  OpenaiCodexDeviceAuthStart: "openaiCodexDeviceAuthStart",
  OpenaiCodexDeviceAuthPoll: "openaiCodexDeviceAuthPoll",

  // xAI "SuperGrok" device-flow sign-in — connects a SuperGrok
  // subscription as an xAI provider credential
  XaiSubscriptionDeviceAuthStart: "xaiSubscriptionDeviceAuthStart",
  XaiSubscriptionDeviceAuthPoll: "xaiSubscriptionDeviceAuthPoll",

  // Proxy Routes - Azure AI Foundry
  AzureChatCompletionsWithDefaultAgent: "azureChatCompletionsWithDefaultAgent",
  AzureChatCompletionsWithAgent: "azureChatCompletionsWithAgent",
  AzureResponsesWithDefaultAgent: "azureResponsesWithDefaultAgent",
  AzureResponsesWithAgent: "azureResponsesWithAgent",
  AzureEmbeddingsWithDefaultAgent: "azureEmbeddingsWithDefaultAgent",
  AzureEmbeddingsWithAgent: "azureEmbeddingsWithAgent",

  // Chat Routes
  StreamChat: "streamChat",
  ResolveChatMcpElicitation: "resolveChatMcpElicitation",
  StopChatStream: "stopChatStream",
  CancelChatMcpTask: "cancelChatMcpTask",
  GetActiveChatRun: "getActiveChatRun",
  GetChatConversations: "getChatConversations",
  GetDeletedChatConversations: "getDeletedChatConversations",
  GetChatConversation: "getChatConversation",
  GetChatConversationFiles: "getChatConversationFiles",
  GetChatAgentMcpTools: "getChatAgentMcpTools",
  CreateChatConversation: "createChatConversation",
  ForkChatConversation: "forkChatConversation",
  UpdateChatConversation: "updateChatConversation",
  SetConversationHooksDebug: "setConversationHooksDebug",
  MarkChatConversationRead: "markChatConversationRead",
  DeleteChatConversation: "deleteChatConversation",
  RestoreChatConversation: "restoreChatConversation",
  ClearChatConversationErrors: "clearChatConversationErrors",
  CompactChatConversation: "compactChatConversation",
  GenerateChatConversationTitle: "generateChatConversationTitle",
  GetChatMcpTools: "getChatMcpTools",
  UpdateChatMessage: "updateChatMessage",
  SetChatMessageFeedback: "setChatMessageFeedback",
  GetConversationEnabledTools: "getConversationEnabledTools",
  UpdateConversationEnabledTools: "updateConversationEnabledTools",
  DeleteConversationEnabledTools: "deleteConversationEnabledTools",
  ShareConversation: "shareConversation",
  UnshareConversation: "unshareConversation",
  GetConversationShare: "getConversationShare",
  GetSharedConversation: "getSharedConversation",
  ForkSharedConversation: "forkSharedConversation",
  GetChatAttachmentContent: "getChatAttachmentContent",
  DeleteChatAttachment: "deleteChatAttachment",
  GetLlmModels: "getLlmModels",
  SyncLlmModels: "syncLlmModels",

  // LLM Provider API Key Routes
  GetLlmProviderApiKeys: "getLlmProviderApiKeys",
  GetAvailableLlmProviderApiKeys: "getAvailableLlmProviderApiKeys",
  CreateLlmProviderApiKey: "createLlmProviderApiKey",
  GetLlmProviderApiKey: "getLlmProviderApiKey",
  UpdateLlmProviderApiKey: "updateLlmProviderApiKey",
  ReconnectLlmProviderApiKey: "reconnectLlmProviderApiKey",
  DeleteLlmProviderApiKey: "deleteLlmProviderApiKey",
  BulkDeleteLlmProviderApiKeys: "bulkDeleteLlmProviderApiKeys",

  // User API Key Routes
  GetApiKeys: "getApiKeys",
  GetApiKey: "getApiKey",
  CreateApiKey: "createApiKey",
  DeleteApiKey: "deleteApiKey",
  BulkDeleteApiKeys: "bulkDeleteApiKeys",

  // Service Account Routes
  GetServiceAccounts: "getServiceAccounts",
  GetServiceAccount: "getServiceAccount",
  CreateServiceAccount: "createServiceAccount",
  UpdateServiceAccount: "updateServiceAccount",
  DeleteServiceAccount: "deleteServiceAccount",
  BulkDeleteServiceAccounts: "bulkDeleteServiceAccounts",
  BulkSetServiceAccountsDisabled: "bulkSetServiceAccountsDisabled",
  CreateServiceAccountToken: "createServiceAccountToken",
  UpdateServiceAccountToken: "updateServiceAccountToken",
  DeleteServiceAccountToken: "deleteServiceAccountToken",

  // Agent Background execution
  GetAgentBackgroundExecutionPreflight: "getAgentBackgroundExecutionPreflight",
  SetAgentBackgroundExecutionCredential:
    "setAgentBackgroundExecutionCredential",
  DeleteAgentBackgroundExecutionCredential:
    "deleteAgentBackgroundExecutionCredential",
  ListExecutionCredentials: "listExecutionCredentials",
  CreateExecutionCredential: "createExecutionCredential",
  GetExecutionCredentialUsage: "getExecutionCredentialUsage",
  UpdateExecutionCredential: "updateExecutionCredential",
  DeleteExecutionCredential: "deleteExecutionCredential",
  SetPersonalExecutionCredentialConnection:
    "setPersonalExecutionCredentialConnection",
  DeletePersonalExecutionCredentialConnection:
    "deletePersonalExecutionCredentialConnection",
  SetOrganizationExecutionCredentialConnection:
    "setOrganizationExecutionCredentialConnection",
  DeleteOrganizationExecutionCredentialConnection:
    "deleteOrganizationExecutionCredentialConnection",
  GetAgentExecutions: "getAgentExecutions",
  StartAgentExecution: "startAgentExecution",
  GetMyAgentExecutions: "getMyAgentExecutions",
  GetMyAgentExecution: "getMyAgentExecution",
  UpdateAgentExecution: "updateAgentExecution",
  CancelAgentExecution: "cancelAgentExecution",
  DeleteAgentExecution: "deleteAgentExecution",

  // Virtual API Key Routes
  GetAllVirtualApiKeys: "getAllVirtualApiKeys",
  GetVirtualApiKey: "getVirtualApiKey",
  GetVirtualApiKeyValue: "getVirtualApiKeyValue",
  CreateVirtualApiKey: "createVirtualApiKey",
  UpdateVirtualApiKey: "updateVirtualApiKey",
  DeleteVirtualApiKey: "deleteVirtualApiKey",
  BulkDeleteVirtualApiKeys: "bulkDeleteVirtualApiKeys",

  // LLM OAuth Client Routes
  GetLlmOauthClients: "getLlmOauthClients",
  CreateLlmOauthClient: "createLlmOauthClient",
  UpdateLlmOauthClient: "updateLlmOauthClient",
  RotateLlmOauthClientSecret: "rotateLlmOauthClientSecret",
  DeleteLlmOauthClient: "deleteLlmOauthClient",
  BulkDeleteLlmOauthClients: "bulkDeleteLlmOauthClients",

  // MCP OAuth Client Routes
  GetMcpOauthClients: "getMcpOauthClients",
  CreateMcpOauthClient: "createMcpOauthClient",
  UpdateMcpOauthClient: "updateMcpOauthClient",
  RotateMcpOauthClientSecret: "rotateMcpOauthClientSecret",
  DeleteMcpOauthClient: "deleteMcpOauthClient",

  // Models with API Keys Routes
  GetModelsWithApiKeys: "getModelsWithApiKeys",
  UpdateModel: "updateModel",
  BulkUpdateModels: "bulkUpdateModels",

  // Limits Routes
  GetLimits: "getLimits",
  CreateLimit: "createLimit",
  GetLimit: "getLimit",
  UpdateLimit: "updateLimit",
  DeleteLimit: "deleteLimit",
  BulkDeleteLimits: "bulkDeleteLimits",

  // Per-environment default user limits
  ListDefaultUserLimits: "listDefaultUserLimits",
  CreateDefaultUserLimit: "createDefaultUserLimit",
  UpdateDefaultUserLimit: "updateDefaultUserLimit",
  DeleteDefaultUserLimit: "deleteDefaultUserLimit",

  // Onboarding Routes
  GetOnboardingSeenNavItems: "getOnboardingSeenNavItems",
  MarkOnboardingNavItemsSeen: "markOnboardingNavItemsSeen",
  GetOnboardingSurveyEligibility: "getOnboardingSurveyEligibility",
  SubmitOnboardingSurvey: "submitOnboardingSurvey",
  GetFeedbackPopupActivation: "getFeedbackPopupActivation",

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

  // MCP Settings Routes (organization-level)
  UpdateMcpSettings: "updateMcpSettings",

  // Skills Settings Routes (organization-level)
  UpdateSkillsSettings: "updateSkillsSettings",

  // Agent Settings Routes (organization-level)
  UpdateAgentSettings: "updateAgentSettings",

  // Auth Settings Routes (organization-level)
  UpdateAuthSettings: "updateAuthSettings",

  // Connection Settings Routes (organization-level)
  UpdateConnectionSettings: "updateConnectionSettings",

  // Integration catalog customization (organization-level)
  UpdateIntegrationSettings: "updateIntegrationSettings",

  // Org-level deployment environments
  ListEnvironments: "listEnvironments",
  CreateEnvironment: "createEnvironment",
  UpdateEnvironment: "updateEnvironment",
  DeleteEnvironment: "deleteEnvironment",
  BulkDeleteEnvironments: "bulkDeleteEnvironments",
  UpdateDefaultEnvironment: "updateDefaultEnvironment",
  UpdateEnvironmentResourceDefaults: "updateEnvironmentResourceDefaults",
  GetK8sCapabilities: "getK8sCapabilities",

  // GitHub App Configuration Routes
  ListGithubAppConfigs: "listGithubAppConfigs",
  CreateGithubAppConfig: "createGithubAppConfig",
  GetGithubAppConfig: "getGithubAppConfig",
  UpdateGithubAppConfig: "updateGithubAppConfig",
  DeleteGithubAppConfig: "deleteGithubAppConfig",

  // Stored GitHub personal access tokens
  ListGithubPats: "listGithubPats",
  CreateGithubPat: "createGithubPat",
  UpdateGithubPat: "updateGithubPat",
  DeleteGithubPat: "deleteGithubPat",

  // Knowledge Settings Routes (organization-level)
  UpdateKnowledgeSettings: "updateKnowledgeSettings",
  DropEmbeddingConfig: "dropEmbeddingConfig",
  TestEmbeddingConnection: "testEmbeddingConnection",
  TestRerankerConnection: "testRerankerConnection",
  TestOcrConnection: "testOcrConnection",
  GetKeywordRankingStatus: "getKeywordRankingStatus",

  // Identity Provider Routes
  GetPublicIdentityProviders: "getPublicIdentityProviders",
  GetIdentityProviders: "getIdentityProviders",
  GetIdentityProviderTeamSyncOptions: "getIdentityProviderTeamSyncOptions",
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
  UpdateMemberDefaultAgent: "updateMemberDefaultAgent",
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
  GetUserStatistics: "getUserStatistics",
  GetMyStatistics: "getMyStatistics",
  GetMyUsageBreakdown: "getMyUsageBreakdown",
  GetAppStatistics: "getAppStatistics",
  GetSkillStatistics: "getSkillStatistics",
  GetOverviewStatistics: "getOverviewStatistics",
  GetCostSavingsStatistics: "getCostSavingsStatistics",

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
  ApplyChatOpsBindingPlan: "applyChatOpsBindingPlan",
  CreateChatOpsDmBinding: "createChatOpsDmBinding",
  UpdateChatOpsConfigInQuickstart: "updateChatOpsConfigInQuickstart",
  UpdateSlackChatOpsConfig: "updateSlackChatOpsConfig",
  UpdateTelegramChatOpsConfig: "updateTelegramChatOpsConfig",
  LinkTelegramChatOpsAccount: "linkTelegramChatOpsAccount",
  GenerateTelegramLinkCode: "generateTelegramLinkCode",
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
  BulkDeleteKnowledgeBases: "bulkDeleteKnowledgeBases",
  RestoreKnowledgeBase: "restoreKnowledgeBase",
  PermanentlyDeleteKnowledgeBase: "permanentlyDeleteKnowledgeBase",
  GetKnowledgeBaseHealth: "getKnowledgeBaseHealth",

  // Knowledge Base Connector Routes
  GetConnectors: "getConnectors",
  CreateConnector: "createConnector",
  GetConnector: "getConnector",
  GetConnectorDocuments: "getConnectorDocuments",
  GetConnectorDocument: "getConnectorDocument",
  UpdateConnector: "updateConnector",
  DeleteConnector: "deleteConnector",
  BulkUpdateConnectors: "bulkUpdateConnectors",
  BulkDeleteConnectors: "bulkDeleteConnectors",
  RestoreConnector: "restoreConnector",
  PermanentlyDeleteConnector: "permanentlyDeleteConnector",
  DeleteConnectorDocument: "deleteConnectorDocument",
  BulkDeleteConnectorDocuments: "bulkDeleteConnectorDocuments",
  SyncConnector: "syncConnector",
  TriggerPermissionSync: "triggerPermissionSync",
  GetPermissionSyncCoverage: "getPermissionSyncCoverage",
  GetConnectorUserGroups: "getConnectorUserGroups",
  UpsertConnectorMemberOverride: "upsertConnectorMemberOverride",
  DeleteConnectorMemberOverride: "deleteConnectorMemberOverride",
  ForceResyncConnector: "forceResyncConnector",
  TestConnectorConnection: "testConnectorConnection",
  StartGoogleDriveConnectorOAuth: "startGoogleDriveConnectorOAuth",
  CompleteGoogleDriveConnectorOAuth: "completeGoogleDriveConnectorOAuth",

  // Connector Knowledge Base Assignment Routes
  AssignConnectorToKnowledgeBases: "assignConnectorToKnowledgeBases",
  UnassignConnectorFromKnowledgeBase: "unassignConnectorFromKnowledgeBase",
  GetConnectorKnowledgeBases: "getConnectorKnowledgeBases",

  // Connector Run Routes
  GetConnectorRuns: "getConnectorRuns",
  GetConnectorRun: "getConnectorRun",
  CancelConnectorRun: "cancelConnectorRun",

  // Knowledge File Routes
  GetKnowledgeFiles: "getKnowledgeFiles",
  UploadKnowledgeFile: "uploadKnowledgeFile",
  GetKnowledgeFileContent: "getKnowledgeFileContent",
  DeleteKnowledgeFile: "deleteKnowledgeFile",
  UpdateKnowledgeFile: "updateKnowledgeFile",
  BulkUpdateKnowledgeFiles: "bulkUpdateKnowledgeFiles",
  BulkDeleteKnowledgeFiles: "bulkDeleteKnowledgeFiles",
  IndexKnowledgeFiles: "indexKnowledgeFiles",
  GetKnowledgeDirectories: "getKnowledgeDirectories",
  CreateKnowledgeDirectory: "createKnowledgeDirectory",
  UpdateKnowledgeDirectory: "updateKnowledgeDirectory",
  DeleteKnowledgeDirectory: "deleteKnowledgeDirectory",
  BulkUpdateKnowledgeDirectories: "bulkUpdateKnowledgeDirectories",
  BulkDeleteKnowledgeDirectories: "bulkDeleteKnowledgeDirectories",
  PromoteAttachmentToKnowledgeFile: "promoteAttachmentToKnowledgeFile",

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
  GetExternalMcpSkills: "getExternalMcpSkills",
  GetExternalMcpSkill: "getExternalMcpSkill",
  GetExternalMcpSkillUsageStatistics: "getExternalMcpSkillUsageStatistics",
  CreateSkill: "createSkill",
  ConvertAgentToSkill: "convertAgentToSkill",
  SuggestSkillDescription: "suggestSkillDescription",
  GetSkill: "getSkill",
  UpdateSkill: "updateSkill",
  BulkUpdateSkillsVisibility: "bulkUpdateSkillsVisibility",
  DeleteSkill: "deleteSkill",
  BulkDeleteSkills: "bulkDeleteSkills",
  RestoreSkill: "restoreSkill",
  PermanentlyDeleteSkill: "permanentlyDeleteSkill",
  ResetSkill: "resetSkill",
  UpdateSkillGithubSync: "updateSkillGithubSync",
  DiscoverGithubSkills: "discoverGithubSkills",
  SearchSkillCatalog: "searchSkillCatalog",
  PreviewGithubSkill: "previewGithubSkill",
  ImportGithubSkills: "importGithubSkills",
  GetSkillSourceRepos: "getSkillSourceRepos",

  // Plugin Routes
  GetPlugins: "getPlugins",
  CreatePlugin: "createPlugin",
  GetPlugin: "getPlugin",
  UpdatePlugin: "updatePlugin",
  DeletePlugin: "deletePlugin",
  PreviewGithubPlugin: "previewGithubPlugin",
  ImportGithubPlugin: "importGithubPlugin",
  PreviewGithubPluginUpdate: "previewGithubPluginUpdate",
  ApplyGithubPluginUpdate: "applyGithubPluginUpdate",
  DiscoverGithubPluginMarketplace: "discoverGithubPluginMarketplace",
  ImportGithubPluginMarketplace: "importGithubPluginMarketplace",
  UpdatePluginGithubSync: "updatePluginGithubSync",
  TriggerPluginGithubSync: "triggerPluginGithubSync",
  // Skills projected from plugin file trees
  GetPluginSkills: "getPluginSkills",
  GetPluginSkill: "getPluginSkill",
  GetPluginSkillUsageStatistics: "getPluginSkillUsageStatistics",
  GetSkillUsageStatistics: "getSkillUsageStatistics",
  GetSkillVersions: "getSkillVersions",
  GetSkillVersion: "getSkillVersion",
  EnableSkillToolDefaults: "enableSkillToolDefaults",
  GetSkillSandboxArtifact: "getSkillSandboxArtifact",
  GetSkillSandboxConversationArtifacts: "getSkillSandboxConversationArtifacts",
  CreateProject: "createProject",
  CreateProjectFromConversation: "createProjectFromConversation",
  GetProjects: "getProjects",
  GetProject: "getProject",
  UpdateProject: "updateProject",
  SetProjectShare: "setProjectShare",
  DeleteProject: "deleteProject",
  BulkUpdateProjects: "bulkUpdateProjects",
  BulkDeleteProjects: "bulkDeleteProjects",
  RestoreProject: "restoreProject",
  PermanentlyDeleteProject: "permanentlyDeleteProject",
  GetProjectConversations: "getProjectConversations",
  GetProjectFiles: "getProjectFiles",
  UploadProjectFiles: "uploadProjectFiles",
  GetProjectInstructions: "getProjectInstructions",
  SetProjectInstructions: "setProjectInstructions",
  PinProject: "pinProject",
  UnpinProject: "unpinProject",
  DeleteSkillSandboxArtifact: "deleteSkillSandboxArtifact",
  UpdateSkillSandboxArtifactContent: "updateSkillSandboxArtifactContent",

  // Audit Log Routes
  GetAuditLogs: "getAuditLogs",
  GetAuditLog: "getAuditLog",

  // Hook File Routes
  GetHooks: "getHooks",
  CreateHook: "createHook",
  UpdateHook: "updateHook",
  DeleteHook: "deleteHook",

  // Skill Marketplace Routes
  GetSkillMarketplace: "getSkillMarketplace",

  // Skill Share Link Routes
  GetSkillShareLinks: "getSkillShareLinks",
  CreateSkillShareLink: "createSkillShareLink",
  RevokeSkillShareLink: "revokeSkillShareLink",
  RotateSkillShareLink: "rotateSkillShareLink",

  // Connection Setup Routes
  CreateConnectionSetup: "createConnectionSetup",
  GetMfilesVafAddOnScript: "getMfilesVafAddOnScript",
  GetMfilesVafAddOnPackage: "getMfilesVafAddOnPackage",
  GetMfilesVafAddOnDistribution: "getMfilesVafAddOnDistribution",
  GetConnectionSetupScript: "getConnectionSetupScript",
  CreateConnectionVirtualKey: "createConnectionVirtualKey",
  CreateConnectionPassthroughKey: "createConnectionPassthroughKey",
  GetConnectionHealth: "getConnectionHealth",

  // MCP App Routes
  GetApps: "getApps",
  GetExternalApp: "getExternalApp",
  CreateApp: "createApp",
  GetApp: "getApp",
  UpdateApp: "updateApp",
  EnableApp: "enableApp",
  DisableApp: "disableApp",
  LockApp: "lockApp",
  UnlockApp: "unlockApp",
  DeleteApp: "deleteApp",
  BulkUpdateApps: "bulkUpdateApps",
  BulkDeleteApps: "bulkDeleteApps",
  GetAppVersions: "getAppVersions",
  GetAppVersion: "getAppVersion",
  GetAppTools: "getAppTools",
  AssignToolToApp: "assignToolToApp",
  UnassignToolFromApp: "unassignToolFromApp",
  GetAppTemplates: "getAppTemplates",
  GetAppLabelKeys: "getAppLabelKeys",
  GetAppLabelValues: "getAppLabelValues",
  OpenAppInChat: "openAppInChat",
  OpenExternalAppInChat: "openExternalAppInChat",
  PinApp: "pinApp",
  UnpinApp: "unpinApp",
  PinExternalApp: "pinExternalApp",
  UnpinExternalApp: "unpinExternalApp",
  PostAppRenderDiagnostics: "postAppRenderDiagnostics",
  PostAppRenderScreenshot: "postAppRenderScreenshot",
  // App session recordings live client-side (IndexedDB); the only server
  // endpoint forwards a shared recording plugin to the public demo catalog.
  EnhanceAppRecording: "enhanceAppRecording",
  RenderAppRecordingVideo: "renderAppRecordingVideo",
  GetAppRecordingRenderStatus: "getAppRecordingRenderStatus",
  DownloadAppRecordingVideo: "downloadAppRecordingVideo",
  CancelAppRecordingRender: "cancelAppRecordingRender",
  // Reviewer-facing: fetch a hackathon submission's recording plugin from
  // GitHub (server-side, to dodge the frontend CSP) for the on-platform,
  // read-only review player.
  ReviewAppRecording: "reviewAppRecording",
  // Sharing a recording to the public App Gallery: the backend only relays
  // the GitHub device flow (browser CORS); the PR itself is filed client-side.
  AppGalleryDeviceAuthStart: "appGalleryDeviceAuthStart",
  AppGalleryDeviceAuthPoll: "appGalleryDeviceAuthPoll",
  // Frontend session-based proxy to the app-bound MCP server (chat + standalone)
  McpAppProxyPost: "mcpAppProxyPost",
} as const;

export type RouteId = (typeof RouteId)[keyof typeof RouteId];

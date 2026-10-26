export const RouteId = {
  AzureAudioSpeechWithDefaultAgent: "azureAudioSpeechWithDefaultAgent",
  AzureAudioSpeechWithAgent: "azureAudioSpeechWithAgent",
  AzureAudioTranscriptionsWithDefaultAgent:
    "azureAudioTranscriptionsWithDefaultAgent",
  AzureAudioTranscriptionsWithAgent: "azureAudioTranscriptionsWithAgent",
  AzureAudioTranslationsWithDefaultAgent:
    "azureAudioTranslationsWithDefaultAgent",
  AzureAudioTranslationsWithAgent: "azureAudioTranslationsWithAgent",
  OpenAiAudioSpeechWithDefaultAgent: "openAiAudioSpeechWithDefaultAgent",
  OpenAiAudioSpeechWithAgent: "openAiAudioSpeechWithAgent",
  OpenAiAudioTranscriptionsWithDefaultAgent:
    "openAiAudioTranscriptionsWithDefaultAgent",
  OpenAiAudioTranscriptionsWithAgent: "openAiAudioTranscriptionsWithAgent",
  OpenAiAudioTranslationsWithDefaultAgent:
    "openAiAudioTranslationsWithDefaultAgent",
  OpenAiAudioTranslationsWithAgent: "openAiAudioTranslationsWithAgent",

  AnnotateGuardrailsTool: "annotateGuardrailsTool",
  GetOpenAppaPolicyTests: "getOpenAppaPolicyTests",
  InspectOpenAppaPolicyTests: "inspectOpenAppaPolicyTests",
  UpdateOpenAppaPolicyTests: "updateOpenAppaPolicyTests",
  RunOpenAppaPolicyTests: "runOpenAppaPolicyTests",
  PreviewOpenAppaPolicyTest: "previewOpenAppaPolicyTest",
  GetOpenAppaPolicyTestRuns: "getOpenAppaPolicyTestRuns",
  GetGuardrailsPolicy: "getGuardrailsPolicy",
  ValidateGuardrailsPolicy: "validateGuardrailsPolicy",
  UpdateGuardrailsPolicy: "updateGuardrailsPolicy",
  // Outbound A2A Agent Routes
  InspectA2aRemoteAgent: "inspectA2aRemoteAgent",
  ListA2aRemoteAgents: "listA2aRemoteAgents",
  GetA2aRemoteAgent: "getA2aRemoteAgent",
  ListA2aRemoteAgentRuns: "listA2aRemoteAgentRuns",
  CreateA2aRemoteAgent: "createA2aRemoteAgent",
  UpdateA2aRemoteAgent: "updateA2aRemoteAgent",
  DeleteA2aRemoteAgent: "deleteA2aRemoteAgent",

  // Agent Routes
  GetAgents: "getAgents",
  GetAgentCatalog: "getAgentCatalog",
  GetChatAgentRoster: "getChatAgentRoster",
  GetChatAgentRosterPage: "getChatAgentRosterPage",
  GetAgentOptions: "getAgentOptions",
  GetAgentOptionsPage: "getAgentOptionsPage",
  GetAgentOptionIds: "getAgentOptionIds",
  GetAgentCredentialReadiness: "getAgentCredentialReadiness",
  CreateAgent: "createAgent",
  CloneAgent: "cloneAgent",
  GetAgent: "getAgent",
  GetAgentDefaultSuggestedPrompts: "getAgentDefaultSuggestedPrompts",
  PinAgent: "pinAgent",
  UnpinAgent: "unpinAgent",
  GetDefaultMcpGateway: "getDefaultMcpGateway",
  GetLlmProxy: "getLlmProxy",
  UpdateLlmProxy: "updateLlmProxy",
  TransferSkillOwnership: "transferSkillOwnership",
  TransferPluginOwnership: "transferPluginOwnership",
  TransferProjectOwnership: "transferProjectOwnership",
  TransferAppOwnership: "transferAppOwnership",
  TransferMcpCatalogOwnership: "transferMcpCatalogOwnership",
  TransferRemoteAgentOwnership: "transferRemoteAgentOwnership",
  TransferAgentOwnership: "transferAgentOwnership",
  UpdateAgent: "updateAgent",
  DeleteAgent: "deleteAgent",
  BulkDeleteAgents: "bulkDeleteAgents",
  RestoreAgent: "restoreAgent",
  PermanentlyDeleteAgent: "permanentlyDeleteAgent",
  GetAgentVersions: "getAgentVersions",
  GetAgentVersion: "getAgentVersion",
  RestoreAgentVersion: "restoreAgentVersion",
  ExportAgent: "exportAgent",
  ImportAgent: "importAgent",
  GetAgentToolExclusions: "getAgentToolExclusions",
  GetAgentMcpToolPreview: "getAgentMcpToolPreview",
  UpdateAgentToolExclusions: "updateAgentToolExclusions",
  GetAgentSubagentExclusions: "getAgentSubagentExclusions",
  UpdateAgentSubagentExclusions: "updateAgentSubagentExclusions",
  GetAgentKnowledgeSourceExclusions: "getAgentKnowledgeSourceExclusions",
  UpdateAgentKnowledgeSourceExclusions: "updateAgentKnowledgeSourceExclusions",
  GetAgentActivationSkills: "getAgentActivationSkills",
  GetAgentActivationSkillPolicy: "getAgentActivationSkillPolicy",
  PatchAgentActivationSkillPolicy: "patchAgentActivationSkillPolicy",
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
  UnassignToolFromAgent: "unassignToolFromAgent",
  GetAgentTools: "getAgentTools",
  GetAllAgentTools: "getAllAgentTools",
  UpdateAgentTool: "updateAgentTool",
  GetAgentAvailableTokens: "getAgentAvailableTokens",

  // Agent Delegation Routes (internal agents only)
  GetAgentDelegations: "getAgentDelegations",
  SyncAgentDelegations: "syncAgentDelegations",
  CreateAgentDelegation: "createAgentDelegation",
  DeleteAgentDelegation: "deleteAgentDelegation",
  GetAgentA2aDelegations: "getAgentA2aDelegations",
  SyncAgentA2aDelegations: "syncAgentA2aDelegations",
  GetAllDelegationConnections: "getAllDelegationConnections",

  // Dev Feedback Routes
  GetDevFeedbackSetup: "getDevFeedbackSetup",
  ListDevFeedbackBots: "listDevFeedbackBots",
  ListDevFeedbackChannels: "listDevFeedbackChannels",
  SaveDevFeedbackSetup: "saveDevFeedbackSetup",
  GetDevFeedbackComments: "getDevFeedbackComments",
  CreateDevFeedbackComment: "createDevFeedbackComment",
  GetDevFeedbackReplies: "getDevFeedbackReplies",
  CreateDevFeedbackReply: "createDevFeedbackReply",
  ResolveDevFeedbackComment: "resolveDevFeedbackComment",

  // Config Routes
  GetConfig: "getConfig",
  GetBootstrap: "getBootstrap",
  GetNewChatBootstrap: "getNewChatBootstrap",
  GetConversationBootstrap: "getConversationBootstrap",
  GetPublicConfig: "getPublicConfig",

  // RUM Routes
  IngestRumEvents: "ingestRumEvents",

  // Auth Routes
  GetDefaultCredentialsStatus: "getDefaultCredentialsStatus",
  GetAuthState: "getAuthState",
  BulkRevokeSessions: "bulkRevokeSessions",

  // MCP Catalog Routes
  GetInternalMcpCatalog: "getInternalMcpCatalog",
  SearchMcpRegistry: "searchMcpRegistry",
  SearchMcpRegistryIds: "searchMcpRegistryIds",
  GetMcpRegistryIssueIndex: "getMcpRegistryIssueIndex",
  GetInternalMcpCatalogIcon: "getInternalMcpCatalogIcon",
  CreateInternalMcpCatalogItem: "createInternalMcpCatalogItem",
  GetInternalMcpCatalogItem: "getInternalMcpCatalogItem",
  GetInternalMcpCatalogCredentialPreflight:
    "getInternalMcpCatalogCredentialPreflight",
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
  GetMcpServerAutoModeAgentPage: "getMcpServerAutoModeAgentPage",
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
  McpGatewayDelete: "mcpGatewayDelete",
  McpGatewaySseMessage: "mcpGatewaySseMessage", // Legacy HTTP+SSE message endpoint
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
  GetTeamMembersPage: "getTeamMembersPage",
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
  SearchInitialPermissionSubjects: "searchInitialPermissionSubjects",
  GetScopedCapabilities: "getScopedCapabilities",
  GetResourcePermissions: "getResourcePermissions",
  SearchResourcePermissionSubjects: "searchResourcePermissionSubjects",
  UpdateResourcePermissions: "updateResourcePermissions",
  GetRoles: "getRoles",
  CreateRole: "createRole",
  GetRole: "getRole",
  UpdateRole: "updateRole",
  DeleteRole: "deleteRole",
  BulkDeleteRoles: "bulkDeleteRoles",

  // Tool Routes
  GetTools: "getTools",
  GetToolsWithAssignments: "getToolsWithAssignments",

  // Interaction Routes
  GetInteractions: "getInteractions",
  GetInteractionSummaries: "getInteractionSummaries",
  GetInteraction: "getInteraction",
  GetInteractionSessions: "getInteractionSessions",
  GetInteractionSessionLineage: "getInteractionSessionLineage",
  GetUniqueExternalAgentIds: "getUniqueExternalAgentIds",
  GetUniqueUserIds: "getUniqueUserIds",

  // MCP Tool Call Routes
  GetMcpToolCalls: "getMcpToolCalls",
  GetMcpToolCall: "getMcpToolCall",

  // Proxy Routes - OpenAI
  OpenAiChatCompletionsWithDefaultAgent:
    "openAiChatCompletionsWithDefaultAgent",
  OpenAiChatCompletionsWithAgent: "openAiChatCompletionsWithAgent",
  OpenAiResponsesWithDefaultAgent: "openAiResponsesWithDefaultAgent",
  OpenAiResponsesWithAgent: "openAiResponsesWithAgent",
  OpenAiResponsesCompactWithDefaultAgent:
    "openAiResponsesCompactWithDefaultAgent",
  OpenAiResponsesCompactWithAgent: "openAiResponsesCompactWithAgent",
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
  // Proxy Routes - xAI Responses (served over xAI's chat completions)
  XaiResponsesWithDefaultAgent: "xaiResponsesWithDefaultAgent",
  XaiResponsesWithAgent: "xaiResponsesWithAgent",

  // Proxy Routes - OpenRouter
  OpenrouterChatCompletionsWithDefaultAgent:
    "openrouterChatCompletionsWithDefaultAgent",
  OpenrouterChatCompletionsWithAgent: "openrouterChatCompletionsWithAgent",

  // Proxy Routes - Jev
  JevDecisionsWithDefaultAgent: "jevDecisionsWithDefaultAgent",
  JevDecisionsWithAgent: "jevDecisionsWithAgent",

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
  AzureRealtimeTurnWithDefaultAgent: "azureRealtimeTurnWithDefaultAgent",
  AzureRealtimeTurnWithAgent: "azureRealtimeTurnWithAgent",
  AzureImagesWithDefaultAgent: "azureImagesWithDefaultAgent",
  AzureImagesWithAgent: "azureImagesWithAgent",
  AzureImageEditsWithDefaultAgent: "azureImageEditsWithDefaultAgent",
  AzureImageEditsWithAgent: "azureImageEditsWithAgent",
  AzureCreateFile: "azureCreateFile",
  AzureCreateFileWithAgent: "azureCreateFileWithAgent",
  AzureListFiles: "azureListFiles",
  AzureListFilesWithAgent: "azureListFilesWithAgent",
  AzureRetrieveFile: "azureRetrieveFile",
  AzureRetrieveFileWithAgent: "azureRetrieveFileWithAgent",
  AzureFileContent: "azureFileContent",
  AzureFileContentWithAgent: "azureFileContentWithAgent",
  AzureDeleteFile: "azureDeleteFile",
  AzureDeleteFileWithAgent: "azureDeleteFileWithAgent",
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
  GetChatOpenappaStatus: "getChatOpenappaStatus",
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
  GetChatAttachmentContent: "getChatAttachmentContent",
  DeleteChatAttachment: "deleteChatAttachment",
  GetLlmModels: "getLlmModels",
  GetModelPools: "getModelPools",
  CreateModelPool: "createModelPool",
  UpdateModelPool: "updateModelPool",
  DeleteModelPool: "deleteModelPool",
  GetLlmProviderModelLabelValues: "llmProviderModelLabelValues",
  GetLlmProviderModelLabelKeys: "llmProviderModelLabelKeys",
  SyncLlmModels: "syncLlmModels",

  // LLM Provider API Key Routes
  GetLlmProviderApiKeys: "getLlmProviderApiKeys",
  GetLlmProviderApiKeyLabelValues: "llmProviderApiKeyLabelValues",
  GetLlmProviderApiKeyLabelKeys: "llmProviderApiKeyLabelKeys",
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
  GetServiceAccountLabelValues: "serviceAccountLabelValues",
  GetServiceAccountLabelKeys: "serviceAccountLabelKeys",
  GetServiceAccount: "getServiceAccount",
  CreateServiceAccount: "createServiceAccount",
  UpdateServiceAccount: "updateServiceAccount",
  DeleteServiceAccount: "deleteServiceAccount",
  BulkDeleteServiceAccounts: "bulkDeleteServiceAccounts",
  BulkSetServiceAccountsDisabled: "bulkSetServiceAccountsDisabled",
  CreateServiceAccountToken: "createServiceAccountToken",
  UpdateServiceAccountToken: "updateServiceAccountToken",
  DeleteServiceAccountToken: "deleteServiceAccountToken",

  // Agent Runtime
  GetAgentRuntimePreflight: "getAgentRuntimePreflight",
  GetClaudeCodeAccount: "getClaudeCodeAccount",
  StartClaudeCodeSignIn: "startClaudeCodeSignIn",
  CompleteClaudeCodeSignIn: "completeClaudeCodeSignIn",
  DisconnectClaudeCodeAccount: "disconnectClaudeCodeAccount",
  GetClaudeCodeModels: "getClaudeCodeModels",
  SetAgentRuntimeCredential: "setAgentRuntimeCredential",
  DeleteAgentRuntimeCredential: "deleteAgentRuntimeCredential",
  ListRuntimeCredentials: "listRuntimeCredentials",
  StartGitHubUserConnection: "startGitHubUserConnection",
  CompleteGitHubUserConnection: "completeGitHubUserConnection",
  CreateRuntimeCredential: "createRuntimeCredential",
  GetRuntimeCredentialUsage: "getRuntimeCredentialUsage",
  UpdateRuntimeCredential: "updateRuntimeCredential",
  DeleteRuntimeCredential: "deleteRuntimeCredential",
  SetPersonalRuntimeCredentialConnection:
    "setPersonalRuntimeCredentialConnection",
  DeletePersonalRuntimeCredentialConnection:
    "deletePersonalRuntimeCredentialConnection",
  SetOrganizationRuntimeCredentialConnection:
    "setOrganizationRuntimeCredentialConnection",
  DeleteOrganizationRuntimeCredentialConnection:
    "deleteOrganizationRuntimeCredentialConnection",
  GetAgentRuns: "getAgentRuns",
  StartAgentRun: "startAgentRun",
  GetMyAgentRuns: "getMyAgentRuns",
  GetMyAgentRun: "getMyAgentRun",
  UpdateAgentRun: "updateAgentRun",
  CancelAgentRun: "cancelAgentRun",
  ContinueAgentRun: "continueAgentRun",
  DeleteAgentWorkspace: "deleteAgentWorkspace",
  ReadAgentWorkspaceFile: "readAgentWorkspaceFile",
  WriteAgentWorkspaceFile: "writeAgentWorkspaceFile",
  StartAgentWorkspaceTransfer: "startAgentWorkspaceTransfer",
  DownloadAgentWorkspaceTransfer: "downloadAgentWorkspaceTransfer",
  UploadAgentWorkspaceTransfer: "uploadAgentWorkspaceTransfer",
  DeleteAgentRun: "deleteAgentRun",

  // Saved browser login routes (Playwright)
  GetBrowserStorageStates: "getBrowserStorageStates",
  DeleteBrowserStorageState: "deleteBrowserStorageState",

  // Virtual API Key Routes
  GetAllVirtualApiKeys: "getAllVirtualApiKeys",
  GetVirtualApiKeyLabelValues: "virtualApiKeyLabelValues",
  GetVirtualApiKeyLabelKeys: "virtualApiKeyLabelKeys",
  GetVirtualApiKey: "getVirtualApiKey",
  GetVirtualApiKeyValue: "getVirtualApiKeyValue",
  CreateVirtualApiKey: "createVirtualApiKey",
  UpdateVirtualApiKey: "updateVirtualApiKey",
  DeleteVirtualApiKey: "deleteVirtualApiKey",
  BulkDeleteVirtualApiKeys: "bulkDeleteVirtualApiKeys",

  // Unified OAuth Client Routes
  GetOauthClients: "getOauthClients",
  GetOauthClientLabelKeys: "oauthClientLabelKeys",
  GetOauthClientLabelValues: "oauthClientLabelValues",
  CreateOauthClient: "createOauthClient",
  UpdateOauthClient: "updateOauthClient",
  RotateOauthClientSecret: "rotateOauthClientSecret",
  DeleteOauthClient: "deleteOauthClient",
  BulkDeleteOauthClients: "bulkDeleteOauthClients",

  // LLM OAuth Client Routes
  GetLlmOauthClients: "getLlmOauthClients",
  GetLlmOauthClientLabelValues: "llmOauthClientLabelValues",
  GetLlmOauthClientLabelKeys: "llmOauthClientLabelKeys",
  CreateLlmOauthClient: "createLlmOauthClient",
  UpdateLlmOauthClient: "updateLlmOauthClient",
  RotateLlmOauthClientSecret: "rotateLlmOauthClientSecret",
  DeleteLlmOauthClient: "deleteLlmOauthClient",
  BulkDeleteLlmOauthClients: "bulkDeleteLlmOauthClients",

  // MCP OAuth Client Routes
  GetMcpOauthClients: "getMcpOauthClients",
  GetMcpOauthClientLabelValues: "mcpOauthClientLabelValues",
  GetMcpOauthClientLabelKeys: "mcpOauthClientLabelKeys",
  CreateMcpOauthClient: "createMcpOauthClient",
  UpdateMcpOauthClient: "updateMcpOauthClient",
  RotateMcpOauthClientSecret: "rotateMcpOauthClientSecret",
  DeleteMcpOauthClient: "deleteMcpOauthClient",

  // Models with API Keys Routes
  GetModelsWithApiKeys: "getModelsWithApiKeys",
  GetLlmModelIdsByKey: "getLlmModelIdsByKey",
  GetLlmModelOptions: "getLlmModelOptions",
  UpdateModel: "updateModel",
  BulkUpdateModels: "bulkUpdateModels",

  // Limits Routes
  GetLimits: "getLimits",
  GetLimitLabelValues: "limitLabelValues",
  GetLimitLabelKeys: "limitLabelKeys",
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
  ListUserLimitUsage: "listUserLimitUsage",
  ResetUserLimitUsage: "resetUserLimitUsage",

  // Onboarding Routes
  GetOnboardingSeenNavItems: "getOnboardingSeenNavItems",
  MarkOnboardingNavItemsSeen: "markOnboardingNavItemsSeen",
  GetOnboardingSurveyEligibility: "getOnboardingSurveyEligibility",
  SubmitOnboardingSurvey: "submitOnboardingSurvey",

  // Organization Routes
  GetOrganization: "getOrganization",
  GetOnboardingStatus: "getOnboardingStatus",
  GetMemberSignupStatus: "getMemberSignupStatus",
  GetOrganizationMemberOptions: "getOrganizationMemberOptions",
  GetOrganizationMember: "getOrganizationMember",
  DeletePendingSignupMember: "deletePendingSignupMember",
  CompleteOnboarding: "completeOnboarding",

  // Appearance Settings Routes
  GetAppearanceSettings: "getAppearanceSettings",
  UpdateAppearanceSettings: "updateAppearanceSettings",

  // Security Settings Routes
  UpdateSecuritySettings: "updateSecuritySettings",

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
  GetEnvironment: "getEnvironment",
  GetEnvironmentLabelValues: "environmentLabelValues",
  GetEnvironmentLabelKeys: "environmentLabelKeys",
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
  ListGitCredentials: "listGitCredentials",
  CreateGitlabToken: "createGitlabToken",
  ListGitCredentialRepositories: "listGitCredentialRepositories",
  ListGitCredentialNamespaces: "listGitCredentialNamespaces",
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

  // User Routes
  GetUserPermissionSources: "getUserPermissionSources",
  GetUserPermissions: "getUserPermissions",
  GetImpersonableUsers: "getImpersonableUsers",

  // Team Token Routes

  // User Token Routes (Personal Tokens)
  GetUserToken: "getUserToken",
  GetUserTokenValue: "getUserTokenValue",
  RotateUserToken: "rotateUserToken",

  // Statistics Routes
  GetTeamStatistics: "getTeamStatistics",
  GetProxyCostStatistics: "getProxyCostStatistics",
  GetAgentStatistics: "getAgentStatistics",
  GetModelStatistics: "getModelStatistics",
  GetUserStatistics: "getUserStatistics",
  GetMyStatistics: "getMyStatistics",
  GetMyUsageBreakdown: "getMyUsageBreakdown",
  GetAppStatistics: "getAppStatistics",
  GetSkillStatistics: "getSkillStatistics",
  GetOverviewStatistics: "getOverviewStatistics",
  GetCostStatistics: "getCostStatistics",
  GetCostSavingsStatistics: "getCostSavingsStatistics",
  GetMcpToolCallUsage: "getMcpToolCallUsage",
  GetAppUsage: "getAppUsage",
  GetSkillUsage: "getSkillUsage",

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
  GetMsTeamsChatOpsConfig: "getMsTeamsChatOpsConfig",
  UpdateSlackChatOpsConfig: "updateSlackChatOpsConfig",
  GetSlackChatOpsConfig: "getSlackChatOpsConfig",
  ListSlackAgentBots: "listSlackAgentBots",
  UpdateSlackAgentBot: "updateSlackAgentBot",
  DeleteSlackAgentBot: "deleteSlackAgentBot",
  UpdateSlackAppConfigToken: "updateSlackAppConfigToken",
  CreateSlackAgentBotApp: "createSlackAgentBotApp",
  CreateSlackRouterBotApp: "createSlackRouterBotApp",
  MigrateSlackApps: "migrateSlackApps",
  ConvertSlackAppToAgentBot: "convertSlackAppToAgentBot",
  ListSlackAgentBotChannels: "listSlackAgentBotChannels",
  JoinSlackAgentBotChannel: "joinSlackAgentBotChannel",
  ListSlackRouterBotChannels: "listSlackRouterBotChannels",
  JoinSlackRouterBotChannel: "joinSlackRouterBotChannel",
  UpdateTelegramChatOpsConfig: "updateTelegramChatOpsConfig",
  GetTelegramChatOpsConfig: "getTelegramChatOpsConfig",
  LinkTelegramChatOpsAccount: "linkTelegramChatOpsAccount",
  UnlinkTelegramChatOpsAccount: "unlinkTelegramChatOpsAccount",
  GenerateTelegramLinkCode: "generateTelegramLinkCode",
  ConnectNgrok: "connectNgrok",
  DisconnectNgrok: "disconnectNgrok",
  GetNgrokConfig: "getNgrokConfig",
  RefreshChatOpsChannelDiscovery: "refreshChatOpsChannelDiscovery",

  // Knowledge Base Routes
  GetKnowledgeBases: "getKnowledgeBases",
  GetKnowledgeBaseLabelValues: "knowledgeBaseLabelValues",
  GetKnowledgeBaseLabelKeys: "knowledgeBaseLabelKeys",
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
  GetConnectorLabelValues: "connectorLabelValues",
  GetConnectorLabelKeys: "connectorLabelKeys",
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
  GetKnowledgeFileLabelValues: "knowledgeFileLabelValues",
  GetKnowledgeFileLabelKeys: "knowledgeFileLabelKeys",
  UpsertKnowledgeFile: "upsertKnowledgeFile",
  UploadKnowledgeFile: "uploadKnowledgeFile",
  GetKnowledgeFileContent: "getKnowledgeFileContent",
  DeleteKnowledgeFile: "deleteKnowledgeFile",
  UpdateKnowledgeFile: "updateKnowledgeFile",
  BulkDeleteKnowledgeFiles: "bulkDeleteKnowledgeFiles",
  IndexKnowledgeFiles: "indexKnowledgeFiles",
  GetKnowledgeDirectories: "getKnowledgeDirectories",
  CreateKnowledgeDirectory: "createKnowledgeDirectory",
  UpdateKnowledgeDirectory: "updateKnowledgeDirectory",
  DeleteKnowledgeDirectory: "deleteKnowledgeDirectory",
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
  GetSkillLabelValues: "skillLabelValues",
  GetSkillLabelKeys: "skillLabelKeys",
  GetExternalMcpSkills: "getExternalMcpSkills",
  GetExternalMcpSkill: "getExternalMcpSkill",
  GetExternalMcpSkillUsageStatistics: "getExternalMcpSkillUsageStatistics",
  CreateSkill: "createSkill",
  GetSkill: "getSkill",
  UpdateSkill: "updateSkill",
  DeleteSkill: "deleteSkill",
  BulkDeleteSkills: "bulkDeleteSkills",
  RestoreSkill: "restoreSkill",
  PermanentlyDeleteSkill: "permanentlyDeleteSkill",
  ResetSkill: "resetSkill",
  GetGuardrailsDeployment: "getGuardrailsDeployment",
  UpdateGuardrailsDeployment: "updateGuardrailsDeployment",
  GetAppaGithubSync: "getAppaGithubSync",
  ConfigureAppaGithubSync: "configureAppaGithubSync",
  CreateAppaGithubRepository: "createAppaGithubRepository",
  StartAppaGithubApp: "startAppaGithubApp",
  CompleteAppaGithubApp: "completeAppaGithubApp",
  GetPendingAppaGithubApp: "getPendingAppaGithubApp",
  DiscardAppaGithubApp: "discardAppaGithubApp",
  InstallAppaGithubApp: "installAppaGithubApp",
  GetAppaGithubAppAccounts: "getAppaGithubAppAccounts",
  GetAppaGithubAppRepositories: "getAppaGithubAppRepositories",
  GetAppaGithubRepositoryStatus: "getAppaGithubRepositoryStatus",
  UpdateAppaGithubSync: "updateAppaGithubSync",
  GetOpenappaBatteries: "getOpenappaBatteries",
  GetOpenappaBatteryPolicySource: "getOpenappaBatteryPolicySource",
  GetOpenappaEffectivePolicy: "getOpenappaEffectivePolicy",
  GetOpenappaBatteryMatches: "getOpenappaBatteryMatches",
  GetOpenappaBatteryInstall: "getOpenappaBatteryInstall",
  CreateOpenappaBatteryInstall: "createOpenappaBatteryInstall",
  UpdateOpenappaBatteryInstall: "updateOpenappaBatteryInstall",
  DeleteOpenappaBatteryInstall: "deleteOpenappaBatteryInstall",
  DeleteOpenappaBatteryInclude: "deleteOpenappaBatteryInclude",
  UploadOpenappaBatteryPackage: "uploadOpenappaBatteryPackage",
  DeleteOpenappaBatteryPackage: "deleteOpenappaBatteryPackage",
  SetOpenappaCredentialBinding: "setOpenappaCredentialBinding",
  GetOpenappaCredentialBindings: "getOpenappaCredentialBindings",
  GetOpenappaCredentialBinding: "getOpenappaCredentialBinding",
  GetOpenappaPolicyDeclarations: "getOpenappaPolicyDeclarations",
  ConsultOpenappaBatteryHelper: "consultOpenappaBatteryHelper",
  // white-label-ok: operation id for the builtin = "archestra" annotator route, a wire identifier
  AnnotateOpenappaToolWithArchestra: "annotateOpenappaToolWithArchestra",
  GetOpenAppaYells: "getOpenAppaYells",
  GetOpenAppaYellsSummary: "getOpenAppaYellsSummary",
  DownloadOpenAppaYell: "downloadOpenAppaYell",
  GetOpenAppaYell: "getOpenAppaYell",
  UpdateOpenAppaYell: "updateOpenAppaYell",
  GetOpenappaExternalConsults: "getOpenappaExternalConsults",
  GetOpenappaExternalConsult: "getOpenappaExternalConsult",
  GetOpenappaLabelChanges: "getOpenappaLabelChanges",
  GetOpenappaCoverageEntities: "getOpenappaCoverageEntities",
  GetOpenappaCoverageTools: "getOpenappaCoverageTools",
  GetOpenappaCoverageSummary: "getOpenappaCoverageSummary",
  GetOpenappaTrustAudience: "getOpenappaTrustAudience",
  GetOpenappaRemedies: "getOpenappaRemedies",
  GetOpenappaRemediesActivity: "getOpenappaRemediesActivity",
  UpdateSkillGithubSync: "updateSkillGithubSync",
  DiscoverGithubSkills: "discoverGithubSkills",
  SearchSkillCatalog: "searchSkillCatalog",
  PreviewGithubSkill: "previewGithubSkill",
  ImportGithubSkills: "importGithubSkills",
  GetSkillSourceRepos: "getSkillSourceRepos",
  GetSkillNames: "getSkillNames",

  // Plugin Routes
  GetPlugins: "getPlugins",
  GetPluginLabelValues: "pluginLabelValues",
  GetPluginLabelKeys: "pluginLabelKeys",
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
  GetProjectLabelValues: "projectLabelValues",
  GetProjectLabelKeys: "projectLabelKeys",
  GetProject: "getProject",
  UpdateProject: "updateProject",
  DeleteProject: "deleteProject",
  BulkDeleteProjects: "bulkDeleteProjects",
  RestoreProject: "restoreProject",
  PermanentlyDeleteProject: "permanentlyDeleteProject",
  GetProjectConversations: "getProjectConversations",
  GetProjectRuns: "getProjectRuns",
  GetProjectFiles: "getProjectFiles",
  UploadProjectFiles: "uploadProjectFiles",
  GetProjectInstructions: "getProjectInstructions",
  SetProjectInstructions: "setProjectInstructions",
  PinProject: "pinProject",
  UnpinProject: "unpinProject",
  GetProjectApps: "getProjectApps",
  LinkProjectApp: "linkProjectApp",
  UnlinkProjectApp: "unlinkProjectApp",
  DeleteSkillSandboxArtifact: "deleteSkillSandboxArtifact",
  UpdateSkillSandboxArtifactContent: "updateSkillSandboxArtifactContent",

  // Audit Log Routes
  GetAuditLogs: "getAuditLogs",
  GetAuditLog: "getAuditLog",
  GetAuditLogResources: "getAuditLogResources",

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
  GetClientConnectionInstaller: "getClientConnectionInstaller",
  StartClientConnection: "startClientConnection",
  PollClientConnection: "pollClientConnection",
  GetClientConnection: "getClientConnection",
  DecideClientConnection: "decideClientConnection",
  CreateConnectionSetup: "createConnectionSetup",
  GetMfilesVafAddOnScript: "getMfilesVafAddOnScript",
  GetMfilesVafAddOnPackage: "getMfilesVafAddOnPackage",
  GetMfilesVafAddOnDistribution: "getMfilesVafAddOnDistribution",
  GetConnectionSetupScript: "getConnectionSetupScript",
  CreateConnectionVirtualKey: "createConnectionVirtualKey",
  CreateConnectionPassthroughKey: "createConnectionPassthroughKey",
  GetConnectionInstructions: "getConnectionInstructions",
  GetConnectionRuntime: "getConnectionRuntime",
  GetConnectionHealth: "getConnectionHealth",
  RenderStartupGuard: "renderStartupGuard",
  GetConnectedClients: "getConnectedClients",
  DisconnectConnectedClient: "disconnectConnectedClient",
  GetConnectedClientLog: "getConnectedClientLog",
  GetAgentAdoption: "getAgentAdoption",
  GetAgentAdoptionUsage: "getAgentAdoptionUsage",

  // MCP App Routes
  GetApps: "getApps",
  GetExternalApp: "getExternalApp",
  GetExternalAppIcon: "getExternalAppIcon",
  GetAppIcon: "getAppIcon",
  CreateApp: "createApp",
  GetApp: "getApp",
  UpdateApp: "updateApp",
  EnableApp: "enableApp",
  DisableApp: "disableApp",
  LockApp: "lockApp",
  UnlockApp: "unlockApp",
  DeleteApp: "deleteApp",
  BulkDeleteApps: "bulkDeleteApps",
  GetAppVersions: "getAppVersions",
  GetAppVersionSummaries: "getAppVersionSummaries",
  GetAppVersion: "getAppVersion",
  RestoreAppVersion: "restoreAppVersion",
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
  // Frontend session-based proxy to the app-bound MCP server (chat + standalone)
  McpAppProxyPost: "mcpAppProxyPost",
} as const;

export type RouteId = (typeof RouteId)[keyof typeof RouteId];

/**
 * SQL table names use plural snake_case (`agents`, `mcp_servers`, `conversations`).
 * File names stay singular kebab-case (`mcp-server.ts`); TS exports below are
 * always `${plural}Table` regardless of the underlying SQL name.
 *
 * Two singular-name exceptions exist:
 *
 * 1. Library-owned (permanent — better-auth defines these, do not rename):
 *      account, apikey, invitation, jwks, member, organization, session, team,
 *      team_member, two_factor, user, verification,
 *      oauth_access_token, oauth_client, oauth_consent, oauth_refresh_token
 *
 * 2. Status-quo drift (app-code singular names predating this policy — eligible
 *    to be renamed to plural in future migrations):
 *      a2a_context, a2a_message, a2a_task, a2a_task_approval_request,
 *      agent_connector_assignment, agent_knowledge_base, agent_team,
 *      chatops_channel_binding, chatops_processed_message,
 *      chatops_thread_agent_override,
 *      conversation_share_team, conversation_share_user,
 *      identity_provider, incoming_email_subscription, internal_mcp_catalog,
 *      knowledge_base_connector_assignment, limit_model_usage,
 *      mcp_catalog_team, mcp_preset_entry, mcp_server,
 *      mcp_server_installation_request, mcp_server_user,
 *      organization_role, processed_email, secret,
 *      site_notification, skill_team,
 *      team_external_group, team_token, team_vault_folder, user_token,
 *      virtual_api_key_provider_api_key, virtual_api_key_team
 *
 * New tables must be plural. Tables not listed in (1) or (2) must be plural.
 *
 * Prefix guidance (judgment-based, not lint-enforced): a table scoped to a
 * single conversation should use the `conversation_` prefix so it sits with
 * its siblings (`conversation_compactions`, `conversation_enabled_tools`,
 * `conversation_shares`, `conversation_attachments`). Reserve `chat_` for
 * feature/runtime concerns, not durable conversation children. A
 * `conversation_id` column is a strong signal but not a law — two standing
 * exceptions carry `conversation_id` without the prefix:
 *   - messages — a top-level entity named for itself, not a conversation child
 *   - chat_active_runs — ephemeral run state predating this guidance
 */
export { default as a2aContextsTable } from "./a2a-context";
export { default as a2aMessagesTable } from "./a2a-message";
export { default as a2aTasksTable } from "./a2a-task";
export { default as a2aTaskApprovalRequestsTable } from "./a2a-task-approval-request";
export { default as accountsTable } from "./account";
export { default as agentsTable } from "./agent";
export { default as agentConnectorAssignmentsTable } from "./agent-connector-assignment";
export { default as agentKnowledgeBasesTable } from "./agent-knowledge-base";
export { default as agentLabelsTable } from "./agent-label";
export { default as agentSuggestedPromptsTable } from "./agent-suggested-prompt";
export { default as agentTeamsTable } from "./agent-team";
export { default as agentToolsTable } from "./agent-tool";
export { default as apikeysTable } from "./api-key";
export { default as auditLogsTable } from "./audit-log";
export { default as browserTabStatesTable } from "./browser-tab-state";
export {
  chatActiveRunEventsTable,
  chatActiveRunsTable,
} from "./chat-active-run";
export { default as chatopsChannelBindingsTable } from "./chatops-channel-binding";
export { default as chatopsProcessedMessagesTable } from "./chatops-processed-message";
export { default as chatopsThreadAgentOverrideTable } from "./chatops-thread-agent-override";
export { default as connectorRunsTable } from "./connector-run";
export { default as conversationsTable } from "./conversation";
export { default as conversationAttachmentsTable } from "./conversation-attachment";
export { default as conversationChatErrorsTable } from "./conversation-chat-error";
export { default as conversationCompactionsTable } from "./conversation-compaction";
export { default as conversationEnabledToolsTable } from "./conversation-enabled-tool";
export {
  conversationShareTeamsTable,
  conversationShareUsersTable,
  default as conversationSharesTable,
} from "./conversation-share";
export { default as environmentsTable } from "./environment";
export { default as identityProvidersTable } from "./identity-provider";
export { default as incomingEmailSubscriptionsTable } from "./incoming-email-subscription";
export { default as interactionsTable } from "./interaction";
export { default as internalMcpCatalogTable } from "./internal-mcp-catalog";
export { default as invitationsTable } from "./invitation";
export { default as jwksTable } from "./jwks";
export { default as kbChunksTable } from "./kb-chunk";
export { default as kbDocumentsTable } from "./kb-document";
export { default as kbUploadedFilesTable } from "./kb-uploaded-file";
export { default as knowledgeBasesTable } from "./knowledge-base";
export {
  default as knowledgeBaseConnectorsTable,
  knowledgeBaseConnectorAssignmentsTable,
} from "./knowledge-base-connector";
export { default as labelKeysTable } from "./label-key";
export { default as labelValuesTable } from "./label-value";
export { default as limitsTable } from "./limit";
export { default as limitModelUsageTable } from "./limit-model-usage";
export { default as llmProviderApiKeysTable } from "./llm-provider-api-key";
export { default as llmProviderApiKeyModelsTable } from "./llm-provider-api-key-model";
export { default as mcpCatalogLabelsTable } from "./mcp-catalog-label";
export { default as mcpCatalogTeamsTable } from "./mcp-catalog-team";
export { default as mcpHttpSessionsTable } from "./mcp-http-session";
export { default as mcpPresetEntriesTable } from "./mcp-preset-entry";
export { default as mcpServersTable } from "./mcp-server";
export { default as mcpServerInstallationRequestsTable } from "./mcp-server-installation-request";
export { default as mcpServerUsersTable } from "./mcp-server-user";
export { default as mcpToolCallsTable } from "./mcp-tool-call";
export { default as membersTable } from "./member";
export { default as messagesTable } from "./message";
export { default as modelsTable } from "./model";
export { default as oauthAccessTokensTable } from "./oauth-access-token";
export { default as oauthClientsTable } from "./oauth-client";
export { default as oauthConsentsTable } from "./oauth-consent";
export { default as oauthRefreshTokensTable } from "./oauth-refresh-token";
export { default as optimizationRulesTable } from "./optimization-rule";
export { default as organizationsTable } from "./organization";
export { organizationRole as organizationRolesTable } from "./organization-role";
export { default as processedEmailsTable } from "./processed-email";
export { default as scheduleTriggersTable } from "./schedule-trigger";
export { default as scheduleTriggerRunsTable } from "./schedule-trigger-run";
export { default as secretsTable } from "./secret";
export { default as serviceAccountsTable } from "./service-account";
export { default as serviceAccountTokensTable } from "./service-account-token";
export { default as sessionsTable } from "./session";
export { default as siteNotificationsTable } from "./site-notification";
export { default as skillsTable } from "./skill";
export { default as skillFilesTable } from "./skill-file";
export { default as skillSandboxesTable } from "./skill-sandbox";
export { default as skillSandboxArtifactsTable } from "./skill-sandbox-artifact";
export { default as skillSandboxCommandsTable } from "./skill-sandbox-command";
export { default as skillSandboxFileSnapshotsTable } from "./skill-sandbox-file-snapshot";
export { default as skillSandboxSkillsTable } from "./skill-sandbox-skill";
export {
  default as skillShareLinksTable,
  skillShareLinkSkillsTable,
} from "./skill-share-link";
export { default as skillShareLinkRevisionsTable } from "./skill-share-link-revision";
export { default as skillTeamsTable } from "./skill-team";
export { default as tasksTable } from "./task";
export { team as teamsTable, teamMember as teamMembersTable } from "./team";
export { default as teamExternalGroupsTable } from "./team-external-group";
export { default as teamTokensTable } from "./team-token";
export { default as teamVaultFoldersTable } from "./team-vault-folder";
export { default as toolsTable } from "./tool";
export { default as toolInvocationPoliciesTable } from "./tool-invocation-policy";
export { default as trustedDataPoliciesTable } from "./trusted-data-policy";
export { default as twoFactorsTable } from "./two-factor";
export { default as usersTable } from "./user";
export { default as userTokensTable } from "./user-token";
export { default as verificationsTable } from "./verification";
export { default as virtualApiKeysTable } from "./virtual-api-key";
export { default as virtualApiKeyProviderApiKeysTable } from "./virtual-api-key-provider-api-key";
export { default as virtualApiKeyTeamsTable } from "./virtual-api-key-team";

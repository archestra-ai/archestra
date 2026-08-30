import config from "@/config";
import type { schema } from "@/database";
import AgentModel from "@/models/agent";
import AgentToolModel from "@/models/agent-tool";
import ApiKeyModel from "@/models/api-key";
import AppModel from "@/models/app";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import EnvironmentModel from "@/models/environment";
import EnvironmentDefaultUserLimitModel from "@/models/environment-default-user-limit";
import EnvironmentResourceDefaultModel from "@/models/environment-resource-default";
import ExecutionCredentialDefinitionModel from "@/models/execution-credential-definition";
import GithubAppConfigModel from "@/models/github-app-config";
import GithubPatModel from "@/models/github-pat";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import KbDirectoryModel from "@/models/kb-directory";
import KbFileModel from "@/models/kb-file";
import KnowledgeBaseModel from "@/models/knowledge-base";
import KnowledgeBaseConnectorModel from "@/models/knowledge-base-connector";
import LimitModel from "@/models/limit";
import LlmOauthClientModel from "@/models/llm-oauth-client";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import McpServerModel from "@/models/mcp-server";
import MemberModel from "@/models/member";
import ModelModel from "@/models/model";
import OrganizationModel from "@/models/organization";
import OrganizationRoleModel from "@/models/organization-role";
import PluginModel from "@/models/plugin";
import ProjectModel from "@/models/project";
import ScheduleTriggerModel from "@/models/schedule-trigger";
import ServiceAccountModel from "@/models/service-account";
import SkillModel from "@/models/skill";
import SkillShareLinkModel from "@/models/skill-share-link";
import TeamModel from "@/models/team";
import TeamTokenModel from "@/models/team-token";
import ToolModel from "@/models/tool";
import ToolInvocationPolicyModel from "@/models/tool-invocation-policy";
import TrustedDataPolicyModel from "@/models/trusted-data-policy";
import UserTokenModel from "@/models/user-token";
import VirtualApiKeyModel from "@/models/virtual-api-key";

/**
 * The structural contract every audited table's model must satisfy.
 * The `findByIdForAudit` method is used by the audit hook to capture
 * before/after snapshots. The model value passed here is the class itself
 * (static side), not an instance.
 *
 * @public
 */
export type AuditableModel = {
  findByIdForAudit(
    id: string,
    orgId: string,
  ): Promise<Record<string, unknown> | null>;
};

type AuditDecision =
  | { audited: true; model: AuditableModel }
  | { audited: false; reason: string };

/**
 * Compile-time enforcement that every Drizzle table exported from
 * `database/schemas/index.ts` has an explicit audit decision.
 *
 * The `satisfies` clause is load-bearing: when a contributor adds a new
 * table to the schema, TypeScript fails the build until they add an entry
 * here. This turns "reviewer noticed the gap" into "TS told me before PR
 * review".
 *
 * Decision rules:
 * - Resource-shaped tables with admin-facing CRUD via /api/*: `audited: true`.
 *   The `model` field must implement `findByIdForAudit`.
 * - Join tables: `audited: false`; the parent resource carries the signal.
 * - Runtime/execution-state tables: `audited: false`; own log surface or too
 *   high-volume to belong in the audit log.
 * - Better-auth machinery (sessions, accounts, etc.): `audited: false`; auth
 *   events are captured by the better-auth handleAfterHook, not table writes.
 * - Child documents (skillFiles, kbChunks, etc.): `audited: false`; parent
 *   carries the signal.
 * - Enterprise-only tables: default `audited: false`; overridden at startup
 *   by `initAuditDecisions()` when the EE license is active.
 *
 * @public — consumed by audit-log-snapshot.test.ts invariant tests
 */
export const AUDIT_DECISIONS = {
  // =========================================================================
  // Audited resources — mutations captured via AUDITABLE_ROUTES
  // =========================================================================
  agentsTable: { audited: true, model: AgentModel },
  executionCredentialDefinitionsTable: {
    audited: true,
    model: ExecutionCredentialDefinitionModel,
  },

  agentToolsTable: { audited: true, model: AgentToolModel },
  apikeysTable: { audited: true, model: ApiKeyModel },
  chatopsChannelBindingsTable: {
    audited: true,
    model: ChatOpsChannelBindingModel,
  },
  pluginsTable: { audited: true, model: PluginModel },
  environmentsTable: { audited: true, model: EnvironmentModel },
  environmentDefaultUserLimitsTable: {
    audited: true,
    model: EnvironmentDefaultUserLimitModel,
  },
  environmentResourceDefaultsTable: {
    audited: true,
    model: EnvironmentResourceDefaultModel,
  },
  githubAppConfigsTable: { audited: true, model: GithubAppConfigModel },
  githubPatsTable: { audited: true, model: GithubPatModel },
  internalMcpCatalogTable: { audited: true, model: InternalMcpCatalogModel },
  mcpCatalogSkillsTable: {
    audited: false,
    reason:
      "derived MCP discovery metadata refreshed with the parent catalog's tools; not directly admin-mutable",
  },
  knowledgeBasesTable: { audited: true, model: KnowledgeBaseModel },
  knowledgeBaseConnectorsTable: {
    audited: true,
    model: KnowledgeBaseConnectorModel,
  },
  limitsTable: { audited: true, model: LimitModel },
  llmProviderApiKeysTable: { audited: true, model: LlmProviderApiKeyModel },
  mcpServersTable: { audited: true, model: McpServerModel },
  membersTable: { audited: true, model: MemberModel },
  modelsTable: { audited: true, model: ModelModel },
  // oauthClientsTable stores LLM OAuth clients (/api/llm-oauth-clients) and MCP
  // OAuth clients (/api/mcp-oauth-clients). Admin CRUD for both is audited at the
  // route level via AUDITABLE_ROUTES; this table-level model is the LLM snapshot.
  oauthClientsTable: { audited: true, model: LlmOauthClientModel },
  organizationsTable: { audited: true, model: OrganizationModel },
  organizationRolesTable: { audited: true, model: OrganizationRoleModel },
  scheduleTriggersTable: { audited: true, model: ScheduleTriggerModel },
  skillsTable: { audited: true, model: SkillModel },
  teamsTable: { audited: true, model: TeamModel },
  teamTokensTable: { audited: true, model: TeamTokenModel },
  toolsTable: { audited: true, model: ToolModel },
  toolInvocationPoliciesTable: {
    audited: true,
    model: ToolInvocationPolicyModel,
  },
  toolObservationsTable: {
    audited: false,
    reason:
      "runtime attribution metadata written by the LLM proxy (who observed a tool, via which client); not admin-mutable state",
  },
  trustedDataPoliciesTable: { audited: true, model: TrustedDataPolicyModel },
  userTokensTable: { audited: true, model: UserTokenModel },
  virtualApiKeysTable: { audited: true, model: VirtualApiKeyModel },

  // =========================================================================
  // Audit log itself
  // =========================================================================
  auditLogsTable: {
    audited: false,
    reason: "audit table itself; auditing its mutations would recurse",
  },

  // =========================================================================
  // Invitation lifecycle — audited via better-auth inline writes
  // (invitation.created, invitation.deleted); no AUDITABLE_ROUTES entry
  // =========================================================================
  invitationsTable: {
    audited: false,
    reason:
      "invitation lifecycle audited via better-auth inline writes (invitation.created, invitation.deleted); see auth/better-auth.ts",
  },

  // =========================================================================
  // Enterprise-edition only — override applied at startup by initAuditDecisions()
  // =========================================================================
  identityProvidersTable: {
    audited: false,
    reason:
      "enterprise edition only; override applied via initAuditDecisions() at startup when EE license is active",
  },

  // =========================================================================
  // Chat surface (dedicated /llm/logs + /mcp/logs)
  // =========================================================================
  conversationsTable: {
    audited: false,
    reason: "chat conversations; high-volume, surfaced via /llm/logs",
  },
  conversationChatErrorsTable: {
    audited: false,
    reason: "chat error records; surfaced via /llm/logs",
  },
  conversationCompactionsTable: {
    audited: false,
    reason: "chat compaction state; runtime artifact",
  },
  conversationEnabledToolsTable: {
    audited: false,
    reason: "join: conversation × tool; chat surface",
  },
  conversationSharesTable: {
    audited: false,
    reason: "chat share metadata; surfaced via /llm/logs",
  },
  // Soft-deleted rather than removed, and restorable org-wide by a project
  // admin — so delete and restore are cross-user administrative actions on
  // someone else's data, not the personal grouping this table started as.
  projectsTable: { audited: true, model: ProjectModel },
  projectSharesTable: {
    audited: false,
    reason: "project share metadata; parent (project) audited",
  },
  projectShareTeamsTable: {
    audited: false,
    reason: "join: project share × team; parent (project) audited",
  },
  projectPinsTable: {
    audited: false,
    reason:
      "per-user pin on a project; personal preference, not an access change",
  },
  userOnboardingSeenItemsTable: {
    audited: false,
    reason:
      "per-user onboarding red-dot dismissals; personal preference, not an access change",
  },
  conversationShareTeamsTable: {
    audited: false,
    reason: "join: conversation share × team",
  },
  conversationShareUsersTable: {
    audited: false,
    reason: "join: conversation share × user",
  },
  messagesTable: {
    audited: false,
    reason: "individual chat messages; surfaced via /llm/logs",
  },
  interactionsTable: {
    audited: false,
    reason: "chat interaction execution state",
  },
  conversationAttachmentsTable: {
    audited: false,
    reason:
      "conversation message attachments; high-volume, surfaced via /llm/logs",
  },

  // =========================================================================
  // MCP gateway runtime (dedicated /mcp/logs)
  // =========================================================================
  mcpToolCallsTable: {
    audited: false,
    reason: "MCP tool call log; surfaced via /mcp/logs",
  },
  mcpGatewayTasksTable: {
    audited: false,
    reason:
      "Ephemeral task handles for in-flight tool calls; the calls themselves are logged in mcp_tool_calls",
  },
  mcpDeploymentLeasesTable: {
    audited: false,
    reason:
      "Ephemeral cross-replica mutual-exclusion rows; the actions they serialize (hard resets) are audited themselves",
  },
  mcpHttpSessionsTable: {
    audited: false,
    reason: "MCP session-level transport state",
  },
  mcpPresetEntriesTable: {
    audited: false,
    reason: "preset definitions; static config, audited via catalog",
  },
  // =========================================================================
  // A2A protocol runtime
  // =========================================================================
  a2aContextsTable: { audited: false, reason: "A2A protocol runtime context" },
  a2aContextCompactionsTable: {
    audited: false,
    reason: "A2A context history compaction summaries (runtime state)",
  },
  a2aMessagesTable: { audited: false, reason: "A2A protocol message log" },
  a2aTasksTable: { audited: false, reason: "A2A protocol task state" },
  a2aTaskEventsTable: {
    audited: false,
    reason: "A2A protocol task stream-event log (runtime state)",
  },
  a2aArtifactsTable: {
    audited: false,
    reason: "A2A protocol task artifact output (runtime state)",
  },
  a2aPushNotificationConfigsTable: {
    audited: false,
    reason: "A2A protocol per-task webhook config (runtime state)",
  },
  a2aTaskApprovalRequestsTable: {
    audited: false,
    reason: "A2A protocol approval state",
  },

  // =========================================================================
  // Better-auth runtime (auth events come from handleAfterHook)
  // =========================================================================
  accountsTable: {
    audited: false,
    reason:
      "better-auth account material; auth events captured via handleAfterHook",
  },
  sessionsTable: {
    audited: false,
    reason:
      "better-auth session material; auth events captured via handleAfterHook",
  },
  twoFactorsTable: {
    audited: false,
    reason:
      "better-auth 2FA material; auth events captured via handleAfterHook",
  },
  verificationsTable: {
    audited: false,
    reason: "better-auth verification flow state",
  },
  jwksTable: { audited: false, reason: "better-auth signing key material" },

  // =========================================================================
  // OAuth runtime
  // =========================================================================
  oauthAccessTokensTable: {
    audited: false,
    reason: "OAuth access token runtime state",
  },
  oauthConsentsTable: {
    audited: false,
    reason: "OAuth consent records; ephemeral",
  },
  oauthRefreshTokensTable: {
    audited: false,
    reason: "OAuth refresh token runtime state",
  },

  // =========================================================================
  // Join / membership / labels (parent resource carries audit signal)
  // =========================================================================
  agentConnectorAssignmentsTable: {
    audited: false,
    reason: "join: agent × connector; parent (agent) audited",
  },
  agentExcludedConnectorsTable: {
    audited: false,
    reason: "join: agent × knowledge-source exclusion; parent (agent) audited",
  },
  agentExcludedSkillsTable: {
    audited: false,
    reason: "join: agent × skill exclusion; parent (agent) audited",
  },
  agentExcludedSubagentsTable: {
    audited: false,
    reason: "join: agent × subagent exclusion; parent (agent) audited",
  },
  agentExcludedToolsTable: {
    audited: false,
    reason: "join: agent × tool exclusion; parent (agent) audited",
  },
  agentKnowledgeBasesTable: {
    audited: false,
    reason: "join: agent × knowledge base; parent (agent) audited",
  },
  agentSkillsTable: {
    audited: false,
    reason: "join: agent × skill assignment; parent (agent) audited",
  },
  agentLabelsTable: {
    audited: false,
    reason: "join: agent × label; parent (agent) audited",
  },
  agentSuggestedPromptsTable: {
    audited: false,
    reason: "child of agent; parent audited",
  },
  agentTeamsTable: {
    audited: false,
    reason: "join: agent × team; parent (agent) audited",
  },
  agentVersionsTable: {
    audited: false,
    reason: "child of agent; immutable version snapshot, parent audited",
  },
  // Apps are a resource-shaped table with admin-facing CRUD via /api/apps.
  appsTable: { audited: true, model: AppModel },
  appVersionsTable: {
    audited: false,
    reason: "child of app; immutable version snapshot, parent audited",
  },
  appToolsTable: {
    audited: false,
    reason: "tools attached to an app; parent (app) carries the signal",
  },
  appLabelsTable: {
    audited: false,
    reason: "join: app × label; parent (app) audited",
  },
  appDataTable: {
    audited: false,
    reason:
      "app-scoped runtime data store; written by app HTML, no admin signal",
  },
  appPinsTable: {
    audited: false,
    reason: "per-user pin on an app; personal preference, not an access change",
  },
  appRenderDiagnosticsTable: {
    audited: false,
    reason:
      "ephemeral per-viewer render diagnostics; best-effort, not admin state",
  },
  appRenderScreenshotTable: {
    audited: false,
    reason:
      "ephemeral per-viewer render screenshot; best-effort, not admin state",
  },
  labelKeysTable: { audited: false, reason: "label taxonomy; low-value churn" },
  labelValuesTable: {
    audited: false,
    reason: "label taxonomy; low-value churn",
  },
  knowledgeBaseConnectorAssignmentsTable: {
    audited: false,
    reason:
      "join: knowledge base × connector assignment; parent (knowledgeBaseConnector) audited",
  },
  mcpCatalogLabelsTable: {
    audited: false,
    reason: "join: catalog × label; parent (catalog) audited",
  },
  teamLabelsTable: {
    audited: false,
    reason: "join: team × label; parent (team) audited",
  },
  mcpCatalogTeamsTable: {
    audited: false,
    reason: "join: catalog × team; parent (catalog) audited",
  },
  agentUsersTable: {
    audited: false,
    reason: "join: agent × user; parent (agent) audited",
  },
  skillUsersTable: {
    audited: false,
    reason: "join: skill × user; parent (skill) audited",
  },
  modelUsersTable: {
    audited: false,
    reason: "join: model × user; parent (model) audited",
  },
  projectShareUsersTable: {
    audited: false,
    reason: "join: project share × user; parent (project) audited",
  },
  mcpCatalogUsersTable: {
    audited: false,
    reason: "join: catalog × user; parent (catalog) audited",
  },
  modelTeamsTable: {
    audited: false,
    reason:
      "join: model × team; parent (model) audited, snapshot includes restrictedToTeams",
  },
  oauthClientTeamsTable: {
    audited: false,
    reason: "join: oauth client × team; parent (oauth client) audited",
  },
  mcpServerUsersTable: {
    audited: false,
    reason: "join: mcp server × user; parent (mcp server) audited",
  },
  mcpServerAlertMutesTable: {
    audited: false,
    reason: "per-viewer UI state; intentionally excluded from audit logs",
  },
  teamMembersTable: {
    audited: false,
    reason: "join: team × member; member changes audited via member",
  },
  teamExternalGroupsTable: {
    audited: false,
    reason: "join: team × external group; parent (team) audited",
  },
  // Vault folder mutations are captured under the parent team resource via
  // /api/teams/:teamId/vault-folder → resourceType: "team".
  teamVaultFoldersTable: {
    audited: false,
    reason: "team vault folder; mutations captured under parent team resource",
  },
  virtualApiKeyProviderApiKeysTable: {
    audited: false,
    reason: "join: virtual key × provider key; parent audited",
  },
  virtualApiKeyTeamsTable: {
    audited: false,
    reason: "join: virtual key × team; parent audited",
  },
  virtualApiKeyLlmProxiesTable: {
    audited: false,
    // Orphaned table — the passthrough-key "allowed LLM proxies" feature was
    // removed; no code reads/writes it. Retained only so this release doesn't
    // drop it under old pods; entry stays until the table is dropped (phase 2).
    reason: "orphaned/unused; retained for zero-downtime, dropped in phase 2",
  },

  // =========================================================================
  // Children of audited parents
  // =========================================================================
  hookFilesTable: {
    audited: false,
    reason: "agent-scoped hook script config; child of agent (audited)",
  },
  skillTeamsTable: {
    audited: false,
    reason: "join: skill × team; parent (skill) audited",
  },
  skillEnvironmentsTable: {
    audited: false,
    reason:
      "join: skill × environment; parent (skill) audited, and the skill audit snapshot includes environmentIds",
  },
  skillFilesTable: {
    audited: false,
    reason: "child of skill; parent (skill) audited",
  },
  pluginFilesTable: {
    audited: false,
    reason: "child of plugin; parent (plugin) audited",
  },
  pluginTeamsTable: {
    audited: false,
    reason: "join: plugin × team; parent (plugin) audited",
  },
  pluginUsersTable: {
    audited: false,
    reason: "join: plugin × user; parent (plugin) audited",
  },
  skillUsageEventsTable: {
    audited: false,
    reason:
      "append-only usage metric written by the system on every activation; not a user-driven state change",
  },
  externalMcpSkillUsageEventsTable: {
    audited: false,
    reason:
      "append-only usage metric written by the system on every external MCP Skill activation; not a user-driven state change",
  },
  pluginSkillUsageEventsTable: {
    audited: false,
    reason:
      "append-only usage metric written by the system on every plugin Skill activation; not a user-driven state change",
  },
  connectionSetupsTable: {
    audited: false,
    reason:
      "ephemeral 15-minute render tickets for /connection setup scripts; durable artifacts (virtual key, skill share link) carry the audit signal",
  },
  connectionSetupSkillsTable: {
    audited: false,
    reason:
      "join: connection setup × skill; parent (connectionSetups) ephemeral",
  },
  connectionSetupPluginsTable: {
    audited: false,
    reason:
      "join: connection setup × plugin; parent (connectionSetups) ephemeral",
  },
  skillShareLinksTable: {
    audited: true,
    model: SkillShareLinkModel,
  },
  skillShareLinkSkillsTable: {
    audited: false,
    reason: "join: share link × skill; parent (skillShareLinks) carries signal",
  },
  skillShareLinkPluginsTable: {
    audited: false,
    reason:
      "join: share link × plugin; parent (skillShareLinks) carries signal",
  },
  skillShareLinkRevisionsTable: {
    audited: false,
    reason:
      "child of skillShareLinks / skillMarketplaceRepos; revision history",
  },
  skillMarketplaceCredentialsTable: {
    audited: false,
    reason:
      "read-only marketplace credential with no CRUD route to snapshot; issued implicitly by the audited connection-setup script route and dropped on membership removal, which writes member.deleted",
  },
  skillMarketplaceReposTable: {
    audited: false,
    reason:
      "derived per-viewer marketplace repo; created implicitly on clone, carries no user-authored state",
  },
  agentRunsTable: {
    audited: false,
    reason:
      "records which pod carries an A2A task; the task's own state machine and event log are the record of the work",
  },
  agentExecutionInputsTable: {
    audited: false,
    reason:
      "task-owned runtime inputs; the execution start event records the file count without logging file names or content",
  },
  userCredentialsTable: {
    audited: false,
    reason:
      "a person's own credential references, with no administrative CRUD — only the owner can add or remove one, and the value is never stored here",
  },
  executionCredentialConnectionsTable: {
    audited: false,
    reason:
      "credential references only; secret values are never stored here and mutations are recorded by the execution credential route",
  },
  skillSandboxesTable: {
    audited: false,
    reason:
      "ephemeral execution sandbox state; runtime artifact, no admin signal",
  },
  skillSandboxSkillMountsTable: {
    audited: false,
    reason: "child of sandbox; ordered skill mount, parent is ephemeral",
  },
  skillSandboxCommandsTable: {
    audited: false,
    reason: "child of sandbox; append-only command replay log",
  },
  skillSandboxFilesTable: {
    audited: false,
    reason: "child of sandbox; uploaded input + exported artifact file bytes",
  },
  filesTable: {
    audited: false,
    reason:
      "user's own PFS files; download_file/save_file outputs, no admin signal",
  },
  skillSandboxReplayEventsTable: {
    audited: false,
    reason: "child of sandbox; append-only ordered replay log",
  },
  skillVersionsTable: {
    audited: false,
    reason: "child of skill; immutable version snapshot, parent audited",
  },
  skillVersionFilesTable: {
    audited: false,
    reason: "child of skill version; immutable file snapshot",
  },
  kbChunksTable: {
    audited: false,
    reason: "child of knowledge base; parent audited",
  },
  kbBm25TermStatsTable: {
    audited: false,
    reason:
      "derived BM25 corpus statistics; rebuilt from kb_chunks by a periodic task, never edited by a user",
  },
  kbBm25CorpusStatsTable: {
    audited: false,
    reason:
      "derived BM25 corpus statistics; rebuilt from kb_chunks by a periodic task, never edited by a user",
  },
  kbContainerAclsTable: {
    audited: false,
    reason:
      "permission-sync container-audience snapshot; derived upstream data, not config",
  },
  kbDocumentsTable: {
    audited: false,
    reason: "child of knowledge base; parent audited",
  },
  kbDirectoriesTable: {
    audited: true,
    model: KbDirectoryModel,
  },
  kbDirectoryTeamsTable: {
    audited: false,
    reason: "join table; the directory's audit snapshot carries its team ids",
  },
  kbFilesTable: {
    audited: true,
    model: KbFileModel,
  },
  kbFileTeamsTable: {
    audited: false,
    reason: "join table; the file's audit snapshot carries its team ids",
  },
  kbFileDocumentsTable: {
    audited: false,
    reason:
      "derived link between a repository file and the documents indexed from it",
  },
  kbUploadConnectorsTable: {
    audited: false,
    reason: "internal plumbing; one hidden upload connector per knowledge base",
  },
  kbExternalGroupsTable: {
    audited: false,
    reason:
      "permission-sync source-group catalog; derived upstream data, not config",
  },
  kbExternalUserGroupsTable: {
    audited: false,
    reason:
      "permission-sync group-membership snapshot; derived upstream data, not config",
  },
  kbMemberOverridesTable: {
    audited: false,
    reason:
      "admin member mapping mutated only via /api/connectors/:id/member-overrides, audited at the route level as connector.updated; the connector audit snapshot carries the mapping list so upsert/delete diffs",
  },
  llmProviderApiKeyModelsTable: {
    audited: false,
    reason: "join: provider key × model; parent audited",
  },
  limitModelUsageTable: {
    audited: false,
    reason: "usage metrics; runtime data, not config",
  },

  // =========================================================================
  // Execution / runtime state
  // =========================================================================
  connectorRunsTable: {
    audited: false,
    reason: "connector run execution log",
  },
  scheduleTriggerRunsTable: {
    audited: false,
    reason: "schedule trigger run execution log",
  },
  tasksTable: { audited: false, reason: "task queue runtime state" },

  // =========================================================================
  // ChatOps runtime
  // =========================================================================
  chatopsProcessedMessagesTable: {
    audited: false,
    reason: "ChatOps message dedup; runtime state",
  },
  chatopsThreadContextsTable: {
    audited: false,
    reason: "ChatOps thread → A2A context mapping; runtime state",
  },

  // =========================================================================
  // Email / messaging ingest
  // =========================================================================
  incomingEmailSubscriptionsTable: {
    audited: false,
    reason: "incoming email subscription config; low-value",
  },
  processedEmailsTable: {
    audited: false,
    reason: "email dedup ledger; runtime state",
  },

  // =========================================================================
  // Secrets (presence audited via parent hasSecret flag)
  // =========================================================================
  secretsTable: {
    audited: false,
    reason:
      "secret material; presence audited via parent resource hasSecret flag",
  },
  contentEncryptionStateTable: {
    audited: false,
    reason: "internal backfill progress bookkeeping, no user-facing state",
  },
  encryptionKeyCanariesTable: {
    audited: false,
    reason:
      "internal startup canary for encryption-key verification; no user-facing writes",
  },

  // =========================================================================
  // User / token material
  // =========================================================================
  usersTable: {
    audited: false,
    reason: "user lifecycle audited via auth events + member.*",
  },
  serviceAccountsTable: {
    audited: true,
    model: ServiceAccountModel,
  },
  serviceAccountTokensTable: {
    audited: false,
    reason: "credential material; audited through service account token count",
  },

  // =========================================================================
  // Misc ephemeral
  // =========================================================================
  browserTabStatesTable: {
    audited: false,
    reason: "ephemeral browser tab state; per-user UI cache",
  },

  // =========================================================================
  // Chat active run (streaming execution state)
  // =========================================================================
  chatActiveRunsTable: {
    audited: false,
    reason: "chat active run execution state; high-volume streaming runtime",
  },
  chatActiveRunEventsTable: {
    audited: false,
    reason: "chat active run event stream; child of chatActiveRunsTable",
  },
  chatToolExecutionClaimsTable: {
    audited: false,
    reason:
      "per-tool-call idempotency ledger; runtime dedup state, mcp_tool_calls audits the execution",
  },

  // =========================================================================
  // Site notifications
  // =========================================================================
  siteNotificationsTable: {
    audited: false,
    reason: "ephemeral in-app notifications; per-user UI state",
  },
} satisfies Record<keyof typeof schema, AuditDecision>;

/**
 * Merges enterprise-edition audit decisions into AUDIT_DECISIONS.
 *
 * Must be called once at server startup (before requests begin), after
 * `config` is initialized. Follows the same pattern as `initAuditRegistry()`.
 *
 * When the EE license is active, `identityProvidersTable` is upgraded from
 * its default `audited: false` placeholder to `audited: true` with the
 * real IdentityProviderModel so the runtime cross-check tests pass.
 */
export async function initAuditDecisions(): Promise<void> {
  if (!config.enterpriseFeatures.core) return;
  // biome-ignore lint/style/noRestrictedImports: conditional EE import, never runs in OSS builds
  const idpModule = await import("../models/identity-provider.ee");
  const IdentityProviderModel = idpModule.default;
  (AUDIT_DECISIONS as Record<string, AuditDecision>).identityProvidersTable = {
    audited: true,
    model: IdentityProviderModel,
  };
}

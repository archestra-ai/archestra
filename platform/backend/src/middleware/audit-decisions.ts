import config from "@/config";
import type { schema } from "@/database";
import AgentModel from "@/models/agent";
import AgentToolModel from "@/models/agent-tool";
import ApiKeyModel from "@/models/api-key";
import AppModel from "@/models/app";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import EnvironmentModel from "@/models/environment";
import EnvironmentDefaultUserLimitModel from "@/models/environment-default-user-limit";
import GithubAppConfigModel from "@/models/github-app-config";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import KnowledgeBaseModel from "@/models/knowledge-base";
import KnowledgeBaseConnectorModel from "@/models/knowledge-base-connector";
import LimitModel from "@/models/limit";
import LlmOauthClientModel from "@/models/llm-oauth-client";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import McpServerModel from "@/models/mcp-server";
import McpServerInstallationRequestModel from "@/models/mcp-server-installation-request";
import MemberModel from "@/models/member";
import ModelModel from "@/models/model";
import OptimizationRuleModel from "@/models/optimization-rule";
import OrganizationModel from "@/models/organization";
import OrganizationRoleModel from "@/models/organization-role";
import ScheduleTriggerModel from "@/models/schedule-trigger";
import ServiceAccountModel from "@/models/service-account";
import SkillModel from "@/models/skill";
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
  agentToolsTable: { audited: true, model: AgentToolModel },
  apikeysTable: { audited: true, model: ApiKeyModel },
  chatopsChannelBindingsTable: {
    audited: true,
    model: ChatOpsChannelBindingModel,
  },
  environmentsTable: { audited: true, model: EnvironmentModel },
  environmentDefaultUserLimitsTable: {
    audited: true,
    model: EnvironmentDefaultUserLimitModel,
  },
  githubAppConfigsTable: { audited: true, model: GithubAppConfigModel },
  internalMcpCatalogTable: { audited: true, model: InternalMcpCatalogModel },
  knowledgeBasesTable: { audited: true, model: KnowledgeBaseModel },
  knowledgeBaseConnectorsTable: {
    audited: true,
    model: KnowledgeBaseConnectorModel,
  },
  limitsTable: { audited: true, model: LimitModel },
  llmProviderApiKeysTable: { audited: true, model: LlmProviderApiKeyModel },
  mcpServersTable: { audited: true, model: McpServerModel },
  mcpServerInstallationRequestsTable: {
    audited: true,
    model: McpServerInstallationRequestModel,
  },
  membersTable: { audited: true, model: MemberModel },
  modelsTable: { audited: true, model: ModelModel },
  // oauthClientsTable stores LLM OAuth clients (/api/llm-oauth-clients) and MCP
  // OAuth clients (/api/mcp-oauth-clients). Admin CRUD for both is audited at the
  // route level via AUDITABLE_ROUTES; this table-level model is the LLM snapshot.
  oauthClientsTable: { audited: true, model: LlmOauthClientModel },
  optimizationRulesTable: { audited: true, model: OptimizationRuleModel },
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
  projectsTable: {
    audited: false,
    reason: "user's chat-project grouping; same family as conversations",
  },
  projectSharesTable: {
    audited: false,
    reason: "project share metadata; same family as conversation shares",
  },
  projectShareTeamsTable: {
    audited: false,
    reason: "join: project share × team",
  },
  projectPinsTable: {
    audited: false,
    reason:
      "per-user pin on a project; personal preference, not an access change",
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
  a2aMessagesTable: { audited: false, reason: "A2A protocol message log" },
  a2aTasksTable: { audited: false, reason: "A2A protocol task state" },
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
  agentKnowledgeBasesTable: {
    audited: false,
    reason: "join: agent × knowledge base; parent (agent) audited",
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
  appDataTable: {
    audited: false,
    reason:
      "app-scoped runtime data store; written by app HTML, no admin signal",
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
  mcpServerUsersTable: {
    audited: false,
    reason: "join: mcp server × user; parent (mcp server) audited",
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
  skillFilesTable: {
    audited: false,
    reason: "child of skill; parent (skill) audited",
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
  skillShareLinksTable: {
    audited: false,
    reason:
      "skill share links; admin share/revoke not yet wired for audit (follow-up)",
  },
  skillShareLinkSkillsTable: {
    audited: false,
    reason: "join: share link × skill; parent (skillShareLinks) carries signal",
  },
  skillShareLinkRevisionsTable: {
    audited: false,
    reason: "child of skillShareLinks; revision history",
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
  kbDocumentsTable: {
    audited: false,
    reason: "child of knowledge base; parent audited",
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
  chatopsThreadAgentOverrideTable: {
    audited: false,
    reason: "ChatOps thread override; runtime state",
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

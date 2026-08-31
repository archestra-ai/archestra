import config from "@/config";
import AgentModel from "@/models/agent";
import AgentToolModel from "@/models/agent-tool";
import ApiKeyModel from "@/models/api-key";
import AppModel from "@/models/app";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import chatOpsConfigModel from "@/models/chatops-config";
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
import McpOauthClientModel from "@/models/mcp-oauth-client";
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
import { type AuditEventName, AuditEventNameSchema } from "@/types/audit-log";

export type AuditResourceIdSource =
  | "organizationContext"
  | "currentUser"
  | "currentUserPersonalToken";

export type AuditableRouteConfig = {
  resourceType: string;
  /**
   * Name of the route param that identifies the resource for `fetchById` and
   * `resource_id` (default: `id`). Use `agentId` for `/api/agents/:agentId/...`,
   * `roleId` for `/api/roles/:roleId`, etc.
   */
  resourceIdParam?: string;
  /**
   * When set, the audited resource id is not taken from route params.
   * - `organizationContext`: `request.organizationId` (org settings, bulk org routes).
   * - `currentUser`: `request.user.id` for personal account-level actions.
   * - `currentUserPersonalToken`: the caller's personal token row in the current org.
   */
  resourceIdSource?: AuditResourceIdSource;
  fetchById?: (
    id: string,
    organizationId: string,
    routeParams?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
  /**
   * Hard-coded action name; wins over actionByMethod and method-derivation.
   * Use for routes whose HTTP verb does not map to the semantic action
   * (rotations, syncs, imports, reinstalls, bulk ops).
   */
  action?: AuditEventName;
  /**
   * Per-method action override; falls through to deriveAction when absent.
   * Useful when a single route pattern handles multiple verbs with different
   * semantics.
   */
  actionByMethod?: Partial<
    Record<"POST" | "PUT" | "PATCH" | "DELETE", AuditEventName>
  >;
  /** Skip unsuccessful attempts; the route sets `auditSkip` for no-op successes. */
  onlyWhenChanged?: boolean;
};

/**
 * Return value of `resolveAuditableRouteConfig`.  `viaWalkUp` is true when the
 * config was inherited from a parent path segment rather than being registered
 * for the exact route pattern.  The hook uses this to suppress POST walk-ups
 * which would otherwise mis-attribute a child-resource creation to the parent.
 */
type ResolvedAuditableRoute = {
  cfg: AuditableRouteConfig;
  viaWalkUp: boolean;
};

/**
 * Derives a dotted audit event name from a resource type and HTTP method.
 * Returns null when the candidate name is not in the closed AuditEventNameSchema
 * (i.e., the resource type is unknown or the method doesn't map to a verb).
 *
 * @public — consumed by audit-log-hook.ts and audit-log-snapshot.test.ts
 */
export function deriveAction(
  resourceType: string | null,
  method: string,
): AuditEventName | null {
  if (!resourceType) return null;
  const verb =
    method === "POST"
      ? "created"
      : method === "PUT" || method === "PATCH"
        ? "updated"
        : method === "DELETE"
          ? "deleted"
          : null;
  if (!verb) return null;
  const candidate = `${resourceType}.${verb}`;
  return AuditEventNameSchema.safeParse(candidate).success
    ? (candidate as AuditEventName)
    : null;
}

/**
 * Maps Fastify parameterized route patterns to their resource type and an
 * optional snapshot fetcher.  The audit preHandler hook uses `fetchById` to
 * capture `before`; the onResponse hook uses it again for `after`.
 *
 * Rules:
 * - POST routes (no :id in path) register without `fetchById`; the hook
 *   obtains the id from the response body when needed.
 * - Non-`:id` params use `resourceIdParam` (e.g. `agentId`, `roleId`).
 * - `resolveAuditableRouteConfig` walks up path segments so nested routes
 *   (e.g. `/api/mcp_server/:id/reinstall`) reuse the parent snapshot fetcher.
 * - EE-only routes are added at startup via `initAuditRegistry()`.
 * @public — consumed by audit-log-snapshot.test.ts to verify registry invariants
 */
export const AUDITABLE_ROUTES: Record<string, AuditableRouteConfig> = {
  // Agents
  "/api/agents": {
    resourceType: "agent",
    fetchById: (id, orgId) => AgentModel.findByIdForAudit(id, orgId),
  },
  "/api/agents/:id": {
    resourceType: "agent",
    fetchById: (id, orgId) => AgentModel.findByIdForAudit(id, orgId),
  },
  "/api/agents/:id/background-execution/credentials/:key": {
    resourceType: "agent",
    action: "agent.updated",
    fetchById: (id, orgId) => AgentModel.findByIdForAudit(id, orgId),
    onlyWhenChanged: true,
  },
  "/api/execution-credentials": {
    resourceType: "executionCredential",
    fetchById: (id, orgId) =>
      ExecutionCredentialDefinitionModel.findByIdForAudit(id, orgId),
  },
  "/api/execution-credentials/:key": {
    resourceType: "executionCredential",
    resourceIdParam: "key",
    fetchById: (key, orgId) =>
      ExecutionCredentialDefinitionModel.findByKeyForAudit(key, orgId),
  },
  "/api/execution-credentials/:key/organization": {
    resourceType: "executionCredential",
    resourceIdParam: "key",
    action: "executionCredential.updated",
    onlyWhenChanged: true,
  },
  "/api/agents/:id/executions": {
    resourceType: "agentExecution",
    action: "agentExecution.created",
  },
  "/api/agent-executions/:taskId/cancel": {
    resourceType: "agentExecution",
    resourceIdParam: "taskId",
    action: "agentExecution.canceled",
  },
  "/api/agent-executions/:taskId": {
    resourceType: "agentExecution",
    resourceIdParam: "taskId",
  },
  "/api/agents/:id/restore": {
    resourceType: "agent",
    action: "agent.restored",
    fetchById: (id, orgId) => AgentModel.findByIdForAudit(id, orgId),
  },
  // Restoring a config version rewrites the agent's whole config surface.
  // Registered explicitly because the walk-up to "/api/agents/:id" resolves
  // with viaWalkUp set, and the hook discards every walk-up POST — without
  // this entry the restore produces no audit record at all.
  "/api/agents/:id/versions/:version/restore": {
    resourceType: "agent",
    action: "agent.updated",
    fetchById: (id, orgId) => AgentModel.findByIdForAudit(id, orgId),
  },
  // Permanent deletion. Registered explicitly for two reasons: the walk-up to
  // `/api/agents/:id` would log it as `agent.deleted` (indistinguishable from a
  // recoverable soft delete), and it would attach that route's FULL snapshot as
  // `before` — a copy of exactly the config the caller asked to destroy. The
  // identity fetcher is the guarantee that a purge is audited by who/what/when
  // and nothing more.
  "/api/agents/:id/permanent": {
    resourceType: "agent",
    action: "agent.purged",
    fetchById: (id, orgId) => AgentModel.findIdentityForAudit(id, orgId),
  },
  "/api/agents/:agentId": {
    resourceType: "agent",
    resourceIdParam: "agentId",
    fetchById: (id, orgId) => AgentModel.findByIdForAudit(id, orgId),
  },

  // Syncing/removing delegation targets mutates the agent's subagent surface.
  // Registered explicitly so the POST sync isn't dropped as a walk-up (which
  // falls to unknown.created with a null resourceType) and the single-target
  // DELETE inherits agent.updated instead of deriving agent.deleted.
  "/api/agents/:agentId/delegations": {
    resourceType: "agent",
    resourceIdParam: "agentId",
    action: "agent.updated",
    fetchById: (id, orgId) => AgentModel.findByIdForAudit(id, orgId),
  },

  "/api/agent-tools/:id": {
    resourceType: "agentTool",
    fetchById: (id, orgId) => AgentToolModel.findByIdForAudit(id, orgId),
  },
  // Explicit entry prevents walk-up from inheriting agent.created for POSTs to
  // /api/agents/:agentId/tools/:toolId (assign a tool to an agent).
  "/api/agents/:agentId/tools/:toolId": {
    resourceType: "agentTool",
    resourceIdParam: "toolId",
    fetchById: (toolId, orgId, params) => {
      const agentId = params?.agentId;
      if (typeof agentId !== "string") return Promise.resolve(null);
      return AgentToolModel.findByAgentAndToolForAudit(agentId, toolId, orgId);
    },
  },

  // Apps
  "/api/apps": {
    resourceType: "app",
    fetchById: (id, orgId) => AppModel.findByIdForAudit(id, orgId),
  },
  "/api/apps/:appId": {
    resourceType: "app",
    resourceIdParam: "appId",
    fetchById: (id, orgId) => AppModel.findByIdForAudit(id, orgId),
  },
  // Tool assignment changes the app's effective tool surface; appToolsTable is
  // audited:false ("parent carries the signal"), so record app.updated with the
  // app snapshot instead of inheriting app.created from the POST walk-up.
  "/api/apps/:appId/tools/:toolId": {
    resourceType: "app",
    resourceIdParam: "appId",
    action: "app.updated",
    fetchById: (id, orgId) => AppModel.findByIdForAudit(id, orgId),
  },

  // MCP Servers
  "/api/mcp_server": {
    resourceType: "mcpServer",
    fetchById: (id, orgId) => McpServerModel.findByIdForAudit(id, orgId),
  },
  "/api/mcp_server/:id": {
    resourceType: "mcpServer",
    fetchById: (id, orgId) => McpServerModel.findByIdForAudit(id, orgId),
  },
  // Explicit entry prevents walk-up from inheriting mcpServer.created verb.
  "/api/mcp_server/:id/reinstall": {
    resourceType: "mcpServer",
    action: "mcpServer.reinstalled",
    fetchById: (id, orgId) => McpServerModel.findByIdForAudit(id, orgId),
  },
  // Destroys and recreates the physical deployment. Registered explicitly so it
  // is not logged as `mcpServer.created` by the walk-up to `/api/mcp_server/:id`
  // — a hard reset is the one MCP action an operator has to be able to find
  // after the fact, and it must not be indistinguishable from an install.
  "/api/mcp_server/:id/hard-reset": {
    resourceType: "mcpServer",
    action: "mcpServer.hardReset",
    fetchById: (id, orgId) => McpServerModel.findByIdForAudit(id, orgId),
  },
  // Restore is a POST carrying :id — register directly so the POST walk-up
  // isn't dropped (which would mis-log it as unknown.created). findByIdForAudit
  // does NOT filter soft-deleted rows, so `before` captures the deleted install
  // and `after` the revived one (deletedAt → null, reinstallRequired → true).
  "/api/mcp_server/:id/restore": {
    resourceType: "mcpServer",
    action: "mcpServer.restored",
    fetchById: (id, orgId) => McpServerModel.findByIdForAudit(id, orgId),
  },

  "/api/roles": {
    resourceType: "role",
    fetchById: (id, orgId) => OrganizationRoleModel.findByIdForAudit(id, orgId),
  },
  "/api/roles/:roleId": {
    resourceType: "role",
    resourceIdParam: "roleId",
    fetchById: (id, orgId) => OrganizationRoleModel.findByIdForAudit(id, orgId),
  },

  // Teams
  "/api/teams": {
    resourceType: "team",
    fetchById: (id, orgId) => TeamModel.findByIdForAudit(id, orgId),
  },
  "/api/teams/:id": {
    resourceType: "team",
    fetchById: (id, orgId) => TeamModel.findByIdForAudit(id, orgId),
  },

  // API Keys (REDACTED — raw key excluded from snapshot)
  "/api/api-keys": {
    resourceType: "apiKey",
    fetchById: (id, orgId) => ApiKeyModel.findByIdForAudit(id, orgId),
  },
  "/api/api-keys/:id": {
    resourceType: "apiKey",
    fetchById: (id, orgId) => ApiKeyModel.findByIdForAudit(id, orgId),
  },

  // Service Accounts
  "/api/service-accounts": {
    resourceType: "serviceAccount",
    fetchById: (id, orgId) => ServiceAccountModel.findByIdForAudit(id, orgId),
  },
  "/api/service-accounts/:id": {
    resourceType: "serviceAccount",
    fetchById: (id, orgId) => ServiceAccountModel.findByIdForAudit(id, orgId),
  },
  // Issuing/revoking a token mutates the account's credential surface; the
  // account survives, so pin serviceAccount.updated (not the derived
  // serviceAccount.created for the POST or serviceAccount.deleted for the
  // per-token DELETE).
  "/api/service-accounts/:id/tokens": {
    resourceType: "serviceAccount",
    resourceIdParam: "id",
    action: "serviceAccount.updated",
    fetchById: (id, orgId) => ServiceAccountModel.findByIdForAudit(id, orgId),
  },
  "/api/service-accounts/:id/tokens/:tokenId": {
    resourceType: "serviceAccount",
    resourceIdParam: "id",
    action: "serviceAccount.updated",
    fetchById: (id, orgId) => ServiceAccountModel.findByIdForAudit(id, orgId),
  },

  // LLM Provider API Keys (REDACTED — secretId and key material excluded)
  "/api/llm-provider-api-keys": {
    resourceType: "llmProviderApiKey",
    fetchById: (id, orgId) =>
      LlmProviderApiKeyModel.findByIdForAudit(id, orgId),
  },
  "/api/llm-provider-api-keys/:id": {
    resourceType: "llmProviderApiKey",
    fetchById: (id, orgId) =>
      LlmProviderApiKeyModel.findByIdForAudit(id, orgId),
  },

  // Tool Invocation Policies
  "/api/autonomy-policies/tool-invocation": {
    resourceType: "toolInvocationPolicy",
    fetchById: (id, orgId) =>
      ToolInvocationPolicyModel.findByIdForAudit(id, orgId),
  },
  "/api/autonomy-policies/tool-invocation/:id": {
    resourceType: "toolInvocationPolicy",
    fetchById: (id, orgId) =>
      ToolInvocationPolicyModel.findByIdForAudit(id, orgId),
  },

  // Trusted Data Policies
  "/api/trusted-data-policies": {
    resourceType: "trustedDataPolicy",
    fetchById: (id, orgId) =>
      TrustedDataPolicyModel.findByIdForAudit(id, orgId),
  },
  "/api/trusted-data-policies/:id": {
    resourceType: "trustedDataPolicy",
    fetchById: (id, orgId) =>
      TrustedDataPolicyModel.findByIdForAudit(id, orgId),
  },

  // Knowledge Bases
  "/api/knowledge-bases": {
    resourceType: "knowledgeBase",
    fetchById: (id, orgId) => KnowledgeBaseModel.findByIdForAudit(id, orgId),
  },
  "/api/knowledge-bases/:id": {
    resourceType: "knowledgeBase",
    fetchById: (id, orgId) => KnowledgeBaseModel.findByIdForAudit(id, orgId),
  },
  // findIdentityForAudit, not findByIdForAudit: the full snapshot is
  // notDeleted-filtered (deliberately, for delete records), so it cannot see
  // the still-deleted "before" state of a restore. The identity read sees both
  // states, capturing the deletedAt → null diff.
  "/api/knowledge-bases/:id/restore": {
    resourceType: "knowledgeBase",
    action: "knowledgeBase.restored",
    fetchById: (id, orgId) =>
      KnowledgeBaseModel.findIdentityForAudit(id, orgId),
  },
  // Identity-only snapshot, same as the retention sweep's purge audit rows.
  "/api/knowledge-bases/:id/permanent": {
    resourceType: "knowledgeBase",
    action: "knowledgeBase.purged",
    fetchById: (id, orgId) =>
      KnowledgeBaseModel.findIdentityForAudit(id, orgId),
  },

  // Knowledge file repository
  "/api/knowledge-files": {
    resourceType: "knowledgeFile",
    fetchById: (id, orgId) => KbFileModel.findByIdForAudit(id, orgId),
  },
  "/api/knowledge-files/:fileId": {
    resourceType: "knowledgeFile",
    resourceIdParam: "fileId",
    fetchById: (id, orgId) => KbFileModel.findByIdForAudit(id, orgId),
  },
  // Copying a chat attachment into the repository creates a file like the
  // plain upload does; registered explicitly so the POST isn't dropped as a
  // walk-up to the collection route.
  "/api/knowledge-files/from-attachment": {
    resourceType: "knowledgeFile",
    action: "knowledgeFile.created",
    fetchById: (id, orgId) => KbFileModel.findByIdForAudit(id, orgId),
  },
  // Indexing rewrites a knowledge base's contents (and can create the base);
  // the handler supplies the resource id and post-state itself because the
  // response carries `knowledgeBaseId`, not `id`, and the result spans many
  // files.
  "/api/knowledge-files/index": {
    resourceType: "knowledgeBase",
    action: "knowledgeBase.updated",
  },
  "/api/knowledge-directories": {
    resourceType: "knowledgeDirectory",
    fetchById: (id, orgId) => KbDirectoryModel.findByIdForAudit(id, orgId),
  },
  "/api/knowledge-directories/:directoryId": {
    resourceType: "knowledgeDirectory",
    resourceIdParam: "directoryId",
    fetchById: (id, orgId) => KbDirectoryModel.findByIdForAudit(id, orgId),
  },

  // Connectors
  "/api/connectors": {
    resourceType: "connector",
    fetchById: (id, orgId) =>
      KnowledgeBaseConnectorModel.findByIdForAudit(id, orgId),
  },
  "/api/connectors/:id": {
    resourceType: "connector",
    fetchById: (id, orgId) =>
      KnowledgeBaseConnectorModel.findByIdForAudit(id, orgId),
  },
  // findIdentityForAudit for the same reason as the knowledge-base restore
  // entry: the full snapshot cannot see the still-deleted "before" state.
  "/api/connectors/:id/restore": {
    resourceType: "connector",
    action: "connector.restored",
    fetchById: (id, orgId) =>
      KnowledgeBaseConnectorModel.findIdentityForAudit(id, orgId),
  },
  // Identity-only snapshot, same as the retention sweep's purge audit rows.
  "/api/connectors/:id/permanent": {
    resourceType: "connector",
    action: "connector.purged",
    fetchById: (id, orgId) =>
      KnowledgeBaseConnectorModel.findIdentityForAudit(id, orgId),
  },
  // Member overrides change who a connector's grants resolve to. Explicit
  // entries pin both mutations to connector.updated — a walk-up to
  // /api/connectors/:id would otherwise log the mapping DELETE as
  // connector.deleted.
  "/api/connectors/:id/member-overrides": {
    resourceType: "connector",
    action: "connector.updated",
    fetchById: (id, orgId) =>
      KnowledgeBaseConnectorModel.findByIdForAudit(id, orgId),
  },
  "/api/connectors/:id/member-overrides/:externalAccountId": {
    resourceType: "connector",
    action: "connector.updated",
    fetchById: (id, orgId) =>
      KnowledgeBaseConnectorModel.findByIdForAudit(id, orgId),
  },
  // Recomputes who can read every document the connector has ingested, so the
  // operator who forced the pass is an audit-relevant fact. Registered
  // explicitly: a POST resolved by walk-up is dropped, and the parent's
  // create semantics would be wrong anyway — nothing is created.
  "/api/connectors/:id/permission-sync": {
    resourceType: "connector",
    action: "connector.permission_sync_triggered",
    fetchById: (id, orgId) =>
      KnowledgeBaseConnectorModel.findByIdForAudit(id, orgId),
  },

  // GitHub App configs
  "/api/github-app-configs": {
    resourceType: "githubAppConfig",
    fetchById: (id, orgId) => GithubAppConfigModel.findByIdForAudit(id, orgId),
  },
  "/api/github-app-configs/:id": {
    resourceType: "githubAppConfig",
    fetchById: (id, orgId) => GithubAppConfigModel.findByIdForAudit(id, orgId),
  },

  // Stored GitHub personal access tokens
  "/api/github-pats": {
    resourceType: "githubPat",
    fetchById: (id, orgId) => GithubPatModel.findByIdForAudit(id, orgId),
  },
  "/api/github-pats/:id": {
    resourceType: "githubPat",
    fetchById: (id, orgId) => GithubPatModel.findByIdForAudit(id, orgId),
  },

  // Limits
  "/api/limits": {
    resourceType: "limit",
    fetchById: (id, orgId) => LimitModel.findByIdForAudit(id, orgId),
  },
  "/api/limits/:id": {
    resourceType: "limit",
    fetchById: (id, orgId) => LimitModel.findByIdForAudit(id, orgId),
  },

  // Default user limits (per-environment + org-wide)
  "/api/default-user-limits": {
    resourceType: "defaultUserLimit",
    fetchById: (id, orgId) =>
      EnvironmentDefaultUserLimitModel.findByIdForAudit(id, orgId),
  },
  "/api/default-user-limits/:id": {
    resourceType: "defaultUserLimit",
    fetchById: (id, orgId) =>
      EnvironmentDefaultUserLimitModel.findByIdForAudit(id, orgId),
  },

  // Projects. Delete soft-deletes and restore is a project:admin action on
  // another member's project, so both need a trail. The pin and instructions
  // children are denylisted in audit-log-hook.ts rather than registered: they
  // would inherit project.updated/project.deleted by walk-up while changing
  // nothing on the project row (a pin is per-user state; instructions are a
  // file), producing empty diffs under the wrong action.
  "/api/projects": {
    resourceType: "project",
    fetchById: (id, orgId) => ProjectModel.findByIdForAudit(id, orgId),
  },
  // Converting a chat into a project creates one; POST walk-ups are dropped, so
  // it needs its own entry or the create goes unrecorded.
  "/api/projects/from-conversation": {
    resourceType: "project",
    action: "project.created",
    fetchById: (id, orgId) => ProjectModel.findByIdForAudit(id, orgId),
  },
  "/api/projects/:id": {
    resourceType: "project",
    fetchById: (id, orgId) => ProjectModel.findByIdForAudit(id, orgId),
  },
  "/api/projects/:id/restore": {
    resourceType: "project",
    action: "project.restored",
    fetchById: (id, orgId) => ProjectModel.findByIdForAudit(id, orgId),
  },
  // Identity-only, like the other purges — see the agent entry above.
  "/api/projects/:id/permanent": {
    resourceType: "project",
    action: "project.purged",
    fetchById: (id, orgId) => ProjectModel.findIdentityForAudit(id, orgId),
  },
  // Visibility lives in `project_shares`, captured by the project snapshot.
  "/api/projects/:id/share": {
    resourceType: "project",
    action: "project.updated",
    fetchById: (id, orgId) => ProjectModel.findByIdForAudit(id, orgId),
  },

  // Skills
  "/api/skills": {
    resourceType: "skill",
    fetchById: (id, orgId) => SkillModel.findByIdForAudit(id, orgId),
  },
  "/api/skills/:id": {
    resourceType: "skill",
    fetchById: (id, orgId) => SkillModel.findByIdForAudit(id, orgId),
  },
  // Bulk visibility / delete act on a list of skills from the request body, so
  // there is no single resourceId and `fetchById` (which sees route params
  // only) cannot represent the batch. Both handlers set `auditBefore` and
  // `auditAfter` themselves — see buildBulkSkillAuditSnapshot in
  // routes/skill/skill.routes.ts.
  "/api/skills/bulk-visibility": {
    resourceType: "skill",
    action: "skill.bulk_updated",
    resourceIdSource: "organizationContext",
  },
  "/api/skills/bulk-delete": {
    resourceType: "skill",
    action: "skill.bulk_deleted",
    resourceIdSource: "organizationContext",
  },
  // Restore is a POST carrying :id; register it directly so the hook captures
  // the target id and the before/after (deletedAt) snapshots. findByIdForAudit
  // returns soft-deleted rows, so the "before" is the still-deleted skill.
  "/api/skills/:id/restore": {
    resourceType: "skill",
    action: "skill.restored",
    fetchById: (id, orgId) => SkillModel.findByIdForAudit(id, orgId),
  },
  // Identity-only, like the other purges — see the agent entry above.
  "/api/skills/:id/permanent": {
    resourceType: "skill",
    action: "skill.purged",
    fetchById: (id, orgId) => SkillModel.findIdentityForAudit(id, orgId),
  },
  // Reset is a POST carrying :id, so the hook suppresses the parent walk-up.
  // Register it directly to capture the target id and before/after snapshots of
  // this destructive overwrite.
  "/api/skills/:id/reset": {
    resourceType: "skill",
    action: "skill.updated",
    fetchById: (id, orgId) => SkillModel.findByIdForAudit(id, orgId),
  },
  // Enabling skill slash commands patches the org record — audit as org-level change.
  "/api/skills/enable-defaults": {
    resourceType: "organization",
    action: "organization.updated",
    resourceIdSource: "organizationContext",
    fetchById: (id, _orgId) => OrganizationModel.findByIdForAudit(id, _orgId),
  },
  // Bulk import creates multiple skills, so there is no single resourceId and
  // fetchById can't represent the result. The route handler sets
  // `request.auditAfter` with the created list; resourceId stays null.
  "/api/skills/github/import": {
    resourceType: "skill",
    action: "skill.imported",
  },

  // Marketplace share links (bearer capabilities; snapshots are redacted)
  "/api/skill-share-links": {
    resourceType: "skillShareLink",
    action: "skillShareLink.created",
    fetchById: (id, orgId) => SkillShareLinkModel.findByIdForAudit(id, orgId),
  },
  "/api/skill-share-links/:id/rotate": {
    resourceType: "skillShareLink",
    action: "skillShareLink.rotated",
    fetchById: (id, orgId) => SkillShareLinkModel.findByIdForAudit(id, orgId),
  },
  "/api/skill-share-links/:id": {
    resourceType: "skillShareLink",
    action: "skillShareLink.revoked",
    fetchById: (id, orgId) => SkillShareLinkModel.findByIdForAudit(id, orgId),
  },

  // Plugins
  "/api/plugins": {
    resourceType: "plugin",
    fetchById: (id, orgId) => PluginModel.findByIdForAudit(id, orgId),
  },
  "/api/plugins/:id": {
    resourceType: "plugin",
    fetchById: (id, orgId) => PluginModel.findByIdForAudit(id, orgId),
  },
  "/api/plugins/github/import": {
    resourceType: "plugin",
    action: "plugin.created",
    fetchById: (id, orgId) => PluginModel.findByIdForAudit(id, orgId),
  },
  "/api/plugins/github/marketplace/import": {
    resourceType: "plugin",
    action: "plugin.created",
  },
  "/api/plugins/:id/github/apply-update": {
    resourceType: "plugin",
    action: "plugin.updated",
    fetchById: (id, orgId) => PluginModel.findByIdForAudit(id, orgId),
  },
  "/api/plugins/:id/github/preview-update": {
    resourceType: "plugin",
    action: "plugin.updated",
    fetchById: (id, orgId) => PluginModel.findByIdForAudit(id, orgId),
  },
  "/api/plugins/:id/github/sync": {
    resourceType: "plugin",
    action: "plugin.updated",
    fetchById: (id, orgId) => PluginModel.findByIdForAudit(id, orgId),
  },
  "/api/plugins/:id/github/check": {
    resourceType: "plugin",
    action: "plugin.syncTriggered",
  },

  // Scheduled agent triggers (sub-routes resolve via `resolveAuditableRouteConfig`)
  "/api/schedule-triggers": {
    resourceType: "scheduleTrigger",
    fetchById: (id, orgId) => ScheduleTriggerModel.findByIdForAudit(id, orgId),
  },
  "/api/schedule-triggers/:id": {
    resourceType: "scheduleTrigger",
    fetchById: (id, orgId) => ScheduleTriggerModel.findByIdForAudit(id, orgId),
  },

  // Organization (settings, onboarding, knowledge admin actions, members)
  "/api/organization": {
    resourceType: "organization",
    resourceIdSource: "organizationContext",
    fetchById: (id, _orgId) => OrganizationModel.findByIdForAudit(id, _orgId),
  },
  "/api/organization/members/:userId/pending-signup": {
    resourceType: "member",
    resourceIdParam: "userId",
    fetchById: (userId, orgId) =>
      MemberModel.findByUserIdForAudit(userId, orgId),
  },

  // Deployment environments
  "/api/environments": {
    resourceType: "environment",
    fetchById: (id, orgId) => EnvironmentModel.findByIdForAudit(id, orgId),
  },
  "/api/environments/:id": {
    resourceType: "environment",
    fetchById: (id, orgId) => EnvironmentModel.findByIdForAudit(id, orgId),
  },
  // Org-wide setting rather than one environment's row, so the audited
  // resource is the organization and the snapshot is the whole defaults map.
  "/api/environments/defaults": {
    resourceType: "environment",
    action: "environment.updated",
    resourceIdSource: "organizationContext",
    fetchById: (id, orgId) =>
      EnvironmentResourceDefaultModel.findByIdForAudit(id, orgId),
  },
  // Team / org tokens — rotation is semantically distinct from a generic update.
  "/api/tokens/:tokenId/rotate": {
    resourceType: "teamToken",
    action: "teamToken.rotated",
    resourceIdParam: "tokenId",
    fetchById: (id, orgId) => TeamTokenModel.findByIdForAudit(id, orgId),
  },
  "/api/user-tokens/me/rotate": {
    resourceType: "userToken",
    action: "userToken.rotated",
    resourceIdSource: "currentUserPersonalToken",
    fetchById: (id, orgId) => UserTokenModel.findByIdForAudit(id, orgId),
  },

  // The LLM Proxy (organization-scoped singleton; no id in the route)
  "/api/llm-proxy": {
    resourceType: "llmProxy",
    resourceIdSource: "organizationContext",
    fetchById: (orgId) => AgentModel.findOrgLlmProxyForAudit(orgId),
  },

  // LLM virtual keys & OAuth clients
  "/api/llm-virtual-keys": {
    resourceType: "virtualApiKey",
    fetchById: (id, orgId) => VirtualApiKeyModel.findByIdForAudit(id, orgId),
  },
  "/api/llm-virtual-keys/:id": {
    resourceType: "virtualApiKey",
    fetchById: (id, orgId) => VirtualApiKeyModel.findByIdForAudit(id, orgId),
  },

  "/api/llm-oauth-clients": {
    resourceType: "llmOauthClient",
    fetchById: (id, orgId) => LlmOauthClientModel.findByIdForAudit(id, orgId),
  },
  "/api/llm-oauth-clients/:id": {
    resourceType: "llmOauthClient",
    fetchById: (id, orgId) => LlmOauthClientModel.findByIdForAudit(id, orgId),
  },

  "/api/mcp-oauth-clients": {
    resourceType: "mcpOauthClient",
    fetchById: (id, orgId) => McpOauthClientModel.findByIdForAudit(id, orgId),
  },
  "/api/mcp-oauth-clients/:id": {
    resourceType: "mcpOauthClient",
    fetchById: (id, orgId) => McpOauthClientModel.findByIdForAudit(id, orgId),
  },

  // LLM model catalog (admin) — sync has distinct semantics from a generic update.
  "/api/llm-models/sync": {
    resourceType: "llmModel",
    action: "llmModel.synced",
    resourceIdSource: "organizationContext",
    fetchById: (_id, _orgId) => ModelModel.snapshotModelCatalogForAudit(),
  },
  "/api/llm-models/:id": {
    resourceType: "llmModel",
    fetchById: (id, orgId) => ModelModel.findByIdForAudit(id, orgId),
  },

  // Internal catalog
  "/api/internal_mcp_catalog": {
    resourceType: "internalMcpCatalog",
    fetchById: (id, _orgId) =>
      InternalMcpCatalogModel.findByIdForAudit(id, _orgId),
  },
  "/api/internal_mcp_catalog/:id": {
    resourceType: "internalMcpCatalog",
    fetchById: (id, orgId) =>
      InternalMcpCatalogModel.findByIdForAudit(id, orgId),
  },
  "/api/internal_mcp_catalog/by-name/:name": {
    resourceType: "internalMcpCatalog",
    resourceIdParam: "name",
    fetchById: (name, orgId) =>
      InternalMcpCatalogModel.findByNameForAudit(name, orgId),
  },

  // Tools (delete discovered tools)
  "/api/tools/:id": {
    resourceType: "tool",
    fetchById: (id, orgId) => ToolModel.findByIdForAudit(id, orgId),
  },

  // ChatOps
  "/api/chatops/bindings": {
    resourceType: "chatOpsBinding",
    resourceIdSource: "organizationContext",
    fetchById: (_id, orgId) =>
      ChatOpsChannelBindingModel.findBindingsFingerprintForOrganization(orgId),
  },
  "/api/chatops/bindings/assignment-plan": {
    resourceType: "chatOpsBinding",
    action: "chatOpsBinding.updated",
    resourceIdSource: "organizationContext",
    fetchById: (_id, orgId) =>
      ChatOpsChannelBindingModel.findBindingsFingerprintForOrganization(orgId),
  },
  "/api/chatops/bindings/dm": {
    resourceType: "chatOpsBinding",
    fetchById: (id, orgId) =>
      ChatOpsChannelBindingModel.findByIdForAudit(id, orgId),
  },
  "/api/chatops/bindings/:id": {
    resourceType: "chatOpsBinding",
    fetchById: (id, orgId) =>
      ChatOpsChannelBindingModel.findByIdForAudit(id, orgId),
  },
  "/api/chatops/config/ms-teams": {
    resourceType: "chatOpsConfig",
    resourceIdSource: "organizationContext",
    fetchById: (_id, _orgId) =>
      chatOpsConfigModel.getRedactedSnapshotForAudit(),
  },
  "/api/chatops/config/slack": {
    resourceType: "chatOpsConfig",
    resourceIdSource: "organizationContext",
    fetchById: (_id, _orgId) =>
      chatOpsConfigModel.getRedactedSnapshotForAudit(),
  },
  "/api/chatops/config/ngrok": {
    resourceType: "chatOpsConfig",
    resourceIdSource: "organizationContext",
    fetchById: (_id, _orgId) =>
      chatOpsConfigModel.getRedactedSnapshotForAudit(),
  },
  // Channel discovery refresh is semantically distinct from a generic binding update.
  "/api/chatops/channel-discovery/refresh": {
    resourceType: "chatOpsBinding",
    action: "chatOpsBinding.refreshed",
    resourceIdSource: "organizationContext",
    fetchById: (_id, orgId) =>
      ChatOpsChannelBindingModel.findBindingsFingerprintForOrganization(orgId),
  },

  // Autonomy policy bulk defaults (org-scoped tool footprint)
  "/api/tool-invocation/bulk-default": {
    resourceType: "toolInvocationPolicy",
    action: "toolInvocationPolicy.bulk_defaulted",
    resourceIdSource: "organizationContext",
    fetchById: (id, _orgId) =>
      ToolInvocationPolicyModel.findDefaultPoliciesSnapshotForOrganization(id),
  },
  "/api/trusted-data-policies/bulk-default": {
    resourceType: "trustedDataPolicy",
    action: "trustedDataPolicy.bulk_defaulted",
    resourceIdSource: "organizationContext",
    fetchById: (id, _orgId) =>
      TrustedDataPolicyModel.findDefaultPoliciesSnapshotForOrganization(id),
  },

  // Agent tool bulk / auto-policy (assignment counts + default policy maps)
  "/api/agents/tools/bulk-assign": {
    resourceType: "agentTool",
    action: "agentTool.bulk_assigned",
    resourceIdSource: "organizationContext",
    fetchById: (id, _orgId) =>
      AgentToolModel.countAssignmentsForOrganization(id),
  },
  // Deliberately no `fetchById`: the snapshot must be per-agent, and only the
  // handler can derive it (the affected agents come from the request body,
  // which fetchById never sees). Omitting it also leaves `auditBefore` unset by
  // the preHandler, so the handler owns both sides. See
  // buildBulkToolUpdateAuditSnapshot in routes/agent-tool.ts.
  "/api/agents/tools/bulk-update": {
    resourceType: "agentTool",
    action: "agentTool.bulk_updated",
    resourceIdSource: "organizationContext",
  },
  "/api/agent-tools/auto-configure-policies": {
    resourceType: "toolInvocationPolicy",
    action: "toolInvocationPolicy.auto_configured",
    resourceIdSource: "organizationContext",
    fetchById: async (orgId, _orgId) => {
      const [tip, tdp] = await Promise.all([
        ToolInvocationPolicyModel.findDefaultPoliciesSnapshotForOrganization(
          orgId,
        ),
        TrustedDataPolicyModel.findDefaultPoliciesSnapshotForOrganization(
          orgId,
        ),
      ]);
      return { ...tip, ...tdp };
    },
  },

  // Enterprise: team vault folder (same snapshot model as teams)
  // Creating/removing a team's vault folder mutates the team; the team survives
  // the folder DELETE, so pin team.updated (not the derived team.deleted).
  "/api/teams/:teamId/vault-folder": {
    resourceType: "team",
    resourceIdParam: "teamId",
    action: "team.updated",
    fetchById: (id, orgId) => TeamModel.findByIdForAudit(id, orgId),
  },
  // Team membership & external-group mappings live in join tables the team
  // snapshot reflects; the parent team survives member/mapping removal, so pin
  // team.updated on both the POST (add) and the per-child DELETE.
  "/api/teams/:id/members": {
    resourceType: "team",
    action: "team.updated",
    fetchById: (id, orgId) => TeamModel.findByIdForAudit(id, orgId),
  },
  "/api/teams/:id/members/:userId": {
    resourceType: "team",
    action: "team.updated",
    fetchById: (id, orgId) => TeamModel.findByIdForAudit(id, orgId),
  },
  "/api/teams/:id/external-groups": {
    resourceType: "team",
    action: "team.updated",
    fetchById: (id, orgId) => TeamModel.findByIdForAudit(id, orgId),
  },
  "/api/teams/:id/external-groups/:groupId": {
    resourceType: "team",
    action: "team.updated",
    fetchById: (id, orgId) => TeamModel.findByIdForAudit(id, orgId),
  },

  // Refreshing an MCP server's tool surface mutates the server.
  "/api/mcp_server/:id/reload-tools": {
    resourceType: "mcpServer",
    action: "mcpServer.updated",
    fetchById: (id, orgId) => McpServerModel.findByIdForAudit(id, orgId),
  },

  // Internal catalog lifecycle actions (reinstall/refresh/approve/reset) — POSTs
  // carrying :id, so register directly to avoid the parent walk-up being dropped.
  "/api/internal_mcp_catalog/:id/reinstall": {
    resourceType: "internalMcpCatalog",
    action: "internalMcpCatalog.reinstalled",
    fetchById: (id, orgId) =>
      InternalMcpCatalogModel.findByIdForAudit(id, orgId),
  },
  // Catalog restore is a POST carrying :id — register directly (walk-up POSTs
  // are dropped). One catalog-level summary record: the snapshot carries the
  // install/tool counts affected, and `before`/`after` diff on deletedAt (plus
  // the counts the cascade revives).
  "/api/internal_mcp_catalog/:id/restore": {
    resourceType: "internalMcpCatalog",
    action: "internalMcpCatalog.restored",
    fetchById: (id, orgId) =>
      InternalMcpCatalogModel.findByIdForAudit(id, orgId),
  },
  "/api/internal_mcp_catalog/:id/refresh-image": {
    resourceType: "internalMcpCatalog",
    action: "internalMcpCatalog.updated",
    fetchById: (id, orgId) =>
      InternalMcpCatalogModel.findByIdForAudit(id, orgId),
  },
  "/api/internal_mcp_catalog/:id/approve": {
    resourceType: "internalMcpCatalog",
    action: "internalMcpCatalog.updated",
    fetchById: (id, orgId) =>
      InternalMcpCatalogModel.findByIdForAudit(id, orgId),
  },
  "/api/internal_mcp_catalog/:id/reset-deployment-yaml": {
    resourceType: "internalMcpCatalog",
    action: "internalMcpCatalog.updated",
    fetchById: (id, orgId) =>
      InternalMcpCatalogModel.findByIdForAudit(id, orgId),
  },

  // Connector sync/resync + KB-link and document child mutations; the connector
  // survives, so the per-child DELETEs pin connector.updated (not .deleted).
  "/api/connectors/:id/sync": {
    resourceType: "connector",
    action: "connector.synced",
    fetchById: (id, orgId) =>
      KnowledgeBaseConnectorModel.findByIdForAudit(id, orgId),
  },
  "/api/connectors/:id/runs/:runId/cancel": {
    resourceType: "connector",
    action: "connector.updated",
    fetchById: (id, orgId) =>
      KnowledgeBaseConnectorModel.findByIdForAudit(id, orgId),
  },
  "/api/connectors/:id/force-resync": {
    resourceType: "connector",
    action: "connector.updated",
    fetchById: (id, orgId) =>
      KnowledgeBaseConnectorModel.findByIdForAudit(id, orgId),
  },
  "/api/connectors/:id/knowledge-bases": {
    resourceType: "connector",
    action: "connector.updated",
    fetchById: (id, orgId) =>
      KnowledgeBaseConnectorModel.findByIdForAudit(id, orgId),
  },
  "/api/connectors/:id/knowledge-bases/:kbId": {
    resourceType: "connector",
    action: "connector.updated",
    fetchById: (id, orgId) =>
      KnowledgeBaseConnectorModel.findByIdForAudit(id, orgId),
  },
  // A batch of documents is still a mutation of the connector that owns them,
  // exactly as the single-document delete is, so it keeps connector.updated
  // and the connector's own snapshot rather than inventing a document-level
  // resource type for rows that are never audited individually.
  "/api/connectors/:id/documents/bulk": {
    resourceType: "connector",
    action: "connector.updated",
    fetchById: (id, orgId) =>
      KnowledgeBaseConnectorModel.findByIdForAudit(id, orgId),
  },
  "/api/connectors/:id/documents/:docId": {
    resourceType: "connector",
    action: "connector.updated",
    fetchById: (id, orgId) =>
      KnowledgeBaseConnectorModel.findByIdForAudit(id, orgId),
  },

  // Agent import (creates agents in bulk — no single resourceId, like skill
  // import) and clone (creates one agent; its id comes from the response body,
  // so resourceIdParam names a param the route lacks to skip the source :id).
  "/api/agents/import": {
    resourceType: "agent",
    action: "agent.imported",
  },
  "/api/agents/:id/clone": {
    resourceType: "agent",
    action: "agent.created",
    resourceIdParam: "clonedAgentId",
    fetchById: (id, orgId) => AgentModel.findByIdForAudit(id, orgId),
  },

  // Org-scoped admin actions that mutate organization state.
  "/api/organization/knowledge-settings/drop-embedding": {
    resourceType: "organization",
    action: "organization.updated",
    resourceIdSource: "organizationContext",
    fetchById: (id, _orgId) => OrganizationModel.findByIdForAudit(id, _orgId),
  },
  "/api/organization/complete-onboarding": {
    resourceType: "organization",
    action: "organization.updated",
    resourceIdSource: "organizationContext",
    fetchById: (id, _orgId) => OrganizationModel.findByIdForAudit(id, _orgId),
  },

  // Schedule-trigger enable/disable/run-now — POSTs carrying :id.
  "/api/schedule-triggers/:id/enable": {
    resourceType: "scheduleTrigger",
    action: "scheduleTrigger.updated",
    fetchById: (id, orgId) => ScheduleTriggerModel.findByIdForAudit(id, orgId),
  },
  "/api/schedule-triggers/:id/disable": {
    resourceType: "scheduleTrigger",
    action: "scheduleTrigger.updated",
    fetchById: (id, orgId) => ScheduleTriggerModel.findByIdForAudit(id, orgId),
  },
  "/api/schedule-triggers/:id/run-now": {
    resourceType: "scheduleTrigger",
    action: "scheduleTrigger.triggered",
    fetchById: (id, orgId) => ScheduleTriggerModel.findByIdForAudit(id, orgId),
  },

  // OAuth client secret rotation — security-critical.
  "/api/llm-oauth-clients/:id/rotate-secret": {
    resourceType: "llmOauthClient",
    action: "llmOauthClient.rotated",
    fetchById: (id, orgId) => LlmOauthClientModel.findByIdForAudit(id, orgId),
  },
  "/api/mcp-oauth-clients/:id/rotate-secret": {
    resourceType: "mcpOauthClient",
    action: "mcpOauthClient.rotated",
    fetchById: (id, orgId) => McpOauthClientModel.findByIdForAudit(id, orgId),
  },

  // ===== Bulk routes =====
  //
  // `PATCH /api/<resource>/bulk` and `DELETE /api/<resource>/bulk` share one
  // path, so they are told apart by `actionByMethod` rather than by `action`.
  //
  // Every one of them is registered explicitly, for two reasons. Walking up to
  // the parent (`/api/agents`, say) would derive `agent.updated`/`agent.deleted`
  // and lose the fact that a batch is what happened — the one thing an auditor
  // reading a bulk delete most needs to see. And none of them can use
  // `fetchById`: a batch has no single resource id, and the rows it touches are
  // named by the request body, which the fetcher never sees. The handlers set
  // `auditBefore`/`auditAfter` themselves, through `runBulk`'s `audit` option,
  // so one record covers the whole batch on both sides.
  "/api/agents/bulk": {
    resourceType: "agent",
    resourceIdSource: "organizationContext",
    actionByMethod: {
      PATCH: "agent.bulk_updated",
      DELETE: "agent.bulk_deleted",
    },
  },
  "/api/apps/bulk": {
    resourceType: "app",
    resourceIdSource: "organizationContext",
    actionByMethod: { PATCH: "app.bulk_updated", DELETE: "app.bulk_deleted" },
  },
  "/api/projects/bulk": {
    resourceType: "project",
    resourceIdSource: "organizationContext",
    actionByMethod: {
      PATCH: "project.bulk_updated",
      DELETE: "project.bulk_deleted",
    },
  },
  "/api/api-keys/bulk": {
    resourceType: "apiKey",
    resourceIdSource: "organizationContext",
    actionByMethod: { DELETE: "apiKey.bulk_deleted" },
  },
  "/api/service-accounts/bulk": {
    resourceType: "serviceAccount",
    resourceIdSource: "organizationContext",
    actionByMethod: {
      DELETE: "serviceAccount.bulk_deleted",
      PATCH: "serviceAccount.bulk_updated",
    },
  },
  "/api/environments/bulk": {
    resourceType: "environment",
    resourceIdSource: "organizationContext",
    actionByMethod: { DELETE: "environment.bulk_deleted" },
  },
  "/api/roles/bulk": {
    resourceType: "role",
    resourceIdSource: "organizationContext",
    actionByMethod: { DELETE: "role.bulk_deleted" },
  },
  "/api/teams/bulk": {
    resourceType: "team",
    resourceIdSource: "organizationContext",
    actionByMethod: { DELETE: "team.bulk_deleted" },
  },
  "/api/members/bulk": {
    resourceType: "member",
    resourceIdSource: "organizationContext",
    actionByMethod: { DELETE: "member.bulk_deleted" },
    onlyWhenChanged: true,
  },
  "/api/mcp_server/bulk": {
    resourceType: "mcpServer",
    resourceIdSource: "organizationContext",
    actionByMethod: { DELETE: "mcpServer.bulk_deleted" },
  },
  "/api/llm-virtual-keys/bulk": {
    resourceType: "virtualApiKey",
    resourceIdSource: "organizationContext",
    actionByMethod: { DELETE: "virtualApiKey.bulk_deleted" },
  },
  "/api/llm-oauth-clients/bulk": {
    resourceType: "llmOauthClient",
    resourceIdSource: "organizationContext",
    actionByMethod: { DELETE: "llmOauthClient.bulk_deleted" },
  },
  "/api/llm-models/bulk": {
    resourceType: "llmModel",
    resourceIdSource: "organizationContext",
    actionByMethod: { PATCH: "llmModel.bulk_updated" },
  },
  "/api/limits/bulk": {
    resourceType: "limit",
    resourceIdSource: "organizationContext",
    actionByMethod: { DELETE: "limit.bulk_deleted" },
  },
  "/api/llm-provider-api-keys/bulk": {
    resourceType: "llmProviderApiKey",
    resourceIdSource: "organizationContext",
    actionByMethod: { DELETE: "llmProviderApiKey.bulk_deleted" },
  },
  "/api/knowledge-bases/bulk": {
    resourceType: "knowledgeBase",
    resourceIdSource: "organizationContext",
    actionByMethod: { DELETE: "knowledgeBase.bulk_deleted" },
  },
  "/api/connectors/bulk": {
    resourceType: "connector",
    resourceIdSource: "organizationContext",
    actionByMethod: {
      PATCH: "connector.bulk_updated",
      DELETE: "connector.bulk_deleted",
    },
  },
  "/api/knowledge-files/bulk": {
    resourceType: "knowledgeFile",
    resourceIdSource: "organizationContext",
    actionByMethod: {
      PATCH: "knowledgeFile.bulk_updated",
      DELETE: "knowledgeFile.bulk_deleted",
    },
  },
  "/api/knowledge-directories/bulk": {
    resourceType: "knowledgeDirectory",
    resourceIdSource: "organizationContext",
    actionByMethod: {
      PATCH: "knowledgeDirectory.bulk_updated",
      DELETE: "knowledgeDirectory.bulk_deleted",
    },
  },
  "/api/sessions/bulk": {
    resourceType: "auth",
    resourceIdSource: "currentUser",
    action: "auth.sessions_revoked",
  },
};

/**
 * Looks up the auditable route config, falling back to the longest registered
 * prefix so `/api/mcp_server/:id/reinstall` inherits `/api/mcp_server/:id`,
 * `/api/connectors/:id/knowledge-bases` inherits `/api/connectors/:id`, etc.
 *
 * Returns `{ cfg, viaWalkUp }` where `viaWalkUp` is true when the config was
 * inherited from a parent segment.  The hook uses this to suppress POST
 * walk-ups which would mis-attribute child-resource creations to the parent.
 */
export function resolveAuditableRouteConfig(
  routePattern: string | undefined,
): ResolvedAuditableRoute | undefined {
  if (!routePattern) return undefined;
  let p = routePattern;
  let viaWalkUp = false;
  for (;;) {
    const cfg = AUDITABLE_ROUTES[p];
    if (cfg) return { cfg, viaWalkUp };
    const lastSlash = p.lastIndexOf("/");
    if (lastSlash <= 0) return undefined;
    p = p.slice(0, lastSlash);
    viaWalkUp = true;
  }
}

/**
 * Extends `AUDITABLE_ROUTES` with EE-only entries (identity providers).
 * Must be called once at server startup before requests begin, when the
 * enterprise license is active.
 */
export async function initAuditRegistry(): Promise<void> {
  if (!config.enterpriseFeatures.core) return;
  // biome-ignore lint/style/noRestrictedImports: conditional EE import, never runs in OSS builds
  const idpModule = await import("../models/identity-provider.ee");
  const IdentityProviderModel = idpModule.default;
  AUDITABLE_ROUTES["/api/identity-providers"] = {
    resourceType: "identityProvider",
    fetchById: (id, orgId) => IdentityProviderModel.findByIdForAudit(id, orgId),
  };
  AUDITABLE_ROUTES["/api/identity-providers/:id"] = {
    resourceType: "identityProvider",
    fetchById: (id, orgId) => IdentityProviderModel.findByIdForAudit(id, orgId),
  };
}

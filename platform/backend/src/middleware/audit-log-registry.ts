import config from "@/config";
import AgentModel from "@/models/agent";
import AgentToolModel from "@/models/agent-tool";
import ApiKeyModel from "@/models/api-key";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import chatOpsConfigModel from "@/models/chatops-config";
import EnvironmentModel from "@/models/environment";
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
import { type AuditEventName, AuditEventNameSchema } from "@/types/audit-log";

export type AuditResourceIdSource =
  | "organizationContext"
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
  "/api/agents/:id/restore": {
    resourceType: "agent",
    action: "agent.restored",
    fetchById: (id, orgId) => AgentModel.findByIdForAudit(id, orgId),
  },
  "/api/agents/:agentId": {
    resourceType: "agent",
    resourceIdParam: "agentId",
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
  "/api/service-accounts/:id/tokens": {
    resourceType: "serviceAccount",
    resourceIdParam: "id",
    fetchById: (id, orgId) => ServiceAccountModel.findByIdForAudit(id, orgId),
  },
  "/api/service-accounts/:id/tokens/:tokenId": {
    resourceType: "serviceAccount",
    resourceIdParam: "id",
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

  // Limits
  "/api/limits": {
    resourceType: "limit",
    fetchById: (id, orgId) => LimitModel.findByIdForAudit(id, orgId),
  },
  "/api/limits/:id": {
    resourceType: "limit",
    fetchById: (id, orgId) => LimitModel.findByIdForAudit(id, orgId),
  },

  // Optimization Rules
  "/api/optimization-rules": {
    resourceType: "optimizationRule",
    fetchById: (id, orgId) => OptimizationRuleModel.findByIdForAudit(id, orgId),
  },
  "/api/optimization-rules/:id": {
    resourceType: "optimizationRule",
    fetchById: (id, orgId) => OptimizationRuleModel.findByIdForAudit(id, orgId),
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

  // MCP installation requests & internal catalog
  "/api/mcp_server_installation_requests": {
    resourceType: "mcpServerInstallationRequest",
    fetchById: (id, _orgId) =>
      McpServerInstallationRequestModel.findByIdForAudit(id, _orgId),
  },
  "/api/mcp_server_installation_requests/:id": {
    resourceType: "mcpServerInstallationRequest",
    fetchById: (id, orgId) =>
      McpServerInstallationRequestModel.findByIdForAudit(id, orgId),
  },

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
  "/api/teams/:teamId/vault-folder": {
    resourceType: "team",
    resourceIdParam: "teamId",
    fetchById: (id, orgId) => TeamModel.findByIdForAudit(id, orgId),
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

import config from "@/config";
import AgentModel from "@/models/agent";
import AgentToolModel from "@/models/agent-tool";
import ApiKeyModel from "@/models/api-key";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import chatOpsConfigModel from "@/models/chatops-config";
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
import TeamModel from "@/models/team";
import TeamTokenModel from "@/models/team-token";
import ToolModel from "@/models/tool";
import ToolInvocationPolicyModel from "@/models/tool-invocation-policy";
import TrustedDataPolicyModel from "@/models/trusted-data-policy";
import UserTokenModel from "@/models/user-token";
import VirtualApiKeyModel from "@/models/virtual-api-key";

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
  ) => Promise<Record<string, unknown> | null>;
};

/**
 * Maps Fastify parameterized route patterns to their resource type and an
 * optional snapshot fetcher.  The audit preHandler hook uses `fetchById` to
 * capture `prior_state`; the onResponse hook uses it again for `post_state`.
 *
 * Rules:
 * - POST routes (no :id in path) register without `fetchById`; the hook
 *   obtains the id from the response body when needed.
 * - Non-`:id` params use `resourceIdParam` (e.g. `agentId`, `roleId`).
 * - `resolveAuditableRouteConfig` walks up path segments so nested routes
 *   (e.g. `/api/mcp_server/:id/reinstall`) reuse the parent snapshot fetcher.
 * - EE-only routes are added at startup via `initAuditRegistry()`.
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
  "/api/agents/:agentId": {
    resourceType: "agent",
    resourceIdParam: "agentId",
    fetchById: (id, orgId) => AgentModel.findByIdForAudit(id, orgId),
  },

  "/api/agent-tools/:id": {
    resourceType: "agentTool",
    fetchById: (id, orgId) => AgentToolModel.findByIdForAudit(id, orgId),
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

  // Team / org tokens
  "/api/tokens/:tokenId/rotate": {
    resourceType: "teamToken",
    resourceIdParam: "tokenId",
    fetchById: (id, orgId) => TeamTokenModel.findByIdForAudit(id, orgId),
  },

  "/api/user-tokens/me/rotate": {
    resourceType: "userToken",
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

  // LLM model catalog (admin)
  "/api/llm-models/sync": {
    resourceType: "llmModel",
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
  "/api/chatops/channel-discovery/refresh": {
    resourceType: "chatOpsBinding",
    resourceIdSource: "organizationContext",
    fetchById: (_id, orgId) =>
      ChatOpsChannelBindingModel.findBindingsFingerprintForOrganization(orgId),
  },

  // Autonomy policy bulk defaults (org-scoped tool footprint)
  "/api/tool-invocation/bulk-default": {
    resourceType: "toolInvocationPolicy",
    resourceIdSource: "organizationContext",
    fetchById: (id, _orgId) =>
      ToolInvocationPolicyModel.findDefaultPoliciesSnapshotForOrganization(id),
  },
  "/api/trusted-data-policies/bulk-default": {
    resourceType: "trustedDataPolicy",
    resourceIdSource: "organizationContext",
    fetchById: (id, _orgId) =>
      TrustedDataPolicyModel.findDefaultPoliciesSnapshotForOrganization(id),
  },

  // Agent tool bulk / auto-policy (assignment counts + default policy maps)
  "/api/agents/tools/bulk-assign": {
    resourceType: "agentTool",
    resourceIdSource: "organizationContext",
    fetchById: (id, _orgId) =>
      AgentToolModel.countAssignmentsForOrganization(id),
  },
  "/api/agent-tools/auto-configure-policies": {
    resourceType: "toolInvocationPolicy",
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
 */
export function resolveAuditableRouteConfig(
  routePattern: string | undefined,
): AuditableRouteConfig | undefined {
  if (!routePattern) return undefined;
  let p = routePattern;
  for (;;) {
    const cfg = AUDITABLE_ROUTES[p];
    if (cfg) return cfg;
    const lastSlash = p.lastIndexOf("/");
    if (lastSlash <= 0) return undefined;
    p = p.slice(0, lastSlash);
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

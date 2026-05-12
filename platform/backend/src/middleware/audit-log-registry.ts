import config from "@/config";
import AgentModel from "@/models/agent";
import ApiKeyModel from "@/models/api-key";
import KnowledgeBaseModel from "@/models/knowledge-base";
import KnowledgeBaseConnectorModel from "@/models/knowledge-base-connector";
import LimitModel from "@/models/limit";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import McpServerModel from "@/models/mcp-server";
import OptimizationRuleModel from "@/models/optimization-rule";
import TeamModel from "@/models/team";
import ToolInvocationPolicyModel from "@/models/tool-invocation-policy";
import TrustedDataPolicyModel from "@/models/trusted-data-policy";
// OrganizationRoleModel.findByIdForAudit exists but is not wired here because
// the /api/roles/:roleId route uses the :roleId param, not :id.

export type AuditableRouteConfig = {
  resourceType: string;
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
 *   obtains the id from the response body.
 * - Routes whose id param is not `:id` (e.g. `:roleId`) omit `fetchById`
 *   because the hook reads `request.params.id` only.
 * - EE-only routes are added at startup via `initAuditRegistry()`.
 */
export const AUDITABLE_ROUTES: Record<string, AuditableRouteConfig> = {
  // Agents
  "/api/agents": { resourceType: "agent" },
  "/api/agents/:id": {
    resourceType: "agent",
    fetchById: (id, orgId) => AgentModel.findByIdForAudit(id, orgId),
  },

  // MCP Servers
  "/api/mcp_server": { resourceType: "mcpServer" },
  "/api/mcp_server/:id": {
    resourceType: "mcpServer",
    fetchById: (id, orgId) => McpServerModel.findByIdForAudit(id, orgId),
  },

  // Roles — param is :roleId, not :id, so fetchById is not wired here.
  "/api/roles": { resourceType: "role" },
  "/api/roles/:roleId": { resourceType: "role" },

  // Teams
  "/api/teams": { resourceType: "team" },
  "/api/teams/:id": {
    resourceType: "team",
    fetchById: (id, orgId) => TeamModel.findByIdForAudit(id, orgId),
  },

  // API Keys (REDACTED — raw key excluded from snapshot)
  "/api/api-keys": { resourceType: "apiKey" },
  "/api/api-keys/:id": {
    resourceType: "apiKey",
    fetchById: (id, orgId) => ApiKeyModel.findByIdForAudit(id, orgId),
  },

  // LLM Provider API Keys (REDACTED — secretId and key material excluded)
  "/api/llm-provider-api-keys": { resourceType: "llmProviderApiKey" },
  "/api/llm-provider-api-keys/:id": {
    resourceType: "llmProviderApiKey",
    fetchById: (id, orgId) =>
      LlmProviderApiKeyModel.findByIdForAudit(id, orgId),
  },

  // Tool Invocation Policies
  "/api/autonomy-policies/tool-invocation": {
    resourceType: "toolInvocationPolicy",
  },
  "/api/autonomy-policies/tool-invocation/:id": {
    resourceType: "toolInvocationPolicy",
    fetchById: (id, orgId) =>
      ToolInvocationPolicyModel.findByIdForAudit(id, orgId),
  },

  // Trusted Data Policies
  "/api/trusted-data-policies": { resourceType: "trustedDataPolicy" },
  "/api/trusted-data-policies/:id": {
    resourceType: "trustedDataPolicy",
    fetchById: (id, orgId) =>
      TrustedDataPolicyModel.findByIdForAudit(id, orgId),
  },

  // Knowledge Bases
  "/api/knowledge-bases": { resourceType: "knowledgeBase" },
  "/api/knowledge-bases/:id": {
    resourceType: "knowledgeBase",
    fetchById: (id, orgId) => KnowledgeBaseModel.findByIdForAudit(id, orgId),
  },

  // Connectors
  "/api/connectors": { resourceType: "connector" },
  "/api/connectors/:id": {
    resourceType: "connector",
    fetchById: (id, orgId) =>
      KnowledgeBaseConnectorModel.findByIdForAudit(id, orgId),
  },

  // Limits
  "/api/limits": { resourceType: "limit" },
  "/api/limits/:id": {
    resourceType: "limit",
    fetchById: (id, orgId) => LimitModel.findByIdForAudit(id, orgId),
  },

  // Optimization Rules
  "/api/optimization-rules": { resourceType: "optimizationRule" },
  "/api/optimization-rules/:id": {
    resourceType: "optimizationRule",
    fetchById: (id, orgId) => OptimizationRuleModel.findByIdForAudit(id, orgId),
  },
};

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
  };
  AUDITABLE_ROUTES["/api/identity-providers/:id"] = {
    resourceType: "identityProvider",
    fetchById: (id, orgId) => IdentityProviderModel.findByIdForAudit(id, orgId),
  };
}

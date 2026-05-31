import db, { schema } from "@/database";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import KnowledgeBaseConnectorModel from "@/models/knowledge-base-connector";
import LimitModel from "@/models/limit";
import LlmOauthClientModel from "@/models/llm-oauth-client";
import MemberModel from "@/models/member";
import OptimizationRuleModel from "@/models/optimization-rule";
import OrganizationRoleModel from "@/models/organization-role";
import TeamTokenModel from "@/models/team-token";
import ToolModel from "@/models/tool";
import ToolInvocationPolicyModel from "@/models/tool-invocation-policy";
import TrustedDataPolicyModel from "@/models/trusted-data-policy";
import UserTokenModel from "@/models/user-token";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { describe, expect, test } from "@/test";

/**
 * Snapshot-before-authz scope invariant.
 *
 * Contract: every findByIdForAudit (or findByNameForAudit) fetcher referenced
 * from AUDITABLE_ROUTES must return null when called with an id that belongs
 * to a different organization — even when invoked outside any HTTP context.
 *
 * Why this matters: the audit preHandler runs before route authz. An
 * under-scoped fetcher writes another org's data into the caller's audit_logs
 * even when the route handler eventually rejects the request. Adding a new
 * audited model requires adding a case here; a missing null-return is a
 * cross-tenant metadata leak.
 *
 * Models with dedicated isolation test suites in audit-log-snapshot.test.ts
 * (Agent, McpServer, ApiKey, LlmProviderApiKey, Team, KnowledgeBase,
 * ScheduleTrigger, Skill, AgentTool) are covered there and are not duplicated
 * here. InternalMcpCatalog is covered in both files: snapshot.test.ts tests
 * the full org-or-global predicate; this file adds the cross-org null invariant
 * to the shared parametrised suite because InternalMcpCatalog was the specific
 * model identified in the snapshot-before-authz audit.
 */

// biome-ignore lint/suspicious/noExplicitAny: fixture context varies per case
type TestCtx = any;

type ScopeCase = {
  name: string;
  setup: (ctx: TestCtx) => Promise<{ id: string; orgA: string }>;
  fetch: (id: string, orgId: string) => Promise<Record<string, unknown> | null>;
};

const CASES: ScopeCase[] = [
  {
    name: "InternalMcpCatalogModel.findByIdForAudit",
    setup: async ({ makeOrganization, makeInternalMcpCatalog }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const item = await makeInternalMcpCatalog({ organizationId: orgB.id });
      return { id: item.id, orgA: orgA.id };
    },
    fetch: (id, orgId) => InternalMcpCatalogModel.findByIdForAudit(id, orgId),
  },
  {
    name: "InternalMcpCatalogModel.findByNameForAudit",
    setup: async ({ makeOrganization, makeInternalMcpCatalog }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const item = await makeInternalMcpCatalog({
        organizationId: orgB.id,
        name: `scope-test-name-${crypto.randomUUID().slice(0, 8)}`,
      });
      return { id: item.name, orgA: orgA.id };
    },
    fetch: (name, orgId) =>
      InternalMcpCatalogModel.findByNameForAudit(name, orgId),
  },
  {
    name: "OrganizationRoleModel.findByIdForAudit",
    setup: async ({ makeOrganization, makeCustomRole }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const role = await makeCustomRole(orgB.id);
      return { id: role.id, orgA: orgA.id };
    },
    fetch: (id, orgId) => OrganizationRoleModel.findByIdForAudit(id, orgId),
  },
  {
    name: "VirtualApiKeyModel.findByIdForAudit",
    setup: async ({ makeOrganization, makeVirtualApiKey }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const key = await makeVirtualApiKey(orgB.id);
      return { id: key.id, orgA: orgA.id };
    },
    fetch: (id, orgId) => VirtualApiKeyModel.findByIdForAudit(id, orgId),
  },
  {
    name: "KnowledgeBaseConnectorModel.findByIdForAudit",
    setup: async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const kb = await makeKnowledgeBase(orgB.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, orgB.id);
      return { id: connector.id, orgA: orgA.id };
    },
    fetch: (id, orgId) =>
      KnowledgeBaseConnectorModel.findByIdForAudit(id, orgId),
  },
  {
    name: "ChatOpsChannelBindingModel.findByIdForAudit",
    setup: async ({ makeOrganization }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const [binding] = await db
        .insert(schema.chatopsChannelBindingsTable)
        .values({
          organizationId: orgB.id,
          provider: "slack",
          channelId: `C${crypto.randomUUID().slice(0, 10)}`,
          workspaceId: `W${crypto.randomUUID().slice(0, 10)}`,
        })
        .returning();
      return { id: binding.id, orgA: orgA.id };
    },
    fetch: (id, orgId) =>
      ChatOpsChannelBindingModel.findByIdForAudit(id, orgId),
  },
  {
    name: "OptimizationRuleModel.findByIdForAudit",
    setup: async ({ makeOrganization }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const [rule] = await db
        .insert(schema.optimizationRulesTable)
        .values({
          entityType: "organization",
          entityId: orgB.id,
          conditions: [{ maxLength: 1000 }],
          provider: "openai",
          targetModel: "gpt-4o",
          enabled: true,
        })
        .returning();
      return { id: rule.id, orgA: orgA.id };
    },
    fetch: (id, orgId) => OptimizationRuleModel.findByIdForAudit(id, orgId),
  },
  {
    name: "LlmOauthClientModel.findByIdForAudit",
    setup: async ({ makeOrganization }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      // LLM OAuth clients store organizationId in the oauthClientsTable metadata
      // JSON field — the table is shared with Better Auth OAuth clients.
      const id = crypto.randomUUID();
      const clientId = `llm-oauth-${crypto.randomUUID().slice(0, 8)}`;
      await db.insert(schema.oauthClientsTable).values({
        id,
        clientId,
        name: `Test LLM OAuth ${crypto.randomUUID().slice(0, 8)}`,
        redirectUris: ["http://localhost:8005/callback"],
        tokenEndpointAuthMethod: "none",
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        public: true,
        type: "web",
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: { organizationId: orgB.id },
      });
      return { id, orgA: orgA.id };
    },
    fetch: (id, orgId) => LlmOauthClientModel.findByIdForAudit(id, orgId),
  },
  {
    name: "TeamTokenModel.findByIdForAudit",
    setup: async ({ makeOrganization, makeSecret }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const secret = await makeSecret();
      const [token] = await db
        .insert(schema.teamTokensTable)
        .values({
          organizationId: orgB.id,
          teamId: null,
          isOrganizationToken: true,
          name: "Org Token",
          secretId: secret.id,
          tokenStart: "archestra_test",
          createdAt: new Date(),
        })
        .returning();
      return { id: token.id, orgA: orgA.id };
    },
    fetch: (id, orgId) => TeamTokenModel.findByIdForAudit(id, orgId),
  },
  {
    name: "UserTokenModel.findByIdForAudit",
    setup: async ({ makeOrganization, makeAdmin, makeSecret }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const user = await makeAdmin();
      const secret = await makeSecret();
      const [token] = await db
        .insert(schema.userTokensTable)
        .values({
          organizationId: orgB.id,
          userId: user.id,
          secretId: secret.id,
          name: "Personal Token",
          tokenStart: "archestra_test",
          createdAt: new Date(),
        })
        .returning();
      return { id: token.id, orgA: orgA.id };
    },
    fetch: (id, orgId) => UserTokenModel.findByIdForAudit(id, orgId),
  },
  {
    name: "MemberModel.findByUserIdForAudit",
    setup: async ({ makeOrganization, makeAdmin, makeMember }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const user = await makeAdmin();
      await makeMember(user.id, orgB.id);
      // userId belongs to orgB; querying with orgA should return null
      return { id: user.id, orgA: orgA.id };
    },
    fetch: (userId, orgId) => MemberModel.findByUserIdForAudit(userId, orgId),
  },
  // Limit fetcher is scoped via the entity FK (5 branches in entityType:
  // organization | team | agent | user | virtual_key).  One case per branch
  // exercises every arm of the switch in `LimitModel.findByIdForAudit`.
  {
    name: "LimitModel.findByIdForAudit (entityType=organization)",
    setup: async ({ makeOrganization }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const [limit] = await db
        .insert(schema.limitsTable)
        .values({
          entityType: "organization",
          entityId: orgB.id,
          limitType: "token_cost",
          limitValue: 100,
        })
        .returning();
      return { id: limit.id, orgA: orgA.id };
    },
    fetch: (id, orgId) => LimitModel.findByIdForAudit(id, orgId),
  },
  {
    name: "LimitModel.findByIdForAudit (entityType=team)",
    setup: async ({ makeOrganization, makeAdmin, makeTeam }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const owner = await makeAdmin();
      const team = await makeTeam(orgB.id, owner.id);
      const [limit] = await db
        .insert(schema.limitsTable)
        .values({
          entityType: "team",
          entityId: team.id,
          limitType: "token_cost",
          limitValue: 100,
        })
        .returning();
      return { id: limit.id, orgA: orgA.id };
    },
    fetch: (id, orgId) => LimitModel.findByIdForAudit(id, orgId),
  },
  {
    name: "LimitModel.findByIdForAudit (entityType=agent)",
    setup: async ({ makeOrganization, makeAgent }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const agent = await makeAgent({ organizationId: orgB.id });
      const [limit] = await db
        .insert(schema.limitsTable)
        .values({
          entityType: "agent",
          entityId: agent.id,
          limitType: "token_cost",
          limitValue: 100,
        })
        .returning();
      return { id: limit.id, orgA: orgA.id };
    },
    fetch: (id, orgId) => LimitModel.findByIdForAudit(id, orgId),
  },
  {
    name: "LimitModel.findByIdForAudit (entityType=user)",
    setup: async ({ makeOrganization, makeAdmin, makeMember }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const user = await makeAdmin();
      // user is a member of orgB only; orgA must not see this limit
      await makeMember(user.id, orgB.id);
      const [limit] = await db
        .insert(schema.limitsTable)
        .values({
          entityType: "user",
          entityId: user.id,
          limitType: "token_cost",
          limitValue: 100,
        })
        .returning();
      return { id: limit.id, orgA: orgA.id };
    },
    fetch: (id, orgId) => LimitModel.findByIdForAudit(id, orgId),
  },
  {
    name: "LimitModel.findByIdForAudit (entityType=virtual_key)",
    setup: async ({ makeOrganization, makeVirtualApiKey }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const vKey = await makeVirtualApiKey(orgB.id);
      const [limit] = await db
        .insert(schema.limitsTable)
        .values({
          entityType: "virtual_key",
          entityId: vKey.id,
          limitType: "token_cost",
          limitValue: 100,
        })
        .returning();
      return { id: limit.id, orgA: orgA.id };
    },
    fetch: (id, orgId) => LimitModel.findByIdForAudit(id, orgId),
  },
  {
    name: "ToolInvocationPolicyModel.findByIdForAudit",
    setup: async ({
      makeOrganization,
      makeAgent,
      makeTool,
      makeAgentTool,
      makeToolPolicy,
    }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      // Tool is global (tools have no organizationId column); tenancy is
      // resolved through any agent in the org that is assigned the tool.
      const tool = await makeTool();
      const agentB = await makeAgent({ organizationId: orgB.id });
      await makeAgentTool(agentB.id, tool.id);
      const policy = await makeToolPolicy(tool.id);
      return { id: policy.id, orgA: orgA.id };
    },
    fetch: (id, orgId) => ToolInvocationPolicyModel.findByIdForAudit(id, orgId),
  },
  {
    name: "ToolModel.findByIdForAudit",
    setup: async ({ makeOrganization, makeAgent, makeTool, makeAgentTool }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const tool = await makeTool();
      const agentB = await makeAgent({ organizationId: orgB.id });
      await makeAgentTool(agentB.id, tool.id);
      return { id: tool.id, orgA: orgA.id };
    },
    fetch: (id, orgId) => ToolModel.findByIdForAudit(id, orgId),
  },
  {
    name: "TrustedDataPolicyModel.findByIdForAudit",
    setup: async ({
      makeOrganization,
      makeAgent,
      makeTool,
      makeAgentTool,
      makeTrustedDataPolicy,
    }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const tool = await makeTool();
      const agentB = await makeAgent({ organizationId: orgB.id });
      await makeAgentTool(agentB.id, tool.id);
      const policy = await makeTrustedDataPolicy(tool.id);
      return { id: policy.id, orgA: orgA.id };
    },
    fetch: (id, orgId) => TrustedDataPolicyModel.findByIdForAudit(id, orgId),
  },
];

describe("audit snapshot scope invariant — cross-org returns null", () => {
  test.for(
    CASES,
  )("$name returns null when id belongs to a different org", async (caseDef, {
    makeOrganization,
    makeInternalMcpCatalog,
    makeCustomRole,
    makeVirtualApiKey,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeAdmin,
    makeMember,
    makeSecret,
    makeTeam,
    makeAgent,
    makeTool,
    makeAgentTool,
    makeToolPolicy,
    makeTrustedDataPolicy,
  }) => {
    const { id, orgA } = await caseDef.setup({
      makeOrganization,
      makeInternalMcpCatalog,
      makeCustomRole,
      makeVirtualApiKey,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeAdmin,
      makeMember,
      makeSecret,
      makeTeam,
      makeAgent,
      makeTool,
      makeAgentTool,
      makeToolPolicy,
      makeTrustedDataPolicy,
    });
    expect(await caseDef.fetch(id, orgA)).toBeNull();
  });
});

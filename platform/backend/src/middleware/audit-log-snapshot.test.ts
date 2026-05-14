import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import AgentToolModel from "@/models/agent-tool";
import ApiKeyModel from "@/models/api-key";
import KnowledgeBaseModel from "@/models/knowledge-base";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import ScheduleTriggerModel from "@/models/schedule-trigger";
import TeamModel from "@/models/team";
import ToolInvocationPolicyModel from "@/models/tool-invocation-policy";
import TrustedDataPolicyModel from "@/models/trusted-data-policy";
import { describe, expect, test } from "@/test";
import {
  AUDITABLE_ROUTES,
  resolveAuditableRouteConfig,
} from "./audit-log-registry";

describe("audit snapshot redaction", () => {
  describe("ApiKeyModel.findByIdForAudit", () => {
    test("never exposes the raw key field", async ({ makeOrganization }) => {
      const org = await makeOrganization();
      const userId = crypto.randomUUID();
      const rawKey = "ak_secret_should_never_appear";

      await db.insert(schema.usersTable).values({
        id: userId,
        name: "Key Owner",
        email: `${userId}@test.com`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const [row] = await db
        .insert(schema.apikeysTable)
        .values({
          id: crypto.randomUUID(),
          name: "My API Key",
          key: rawKey,
          referenceId: userId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      const snapshot = await ApiKeyModel.findByIdForAudit(row.id, org.id);

      expect(snapshot).not.toBeNull();
      expect(JSON.stringify(snapshot)).not.toContain(rawKey);
      expect(snapshot).toHaveProperty("id", row.id);
      expect(snapshot).toHaveProperty("name", "My API Key");
      expect(snapshot).toHaveProperty("userId", userId);
      expect(snapshot).not.toHaveProperty("key");
    });
  });

  describe("LlmProviderApiKeyModel.findByIdForAudit", () => {
    test("never exposes secretId or key material", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const [row] = await db
        .insert(schema.llmProviderApiKeysTable)
        .values({
          organizationId: org.id,
          name: "OpenAI Key",
          provider: "openai",
          scope: "org",
          baseUrl: null,
        })
        .returning();

      const snapshot = await LlmProviderApiKeyModel.findByIdForAudit(
        row.id,
        org.id,
      );

      expect(snapshot).not.toBeNull();
      expect(snapshot).not.toHaveProperty("secretId");
      expect(snapshot).toHaveProperty("id", row.id);
      expect(snapshot).toHaveProperty("name", "OpenAI Key");
      expect(snapshot).toHaveProperty("provider", "openai");
      expect(snapshot).toHaveProperty("organizationId", org.id);
    });
  });

  // Identity provider redaction tests are in audit-log-snapshot.ee.test.ts
  // (IdentityProviderModel is an EE-only import requiring an .ee.ts file).
});

describe("audit snapshot shape — non-redacted models", () => {
  test("AgentModel.findByIdForAudit returns expected fields", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await AgentModel.create({
      name: "Audit Test Agent",
      organizationId: org.id,
      scope: "org",
      teams: [],
      knowledgeBaseIds: [],
    });

    const snapshot = await AgentModel.findByIdForAudit(agent.id, org.id);

    expect(snapshot).not.toBeNull();
    expect(snapshot).toHaveProperty("id", agent.id);
    expect(snapshot).toHaveProperty("name", "Audit Test Agent");
    expect(snapshot).toHaveProperty("organizationId", org.id);
    expect(snapshot).toHaveProperty("agentType");
    expect(snapshot).toHaveProperty("scope", "org");
    expect(Array.isArray(snapshot?.delegationTargets)).toBe(true);
    expect(typeof snapshot?.createdAt).toBe("string");
    expect(typeof snapshot?.updatedAt).toBe("string");
  });

  test("AgentModel.findByIdForAudit returns null for wrong org", async ({
    makeOrganization,
  }) => {
    const org1 = await makeOrganization();
    const org2 = await makeOrganization();
    const agent = await AgentModel.create({
      name: "Agent",
      organizationId: org1.id,
      scope: "org",
      teams: [],
      knowledgeBaseIds: [],
    });

    const snapshot = await AgentModel.findByIdForAudit(agent.id, org2.id);
    expect(snapshot).toBeNull();
  });

  test("TeamModel.findByIdForAudit returns expected fields", async ({
    makeOrganization,
    makeAdmin,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const admin = await makeAdmin();
    const team = await makeTeam(org.id, admin.id, { name: "Engineering" });

    const snapshot = await TeamModel.findByIdForAudit(team.id, org.id);

    expect(snapshot).not.toBeNull();
    expect(snapshot).toHaveProperty("id", team.id);
    expect(snapshot).toHaveProperty("name", "Engineering");
    expect(snapshot).toHaveProperty("organizationId", org.id);
    expect(typeof snapshot?.createdAt).toBe("string");
  });

  test("TeamModel.findByIdForAudit returns null for wrong org", async ({
    makeOrganization,
    makeAdmin,
    makeTeam,
  }) => {
    const org1 = await makeOrganization();
    const org2 = await makeOrganization();
    const admin = await makeAdmin();
    const team = await makeTeam(org1.id, admin.id);

    const snapshot = await TeamModel.findByIdForAudit(team.id, org2.id);
    expect(snapshot).toBeNull();
  });

  test("KnowledgeBaseModel.findByIdForAudit returns expected fields", async ({
    makeOrganization,
    makeKnowledgeBase,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id, { name: "My KB" });

    const snapshot = await KnowledgeBaseModel.findByIdForAudit(kb.id, org.id);

    expect(snapshot).not.toBeNull();
    expect(snapshot).toHaveProperty("id", kb.id);
    expect(snapshot).toHaveProperty("name", "My KB");
    expect(snapshot).toHaveProperty("organizationId", org.id);
    expect(typeof snapshot?.createdAt).toBe("string");
  });

  test("ToolInvocationPolicyModel.findByIdForAudit includes toolId and action", async ({
    makeOrganization,
    makeTool,
    makeToolPolicy,
  }) => {
    const org = await makeOrganization();
    const tool = await makeTool();
    const policy = await makeToolPolicy(tool.id, { action: "block_always" });

    const snapshot = await ToolInvocationPolicyModel.findByIdForAudit(
      policy.id,
      org.id,
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot).toHaveProperty("id", policy.id);
    expect(snapshot).toHaveProperty("toolId", policy.toolId);
    expect(snapshot).toHaveProperty("action", "block_always");
    expect(typeof snapshot?.createdAt).toBe("string");
  });

  test("TrustedDataPolicyModel.findByIdForAudit includes toolId and action", async ({
    makeOrganization,
    makeTool,
    makeTrustedDataPolicy,
  }) => {
    const org = await makeOrganization();
    const tool = await makeTool();
    const policy = await makeTrustedDataPolicy(tool.id, {});

    const snapshot = await TrustedDataPolicyModel.findByIdForAudit(
      policy.id,
      org.id,
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot).toHaveProperty("id", policy.id);
    expect(snapshot).toHaveProperty("toolId", policy.toolId);
    expect(snapshot).toHaveProperty("action");
    expect(typeof snapshot?.createdAt).toBe("string");
  });

  test("findByIdForAudit returns null for non-existent id", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const fakeId = "00000000-0000-0000-0000-000000000000";

    expect(await AgentModel.findByIdForAudit(fakeId, org.id)).toBeNull();
    expect(await TeamModel.findByIdForAudit(fakeId, org.id)).toBeNull();
    expect(
      await KnowledgeBaseModel.findByIdForAudit(fakeId, org.id),
    ).toBeNull();
  });

  test("ScheduleTriggerModel.findByIdForAudit scopes to organization", async ({
    makeOrganization,
    makeScheduleTrigger,
  }) => {
    const org = await makeOrganization();
    const org2 = await makeOrganization();
    const trigger = await makeScheduleTrigger({
      organizationId: org.id,
      name: "Cron audit label",
    });

    const snap = await ScheduleTriggerModel.findByIdForAudit(
      trigger.id,
      org.id,
    );
    expect(snap).not.toBeNull();
    expect(snap?.name).toBe("Cron audit label");
    expect(snap).toHaveProperty("cronExpression");

    expect(
      await ScheduleTriggerModel.findByIdForAudit(trigger.id, org2.id),
    ).toBeNull();
  });

  test("AgentToolModel.findByIdForAudit scopes to organization", async ({
    makeOrganization,
    makeAgent,
    makeTool,
    makeAgentTool,
  }) => {
    const org = await makeOrganization();
    const org2 = await makeOrganization();
    const agent = await makeAgent({
      name: "Host",
      organizationId: org.id,
      scope: "org",
      teams: [],
      knowledgeBaseIds: [],
    });
    const tool = await makeTool({
      name: `at-audit-${crypto.randomUUID().slice(0, 8)}`,
    });
    const row = await makeAgentTool(agent.id, tool.id);
    if (!row) throw new Error("expected agent tool row");

    const snap = await AgentToolModel.findByIdForAudit(row.id, org.id);
    expect(snap).not.toBeNull();
    expect(snap?.toolName).toBe(tool.name);
    expect(snap?.agentId).toBe(agent.id);

    expect(await AgentToolModel.findByIdForAudit(row.id, org2.id)).toBeNull();
  });
});

describe("AUDITABLE_ROUTES registry", () => {
  test("every :id route has a fetchById function", () => {
    const idRoutes = Object.entries(AUDITABLE_ROUTES).filter(([pattern]) =>
      pattern.endsWith("/:id"),
    );

    for (const [pattern, cfg] of idRoutes) {
      expect(
        cfg.fetchById,
        `route "${pattern}" ends with /:id but has no fetchById`,
      ).toBeDefined();
    }
  });

  test("every route has a non-empty resourceType", () => {
    for (const [pattern, cfg] of Object.entries(AUDITABLE_ROUTES)) {
      expect(
        cfg.resourceType.length,
        `route "${pattern}" has empty resourceType`,
      ).toBeGreaterThan(0);
    }
  });

  test("collection routes include fetchById for POST create post_state snapshots", () => {
    const collectionPatterns = [
      "/api/agents",
      "/api/mcp_server",
      "/api/teams",
      "/api/api-keys",
      "/api/llm-provider-api-keys",
      "/api/autonomy-policies/tool-invocation",
      "/api/trusted-data-policies",
      "/api/knowledge-bases",
      "/api/connectors",
      "/api/limits",
      "/api/optimization-rules",
      "/api/schedule-triggers",
      "/api/roles",
    ];
    for (const pattern of collectionPatterns) {
      expect(
        AUDITABLE_ROUTES[pattern]?.fetchById,
        `route "${pattern}" should expose fetchById for create auditing`,
      ).toBeDefined();
    }
  });
});

describe("resolveAuditableRouteConfig", () => {
  test("inherits auditable config from parent path for MCP server sub-routes", () => {
    const cfg = resolveAuditableRouteConfig("/api/mcp_server/:id/reinstall");
    expect(cfg?.resourceType).toBe("mcpServer");
    expect(typeof cfg?.fetchById).toBe("function");
    expect(typeof AUDITABLE_ROUTES["/api/mcp_server/:id"].fetchById).toBe(
      "function",
    );
  });

  test("inherits config for connector knowledge-base assignment routes", () => {
    const cfg = resolveAuditableRouteConfig(
      "/api/connectors/:id/knowledge-bases",
    );
    expect(cfg?.resourceType).toBe("connector");
    expect(cfg?.fetchById).toBeDefined();
  });
});

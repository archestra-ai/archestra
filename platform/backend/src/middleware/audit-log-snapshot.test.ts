import { vi } from "vitest";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import AgentToolModel from "@/models/agent-tool";
import ApiKeyModel from "@/models/api-key";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import KnowledgeBaseModel from "@/models/knowledge-base";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import McpServerModel from "@/models/mcp-server";
import ScheduleTriggerModel from "@/models/schedule-trigger";
import SkillModel from "@/models/skill";
import TeamModel from "@/models/team";
import ToolInvocationPolicyModel from "@/models/tool-invocation-policy";
import TrustedDataPolicyModel from "@/models/trusted-data-policy";
import { describe, expect, test } from "@/test";
import { AuditEventNameSchema } from "@/types/audit-log";
import { AUDIT_DECISIONS, type AuditableModel } from "./audit-decisions";
import {
  AUDITABLE_ROUTES,
  deriveAction,
  resolveAuditableRouteConfig,
} from "./audit-log-registry";

/**
 * Contract: findByIdForAudit snapshots + AUDITABLE_ROUTES — redaction, org isolation,
 * MCP enrichment flags (hasSecret, sorted name-only keys), registry invariants.
 */

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

      // The INNER JOIN in findByIdForAudit requires the key owner to be a
      // member of the org being queried — add that membership row.
      await db.insert(schema.membersTable).values({
        id: crypto.randomUUID(),
        userId,
        organizationId: org.id,
        role: "member",
        createdAt: new Date(),
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

  describe("ApiKeyModel.findByIdForAudit org isolation", () => {
    test("returns null for an id that belongs to a user in another org (INNER JOIN guard)", async ({
      makeOrganization,
    }) => {
      const ownerOrg = await makeOrganization();
      const intruderOrg = await makeOrganization();

      // Create a user that is a member of ownerOrg only.
      const userId = crypto.randomUUID();
      await db.insert(schema.usersTable).values({
        id: userId,
        name: "Owner",
        email: `${userId}@test.com`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(schema.membersTable).values({
        id: crypto.randomUUID(),
        userId,
        organizationId: ownerOrg.id,
        role: "member",
        createdAt: new Date(),
      });

      const [row] = await db
        .insert(schema.apikeysTable)
        .values({
          id: crypto.randomUUID(),
          name: "Owner Key",
          key: "ak_owner_secret",
          referenceId: userId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      // Lookup with the real id, but from the intruder org — must be null.
      const snapshot = await ApiKeyModel.findByIdForAudit(
        row.id,
        intruderOrg.id,
      );
      expect(snapshot).toBeNull();

      // Owner org sees it normally.
      const ownSnapshot = await ApiKeyModel.findByIdForAudit(
        row.id,
        ownerOrg.id,
      );
      expect(ownSnapshot).not.toBeNull();
      expect(ownSnapshot?.id).toBe(row.id);
    });
  });

  // Identity provider redaction tests are in audit-log-snapshot.ee.test.ts
  // (IdentityProviderModel is an EE-only import requiring an .ee.ts file).
});

describe("McpServerModel.findByIdForAudit — secret/config flags", () => {
  test("envKeys are name-only and sorted; hasSecret false when secretId is null", async ({
    makeOrganization,
    makeMcpServer,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      localConfig: {
        transportType: "stdio",
        command: "node",
        arguments: [],
        environment: [
          {
            key: "ZZ_LAST",
            type: "secret",
            value: "secret-z",
            promptOnInstallation: false,
          },
          {
            key: "AA_FIRST",
            type: "secret",
            value: "secret-a",
            promptOnInstallation: false,
          },
          {
            key: "MM_MID",
            type: "secret",
            value: "secret-m",
            promptOnInstallation: false,
          },
        ],
      },
      oauthConfig: null,
    });

    const server = await makeMcpServer({
      catalogId: catalog.id,
      scope: "org",
    });

    const snapshot = await McpServerModel.findByIdForAudit(server.id, org.id);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.envKeys).toEqual(["AA_FIRST", "MM_MID", "ZZ_LAST"]);

    // No secret values should leak — only names.
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("secret-z");
    expect(serialized).not.toContain("secret-a");
    expect(serialized).not.toContain("secret-m");

    // Boolean flags reflect actual config presence
    expect(snapshot?.hasOauthConfig).toBe(false);
    expect(snapshot?.hasSecret).toBe(false);
  });

  test("hasOauthConfig flips to true when the catalog has an oauthConfig", async ({
    makeOrganization,
    makeMcpServer,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      oauthConfig: {
        name: "Test OAuth",
        server_url: "https://example.com/oauth",
        client_id: "client-id",
        client_secret: "super-secret-oauth",
        authorization_endpoint: "https://example.com/oauth/authorize",
        token_endpoint: "https://example.com/oauth/token",
        redirect_uris: ["https://example.com/callback"],
        scopes: ["openid"],
        default_scopes: ["openid"],
        supports_resource_metadata: false,
      },
    });
    const server = await makeMcpServer({ catalogId: catalog.id, scope: "org" });

    const snapshot = await McpServerModel.findByIdForAudit(server.id, org.id);
    expect(snapshot?.hasOauthConfig).toBe(true);
    // The raw client secret must not appear in the audit snapshot.
    expect(JSON.stringify(snapshot)).not.toContain("super-secret-oauth");
  });

  test("hasSecret is true when the MCP server row references secretId", async ({
    makeOrganization,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const secret = await makeSecret();
    const server = await makeMcpServer({
      catalogId: catalog.id,
      scope: "org",
      secretId: secret.id,
    } as Parameters<typeof makeMcpServer>[0] & { secretId: string });

    const snapshot = await McpServerModel.findByIdForAudit(server.id, org.id);
    expect(snapshot?.hasSecret).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("access_token");
  });

  test("returns null for an MCP server in another organization", async ({
    makeOrganization,
    makeAdmin,
    makeTeam,
    makeMcpServer,
    makeInternalMcpCatalog,
  }) => {
    const org1 = await makeOrganization();
    const org2 = await makeOrganization();
    const admin = await makeAdmin();
    const team = await makeTeam(org1.id, admin.id);
    const catalog = await makeInternalMcpCatalog({ organizationId: org1.id });

    const server = await makeMcpServer({
      catalogId: catalog.id,
      teamId: team.id,
      scope: "team",
    });

    expect(
      await McpServerModel.findByIdForAudit(server.id, org2.id),
    ).toBeNull();
  });

  test("returns null for a teamless server owned by a user from another org", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeMcpServer,
    makeInternalMcpCatalog,
  }) => {
    // Defense-in-depth: `mcp_server` has no `organization_id` column, so
    // teamless personal/org-scoped servers were previously returned
    // unfiltered. Verify owner-via-members is the org boundary now.
    const ownerOrg = await makeOrganization();
    const intruderOrg = await makeOrganization();
    const owner = await makeAdmin();
    await makeMember(owner.id, ownerOrg.id, { role: "admin" });
    const catalog = await makeInternalMcpCatalog({
      organizationId: ownerOrg.id,
    });

    const server = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: owner.id,
      teamId: null,
    });

    // Owner's org sees it.
    const visible = await McpServerModel.findByIdForAudit(
      server.id,
      ownerOrg.id,
    );
    expect(visible).not.toBeNull();
    expect(visible?.id).toBe(server.id);

    // Intruder org must not — owner is not a member of intruderOrg.
    expect(
      await McpServerModel.findByIdForAudit(server.id, intruderOrg.id),
    ).toBeNull();
  });
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
    makeAgent,
    makeAgentTool,
  }) => {
    const org = await makeOrganization();
    const tool = await makeTool();
    const agent = await makeAgent({ organizationId: org.id });
    await makeAgentTool(agent.id, tool.id);
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
    makeAgent,
    makeAgentTool,
  }) => {
    const org = await makeOrganization();
    const tool = await makeTool();
    const agent = await makeAgent({ organizationId: org.id });
    await makeAgentTool(agent.id, tool.id);
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

  test("TrustedDataPolicyModel.findByIdForAudit ignores soft-deleted agent assignments", async ({
    makeOrganization,
    makeTool,
    makeTrustedDataPolicy,
    makeAgent,
    makeAgentTool,
  }) => {
    const org = await makeOrganization();
    const tool = await makeTool();
    const agent = await makeAgent({ organizationId: org.id });
    await makeAgentTool(agent.id, tool.id);
    const policy = await makeTrustedDataPolicy(tool.id, {});
    await AgentModel.delete(agent.id);

    await expect(
      TrustedDataPolicyModel.findByIdForAudit(policy.id, org.id),
    ).resolves.toBeNull();
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

  test("SkillModel.findByIdForAudit returns expected fields and scopes to org", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const org2 = await makeOrganization();

    const [skill] = await db
      .insert(schema.skillsTable)
      .values({
        organizationId: org.id,
        name: "My Test Skill",
        description: "Does things",
        content: "# My Test Skill\nInstructions here.",
        sourceType: "manual",
        latestVersion: 1,
      })
      .returning();

    const snap = await SkillModel.findByIdForAudit(skill.id, org.id);
    expect(snap).not.toBeNull();
    expect(snap).toHaveProperty("id", skill.id);
    expect(snap).toHaveProperty("name", "My Test Skill");
    expect(snap).toHaveProperty("organizationId", org.id);
    expect(snap).toHaveProperty("sourceType", "manual");
    expect(snap?.createdAt).toBeInstanceOf(Date);

    expect(await SkillModel.findByIdForAudit(skill.id, org2.id)).toBeNull();
  });

  test("AgentToolModel.findByAgentAndToolForAudit scopes to organization", async ({
    makeOrganization,
    makeAgent,
    makeTool,
    makeAgentTool,
  }) => {
    const org = await makeOrganization();
    const org2 = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const tool = await makeTool();
    await makeAgentTool(agent.id, tool.id);

    const snap = await AgentToolModel.findByAgentAndToolForAudit(
      agent.id,
      tool.id,
      org.id,
    );
    expect(snap).not.toBeNull();
    expect(snap?.toolId).toBe(tool.id);
    expect(snap?.agentId).toBe(agent.id);

    expect(
      await AgentToolModel.findByAgentAndToolForAudit(
        agent.id,
        tool.id,
        org2.id,
      ),
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

describe("InternalMcpCatalogModel — org-or-global audit scoping", () => {
  test("org-scoped catalog item is visible to its own org", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const snapshot = await InternalMcpCatalogModel.findByIdForAudit(
      catalog.id,
      org.id,
    );
    expect(snapshot).not.toBeNull();
    expect(snapshot?.id).toBe(catalog.id);
    expect(snapshot?.organizationId).toBe(org.id);
  });

  test("org-scoped catalog item is invisible to a different org (snapshot-before-authz fix)", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const ownerOrg = await makeOrganization();
    const intruderOrg = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({
      organizationId: ownerOrg.id,
    });
    const snapshot = await InternalMcpCatalogModel.findByIdForAudit(
      catalog.id,
      intruderOrg.id,
    );
    expect(snapshot).toBeNull();
  });

  test("global catalog item (organizationId=null) is visible to any org", async ({
    makeOrganization,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();

    // Insert a global catalog entry directly — organizationId=null marks it as
    // a platform-wide entry (e.g. the seeded Archestra catalog). scope="org"
    // is the correct value; "global" is not a valid enum member.
    const [global] = await db
      .insert(schema.internalMcpCatalogTable)
      .values({
        id: crypto.randomUUID(),
        name: `global-catalog-${crypto.randomUUID().slice(0, 8)}`,
        serverType: "remote",
        serverUrl: "https://global.example.com/mcp/",
        scope: "org",
        organizationId: null,
        requiresAuth: false,
        multitenant: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    const snapA = await InternalMcpCatalogModel.findByIdForAudit(
      global.id,
      orgA.id,
    );
    const snapB = await InternalMcpCatalogModel.findByIdForAudit(
      global.id,
      orgB.id,
    );

    expect(snapA).not.toBeNull();
    expect(snapA?.id).toBe(global.id);
    expect(snapA?.organizationId).toBeNull();
    expect(snapB).not.toBeNull();
    expect(snapB?.id).toBe(global.id);
  });

  test("findByNameForAudit enforces the same org-or-global predicate", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const ownerOrg = await makeOrganization();
    const intruderOrg = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({
      organizationId: ownerOrg.id,
      name: `unique-audit-name-${crypto.randomUUID().slice(0, 8)}`,
    });

    // Owner sees it by name.
    const own = await InternalMcpCatalogModel.findByNameForAudit(
      catalog.name,
      ownerOrg.id,
    );
    expect(own).not.toBeNull();
    expect(own?.id).toBe(catalog.id);

    // Intruder cannot find it by name.
    const intruder = await InternalMcpCatalogModel.findByNameForAudit(
      catalog.name,
      intruderOrg.id,
    );
    expect(intruder).toBeNull();
  });

  test("returns null for a non-existent id", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    const fakeId = "00000000-0000-0000-0000-000000000000";
    expect(
      await InternalMcpCatalogModel.findByIdForAudit(fakeId, org.id),
    ).toBeNull();
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
      "/api/skills",
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
    const resolved = resolveAuditableRouteConfig(
      "/api/mcp_server/:id/reinstall",
    );
    expect(resolved?.cfg.resourceType).toBe("mcpServer");
    expect(typeof resolved?.cfg.fetchById).toBe("function");
    expect(typeof AUDITABLE_ROUTES["/api/mcp_server/:id"].fetchById).toBe(
      "function",
    );
  });

  test("inherits config for connector knowledge-base assignment routes", () => {
    const resolved = resolveAuditableRouteConfig(
      "/api/connectors/:id/knowledge-bases",
    );
    expect(resolved?.cfg.resourceType).toBe("connector");
    expect(resolved?.cfg.fetchById).toBeDefined();
  });
});

describe("AUDIT_DECISIONS — compile-time + runtime invariants", () => {
  test("every table in schema appears in AUDIT_DECISIONS (compile-time enforced by `satisfies`)", () => {
    // The `satisfies` clause in audit-decisions.ts is the primary guard.
    // This test is a runtime smoke check that fails loudly if the satisfies
    // clause is deleted or if the schema gains a table that wasn't covered.
    const schemaKeys = Object.keys(schema).sort();
    const decisionKeys = Object.keys(AUDIT_DECISIONS).sort();
    expect(decisionKeys).toEqual(schemaKeys);
  });

  test("every audited:true table has a model with findByIdForAudit", () => {
    for (const [name, decision] of Object.entries(AUDIT_DECISIONS)) {
      if (decision.audited) {
        expect(
          typeof decision.model.findByIdForAudit,
          `${name}.model.findByIdForAudit must be a function`,
        ).toBe("function");
      }
    }
  });

  test("every audited:true table has at least one route in AUDITABLE_ROUTES that references its model", async () => {
    // Closes the gap the satisfies-clause alone cannot catch: a table can be
    // marked audited:true but have no entry in AUDITABLE_ROUTES.
    // We check this by spying on all static methods of the model and calling
    // each route's fetchById function to see if any model method is invoked.
    for (const [name, decision] of Object.entries(AUDIT_DECISIONS)) {
      if (!decision.audited) continue;
      const model = (decision as { audited: true; model: AuditableModel })
        .model;

      const methodNames = Object.getOwnPropertyNames(model).filter(
        // biome-ignore lint/suspicious/noExplicitAny: test instrumentation
        (prop) => typeof (model as any)[prop] === "function",
      );

      const spies = methodNames.map((methodName) =>
        vi
          // biome-ignore lint/suspicious/noExplicitAny: test instrumentation
          .spyOn(model as any, methodName)
          .mockImplementation(() => Promise.resolve(null)),
      );

      let found = false;
      for (const cfg of Object.values(AUDITABLE_ROUTES)) {
        if (!cfg.fetchById) continue;

        for (const spy of spies) spy.mockClear();

        try {
          await cfg.fetchById("fake-id", "fake-org");
        } catch {
          // Ignore errors
        }

        if (spies.some((spy) => spy.mock.calls.length > 0)) {
          found = true;
          break;
        }
      }

      for (const spy of spies) spy.mockRestore();

      expect(
        found,
        `Table "${name}" is audited:true but no route in AUDITABLE_ROUTES references its model. ` +
          "Either add a route entry with fetchById pointing at the model, " +
          "or change the decision to audited:false with a reason.",
      ).toBe(true);
    }
  });

  test("every audited:false table has a non-empty reason", () => {
    for (const [name, decision] of Object.entries(AUDIT_DECISIONS)) {
      if (!decision.audited) {
        expect(
          decision.reason.length,
          `${name}.reason must be a non-empty string`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("AUDITABLE_ROUTES vocabulary completeness", () => {
  test("every AUDITABLE_ROUTES entry resolves to a known AuditEventName for each HTTP verb", () => {
    // Verifies that hard-coded action overrides and method-derived actions
    // are all members of the closed AuditEventNameSchema enum. This catches
    // typos in action strings and enum drift when names are renamed.
    const methods = ["POST", "PUT", "PATCH", "DELETE"] as const;

    for (const [pattern, cfg] of Object.entries(AUDITABLE_ROUTES)) {
      // Hard-coded action wins — validate it directly.
      if (cfg.action !== undefined) {
        expect(
          AuditEventNameSchema.safeParse(cfg.action).success,
          `Route ${pattern}: hard-coded action "${cfg.action}" is not in AuditEventNameSchema`,
        ).toBe(true);
      }

      // Per-method overrides — validate each present entry.
      if (cfg.actionByMethod) {
        for (const [method, action] of Object.entries(cfg.actionByMethod)) {
          if (action !== undefined) {
            expect(
              AuditEventNameSchema.safeParse(action).success,
              `Route ${pattern} (${method}): actionByMethod "${action}" is not in AuditEventNameSchema`,
            ).toBe(true);
          }
        }
      }

      // Method-derived fallback — only validate when deriveAction returns a
      // non-null candidate (resource type maps to a known verb).
      for (const method of methods) {
        if (cfg.action !== undefined) continue;
        if (cfg.actionByMethod?.[method] !== undefined) continue;
        const derived = deriveAction(cfg.resourceType, method);
        if (derived === null) continue;
        expect(
          AuditEventNameSchema.safeParse(derived).success,
          `Route ${pattern} (${method}): derived action "${derived}" is not in AuditEventNameSchema`,
        ).toBe(true);
      }
    }
  });
});

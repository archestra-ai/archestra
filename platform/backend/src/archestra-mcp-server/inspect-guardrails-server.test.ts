import {
  ARCHESTRA_MCP_CATALOG_ID,
  BUILT_IN_AGENT_IDS,
  BUILT_IN_AGENT_NAMES,
  getArchestraToolFullName,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import {
  AgentExcludedToolModel,
  ConversationEnabledToolModel,
  EnvironmentModel,
  InternalMcpCatalogModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { seedCoverage } from "@/test/openappa-coverage";
import { ApiError } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const toolName = getArchestraToolFullName("inspect_guardrails_server");
const originalEnabled = config.openappa.enabled;
let context: ArchestraContext;
let catalogId: string;
let environmentId: string;

async function inspect(ctx = context, id = catalogId) {
  return executeArchestraTool(toolName, { mcpServerId: id }, ctx);
}

async function expectDenied(ctx: ArchestraContext, id = catalogId) {
  // Admission returns tool errors; handler authorization throws ApiError.
  const outcome = await inspect(ctx, id).catch((error: unknown) => error);
  expect(outcome).toSatisfy(
    (value: unknown) =>
      (value instanceof ApiError &&
        [401, 403, 404].includes(value.statusCode)) ||
      (typeof value === "object" &&
        value !== null &&
        "isError" in value &&
        value.isError === true &&
        /permission|context|not assigned|not found|access|authorized|requires an acting user/i.test(
          JSON.stringify(value),
        )),
  );
}

beforeEach(
  async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    seedAndAssignArchestraTools,
  }) => {
    config.openappa.enabled = true;
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "admin" });
    const agent = await makeAgent({
      agentType: "agent",
      organizationId: organization.id,
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
    });
    await seedAndAssignArchestraTools(agent.id);
    context = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      userId: user.id,
      organizationId: organization.id,
    };
    const environment = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "Production",
    });
    environmentId = environment.id;
    const catalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
      environmentId,
      name: "Inspection target",
    });
    catalogId = catalog.id;
  },
);

afterEach(() => {
  config.openappa.enabled = originalEnabled;
});

describe("inspect_guardrails_server", () => {
  test("reads complete cross-environment metadata and coverage without a matching battery; ordinary inspection stays fenced", async ({
    makeTool,
  }) => {
    for (let index = 0; index < 55; index++) {
      await makeTool({
        catalogId,
        name: `inspection__read_${index}`,
        description: "Stored description",
        parameters: { type: "object", properties: { id: { type: "string" } } },
        meta: { privateMetadata: "must-not-return" },
      });
    }
    const result = await inspect();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      scope: "organization",
      mcpServer: { id: catalogId, name: "Inspection target", environmentId },
      tools: expect.arrayContaining([
        expect.objectContaining({
          name: "inspection__read_54",
          description: "Stored description",
          parameters: expect.objectContaining({ type: "object" }),
        }),
      ]),
      coverage: expect.arrayContaining([
        expect.objectContaining({
          fullName: "inspection__read_54",
          rule: null,
          unlisted: true,
        }),
      ]),
    });
    expect(result.structuredContent?.tools).toHaveLength(55);
    expect(result.structuredContent?.coverage).toHaveLength(55);
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).not.toContain("must-not-return");
    expect(serialized).not.toContain("assignedAgents");
    expect(result.structuredContent).not.toHaveProperty("servers");
    const ordinary = await executeArchestraTool(
      getArchestraToolFullName("get_mcp_server_tools"),
      { mcpServerId: catalogId },
      context,
    );
    expect(ordinary.isError).toBe(true);
  });

  test("includes current declared-battery and selector rules, without unrelated catalog metadata", async ({
    makeInternalMcpCatalog,
    makeTool,
    makeAgent,
    makeAgentTool,
  }) => {
    const fixture = await seedCoverage({
      organizationId: context.organizationId as string,
      userId: context.userId as string,
      fixtures: {
        makeInternalMcpCatalog,
        makeTool,
        makeAgent,
        makeAgentTool,
      },
    });
    await InternalMcpCatalogModel.update(fixture.catalogIds.docs, {
      environmentId,
    });
    const result = await inspect(context, fixture.catalogIds.docs);
    expect(result.structuredContent).toMatchObject({
      coverage: expect.arrayContaining([
        expect.objectContaining({
          policySource: "battery",
          rule: expect.objectContaining({
            source: "battery",
            battery: "microsoft-learn",
          }),
        }),
        expect.objectContaining({
          rule: expect.objectContaining({
            source: "root",
            selector: expect.any(String),
          }),
        }),
      ]),
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      fixture.catalogIds.acme,
    );
  });

  test("does not grant other agents cross-environment access through copied names, assignments or Auto mode", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
    seedAndAssignArchestraTools,
  }) => {
    const target = await makeTool({ catalogId, name: "target__read" });
    for (const overrides of [
      { name: BUILT_IN_AGENT_NAMES.OPENAPPA_CONFIG },
      { name: BUILT_IN_AGENT_NAMES.OPENAPPA_CONFIG, accessAllTools: true },
      { builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.ADVISOR } },
    ]) {
      const agent = await makeAgent({
        agentType: "agent",
        organizationId: context.organizationId,
        ...overrides,
      });
      if (!agent.accessAllTools) await seedAndAssignArchestraTools(agent.id);
      await makeAgentTool(agent.id, target.id);
      await expectDenied({
        ...context,
        agent: { id: agent.id, name: BUILT_IN_AGENT_NAMES.OPENAPPA_CONFIG },
        agentId: agent.id,
      });
    }
  });

  test("ordinary agents, gateways and other built-ins see assigned tools without catalog siblings", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
    seedAndAssignArchestraTools,
  }) => {
    const allowed = await makeTool({ catalogId, name: "partial__allowed" });
    const sibling = await makeTool({ catalogId, name: "partial__hidden" });
    for (const overrides of [
      {
        agentType: "agent" as const,
        name: BUILT_IN_AGENT_NAMES.OPENAPPA_CONFIG,
      },
      { agentType: "mcp_gateway" as const },
      {
        agentType: "agent" as const,
        builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.ADVISOR },
      },
    ]) {
      const agent = await makeAgent({
        organizationId: context.organizationId,
        environmentId,
        ...overrides,
      });
      await seedAndAssignArchestraTools(agent.id);
      await makeAgentTool(agent.id, allowed.id);
      const response = await inspect({
        ...context,
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
      });
      expect(response.structuredContent).toMatchObject({
        scope: "agent",
        tools: [{ id: allowed.id }],
        coverage: [{ toolId: allowed.id }],
      });
      expect(JSON.stringify(response.structuredContent)).not.toContain(
        sibling.id,
      );
      expect(JSON.stringify(response.structuredContent)).not.toContain(
        sibling.name,
      );
    }
  });

  test("Auto discovery applies exclusions to both metadata and coverage and denies an empty reachable catalog", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
  }) => {
    const allowed = await makeTool({ catalogId, name: "auto__allowed" });
    const excluded = await makeTool({ catalogId, name: "auto__excluded" });
    const agent = await makeAgent({
      organizationId: context.organizationId,
      agentType: "agent",
      environmentId,
      accessAllTools: true,
    });
    await makeAgentTool(agent.id, excluded.id);
    await AgentExcludedToolModel.replaceForAgent(agent.id, [excluded.id]);
    const ctx = {
      ...context,
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
    };
    const response = await inspect(ctx);
    expect(response.structuredContent).toMatchObject({
      scope: "agent",
      tools: [{ id: allowed.id }],
      coverage: [{ toolId: allowed.id }],
    });
    expect(JSON.stringify(response.structuredContent)).not.toContain(
      excluded.name,
    );
    await AgentExcludedToolModel.replaceForAgent(agent.id, [
      excluded.id,
      allowed.id,
    ]);
    await expectDenied(ctx);
  });

  test("resolves duplicate names globally, with assignments winning over Auto discovery", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
    makeInternalMcpCatalog,
  }) => {
    const original = await makeTool({ catalogId, name: "duplicate__read" });
    const otherCatalog = await makeInternalMcpCatalog({
      organizationId: context.organizationId,
      environmentId,
    });
    const [newer] = await db
      .insert(schema.toolsTable)
      .values({
        catalogId: otherCatalog.id,
        name: original.name,
        rawName: "read",
        parameters: {},
        description: "Other metadata",
        createdAt: new Date(Date.now() + 1000),
      })
      .returning();
    const agent = await makeAgent({
      organizationId: context.organizationId,
      agentType: "agent",
      environmentId,
      accessAllTools: true,
    });
    // Enable the new built-in inspection tool, which Auto creation pre-excludes.
    await AgentExcludedToolModel.replaceForAgent(agent.id, []);
    const ctx = {
      ...context,
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
    };
    await expectDenied(ctx);
    expect(
      (await inspect(ctx, otherCatalog.id)).structuredContent,
    ).toMatchObject({
      tools: [{ id: newer.id }],
      coverage: [{ toolId: newer.id }],
    });
    await makeAgentTool(agent.id, original.id);
    expect((await inspect(ctx)).structuredContent).toMatchObject({
      tools: [{ id: original.id }],
      coverage: [{ toolId: original.id }],
    });
    await expectDenied(ctx, otherCatalog.id);
  });

  test("respects conversation selections and retired pinned installations for ordinary callers", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
    makeConversation,
    makeMcpServer,
    seedAndAssignArchestraTools,
  }) => {
    const allowed = await makeTool({ catalogId, name: "selected__allowed" });
    const disabled = await makeTool({ catalogId, name: "selected__disabled" });
    const retired = await makeTool({ catalogId, name: "selected__retired" });
    const agent = await makeAgent({
      organizationId: context.organizationId,
      agentType: "agent",
      environmentId,
    });
    await seedAndAssignArchestraTools(agent.id);
    await makeAgentTool(agent.id, allowed.id);
    await makeAgentTool(agent.id, disabled.id);
    const install = await makeMcpServer({ catalogId });
    await makeAgentTool(agent.id, retired.id, { mcpServerId: install.id });
    await db
      .update(schema.mcpServersTable)
      .set({ deletedAt: new Date() })
      .where(eq(schema.mcpServersTable.id, install.id));
    const conversation = await makeConversation(agent.id, {
      userId: context.userId,
      organizationId: context.organizationId,
    });
    await ConversationEnabledToolModel.setEnabledTools(conversation.id, [
      allowed.id,
      retired.id,
    ]);
    const ctx = {
      ...context,
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      conversationId: conversation.id,
    };
    expect((await inspect(ctx)).structuredContent).toMatchObject({
      tools: [{ id: allowed.id }],
      coverage: [{ toolId: allowed.id }],
    });
    await ConversationEnabledToolModel.setEnabledTools(conversation.id, []);
    await expectDenied(ctx);
  });

  test("ordinary inspection applies per-tool RBAC to built-in catalog metadata and coverage", async ({
    makeAgent,
    makeCustomRole,
    makeUser,
    makeMember,
    seedAndAssignArchestraTools,
  }) => {
    const viewer = await makeUser();
    const role = await makeCustomRole(context.organizationId as string, {
      permission: { toolPolicy: ["read"], mcpRegistry: ["read"] },
    });
    await makeMember(viewer.id, context.organizationId as string, {
      role: role.role,
    });
    const agent = await makeAgent({
      organizationId: context.organizationId,
      agentType: "agent",
    });
    await seedAndAssignArchestraTools(agent.id);
    const response = await inspect(
      {
        ...context,
        userId: viewer.id,
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
      },
      ARCHESTRA_MCP_CATALOG_ID,
    );
    expect(response.structuredContent).toMatchObject({
      scope: "agent",
      tools: expect.arrayContaining([
        expect.objectContaining({ name: toolName }),
      ]),
    });
    expect(response.structuredContent?.tools).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: getArchestraToolFullName("create_agent"),
        }),
      ]),
    );
    expect(response.structuredContent?.coverage).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fullName: getArchestraToolFullName("create_agent"),
        }),
      ]),
    );
  });

  test("denies missing, deleted, foreign and inconsistent persisted caller identities", async ({
    makeOrganization,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const otherOrganization = await makeOrganization();
    const foreign = await makeAgent({
      agentType: "agent",
      organizationId: otherOrganization.id,
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
    });
    await seedAndAssignArchestraTools(foreign.id);
    await expectDenied({
      ...context,
      agent: { id: foreign.id, name: "Configuration" },
      agentId: foreign.id,
    });
    await expectDenied({ ...context, agentId: foreign.id });
    await expectDenied({
      ...context,
      agent: { id: crypto.randomUUID(), name: "Configuration" },
      agentId: undefined,
    });
    await db
      .update(schema.agentsTable)
      .set({ deletedAt: new Date() })
      .where(eq(schema.agentsTable.id, context.agent.id));
    await expectDenied(context);
  });

  test("requires policy read and context even when catalog read is granted", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const role = await makeCustomRole(context.organizationId as string, {
      permission: { mcpRegistry: ["read"] },
    });
    await makeMember(user.id, context.organizationId as string, {
      role: role.role,
    });
    await expectDenied({ ...context, userId: user.id });
    await expectDenied({ ...context, userId: undefined });
    await expectDenied({ ...context, organizationId: undefined });
  });

  test("requires exact catalog read, permits a scoped reader and rejects foreign catalogs", async ({
    makeUser,
    makeMember,
    makeCustomRole,
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const viewer = await makeUser();
    const owner = await makeUser();
    const role = await makeCustomRole(context.organizationId as string, {
      permission: { toolPolicy: ["read"] },
    });
    await makeMember(viewer.id, context.organizationId as string, {
      role: role.role,
    });
    await makeMember(owner.id, context.organizationId as string, {
      role: "member",
    });
    const viewerContext = { ...context, userId: viewer.id };
    const sharedCatalog = await makeInternalMcpCatalog({
      organizationId: context.organizationId,
      environmentId,
      access: { users: [viewer.id], preset: "view" },
    });
    expect(
      (await inspect(viewerContext, sharedCatalog.id)).isError,
    ).toBeFalsy();
    const privateCatalog = await makeInternalMcpCatalog({
      organizationId: context.organizationId,
      authorId: owner.id,
      access: "personal",
      environmentId,
    });
    await expectDenied(viewerContext, privateCatalog.id);
    const foreignOrganization = await makeOrganization();
    const foreignCatalog = await makeInternalMcpCatalog({
      organizationId: foreignOrganization.id,
    });
    await expectDenied(context, foreignCatalog.id);
  });

  test("does not exist when OpenAPPA is disabled", async () => {
    config.openappa.enabled = false;
    await expect(inspect()).rejects.toMatchObject({ code: -32601 });
  });
});

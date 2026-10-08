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
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { seedCoverage } from "@/test/openappa-coverage";
import { ApiError } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const toolName = getArchestraToolFullName("inspect_guardrails_server");
const originalEnabled = config.openappa.enabled;
let context: ArchestraContext;
let catalogId: string;
let environmentId: string;

async function inspect(
  ctx = context,
  id = catalogId,
  options: {
    detail?: "summary" | "full";
    tools?: string[];
    offset?: number;
  } = {},
) {
  return executeArchestraTool(toolName, { mcpServerId: id, ...options }, ctx);
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
  test("summarizes cross-environment tools and coverage without a matching battery; ordinary inspection stays fenced", async ({
    makeTool,
  }) => {
    for (let index = 0; index < 55; index++) {
      await makeTool({
        catalogId,
        name: `inspection__read_${index}`,
        description: "Reads one record. Long details follow here.",
        parameters: { type: "object", properties: { id: { type: "string" } } },
        meta: { privateMetadata: "must-not-return" },
      });
    }
    const result = await inspect();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      scope: "organization",
      mcpServer: { id: catalogId, name: "Inspection target", environmentId },
      total: 55,
      offset: 0,
      nextOffset: null,
      tools: expect.arrayContaining([
        {
          id: expect.any(String),
          name: "inspection__read_54",
          readOnly: null,
          kind: "unlisted",
          description: "Reads one record.",
          rules: [
            {
              kind: "unlisted",
              policySource: "not_covered",
              rule: expect.objectContaining({ source: "catchall", name: "*" }),
            },
          ],
        },
      ]),
    });
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).not.toContain("must-not-return");
    expect(serialized).not.toContain("parameters");
    expect(serialized).not.toContain("assignedAgents");
    expect(result.structuredContent).not.toHaveProperty("servers");
    const ordinary = await executeArchestraTool(
      getArchestraToolFullName("get_mcp_server_tools"),
      { mcpServerId: catalogId },
      context,
    );
    expect(ordinary.isError).toBe(true);
  });

  test("full detail of named tools carries schemas and rule details", async ({
    makeTool,
  }) => {
    await makeTool({
      catalogId,
      name: "named__wanted",
      description: "First. Second.",
      parameters: { type: "object", properties: { id: { type: "string" } } },
    });
    await makeTool({ catalogId, name: "named__other" });
    const result = await inspect(context, catalogId, {
      detail: "full",
      tools: ["wanted"],
    });
    expect(result.structuredContent).toMatchObject({
      total: 1,
      nextOffset: null,
      tools: [
        {
          name: "named__wanted",
          description: "First. Second.",
          parameters: { type: "object" },
          rules: [
            {
              rule: expect.objectContaining({
                source: "catchall",
                annotator: "noop",
                delta: {},
              }),
            },
          ],
        },
      ],
    });
  });

  test("pages rows that exceed the result budget until nextOffset is null", async ({
    makeTool,
  }) => {
    const names: string[] = [];
    for (let index = 0; index < 30; index++) {
      const name = `paged__tool_${index}`;
      names.push(name);
      await makeTool({
        catalogId,
        name,
        parameters: { type: "object", description: `"ж"\n`.repeat(1000) },
      });
    }
    const seen: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      const { structuredContent } = await inspect(context, catalogId, {
        detail: "full",
        offset,
      });
      const page = structuredContent as {
        tools: { name: string }[];
        nextOffset: number | null;
      };
      expect(
        Buffer.byteLength(JSON.stringify(JSON.stringify(page)), "utf8"),
      ).toBeLessThan(64 * 1024);
      seen.push(...page.tools.map((tool) => tool.name));
      offset = page.nextOffset;
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual([...names].sort());
  });

  test("a tool too large for one result comes back as its summary", async ({
    makeTool,
  }) => {
    await makeTool({
      catalogId,
      name: "huge__schema",
      description: "Huge. Schema.",
      parameters: { type: "object", description: "x".repeat(100_000) },
    });
    const { structuredContent } = await inspect(context, catalogId, {
      detail: "full",
    });
    expect(structuredContent).toMatchObject({
      nextOffset: null,
      tools: [
        {
          name: "huge__schema",
          description: "Huge.",
          fullDetail: expect.any(String),
        },
      ],
    });
    expect(JSON.stringify(structuredContent)).not.toContain("xxxx");
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
    const tools = (
      result.structuredContent as {
        tools: {
          kind: string | null;
          rules: { kind: string; rule: { selector: string | null } | null }[];
        }[];
      }
    ).tools;
    for (const tool of tools)
      expect(tool.kind).toBe(
        (tool.rules.find((row) => !row.rule?.selector) ?? tool.rules[0])
          ?.kind ?? null,
      );
    const rules = tools.flatMap((tool) => tool.rules);
    expect(rules).toEqual(
      expect.arrayContaining([
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
    );
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      fixture.catalogIds.acme,
    );
  });

  test("judges app catalog tools by the root rule that names them, or the catch-all", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = context.organizationId as string;
    const app = await makeInternalMcpCatalog({
      organizationId,
      environmentId,
      serverType: "app",
      name: "Clock App",
    });
    await makeTool({ catalogId: app.id, name: "clock_app__open" });
    await makeTool({ catalogId: app.id, name: "clock_app__tick" });
    const current = await guardrailsPolicyService.get(organizationId);
    await guardrailsPolicyService.update({
      organizationId,
      userId: context.userId as string,
      content: `${current.content}\n[[policy.tool]]\nname = "clock_app__open"\ndelta = {}\n`,
      expectedRevision: current.revision,
    });
    const result = await inspect(context, app.id);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      total: 2,
      tools: [
        {
          name: "clock_app__open",
          kind: "neutral",
          rules: [
            {
              policySource: "root",
              rule: expect.objectContaining({
                source: "root",
                name: "clock_app__open",
              }),
            },
          ],
        },
        {
          name: "clock_app__tick",
          kind: "unlisted",
          rules: [
            {
              policySource: "not_covered",
              rule: expect.objectContaining({ source: "catchall", name: "*" }),
            },
          ],
        },
      ],
    });
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
    });
    await makeAgentTool(agent.id, original.id);
    expect((await inspect(ctx)).structuredContent).toMatchObject({
      tools: [{ id: original.id }],
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
      permission: { openappaPolicy: ["read"], mcpRegistry: ["read"] },
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
      permission: { openappaPolicy: ["read"] },
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

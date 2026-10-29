import { TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME } from "@archestra/shared";
import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import { describe, expect, test } from "@/test";
import { recordQueries } from "@/test/query-counter";
import { useRouteTestApp } from "@/test/route-test-app";
import agentRoutes from "./agent";

describe("GET /api/mcp-gateways/default", () => {
  const ctx = useRouteTestApp(agentRoutes);

  const readDefault = (query = "") =>
    ctx.app.inject({ method: "GET", url: `/api/mcp-gateways/default${query}` });

  test("returns the gateway as the agent read does, with its tool counts", async ({
    makeMember,
    makeTeam,
    makeAgent,
    makeTool,
    makeAgentTool,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeLlmProviderApiKey,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const team = await makeTeam(ctx.organizationId, ctx.user.id);
    const kb = await makeKnowledgeBase(ctx.organizationId, { access: "org" });
    const connector = await makeKnowledgeBaseConnector(
      kb.id,
      ctx.organizationId,
    );
    const key = await makeLlmProviderApiKey(ctx.organizationId, null);
    const gateway = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "mcp_gateway",
      isPersonalGateway: true,
      access: { teams: [team.id], level: "use" },
      labels: [{ key: "env", value: "prod" }],
      knowledgeBaseIds: [kb.id],
      connectorIds: [connector.id],
      llmApiKeyId: key.id,
      suggestedPrompts: [{ summaryTitle: "Hello", prompt: "Say hello" }],
    });
    const subagent = await makeAgent({ organizationId: ctx.organizationId });
    const delegation = await makeTool({ name: "delegate" });
    await db
      .update(schema.toolsTable)
      .set({ delegateToAgentId: subagent.id })
      .where(eq(schema.toolsTable.id, delegation.id));
    for (const tool of [
      await makeTool({ name: "server__first" }),
      await makeTool({ name: "server__second" }),
      await makeTool({ name: TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME }),
      delegation,
    ])
      await makeAgentTool(gateway.id, tool.id);

    const response = await readDefault();
    const byId = await ctx.app.inject({
      method: "GET",
      url: `/api/agents/${gateway.id}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(byId.statusCode, byId.body).toBe(200);
    const body = response.json();
    const expected = byId.json();
    const byToolId = (a: { id: string }, b: { id: string }) =>
      a.id.localeCompare(b.id);
    expect({ ...body, tools: [...body.tools].sort(byToolId) }).toMatchObject({
      ...expected,
      tools: [...expected.tools].sort(byToolId),
    });
    expect(body.teams).toEqual([{ id: team.id, name: team.name }]);
    expect(body.labels).toMatchObject([{ key: "env", value: "prod" }]);
    // The knowledge search tool counts because the gateway has knowledge
    // sources; the delegation counts as a subagent.
    expect(body.tools).toHaveLength(4);
    expect(body.toolsCount).toBe(3);
    expect(body.subagentsCount).toBe(1);
  });

  test("includeTools=false leaves the tools out and keeps their counts", async ({
    makeMember,
    makeTool,
    makeAgentTool,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "member" });
    const gateway = await AgentModel.ensurePersonalMcpGateway({
      userId: ctx.user.id,
      organizationId: ctx.organizationId,
    });
    for (const name of ["server__first", "server__second"])
      await makeAgentTool(gateway.id, (await makeTool({ name })).id);
    // Without knowledge sources the knowledge search tool is not offered.
    await makeAgentTool(
      gateway.id,
      (await makeTool({ name: TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME })).id,
    );

    const full = (await readDefault()).json();
    const slim = await readDefault("?includeTools=false");

    expect(slim.statusCode, slim.body).toBe(200);
    expect(
      full.tools.map((tool: { name: string }) => tool.name).sort(),
    ).toEqual(["server__first", "server__second"]);
    const { tools, sandboxAvailable, ...rest } = full;
    expect(slim.json()).toEqual({ ...rest, tools: [] });
    expect(slim.json()).toMatchObject({ toolsCount: 2, subagentsCount: 0 });
  });

  for (const role of ["admin", "member"] as const)
    test(`reads an existing gateway in two statements, three with its tools (${role})`, async ({
      makeMember,
      makeTool,
      makeAgentTool,
    }) => {
      await makeMember(ctx.user.id, ctx.organizationId, { role });
      const gateway = await AgentModel.ensurePersonalMcpGateway({
        userId: ctx.user.id,
        organizationId: ctx.organizationId,
      });
      for (let index = 0; index < 3; index++)
        await makeAgentTool(gateway.id, (await makeTool()).id);
      // The sandbox check belongs to the full read only.
      config.skillsSandbox.enabled = true;

      const slim = await recordQueries(() =>
        readDefault("?includeTools=false"),
      );
      config.skillsSandbox.enabled = false;
      const full = await recordQueries(() => readDefault());

      expect(slim.result.statusCode).toBe(200);
      expect(slim.result.json()).toMatchObject({
        id: gateway.id,
        tools: [],
        toolsCount: 3,
      });
      expect(full.result.json().tools).toHaveLength(3);
      expect(slim.statements).toHaveLength(2);
      expect(full.statements).toHaveLength(3);
      // The tools are read as refs, not as whole rows with their schemas.
      expect(
        full.statements.filter((statement) => statement.includes('"tools"')),
      ).toHaveLength(1);
      expect(full.statements.join("\n")).not.toContain("parameters");
    });

  test("creates the gateway on a first read without tools", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "member" });

    const first = await readDefault("?includeTools=false");
    const second = await readDefault("?includeTools=false");

    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      agentType: "mcp_gateway",
      isPersonalGateway: true,
      authorId: ctx.user.id,
      scope: "personal",
      tools: [],
      toolsCount: 0,
      subagentsCount: 0,
    });
    expect(second.json().id).toBe(first.json().id);
    expect(
      (await AgentModel.getPersonalMcpGateway(ctx.user.id, ctx.organizationId))
        ?.id,
    ).toBe(first.json().id);
  });
});

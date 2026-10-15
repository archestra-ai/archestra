// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import { getAgentCredentialReadiness } from "@/services/agent-credential-readiness";
import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import agentRoutes from "./agent";
import agentToolRoutes from "./agent-tool";

describe("agent metadata reads", () => {
  const ctx = useRouteTestApp(async (app) => {
    await app.register(agentRoutes);
    await app.register(agentToolRoutes);
  });

  test("delegation graph preserves organization, agent type, deletion and exact roster ordering", async ({
    makeMember,
    makeOrganization,
    makeAgent,
    makeTool,
    makeAgentTool,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const first = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "First",
      systemPrompt: "Large configuration",
    });
    const second = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "Second",
    });
    const builtin = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "Built in",
    });
    await db
      .update(schema.agentsTable)
      .set({
        builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.CONTEXT_COMPACTION },
      })
      .where(eq(schema.agentsTable.id, builtin.id));
    const deleted = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "Deleted",
    });
    await db
      .update(schema.agentsTable)
      .set({ deletedAt: new Date() })
      .where(eq(schema.agentsTable.id, deleted.id));
    await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "mcp_gateway",
      name: "Gateway",
    });
    const foreign = await makeOrganization();
    await makeAgent({
      organizationId: foreign.id,
      agentType: "agent",
      name: "Foreign",
    });
    for (const agent of [first, second])
      await db
        .update(schema.agentsTable)
        .set({ createdAt: new Date("2025-01-01T00:00:00Z") })
        .where(eq(schema.agentsTable.id, agent.id));
    const tool = await makeTool({});
    await db
      .update(schema.toolsTable)
      .set({ delegateToAgentId: second.id })
      .where(eq(schema.toolsTable.id, tool.id));
    await makeAgentTool(first.id, tool.id);
    const expected = (
      await AgentModel.findByOrganizationId(ctx.organizationId, {
        agentType: "agent",
      })
    ).map(({ id, name, agentType }) => ({ id, name, agentType }));
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/agent-delegations",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().agents).toEqual(expected);
    expect(response.json().agents).toHaveLength(3);
    expect(response.json().connections).toContainEqual({
      sourceAgentId: first.id,
      sourceAgentName: first.name,
      targetAgentId: second.id,
      targetAgentName: second.name,
      toolId: tool.id,
    });
  });

  test("credential readiness resolves assigned tools independently of embedded roster tools", async ({
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
    makeAgentTool,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      missingCredentialBehavior: "warn",
    });
    await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      missingCredentialBehavior: "allow",
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "Documentation",
    });
    const tool = await makeTool({ catalogId: catalog.id });
    await makeAgentTool(agent.id, tool.id);
    const hydrated = await AgentModel.findAll(ctx.user.id, true, {
      agentTypes: ["agent"],
      excludeBuiltIn: true,
      onlyEnforcingMissingCredentials: true,
    });
    expect(
      hydrated
        .find((row) => row.id === agent.id)
        ?.tools.some((row) => row.id === tool.id),
    ).toBe(true);
    const expected = await getAgentCredentialReadiness({
      agents: hydrated,
      userId: ctx.user.id,
    });
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/agents/credential-readiness",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(expected);
    expect(response.json()).toEqual([
      {
        agentId: agent.id,
        missingCredentialBehavior: "warn",
        missingConnections: [
          { catalogId: catalog.id, catalogName: catalog.name },
        ],
      },
    ]);
  });
});

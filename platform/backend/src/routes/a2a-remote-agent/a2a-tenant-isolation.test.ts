import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { A2aConnectionModel, ToolModel } from "@/models";
import AgentToolModel from "@/models/agent-tool";
import { createA2aRemoteAgent } from "@/services/a2a-outbound-registry";
import { describe, expect, test, useRouteTestApp } from "@/test";
import agentToolRoutes from "../agent-tool";
import toolRoutes from "../tool";
import a2aRemoteAgentRoutes from "./a2a-remote-agent.routes";
import { makeAgentCard } from "./a2a-remote-agent.test-helpers";

const routes: FastifyPluginAsyncZod = async (fastify) => {
  await fastify.register(toolRoutes);
  await fastify.register(agentToolRoutes);
  await fastify.register(a2aRemoteAgentRoutes);
};

async function createRemoteAgent(organizationId: string, name: string) {
  return createA2aRemoteAgent({
    organizationId,
    input: {
      name,
      source: { type: "inline_card", agentCard: makeAgentCard("none") },
      auth: { type: "none" },
      connectionName: "Default",
    },
  });
}

describe("outbound A2A tenant isolation", () => {
  const ctx = useRouteTestApp(routes);

  test("generic tool APIs hide and cannot delete synthetic A2A tools", async ({
    makeMember,
    makeOrganization,
    makeTool,
  }) => {
    const ownerOrganizationId = ctx.organizationId;
    const foreignOrganizationId = (await makeOrganization()).id;
    await makeMember(ctx.user.id, ownerOrganizationId, {
      role: ADMIN_ROLE_NAME,
    });
    await makeMember(ctx.user.id, foreignOrganizationId, {
      role: ADMIN_ROLE_NAME,
    });

    const ordinaryTool = await makeTool({ name: "ordinary-visible-tool" });
    const ownedRemote = await createRemoteAgent(
      ownerOrganizationId,
      "Owned Remote",
    );
    const foreignRemote = await createRemoteAgent(
      foreignOrganizationId,
      "Foreign Remote",
    );

    const listResponse = await ctx.app.inject({
      method: "GET",
      url: "/api/tools?limit=100&offset=0",
    });
    expect(listResponse.statusCode).toBe(200);
    const listedToolIds = listResponse
      .json<{ data: Array<{ id: string }> }>()
      .data.map((tool) => tool.id);
    expect(listedToolIds).toContain(ordinaryTool.id);
    expect(listedToolIds).not.toContain(ownedRemote.toolId);
    expect(listedToolIds).not.toContain(foreignRemote.toolId);

    const deleteResponse = await ctx.app.inject({
      method: "DELETE",
      url: `/api/tools/${ownedRemote.toolId}`,
    });
    expect(deleteResponse.statusCode).toBe(404);
    expect(await ToolModel.findById(ownedRemote.toolId)).not.toBeNull();
  });

  test("generic agent-tool assignment rejects owned and foreign synthetic tools", async ({
    makeAgent,
    makeMember,
    makeOrganization,
  }) => {
    const ownerOrganizationId = ctx.organizationId;
    const foreignOrganizationId = (await makeOrganization()).id;
    await makeMember(ctx.user.id, ownerOrganizationId, {
      role: ADMIN_ROLE_NAME,
    });

    const parent = await makeAgent({
      organizationId: ownerOrganizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      scope: "org",
    });
    const ownedRemote = await createRemoteAgent(
      ownerOrganizationId,
      "Owned Assignment Target",
    );
    const foreignRemote = await createRemoteAgent(
      foreignOrganizationId,
      "Foreign Assignment Target",
    );

    for (const toolId of [ownedRemote.toolId, foreignRemote.toolId]) {
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/agents/${parent.id}/tools/${toolId}`,
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          message:
            "Outbound A2A agents must be assigned through the subagent configuration",
        },
      });
      expect(await AgentToolModel.exists(parent.id, toolId)).toBe(false);
    }
  });

  test("assigned-target discovery applies the caller organization fence", async ({
    makeAgent,
    makeMember,
    makeOrganization,
  }) => {
    const ownerOrganizationId = ctx.organizationId;
    const foreignOrganizationId = (await makeOrganization()).id;
    await makeMember(ctx.user.id, ownerOrganizationId, {
      role: ADMIN_ROLE_NAME,
    });

    const parent = await makeAgent({
      organizationId: ownerOrganizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      scope: "org",
    });
    const remote = await createRemoteAgent(
      ownerOrganizationId,
      "Scoped Discovery Target",
    );
    await AgentToolModel.createIfNotExists(parent.id, remote.toolId);

    const ownedTargets = await A2aConnectionModel.findAssignedTargets(
      parent.id,
      ownerOrganizationId,
    );
    expect(ownedTargets.map(({ tool }) => tool.id)).toEqual([remote.toolId]);

    const foreignTargets = await A2aConnectionModel.findAssignedTargets(
      parent.id,
      foreignOrganizationId,
    );
    expect(foreignTargets).toEqual([]);
  });

  test("policy-editor reads expose a synthetic tool only to its owning organization", async ({
    makeMember,
    makeOrganization,
  }) => {
    const ownerOrganizationId = ctx.organizationId;
    const foreignOrganizationId = (await makeOrganization()).id;
    await makeMember(ctx.user.id, ownerOrganizationId, {
      role: ADMIN_ROLE_NAME,
    });
    await makeMember(ctx.user.id, foreignOrganizationId, {
      role: ADMIN_ROLE_NAME,
    });

    const remote = await createRemoteAgent(
      ownerOrganizationId,
      "Policy Editor Target",
    );

    const ownerResponse = await ctx.app.inject({
      method: "GET",
      url: `/api/tools/${remote.toolId}`,
    });
    expect(ownerResponse.statusCode).toBe(200);
    expect(ownerResponse.json()).toMatchObject({
      id: remote.toolId,
      name: expect.stringMatching(/^agent__policy_editor_target__[a-f0-9]+$/),
    });

    ctx.organizationId = foreignOrganizationId;
    const foreignResponse = await ctx.app.inject({
      method: "GET",
      url: `/api/tools/${remote.toolId}`,
    });
    expect(foreignResponse.statusCode).toBe(404);
  });
});

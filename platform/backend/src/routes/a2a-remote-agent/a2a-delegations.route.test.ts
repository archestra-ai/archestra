import { AGENT_TOOL_PREFIX, slugify } from "@archestra/shared";
import { eq } from "drizzle-orm";
import { getAgentTools } from "@/archestra-mcp-server";
import db, { schema } from "@/database";
import { A2aConnectionModel } from "@/models";
import AgentToolModel from "@/models/agent-tool";
import { createA2aRemoteAgent } from "@/services/a2a-outbound-registry";
import { describe, expect, test, useRouteTestApp } from "@/test";
import a2aRemoteAgentRoutes from "./a2a-remote-agent.routes";
import { makeAgentCard } from "./a2a-remote-agent.test-helpers";

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

async function assignedToolIds(agentId: string): Promise<string[]> {
  const rows = await db
    .select({ toolId: schema.agentToolsTable.toolId })
    .from(schema.agentToolsTable)
    .where(eq(schema.agentToolsTable.agentId, agentId));
  return rows.map((row) => row.toolId);
}

describe("outbound A2A subagent assignments", () => {
  const ctx = useRouteTestApp(a2aRemoteAgentRoutes);

  test("GET and POST persist and return an explicit outbound assignment", async ({
    makeAgent,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const parent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      scope: "org",
      accessAllSubagents: false,
    });
    const remote = await createRemoteAgent(
      ctx.organizationId,
      "External Researcher",
    );

    const initiallyEmpty = await ctx.app.inject({
      method: "GET",
      url: `/api/agents/${parent.id}/a2a-delegations`,
    });
    expect(initiallyEmpty.statusCode).toBe(200);
    expect(initiallyEmpty.json()).toEqual([]);

    const assigned = await ctx.app.inject({
      method: "POST",
      url: `/api/agents/${parent.id}/a2a-delegations`,
      payload: { connectionIds: [remote.connection.id] },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toEqual({
      added: [remote.connection.id],
      removed: [],
    });
    expect(await assignedToolIds(parent.id)).toEqual([remote.toolId]);

    const listed = await ctx.app.inject({
      method: "GET",
      url: `/api/agents/${parent.id}/a2a-delegations`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([
      {
        remoteAgentId: remote.id,
        connectionId: remote.connection.id,
        toolId: remote.toolId,
        name: "External Researcher",
        description: "A deterministic outbound A2A route-test target.",
        enabled: true,
      },
    ]);

    const idempotent = await ctx.app.inject({
      method: "POST",
      url: `/api/agents/${parent.id}/a2a-delegations`,
      payload: {
        connectionIds: [remote.connection.id, remote.connection.id],
      },
    });
    expect(idempotent.statusCode).toBe(200);
    expect(idempotent.json()).toEqual({ added: [], removed: [] });
    expect(await assignedToolIds(parent.id)).toEqual([remote.toolId]);
  });

  test("POST replaces and removes the complete explicit assignment set", async ({
    makeAgent,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const parent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      scope: "org",
    });
    const first = await createRemoteAgent(ctx.organizationId, "First Remote");
    const second = await createRemoteAgent(ctx.organizationId, "Second Remote");

    const initial = await ctx.app.inject({
      method: "POST",
      url: `/api/agents/${parent.id}/a2a-delegations`,
      payload: { connectionIds: [first.connection.id] },
    });
    expect(initial.statusCode).toBe(200);

    const replacement = await ctx.app.inject({
      method: "POST",
      url: `/api/agents/${parent.id}/a2a-delegations`,
      payload: { connectionIds: [second.connection.id] },
    });
    expect(replacement.statusCode).toBe(200);
    expect(replacement.json()).toEqual({
      added: [second.connection.id],
      removed: [first.connection.id],
    });
    expect(await assignedToolIds(parent.id)).toEqual([second.toolId]);

    const removed = await ctx.app.inject({
      method: "POST",
      url: `/api/agents/${parent.id}/a2a-delegations`,
      payload: { connectionIds: [] },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({
      added: [],
      removed: [second.connection.id],
    });
    expect(await assignedToolIds(parent.id)).toEqual([]);
  });

  test("rejects missing, disabled, and cross-organization connections", async ({
    makeAgent,
    makeMember,
    makeOrganization,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const parent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      scope: "org",
    });
    const disabled = await createRemoteAgent(
      ctx.organizationId,
      "Disabled Remote",
    );
    await A2aConnectionModel.update(disabled.connection.id, { enabled: false });

    const foreignOrganization = await makeOrganization();
    const foreign = await createRemoteAgent(
      foreignOrganization.id,
      "Foreign Remote",
    );

    for (const connectionId of [
      crypto.randomUUID(),
      disabled.connection.id,
      foreign.connection.id,
    ]) {
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/agents/${parent.id}/a2a-delegations`,
        payload: { connectionIds: [connectionId] },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          message:
            "One or more outbound A2A connections are missing, disabled, or belong to another organization",
        },
      });
    }
    expect(await assignedToolIds(parent.id)).toEqual([]);
  });

  test("does not expose a parent agent from another organization", async ({
    makeAgent,
    makeMember,
    makeOrganization,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const foreignOrganization = await makeOrganization();
    const foreignParent = await makeAgent({
      organizationId: foreignOrganization.id,
      authorId: ctx.user.id,
      agentType: "agent",
      scope: "org",
    });

    const getResponse = await ctx.app.inject({
      method: "GET",
      url: `/api/agents/${foreignParent.id}/a2a-delegations`,
    });
    const postResponse = await ctx.app.inject({
      method: "POST",
      url: `/api/agents/${foreignParent.id}/a2a-delegations`,
      payload: { connectionIds: [] },
    });

    expect.soft(getResponse.statusCode).toBe(404);
    expect.soft(getResponse.json()).toMatchObject({
      error: { message: "Agent not found" },
    });
    expect.soft(postResponse.statusCode).toBe(404);
    expect.soft(postResponse.json()).toMatchObject({
      error: { message: "Agent not found" },
    });
  });

  test("rejects a delegation-name collision with an existing assigned tool", async ({
    makeAgent,
    makeAgentTool,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const parent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      scope: "org",
    });
    const remote = await createRemoteAgent(
      ctx.organizationId,
      "Colliding Remote",
    );
    const [remoteTool] = await db
      .select({ name: schema.toolsTable.name })
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, remote.toolId));
    const [collidingTool] = await db
      .insert(schema.toolsTable)
      .values({ name: remoteTool.name })
      .returning();
    await makeAgentTool(parent.id, collidingTool.id);

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/agents/${parent.id}/a2a-delegations`,
      payload: { connectionIds: [remote.connection.id] },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        message: `Delegation tool name "${collidingTool.name}" is already assigned to this agent`,
      },
    });
    expect(await assignedToolIds(parent.id)).toEqual([collidingTool.id]);
  });

  test("keeps two same-named outbound targets callable with stable tool identities", async ({
    makeAgent,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const parent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      scope: "org",
    });
    const first = await createRemoteAgent(ctx.organizationId, "Shared Name");
    const second = await createRemoteAgent(ctx.organizationId, "shared-name");

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/agents/${parent.id}/a2a-delegations`,
      payload: { connectionIds: [first.connection.id, second.connection.id] },
    });

    expect(response.statusCode).toBe(200);
    expect(new Set(await assignedToolIds(parent.id))).toEqual(
      new Set([first.toolId, second.toolId]),
    );
    const toolNames = (
      await getAgentTools({
        agentId: parent.id,
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
      })
    ).map((tool) => tool.name);
    expect(new Set(toolNames).size).toBe(toolNames.length);
  });

  test("keeps a same-named local and outbound subagent independently callable", async ({
    makeAgent,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const parent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      scope: "org",
    });
    const localTarget = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      scope: "org",
      name: "Shared Delegate",
    });
    const remote = await createRemoteAgent(
      ctx.organizationId,
      "Shared Delegate",
    );

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/agents/${parent.id}/a2a-delegations`,
      payload: { connectionIds: [remote.connection.id] },
    });
    expect(response.statusCode).toBe(200);

    await AgentToolModel.assignDelegation(parent.id, localTarget.id);
    expect(new Set(await assignedToolIds(parent.id))).toEqual(
      new Set([
        remote.toolId,
        (
          await db
            .select({ id: schema.toolsTable.id })
            .from(schema.toolsTable)
            .where(eq(schema.toolsTable.delegateToAgentId, localTarget.id))
        )[0].id,
      ]),
    );
  });

  test("keeps outbound A2A targets explicit when local subagents use Auto mode", async ({
    makeAgent,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const parent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      scope: "org",
      accessAllSubagents: true,
    });
    const localTarget = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      name: "Local Auto Target",
      agentType: "agent",
      scope: "org",
    });
    const assignedRemote = await createRemoteAgent(
      ctx.organizationId,
      "Assigned External",
    );
    const unassignedRemote = await createRemoteAgent(
      ctx.organizationId,
      "Unassigned External",
    );

    const assignment = await ctx.app.inject({
      method: "POST",
      url: `/api/agents/${parent.id}/a2a-delegations`,
      payload: { connectionIds: [assignedRemote.connection.id] },
    });
    expect(assignment.statusCode).toBe(200);

    const toolNames = (
      await getAgentTools({
        agentId: parent.id,
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
      })
    ).map((tool) => tool.name);

    expect(toolNames).toContain(
      `${AGENT_TOOL_PREFIX}${slugify(localTarget.name)}`,
    );
    const assignedRemoteTool = await db
      .select({ name: schema.toolsTable.name })
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, assignedRemote.toolId));
    const unassignedRemoteTool = await db
      .select({ name: schema.toolsTable.name })
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, unassignedRemote.toolId));
    expect(toolNames).toContain(assignedRemoteTool[0].name);
    expect(toolNames).not.toContain(unassignedRemoteTool[0].name);
  });
});

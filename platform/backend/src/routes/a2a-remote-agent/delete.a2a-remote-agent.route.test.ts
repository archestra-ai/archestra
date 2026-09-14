import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { A2aOutboundRunModel, A2aRemoteAgentModel } from "@/models";
import AgentToolModel from "@/models/agent-tool";
import { describe, expect, test, useRouteTestApp } from "@/test";
import a2aRemoteAgentRoutes from "./a2a-remote-agent.routes";
import { makeAgentCard } from "./a2a-remote-agent.test-helpers";

describe("DELETE /api/a2a/remote-agents/:id", () => {
  const ctx = useRouteTestApp(a2aRemoteAgentRoutes);

  test("deletes an unassigned remote agent", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        source: { type: "inline_card", agentCard: makeAgentCard("none") },
        auth: { type: "none" },
      },
    });
    expect(created.statusCode).toBe(200);
    const createdBody = created.json();

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/a2a/remote-agents/${createdBody.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(
      await A2aRemoteAgentModel.findByIdForOrganization({
        id: createdBody.id,
        organizationId: ctx.organizationId,
      }),
    ).toBeNull();
  });

  test("deletes an assigned remote agent and cascades its assignments", async ({
    makeAgent,
  }) => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        source: { type: "inline_card", agentCard: makeAgentCard("none") },
        auth: { type: "none" },
      },
    });
    expect(created.statusCode).toBe(200);
    const remote = created.json();
    const parent = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
    });
    await AgentToolModel.createIfNotExists(parent.id, remote.toolId);

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/a2a/remote-agents/${remote.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(
      await A2aRemoteAgentModel.findByIdForOrganization({
        id: remote.id,
        organizationId: ctx.organizationId,
      }),
    ).toBeNull();
    expect(
      await db
        .select({ id: schema.agentToolsTable.id })
        .from(schema.agentToolsTable)
        .where(eq(schema.agentToolsTable.agentId, parent.id)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: schema.toolsTable.id })
        .from(schema.toolsTable)
        .where(eq(schema.toolsTable.id, remote.toolId)),
    ).toEqual([]);
  });

  test("retains monitoring history after deleting a remote agent", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        source: { type: "inline_card", agentCard: makeAgentCard("none") },
        auth: { type: "none" },
      },
    });
    expect(created.statusCode).toBe(200);
    const remote = created.json();
    const run = await A2aOutboundRunModel.create({
      organizationId: ctx.organizationId,
      remoteAgentId: remote.id,
      connectionId: remote.connection.id,
      toolId: remote.toolId,
      messageId: "historical-run",
      state: "completed",
      targetNameSnapshot: remote.name,
      interfaceSnapshot: remote.connection.selectedInterface,
      completedAt: new Date(),
    });

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/a2a/remote-agents/${remote.id}`,
    });

    expect(response.statusCode).toBe(200);
    const [retainedRun] = await db
      .select()
      .from(schema.a2aOutboundRunsTable)
      .where(eq(schema.a2aOutboundRunsTable.id, run.id));
    expect(retainedRun).toMatchObject({
      remoteAgentId: null,
      connectionId: null,
      toolId: null,
      targetNameSnapshot: remote.name,
      state: "completed",
    });
  });

  test("returns 404 for an unknown remote agent", async () => {
    const response = await ctx.app.inject({
      method: "DELETE",
      url: "/api/a2a/remote-agents/00000000-0000-0000-0000-000000000000",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { message: "Outbound A2A agent not found" },
    });
  });
});

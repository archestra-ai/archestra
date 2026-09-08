import { A2aOutboundRunModel } from "@/models";
import { createA2aRemoteAgent } from "@/services/a2a-outbound-registry";
import { describe, expect, test, useRouteTestApp } from "@/test";
import a2aRemoteAgentRoutes from "./a2a-remote-agent.routes";
import { makeAgentCard } from "./a2a-remote-agent.test-helpers";

describe("GET /api/a2a/remote-agents/:id/runs", () => {
  const ctx = useRouteTestApp(a2aRemoteAgentRoutes);

  test("returns bounded recent protocol outcomes without message content", async ({
    makeAgent,
  }) => {
    const parent = await makeAgent({ organizationId: ctx.organizationId });
    const remote = await createA2aRemoteAgent({
      organizationId: ctx.organizationId,
      input: {
        name: "Monitored Remote",
        source: { type: "inline_card", agentCard: makeAgentCard("none") },
        auth: { type: "none" },
        connectionName: "Default",
      },
    });
    await A2aOutboundRunModel.create({
      organizationId: ctx.organizationId,
      parentAgentId: parent.id,
      remoteAgentId: remote.id,
      connectionId: remote.connection.id,
      toolId: remote.toolId,
      messageId: "outbound-message-1",
      remoteTaskId: "remote-task-1",
      state: "completed",
      targetNameSnapshot: remote.name,
      interfaceSnapshot: remote.connection.selectedInterface,
      completedAt: new Date(),
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/a2a/remote-agents/${remote.id}/runs?limit=1`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        parentAgentId: parent.id,
        remoteTaskId: "remote-task-1",
        state: "completed",
        targetNameSnapshot: "Monitored Remote",
      }),
    ]);
    expect(JSON.stringify(response.json())).not.toContain("message content");
  });

  test("does not expose runs for another organization", async ({
    makeOrganization,
  }) => {
    const foreignOrganization = await makeOrganization();
    const remote = await createA2aRemoteAgent({
      organizationId: foreignOrganization.id,
      input: {
        source: { type: "inline_card", agentCard: makeAgentCard("none") },
        auth: { type: "none" },
        connectionName: "Default",
      },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/a2a/remote-agents/${remote.id}/runs`,
    });

    expect(response.statusCode).toBe(404);
  });
});

import A2aRemoteAgentModel from "@/models/a2a-remote-agent";
import { describe, expect, test, useRouteTestApp } from "@/test";
import a2aRemoteAgentRoutes from "./a2a-remote-agent.routes";
import { makeAgentCard } from "./a2a-remote-agent.test-helpers";

describe("DELETE /api/a2a/remote-agents/:id", () => {
  const ctx = useRouteTestApp(a2aRemoteAgentRoutes);

  test("deletes an unassigned remote agent and its generated delegation tool", async () => {
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

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/a2a/remote-agents",
    });
    expect(list.json()).toEqual([]);
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

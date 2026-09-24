import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import skillRoutes from "./skill.routes";

describe("Removed agent-to-skill endpoints", () => {
  const ctx = useRouteTestApp(skillRoutes);

  test.for([
    "convert-to-skill",
    "suggest-skill-description",
  ])("%s returns route-not-found even for an existing agent", async (endpoint, {
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/${endpoint}`,
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().message).toContain("Route POST:");
  });
});

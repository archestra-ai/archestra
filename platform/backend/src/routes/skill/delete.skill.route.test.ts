import { describe, expect, test, useRouteTestApp } from "@/test";
import skillRoutes from "./skill.routes";
import { MANIFEST } from "./skill.test-helpers";

describe("DELETE /api/skills/:id", () => {
  const ctx = useRouteTestApp(skillRoutes);

  test("deletes a skill", async () => {
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: MANIFEST },
      })
    ).json();

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/skills/${created.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });

    const getResponse = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/${created.id}`,
    });
    expect(getResponse.statusCode).toBe(404);
  });
});

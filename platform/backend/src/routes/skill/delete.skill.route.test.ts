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

  test("a deleted skill leaves the list and 404s on repeat delete", async () => {
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: MANIFEST },
      })
    ).json();

    await ctx.app.inject({
      method: "DELETE",
      url: `/api/skills/${created.id}`,
    });

    const list = (
      await ctx.app.inject({ method: "GET", url: "/api/skills" })
    ).json();
    expect(list.data.map((s: { id: string }) => s.id)).not.toContain(
      created.id,
    );

    const repeat = await ctx.app.inject({
      method: "DELETE",
      url: `/api/skills/${created.id}`,
    });
    expect(repeat.statusCode).toBe(404);
  });

  test("deleting a skill frees its name for a new one", async () => {
    const first = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: MANIFEST },
      })
    ).json();

    await ctx.app.inject({
      method: "DELETE",
      url: `/api/skills/${first.id}`,
    });

    const recreate = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: MANIFEST },
    });
    expect(recreate.statusCode).toBe(200);
    expect(recreate.json().id).not.toBe(first.id);
  });
});

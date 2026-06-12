import { SkillModel } from "@/models";
import { describe, expect, test, useRouteTestApp } from "@/test";
import skillRoutes from "./skill.routes";

describe("GET /api/skills/:id", () => {
  const ctx = useRouteTestApp(skillRoutes);

  test("a personal skill is hidden from non-authors", async ({ makeUser }) => {
    const author = await makeUser();
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId: ctx.organizationId,
        authorId: author.id,
        name: "someone-elses-skill",
        description: "private",
        content: "# private",
        metadata: {},
        sourceType: "manual",
        scope: "personal",
      },
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    // current request user is not the author and not an admin
    const getResponse = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/${skill.id}`,
    });
    expect(getResponse.statusCode).toBe(404);

    const listResponse = await ctx.app.inject({
      method: "GET",
      url: "/api/skills",
    });
    expect(
      listResponse.json().data.map((s: { id: string }) => s.id),
    ).not.toContain(skill.id);

    const deleteResponse = await ctx.app.inject({
      method: "DELETE",
      url: `/api/skills/${skill.id}`,
    });
    expect(deleteResponse.statusCode).toBe(404);
  });
});

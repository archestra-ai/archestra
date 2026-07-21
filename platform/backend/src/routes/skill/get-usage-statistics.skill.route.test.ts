import { SkillModel } from "@/models";
import { describe, expect, test, useRouteTestApp } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import skillRoutes from "./skill.routes";

describe("GET /api/skills/:id/usage-statistics", () => {
  const ctx = useRouteTestApp(skillRoutes);

  test("returns per-user daily counts for the last month", async ({
    makeUser,
  }) => {
    const alice = await makeUser({ name: "Alice" });
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId: ctx.organizationId,
        authorId: null,
        name: "shared-skill",
        description: "org-wide",
        content: "# body",
        metadata: {},
        sourceType: "manual",
        scope: "org",
      },
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    SkillModel.recordUsage({ skillId: skill.id, userId: alice.id });
    SkillModel.recordUsage({ skillId: skill.id, userId: alice.id });
    SkillModel.recordUsage({ skillId: skill.id, userId: ctx.user.id });
    await drainBackgroundWork();

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/${skill.id}/usage-statistics`,
    });
    expect(response.statusCode).toBe(200);

    const stats = response.json();
    expect(stats.users[0]).toEqual({
      userId: alice.id,
      name: "Alice",
      total: 2,
    });
    expect(stats.users).toHaveLength(2);
    const today = new Date().toISOString().slice(0, 10);
    expect(stats.daily).toContainEqual({
      date: today,
      userId: alice.id,
      count: 2,
    });
    expect(stats.daily).toContainEqual({
      date: today,
      userId: ctx.user.id,
      count: 1,
    });
  });

  test("a personal skill of another user is 404, not 403", async ({
    makeUser,
  }) => {
    const author = await makeUser();
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId: ctx.organizationId,
        authorId: author.id,
        name: "private-skill",
        description: "private",
        content: "# private",
        metadata: {},
        sourceType: "manual",
        scope: "personal",
      },
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/${skill.id}/usage-statistics`,
    });
    expect(response.statusCode).toBe(404);
  });
});

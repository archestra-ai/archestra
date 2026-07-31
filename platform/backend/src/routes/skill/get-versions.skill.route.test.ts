import { SkillModel } from "@/models";
import { describe, expect, test, useRouteTestApp } from "@/test";
import type { Skill } from "@/types";
import skillRoutes from "./skill.routes";

describe("GET /api/skills/:id/versions", () => {
  const ctx = useRouteTestApp(skillRoutes);

  async function seedSkill(): Promise<Skill> {
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId: ctx.organizationId,
        authorId: null,
        name: "versioned-skill",
        description: "org-wide",
        content: "# v1",
        metadata: {},
        sourceType: "manual",
        scope: "org",
      },
      files: [],
    });
    if (!skill) throw new Error("seed failed");
    return skill;
  }

  test("lists version metadata newest first, without the body", async () => {
    const skill = await seedSkill();
    await SkillModel.updateWithFiles({
      id: skill.id,
      skill: { content: "# v2" },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/${skill.id}/versions`,
    });
    expect(response.statusCode).toBe(200);

    const { data, pagination } = response.json();
    expect(pagination.total).toBe(2);
    expect(data.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    // the list is a metadata projection; the body stays on get-one
    expect(data[0]).not.toHaveProperty("content");
    expect(data[0].contentHash).toEqual(expect.any(String));
  });

  test("paginates with limit and offset", async () => {
    const skill = await seedSkill();
    await SkillModel.updateWithFiles({
      id: skill.id,
      skill: { content: "# v2" },
    });
    await SkillModel.updateWithFiles({
      id: skill.id,
      skill: { content: "# v3" },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/${skill.id}/versions?limit=2&offset=2`,
    });
    expect(response.statusCode).toBe(200);

    const { data, pagination } = response.json();
    expect(pagination.total).toBe(3);
    expect(data.map((v: { version: number }) => v.version)).toEqual([1]);
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
      url: `/api/skills/${skill.id}/versions`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("a soft-deleted skill's history is unreachable", async () => {
    const skill = await seedSkill();
    await SkillModel.delete(skill.id);

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/${skill.id}/versions`,
    });
    expect(response.statusCode).toBe(404);
  });
});

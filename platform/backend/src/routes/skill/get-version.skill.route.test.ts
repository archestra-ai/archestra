import { SkillModel } from "@/models";
import { describe, expect, test, useRouteTestApp } from "@/test";
import type { Skill } from "@/types";
import skillRoutes from "./skill.routes";

describe("GET /api/skills/:id/versions/:version", () => {
  const ctx = useRouteTestApp(skillRoutes);

  async function seedSkillWithTwoVersions(): Promise<Skill> {
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
      files: [
        {
          path: "references/NOTES.md",
          content: "first notes",
          encoding: "utf8",
          kind: "reference",
        },
      ],
    });
    if (!skill) throw new Error("seed failed");

    await SkillModel.updateWithFiles({
      id: skill.id,
      skill: { content: "# v2" },
      files: [
        {
          path: "references/NOTES.md",
          content: "second notes",
          encoding: "utf8",
          kind: "reference",
        },
      ],
    });
    return skill;
  }

  test("returns the captured body and file snapshots per version", async () => {
    const skill = await seedSkillWithTwoVersions();

    const v1Response = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/${skill.id}/versions/1`,
    });
    expect(v1Response.statusCode).toBe(200);
    const v1 = v1Response.json();
    expect(v1.version).toBe(1);
    expect(v1.content).toBe("# v1");
    expect(v1.files).toHaveLength(1);
    expect(v1.files[0].path).toBe("references/NOTES.md");
    expect(v1.files[0].content).toBe("first notes");

    // the older snapshot is immutable: the edit forked v2 instead
    const v2Response = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/${skill.id}/versions/2`,
    });
    expect(v2Response.statusCode).toBe(200);
    const v2 = v2Response.json();
    expect(v2.content).toBe("# v2");
    expect(v2.files[0].content).toBe("second notes");
  });

  test("a version that does not exist is 404", async () => {
    const skill = await seedSkillWithTwoVersions();

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/${skill.id}/versions/99`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("a version beyond the int4 range is 400", async () => {
    const skill = await seedSkillWithTwoVersions();

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/${skill.id}/versions/3000000000`,
    });
    expect(response.statusCode).toBe(400);
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
      url: `/api/skills/${skill.id}/versions/1`,
    });
    expect(response.statusCode).toBe(404);
  });
});

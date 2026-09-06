import { SkillModel } from "@/models";
import { describe, expect, test, useRouteTestApp } from "@/test";
import skillRoutes from "./skill.routes";
import { seedImportedSkill } from "./skill.test-helpers";

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

  test("a non-uuid id (e.g. a skill name) is rejected as 400, not a database 500", async () => {
    // Callers pass skill names here; the raw string used to reach Postgres
    // and fail with `invalid input syntax for type uuid` as a 500.
    for (const url of [
      "/api/skills/agent-builder",
      "/api/skills/agent-builder/usage-statistics",
    ]) {
      const response = await ctx.app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
    }
  });

  test("a child-team member can read parent-team skills but not sibling-team skills", async ({
    makeTeam,
    makeTeamMember,
  }) => {
    const parent = await makeTeam(ctx.organizationId, ctx.user.id, {
      name: "Product",
    });
    const child = await makeTeam(ctx.organizationId, ctx.user.id, {
      name: "Platform",
      parentId: parent.id,
    });
    const sibling = await makeTeam(ctx.organizationId, ctx.user.id, {
      name: "Operations",
    });
    await makeTeamMember(child.id, ctx.user.id);

    const parentSkill = await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "parent-skill",
      sourceRef: "parent/repo@main:SKILL.md",
      scope: "team",
      teamIds: [parent.id],
    });
    const childSkill = await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "child-skill",
      sourceRef: "child/repo@main:SKILL.md",
      scope: "team",
      teamIds: [child.id],
    });
    const siblingSkill = await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "sibling-skill",
      sourceRef: "sibling/repo@main:SKILL.md",
      scope: "team",
      teamIds: [sibling.id],
    });

    const parentResponse = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/${parentSkill.id}`,
    });
    const childResponse = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/${childSkill.id}`,
    });
    const siblingResponse = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/${siblingSkill.id}`,
    });

    expect(parentResponse.statusCode).toBe(200);
    expect(childResponse.statusCode).toBe(200);
    expect(siblingResponse.statusCode).toBe(404);
  });
});

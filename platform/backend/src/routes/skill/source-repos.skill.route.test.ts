import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { describe, expect, test, useRouteTestApp } from "@/test";
import skillRoutes from "./skill.routes";
import { seedImportedSkill } from "./skill.test-helpers";

describe("GET /api/skills/source-repos", () => {
  const ctx = useRouteTestApp(skillRoutes);

  test("non-admins see repositories only for skills within their scope", async ({
    makeMember,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: MEMBER_ROLE_NAME,
    });
    const otherAuthor = await makeUser();
    const team = await makeTeam(ctx.organizationId, ctx.user.id);
    await makeTeamMember(team.id, ctx.user.id);
    const inaccessibleTeam = await makeTeam(ctx.organizationId, otherAuthor.id);

    await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "org-imported",
      sourceRef: "shared/org-repo@main:SKILL.md",
      scope: "org",
    });
    await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "own-imported",
      sourceRef: "mine/personal-repo@main:SKILL.md",
      scope: "personal",
      authorId: ctx.user.id,
    });
    await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "team-imported",
      sourceRef: "team/team-repo@main:SKILL.md",
      scope: "team",
      teamIds: [team.id],
    });
    await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "private-imported",
      sourceRef: "secret/private-repo@main:SKILL.md",
      scope: "personal",
      authorId: otherAuthor.id,
    });
    await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "inaccessible-team-imported",
      sourceRef: "secret/team-repo@main:SKILL.md",
      scope: "team",
      teamIds: [inaccessibleTeam.id],
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/source-repos",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().repos).toEqual([
      "mine/personal-repo",
      "shared/org-repo",
      "team/team-repo",
    ]);
  });

  test("admins see repositories from all skills in the organization", async ({
    makeMember,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const otherAuthor = await makeUser();

    await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "org-imported",
      sourceRef: "shared/org-repo@main:SKILL.md",
      scope: "org",
    });
    await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "private-imported",
      sourceRef: "secret/private-repo@main:SKILL.md",
      scope: "personal",
      authorId: otherAuthor.id,
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/source-repos",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().repos).toEqual([
      "secret/private-repo",
      "shared/org-repo",
    ]);
  });

  test("non-admins with no accessible imported skills see no repositories", async ({
    makeMember,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: MEMBER_ROLE_NAME,
    });
    const otherAuthor = await makeUser();

    await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "private-imported",
      sourceRef: "secret/private-repo@main:SKILL.md",
      scope: "personal",
      authorId: otherAuthor.id,
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/source-repos",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().repos).toEqual([]);
  });
});

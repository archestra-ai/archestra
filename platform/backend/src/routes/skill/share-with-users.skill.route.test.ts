import { SkillModel, SkillTeamModel, SkillUserModel } from "@/models";
import MemberModel from "@/models/member";
import { describe, expect, test } from "@/test";
import skillRoutes from "./skill.routes";
import { MANIFEST, useSkillRouteTestApp } from "./skill.test-helpers";

/**
 * Sharing a skill with named people. Such a skill stays `scope = 'personal'`
 * and carries grants beside it, so these cover the round trip the scope alone
 * cannot express, and the boundary where widening the scope drops the grants.
 */
describe("per-user skill sharing", () => {
  const ctx = useSkillRouteTestApp(skillRoutes);

  test("creating a personal skill with userIds grants and returns them", async ({
    makeUser,
    makeMember,
  }) => {
    const grantee = await makeUser({ email: "grantee@test.com" });
    await makeMember(grantee.id, ctx.organizationId);

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: MANIFEST, userIds: [grantee.id] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.scope).toBe("personal");
    expect(body.users).toEqual([
      { id: grantee.id, name: grantee.name, email: grantee.email },
    ]);
    expect(await SkillUserModel.userHasGrant(body.id, grantee.id)).toBe(true);
  });

  test("a grantee reaches the skill the author kept personal", async ({
    makeUser,
    makeMember,
  }) => {
    const grantee = await makeUser({ email: "reader@test.com" });
    await makeMember(grantee.id, ctx.organizationId);
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: MANIFEST, userIds: [grantee.id] },
    });
    const skillId = created.json().id;

    // The point of the grant: access without widening the scope.
    const skill = await SkillModel.findById(skillId);
    if (!skill) throw new Error("skill not found");
    expect(
      await SkillTeamModel.userHasSkillAccess({
        skill,
        userId: grantee.id,
        organizationId: ctx.organizationId,
        isSkillAdmin: false,
      }),
    ).toBe(true);
  });

  test("retired userIds updates cannot replace existing grants", async ({
    makeUser,
    makeMember,
  }) => {
    const first = await makeUser({ email: "first@test.com" });
    await makeMember(first.id, ctx.organizationId);
    const second = await makeUser({ email: "second@test.com" });
    await makeMember(second.id, ctx.organizationId);
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: MANIFEST, userIds: [first.id] },
    });
    const skillId = created.json().id;

    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${skillId}`,
      payload: { content: MANIFEST, userIds: [second.id] },
    });

    expect(response.statusCode).toBe(400);
    expect(await SkillUserModel.userHasGrant(skillId, first.id)).toBe(true);
    expect(await SkillUserModel.userHasGrant(skillId, second.id)).toBe(false);
  });

  test("an edit that omits userIds leaves existing grants alone", async ({
    makeUser,
    makeMember,
  }) => {
    const grantee = await makeUser({ email: "kept@test.com" });
    await makeMember(grantee.id, ctx.organizationId);
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: MANIFEST, userIds: [grantee.id] },
    });
    const skillId = created.json().id;

    // A content-only save must not quietly revoke everyone.
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${skillId}`,
      payload: { content: MANIFEST },
    });

    expect(response.statusCode).toBe(200);
    expect(
      response.json().users.map((user: { id: string }) => user.id),
    ).toEqual([grantee.id]);
  });

  test("retired visibility writes preserve existing grants", async ({
    makeUser,
    makeMember,
  }) => {
    const grantee = await makeUser({ email: "dropped@test.com" });
    await makeMember(grantee.id, ctx.organizationId);
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: MANIFEST, userIds: [grantee.id] },
    });
    const skillId = created.json().id;
    await MemberModel.updateRole(ctx.user.id, ctx.organizationId, "admin");

    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${skillId}`,
      payload: { content: MANIFEST, scope: "org" },
    });

    expect(response.statusCode).toBe(400);
    expect((await SkillModel.findById(skillId))?.scope).toBe("personal");
    expect(await SkillUserModel.userHasGrant(skillId, grantee.id)).toBe(true);
  });

  test("userIds on a team-scoped create are ignored", async ({
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const grantee = await makeUser({ email: "ignored@test.com" });
    await makeMember(grantee.id, ctx.organizationId);
    await MemberModel.updateRole(ctx.user.id, ctx.organizationId, "admin");
    const team = await makeTeam(ctx.organizationId, ctx.user.id);

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: MANIFEST,
        scope: "team",
        teamIds: [team.id],
        userIds: [grantee.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().users).toEqual([]);
  });

  test("the list payload carries grantees so a shared skill reads as shared", async ({
    makeUser,
    makeMember,
  }) => {
    const grantee = await makeUser({ email: "listed@test.com" });
    await makeMember(grantee.id, ctx.organizationId);
    await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: MANIFEST, userIds: [grantee.id] },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/skills",
    });

    expect(response.statusCode).toBe(200);
    const skill = response
      .json()
      .data.find((item: { name: string }) => item.name === "pdf-processing");
    expect(skill.users).toEqual([
      { id: grantee.id, name: grantee.name, email: grantee.email },
    ]);
  });
});

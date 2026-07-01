import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { SkillShareLinkModel } from "@/models";
import { describe, expect, test, useRouteTestApp } from "@/test";
import skillShareRoutes from "./skill-share.routes";
import { seedSkill } from "./skill-share.test-helpers";

describe("DELETE /api/skill-share-links/:id", () => {
  const ctx = useRouteTestApp(skillShareRoutes);

  test("revoking flips status to revoked and a subsequent token validate returns null", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const skill = await seedSkill({
      organizationId: ctx.organizationId,
      name: "to-revoke",
    });
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [skill.id] },
      })
    ).json();

    const revoke = await ctx.app.inject({
      method: "DELETE",
      url: `/api/skill-share-links/${created.link.id}`,
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toEqual({ success: true });

    // a token validate after revoke must miss — same shape as a clone attempt
    const validated = await SkillShareLinkModel.validate({
      rawToken: created.rawToken,
    });
    expect(validated).toBeNull();
  });

  test("revoke is idempotent", async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const skill = await seedSkill({
      organizationId: ctx.organizationId,
      name: "idem",
    });
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [skill.id] },
      })
    ).json();

    const first = await ctx.app.inject({
      method: "DELETE",
      url: `/api/skill-share-links/${created.link.id}`,
    });
    const second = await ctx.app.inject({
      method: "DELETE",
      url: `/api/skill-share-links/${created.link.id}`,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
  });

  test("revoking a link from another org returns 404", async ({
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });

    const otherOrg = await makeOrganization();
    const otherUser = await makeUser();
    const otherSkill = await seedSkill({
      organizationId: otherOrg.id,
      name: "other-org",
    });
    const { link } = await SkillShareLinkModel.create({
      organizationId: otherOrg.id,
      createdByUserId: otherUser.id,
      skillIds: [otherSkill.id],
      marketplaceName: "org-other-skills",
    });

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/skill-share-links/${link.id}`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("member without admin role gets 403", async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: MEMBER_ROLE_NAME,
    });
    const skill = await seedSkill({
      organizationId: ctx.organizationId,
      name: "no-revoke",
    });
    const { link } = await SkillShareLinkModel.create({
      organizationId: ctx.organizationId,
      createdByUserId: ctx.user.id,
      skillIds: [skill.id],
      marketplaceName: "org-x-skills",
    });

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/skill-share-links/${link.id}`,
    });
    expect(response.statusCode).toBe(403);
  });
});

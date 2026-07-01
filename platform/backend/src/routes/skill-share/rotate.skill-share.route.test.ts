import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { SkillShareLinkModel } from "@/models";
import { describe, expect, test, useRouteTestApp } from "@/test";
import skillShareRoutes from "./skill-share.routes";
import { seedSkill } from "./skill-share.test-helpers";

describe("POST /api/skill-share-links/:id/rotate", () => {
  const ctx = useRouteTestApp(skillShareRoutes);

  test("revokes the old link and returns a working replacement", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const skill = await seedSkill({
      organizationId: ctx.organizationId,
      name: "rotate-me",
    });
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [skill.id] },
      })
    ).json();

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/skill-share-links/${created.link.id}/rotate`,
      payload: { skillIds: [skill.id] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.link.id).not.toBe(created.link.id);
    expect(body.rawToken).toMatch(/^archestra_skl_/);
    expect(body.rawToken).not.toBe(created.rawToken);
    expect(body.cloneUrl).toContain(`/skills/m/${body.rawToken}/repo.git`);
    expect(body.link.status).toBe("active");
    expect(body.link.skills[0].id).toBe(skill.id);

    // the old token no longer validates; the new one does
    expect(
      await SkillShareLinkModel.validate({ rawToken: created.rawToken }),
    ).toBeNull();
    expect(
      await SkillShareLinkModel.validate({ rawToken: body.rawToken }),
    ).not.toBeNull();
  });

  test("keeps the marketplace name frozen at create time", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const skill = await seedSkill({
      organizationId: ctx.organizationId,
      name: "frozen-name",
    });
    // a name that does NOT match what deriveMarketplaceName would produce for
    // this org (e.g. the link was created under earlier branding)
    const frozenName = "legacy-brand-marketplace-skills";
    const { link } = await SkillShareLinkModel.create({
      organizationId: ctx.organizationId,
      createdByUserId: ctx.user.id,
      skillIds: [skill.id],
      marketplaceName: frozenName,
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/skill-share-links/${link.id}/rotate`,
      payload: { skillIds: [skill.id] },
    });

    expect(response.statusCode).toBe(200);
    const rotated = await SkillShareLinkModel.findById(response.json().link.id);
    expect(rotated?.marketplaceName).toBe(frozenName);
  });

  test("forwards expiresAt to the replacement link", async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const skill = await seedSkill({
      organizationId: ctx.organizationId,
      name: "ttl-rotate",
    });
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [skill.id] },
      })
    ).json();

    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/skill-share-links/${created.link.id}/rotate`,
      payload: { skillIds: [skill.id], expiresAt },
    });

    expect(response.statusCode).toBe(200);
    expect(new Date(response.json().link.expiresAt).toISOString()).toBe(
      expiresAt,
    );
  });

  test("rotating a nonexistent link returns 404 and creates nothing", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const skill = await seedSkill({
      organizationId: ctx.organizationId,
      name: "no-link",
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skill-share-links/00000000-0000-4000-8000-000000000000/rotate",
      payload: { skillIds: [skill.id] },
    });

    expect(response.statusCode).toBe(404);
    const list = (
      await ctx.app.inject({ method: "GET", url: "/api/skill-share-links" })
    ).json();
    expect(list.links).toHaveLength(0);
  });

  test("rotating a link from another org returns 404", async ({
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const skill = await seedSkill({
      organizationId: ctx.organizationId,
      name: "mine",
    });

    const otherOrg = await makeOrganization();
    const otherUser = await makeUser();
    const otherSkill = await seedSkill({
      organizationId: otherOrg.id,
      name: "theirs",
    });
    const { link } = await SkillShareLinkModel.create({
      organizationId: otherOrg.id,
      createdByUserId: otherUser.id,
      skillIds: [otherSkill.id],
      marketplaceName: "org-other-skills",
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/skill-share-links/${link.id}/rotate`,
      payload: { skillIds: [skill.id] },
    });
    expect(response.statusCode).toBe(404);
  });

  test("rotating an already-revoked link returns 409 and mints nothing", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const skill = await seedSkill({
      organizationId: ctx.organizationId,
      name: "re-key",
    });
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [skill.id] },
      })
    ).json();
    await ctx.app.inject({
      method: "DELETE",
      url: `/api/skill-share-links/${created.link.id}`,
    });

    // a replayed rotate (client retry, double-submit) must not create a
    // second live replacement token
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/skill-share-links/${created.link.id}/rotate`,
      payload: { skillIds: [skill.id] },
    });

    expect(response.statusCode).toBe(409);
    const list = (
      await ctx.app.inject({ method: "GET", url: "/api/skill-share-links" })
    ).json();
    expect(list.links).toHaveLength(1);
    expect(list.links[0].status).toBe("revoked");
  });

  test("member without admin role gets 403", async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: MEMBER_ROLE_NAME,
    });
    const skill = await seedSkill({
      organizationId: ctx.organizationId,
      name: "no-rotate",
    });
    const { link } = await SkillShareLinkModel.create({
      organizationId: ctx.organizationId,
      createdByUserId: ctx.user.id,
      skillIds: [skill.id],
      marketplaceName: "org-x-skills",
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/skill-share-links/${link.id}/rotate`,
      payload: { skillIds: [skill.id] },
    });
    expect(response.statusCode).toBe(403);
  });
});

import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
import { PluginModel, SkillShareLinkModel } from "@/models";
import { describe, expect, test, useRouteTestApp } from "@/test";
import skillShareRoutes from "./skill-share.routes";
import { seedSkill } from "./skill-share.test-helpers";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    plugins: { enabled: true },
  }),
);

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

  test("preserves attached plugins when rotation omits a new set", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const plugin = await PluginModel.create({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      input: {
        displayName: "Rotation hook",
        description: "Kept across token rotation",
        clientType: "claude-code",
        files: [
          {
            path: "hooks/hooks.json",
            content: "{}\n",
            encoding: "utf8",
            mode: "100644",
          },
        ],
      },
    });
    if (!plugin) throw new Error("failed to seed plugin");
    const expiresAt = new Date(Date.now() + 86_400_000);
    const created = await SkillShareLinkModel.create({
      organizationId: ctx.organizationId,
      createdByUserId: ctx.user.id,
      skillIds: [],
      pluginIds: [plugin.id],
      pluginClientType: "claude-code",
      pluginPlatform: "posix",
      marketplaceName: "rotation-hook-marketplace",
      expiresAt,
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/skill-share-links/${created.link.id}/rotate`,
      payload: { expiresAt: expiresAt.toISOString() },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().link.plugins).toEqual([
      expect.objectContaining({ id: plugin.id }),
    ]);
    const validated = await SkillShareLinkModel.validate({
      rawToken: response.json().rawToken,
    });
    expect(validated?.plugins).toEqual([
      expect.objectContaining({ id: plugin.id }),
    ]);
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

  test("preserves the existing expiry when rotation omits it", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const skill = await seedSkill({
      organizationId: ctx.organizationId,
      name: "ttl-preserved",
    });
    const expiresAt = new Date(Date.now() + 3_600_000);
    const created = await SkillShareLinkModel.create({
      organizationId: ctx.organizationId,
      createdByUserId: ctx.user.id,
      skillIds: [skill.id],
      marketplaceName: "ttl-preserved-marketplace",
      expiresAt,
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/skill-share-links/${created.link.id}/rotate`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(new Date(response.json().link.expiresAt).toISOString()).toBe(
      expiresAt.toISOString(),
    );
  });

  test("rejects an explicit empty replacement before revoking the old token", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const skill = await seedSkill({
      organizationId: ctx.organizationId,
      name: "keep-live",
    });
    const created = await SkillShareLinkModel.create({
      organizationId: ctx.organizationId,
      createdByUserId: ctx.user.id,
      skillIds: [skill.id],
      marketplaceName: "keep-live-marketplace",
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/skill-share-links/${created.link.id}/rotate`,
      payload: { skillIds: [], pluginIds: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(
      await SkillShareLinkModel.validate({ rawToken: created.rawToken }),
    ).not.toBeNull();
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

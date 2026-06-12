import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { SkillModel, SkillShareLinkModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

async function seedSkill(params: { organizationId: string; name: string }) {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId: params.organizationId,
      authorId: null,
      name: params.name,
      description: `${params.name} description`,
      content: `# ${params.name}`,
      metadata: {},
      sourceType: "manual",
      scope: "org",
    },
    files: [],
  });
  if (!skill) throw new Error("failed to seed skill");
  return skill;
}

describe("POST /api/skill-share-links/:id/rotate", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: skillShareRoutes } = await import("./skill-share.routes");
    await app.register(skillShareRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("revokes the old link and returns a working replacement", async ({
    makeMember,
  }) => {
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    const skill = await seedSkill({ organizationId, name: "rotate-me" });
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [skill.id] },
      })
    ).json();

    const response = await app.inject({
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

  test("forwards expiresAt to the replacement link", async ({ makeMember }) => {
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    const skill = await seedSkill({ organizationId, name: "ttl-rotate" });
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [skill.id] },
      })
    ).json();

    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const response = await app.inject({
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
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    const skill = await seedSkill({ organizationId, name: "no-link" });

    const response = await app.inject({
      method: "POST",
      url: "/api/skill-share-links/00000000-0000-4000-8000-000000000000/rotate",
      payload: { skillIds: [skill.id] },
    });

    expect(response.statusCode).toBe(404);
    const list = (
      await app.inject({ method: "GET", url: "/api/skill-share-links" })
    ).json();
    expect(list.links).toHaveLength(0);
  });

  test("rotating a link from another org returns 404", async ({
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    const skill = await seedSkill({ organizationId, name: "mine" });

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

    const response = await app.inject({
      method: "POST",
      url: `/api/skill-share-links/${link.id}/rotate`,
      payload: { skillIds: [skill.id] },
    });
    expect(response.statusCode).toBe(404);
  });

  test("rotating an already-revoked link returns 409 and mints nothing", async ({
    makeMember,
  }) => {
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    const skill = await seedSkill({ organizationId, name: "re-key" });
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [skill.id] },
      })
    ).json();
    await app.inject({
      method: "DELETE",
      url: `/api/skill-share-links/${created.link.id}`,
    });

    // a replayed rotate (client retry, double-submit) must not create a
    // second live replacement token
    const response = await app.inject({
      method: "POST",
      url: `/api/skill-share-links/${created.link.id}/rotate`,
      payload: { skillIds: [skill.id] },
    });

    expect(response.statusCode).toBe(409);
    const list = (
      await app.inject({ method: "GET", url: "/api/skill-share-links" })
    ).json();
    expect(list.links).toHaveLength(1);
    expect(list.links[0].status).toBe("revoked");
  });

  test("member without admin role gets 403", async ({ makeMember }) => {
    await makeMember(user.id, organizationId, { role: MEMBER_ROLE_NAME });
    const skill = await seedSkill({ organizationId, name: "no-rotate" });
    const { link } = await SkillShareLinkModel.create({
      organizationId,
      createdByUserId: user.id,
      skillIds: [skill.id],
      marketplaceName: "org-x-skills",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/skill-share-links/${link.id}/rotate`,
      payload: { skillIds: [skill.id] },
    });
    expect(response.statusCode).toBe(403);
  });
});

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

describe("DELETE /api/skill-share-links/:id", () => {
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

  test("revoking flips status to revoked and a subsequent token validate returns null", async ({
    makeMember,
  }) => {
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    const skill = await seedSkill({ organizationId, name: "to-revoke" });
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [skill.id] },
      })
    ).json();

    const revoke = await app.inject({
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
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    const skill = await seedSkill({ organizationId, name: "idem" });
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [skill.id] },
      })
    ).json();

    const first = await app.inject({
      method: "DELETE",
      url: `/api/skill-share-links/${created.link.id}`,
    });
    const second = await app.inject({
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
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

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

    const response = await app.inject({
      method: "DELETE",
      url: `/api/skill-share-links/${link.id}`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("member without admin role gets 403", async ({ makeMember }) => {
    await makeMember(user.id, organizationId, { role: MEMBER_ROLE_NAME });
    const skill = await seedSkill({ organizationId, name: "no-revoke" });
    const { link } = await SkillShareLinkModel.create({
      organizationId,
      createdByUserId: user.id,
      skillIds: [skill.id],
      marketplaceName: "org-x-skills",
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/skill-share-links/${link.id}`,
    });
    expect(response.statusCode).toBe(403);
  });
});

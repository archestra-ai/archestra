import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
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

describe("skill-share routes", () => {
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

    const { default: skillShareRoutes } = await import("./skill-share");
    await app.register(skillShareRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  describe("POST /api/skill-share-links", () => {
    test("admin can create a share link and receives the raw token once", async ({
      makeMember,
    }) => {
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      const skill = await seedSkill({ organizationId, name: "alpha" });

      const response = await app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [skill.id], name: "Demo" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(typeof body.rawToken).toBe("string");
      expect(body.rawToken).toMatch(/^archestra_skl_/);
      // <app>-<org>-skills; "archestra" is the default app slug, org slug
      // is whatever the test fixture stamped on the organization row.
      expect(body.marketplaceName).toMatch(/^archestra-[a-z0-9-]+-skills$/);
      expect(body.cloneUrl).toContain(`/skills/m/${body.rawToken}/repo.git`);
      expect(body.link.status).toBe("active");
      expect(body.link.skills).toHaveLength(1);
      expect(body.link.skills[0].id).toBe(skill.id);
      expect(body.link.tokenStart).toBe(body.rawToken.slice(0, 22));
      // tokenHash must never leak to the response
      expect(body.link).not.toHaveProperty("tokenHash");
    });

    test("member without admin role gets 403", async ({ makeMember }) => {
      await makeMember(user.id, organizationId, { role: MEMBER_ROLE_NAME });
      const skill = await seedSkill({ organizationId, name: "beta" });

      const response = await app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [skill.id] },
      });

      expect(response.statusCode).toBe(403);
    });

    test("creating a share for a skill in another org returns 404", async ({
      makeMember,
      makeOrganization,
    }) => {
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      const otherOrg = await makeOrganization();
      const otherSkill = await seedSkill({
        organizationId: otherOrg.id,
        name: "foreign",
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [otherSkill.id] },
      });

      expect(response.statusCode).toBe(404);
    });

    test("expiresAt is honored and a far-past value classifies the link as expired", async ({
      makeMember,
    }) => {
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      const skill = await seedSkill({ organizationId, name: "ttl" });

      const expired = new Date(Date.now() - 60_000).toISOString();
      const response = await app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [skill.id], expiresAt: expired },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.link.status).toBe("expired");
    });

    test("rejects an empty skillIds list", async ({ makeMember }) => {
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      const response = await app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [] },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /api/skill-share-links", () => {
    test("lists links for the organization without tokenHash", async ({
      makeMember,
    }) => {
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      const skill = await seedSkill({ organizationId, name: "list-me" });
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/skill-share-links",
          payload: { skillIds: [skill.id], name: "L" },
        })
      ).json();

      const response = await app.inject({
        method: "GET",
        url: "/api/skill-share-links",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.links).toHaveLength(1);
      expect(body.links[0].id).toBe(created.link.id);
      expect(body.links[0].tokenStart).toBe(created.rawToken.slice(0, 22));
      expect(body.links[0]).not.toHaveProperty("tokenHash");
      expect(body.links[0].skills[0].id).toBe(skill.id);
    });

    test("filters by skillId", async ({ makeMember }) => {
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      const skillA = await seedSkill({ organizationId, name: "a" });
      const skillB = await seedSkill({ organizationId, name: "b" });

      await app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [skillA.id] },
      });
      await app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [skillB.id] },
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/skill-share-links?skillId=${skillA.id}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.links).toHaveLength(1);
      expect(body.links[0].skills[0].id).toBe(skillA.id);
    });

    test("member without admin role gets 403", async ({ makeMember }) => {
      await makeMember(user.id, organizationId, { role: MEMBER_ROLE_NAME });
      const response = await app.inject({
        method: "GET",
        url: "/api/skill-share-links",
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe("DELETE /api/skill-share-links/:id", () => {
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
});

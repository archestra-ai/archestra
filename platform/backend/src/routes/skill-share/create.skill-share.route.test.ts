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

describe("POST /api/skill-share-links", () => {
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

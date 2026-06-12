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

describe("GET /api/skill-share-links", () => {
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

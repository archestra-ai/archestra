import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { describe, expect, test, useRouteTestApp } from "@/test";
import skillShareRoutes from "./skill-share.routes";
import { seedSkill } from "./skill-share.test-helpers";

describe("GET /api/skill-share-links", () => {
  const ctx = useRouteTestApp(skillShareRoutes);

  test("lists links for the organization without tokenHash", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const skill = await seedSkill({
      organizationId: ctx.organizationId,
      name: "list-me",
    });
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [skill.id], name: "L" },
      })
    ).json();

    const response = await ctx.app.inject({
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
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const skillA = await seedSkill({
      organizationId: ctx.organizationId,
      name: "a",
    });
    const skillB = await seedSkill({
      organizationId: ctx.organizationId,
      name: "b",
    });

    await ctx.app.inject({
      method: "POST",
      url: "/api/skill-share-links",
      payload: { skillIds: [skillA.id] },
    });
    await ctx.app.inject({
      method: "POST",
      url: "/api/skill-share-links",
      payload: { skillIds: [skillB.id] },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/skill-share-links?skillId=${skillA.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.links).toHaveLength(1);
    expect(body.links[0].skills[0].id).toBe(skillA.id);
  });

  test("member without admin role gets 403", async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: MEMBER_ROLE_NAME,
    });
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/skill-share-links",
    });
    expect(response.statusCode).toBe(403);
  });
});

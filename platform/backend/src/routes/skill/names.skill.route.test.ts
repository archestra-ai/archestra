import { MEMBER_ROLE_NAME } from "@archestra/shared";
import { SkillModel } from "@/models";
import { describe, expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import skillRoutes from "./skill.routes";
import {
  manifestNamed,
  seedImportedSkill,
  useSkillRouteTestApp,
} from "./skill.test-helpers";

describe("GET /api/skills/names", () => {
  const ctx = useSkillRouteTestApp(skillRoutes);

  test("names exactly the skills the default list shows, in its order", async ({
    makeMember,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: MEMBER_ROLE_NAME,
    });
    const seeded = new Map<string, string>();
    for (const name of ["alpha", "beta", "gamma"]) {
      const skill = await seedImportedSkill({
        organizationId: ctx.organizationId,
        name,
        sourceRef: `example/skills@main:skills/${name}`,
        access: "org",
      });
      seeded.set(name, skill.id);
    }
    const owner = await makeUser();
    await seedImportedSkill({
      organizationId: ctx.organizationId,
      authorId: owner.id,
      name: "someone-elses",
      sourceRef: "example/skills@main:skills/private",
      access: "personal",
    });
    // Most-used first, as the default list orders it.
    SkillModel.recordUsage({
      skillId: seeded.get("gamma") as string,
      userId: ctx.user.id,
    });
    await drainBackgroundWork();

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/skills?includeContent=false",
    });
    const names = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/names",
    });

    expect(names.statusCode, names.body).toBe(200);
    expect(names.json()).toEqual({
      data: list.json().data.map((skill: { id: string; name: string }) => ({
        id: skill.id,
        name: skill.name,
      })),
      total: list.json().pagination.total,
    });
    expect(names.json().total).toBe(3);
    expect(names.json().data[0].name).toBe("gamma");
  });

  test("a limit caps the names but not the total, and the trash is left out", async () => {
    const created: string[] = [];
    for (const name of ["one", "two", "three"]) {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: manifestNamed(name) },
      });
      created.push(response.json().id);
    }
    await ctx.app.inject({
      method: "DELETE",
      url: `/api/skills/${created[0]}`,
    });

    const names = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/names?limit=1",
    });

    expect(names.statusCode, names.body).toBe(200);
    expect(names.json().data).toHaveLength(1);
    expect(names.json().total).toBe(2);
    expect(names.json().data[0].id).not.toBe(created[0]);
    const all = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/names",
    });
    expect(
      all.json().data.map((skill: { id: string }) => skill.id),
    ).not.toContain(created[0]);
  });

  test("rejects a limit above the setup cap", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/names?limit=1112",
    });
    expect(response.statusCode).toBe(400);
  });
});

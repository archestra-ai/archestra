import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { EnvironmentModel, SkillModel } from "@/models";
import { describe, expect, test, useRouteTestApp } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import skillRoutes from "./skill.routes";
import {
  MANIFEST,
  manifestNamed,
  seedImportedSkill,
} from "./skill.test-helpers";

describe("GET /api/skills", () => {
  const ctx = useRouteTestApp(skillRoutes);

  test("forAgentId restricts the list to the agent's environment", async ({
    makeAgent,
  }) => {
    const staging = await EnvironmentModel.create({
      organizationId: ctx.organizationId,
      name: "Staging",
    });
    const production = await EnvironmentModel.create({
      organizationId: ctx.organizationId,
      name: "Production",
    });
    const stagingAgent = await makeAgent({
      name: "Env Agent",
      organizationId: ctx.organizationId,
      environmentId: staging.id,
    });
    const defaultAgent = await makeAgent({
      name: "Default Agent",
      organizationId: ctx.organizationId,
    });

    // no environments = available to agents in every environment
    await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: manifestNamed("everywhere-skill") },
    });
    await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: manifestNamed("staging-skill"),
        environmentIds: [staging.id],
      },
    });
    // a skill can be assigned to more than one environment
    await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: manifestNamed("staging-and-prod-skill"),
        environmentIds: [staging.id, production.id],
      },
    });
    await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: manifestNamed("prod-only-skill"),
        environmentIds: [production.id],
      },
    });

    const stagingList = await ctx.app.inject({
      method: "GET",
      url: `/api/skills?forAgentId=${stagingAgent.id}`,
    });
    expect(stagingList.statusCode).toBe(200);
    expect(
      stagingList
        .json()
        .data.map((s: { name: string }) => s.name)
        .sort(),
    ).toEqual(["everywhere-skill", "staging-and-prod-skill", "staging-skill"]);

    // a Default-environment agent sees only unassigned skills
    const dflt = await ctx.app.inject({
      method: "GET",
      url: `/api/skills?forAgentId=${defaultAgent.id}`,
    });
    expect(dflt.json().data.map((s: { name: string }) => s.name)).toEqual([
      "everywhere-skill",
    ]);

    // without the filter, the management surface lists every environment
    const all = await ctx.app.inject({ method: "GET", url: "/api/skills" });
    expect(all.json().data).toHaveLength(4);
  });

  test("lists skills with a file count that includes SKILL.md", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: MANIFEST,
        files: [{ path: "references/FORMS.md", content: "# Forms" }],
      },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/skills",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    // one bundled resource (references/FORMS.md) plus the SKILL.md manifest.
    expect(body.data[0].fileCount).toBe(2);
  });

  test("lists most-used skills first by default; sortBy overrides", async () => {
    for (const name of ["alpha", "beta", "gamma"]) {
      await ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: manifestNamed(name) },
      });
    }
    const list = await ctx.app.inject({ method: "GET", url: "/api/skills" });
    const beta = list
      .json()
      .data.find((s: { name: string }) => s.name === "beta");

    SkillModel.recordUsage({ skillId: beta.id, userId: null });
    SkillModel.recordUsage({ skillId: beta.id, userId: ctx.user.id });
    SkillModel.recordUsage({ skillId: beta.id, userId: ctx.user.id });
    await drainBackgroundWork();

    const byUsage = await ctx.app.inject({
      method: "GET",
      url: "/api/skills",
    });
    const names = byUsage
      .json()
      .data.map((s: { name: string; usageCount: number }) => s.name);
    expect(names[0]).toBe("beta");
    expect(byUsage.json().data[0].usageCount).toBe(3);
    // distinct attributed users; the null-user activation doesn't count one.
    expect(byUsage.json().data[0].usageUserCount).toBe(1);
    expect(byUsage.json().data[1].usageUserCount).toBe(0);

    const byName = await ctx.app.inject({
      method: "GET",
      url: "/api/skills?sortBy=name&sortDirection=asc",
    });
    expect(byName.json().data.map((s: { name: string }) => s.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  test("scope and teamIds filter the list by visibility", async ({
    makeMember,
    makeTeam,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const otherAuthor = await makeUser();
    const teamA = await makeTeam(ctx.organizationId, ctx.user.id);
    const teamB = await makeTeam(ctx.organizationId, ctx.user.id);

    await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "org-skill",
      sourceRef: "shared/org@main:SKILL.md",
      scope: "org",
    });
    await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "my-personal-skill",
      sourceRef: "mine/personal@main:SKILL.md",
      scope: "personal",
      authorId: ctx.user.id,
    });
    await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "team-a-skill",
      sourceRef: "team/a@main:SKILL.md",
      scope: "team",
      teamIds: [teamA.id],
    });
    await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "team-b-skill",
      sourceRef: "team/b@main:SKILL.md",
      scope: "team",
      teamIds: [teamB.id],
    });
    await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "other-personal-skill",
      sourceRef: "other/personal@main:SKILL.md",
      scope: "personal",
      authorId: otherAuthor.id,
    });

    const listNames = async (query: string) => {
      const response = await ctx.app.inject({
        method: "GET",
        url: `/api/skills${query}`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const names = body.data.map((s: { name: string }) => s.name).sort();
      expect(body.pagination.total).toBe(names.length);
      return names;
    };

    expect(await listNames("?scope=org")).toEqual(["org-skill"]);
    expect(await listNames("?scope=personal")).toEqual([
      "my-personal-skill",
      "other-personal-skill",
    ]);
    expect(await listNames("?scope=team")).toEqual([
      "team-a-skill",
      "team-b-skill",
    ]);
    expect(await listNames(`?scope=team&teamIds=${teamA.id}`)).toEqual([
      "team-a-skill",
    ]);
  });

  test("author filters apply for admins and are ignored for non-admins", async ({
    makeMember,
    makeUser,
  }) => {
    const otherAuthor = await makeUser();
    await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "org-skill",
      sourceRef: "shared/org@main:SKILL.md",
      scope: "org",
    });
    await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "my-personal-skill",
      sourceRef: "mine/personal@main:SKILL.md",
      scope: "personal",
      authorId: ctx.user.id,
    });
    await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "other-personal-skill",
      sourceRef: "other/personal@main:SKILL.md",
      scope: "personal",
      authorId: otherAuthor.id,
    });

    const listNames = async (query: string) => {
      const response = await ctx.app.inject({
        method: "GET",
        url: `/api/skills${query}`,
      });
      expect(response.statusCode).toBe(200);
      return response
        .json()
        .data.map((s: { name: string }) => s.name)
        .sort();
    };

    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    expect(
      await listNames(`?scope=personal&authorIds=${otherAuthor.id}`),
    ).toEqual(["other-personal-skill"]);
    // authorless rows (e.g. built-ins) survive an exclude filter
    expect(await listNames(`?excludeAuthorIds=${otherAuthor.id}`)).toEqual([
      "my-personal-skill",
      "org-skill",
    ]);
    expect(await listNames("?excludeOtherPersonalSkills=true")).toEqual([
      "my-personal-skill",
      "org-skill",
    ]);
  });

  test("non-admins cannot use author filters to see other users' personal skills", async ({
    makeMember,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: MEMBER_ROLE_NAME,
    });
    const otherAuthor = await makeUser();
    await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "my-personal-skill",
      sourceRef: "mine/personal@main:SKILL.md",
      scope: "personal",
      authorId: ctx.user.id,
    });
    await seedImportedSkill({
      organizationId: ctx.organizationId,
      name: "other-personal-skill",
      sourceRef: "other/personal@main:SKILL.md",
      scope: "personal",
      authorId: otherAuthor.id,
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/skills?scope=personal&authorIds=${otherAuthor.id}`,
    });
    expect(response.statusCode).toBe(200);
    // the authorIds filter is dropped; scope access control still applies
    expect(response.json().data.map((s: { name: string }) => s.name)).toEqual([
      "my-personal-skill",
    ]);
  });
});

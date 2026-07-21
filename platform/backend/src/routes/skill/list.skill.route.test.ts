import { EnvironmentModel, SkillModel } from "@/models";
import { describe, expect, test, useRouteTestApp } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import skillRoutes from "./skill.routes";
import { MANIFEST, manifestNamed } from "./skill.test-helpers";

describe("GET /api/skills", () => {
  const ctx = useRouteTestApp(skillRoutes);

  test("forAgentId restricts the list to the agent's environment", async ({
    makeAgent,
  }) => {
    const env = await EnvironmentModel.create({
      organizationId: ctx.organizationId,
      name: "Staging",
    });
    const envAgent = await makeAgent({
      name: "Env Agent",
      organizationId: ctx.organizationId,
      environmentId: env.id,
    });
    const defaultAgent = await makeAgent({
      name: "Default Agent",
      organizationId: ctx.organizationId,
    });

    await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: manifestNamed("default-env-skill") },
    });
    await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: manifestNamed("staging-skill"),
        environmentId: env.id,
      },
    });

    const staging = await ctx.app.inject({
      method: "GET",
      url: `/api/skills?forAgentId=${envAgent.id}`,
    });
    expect(staging.statusCode).toBe(200);
    expect(staging.json().data.map((s: { name: string }) => s.name)).toEqual([
      "staging-skill",
    ]);

    const dflt = await ctx.app.inject({
      method: "GET",
      url: `/api/skills?forAgentId=${defaultAgent.id}`,
    });
    expect(dflt.json().data.map((s: { name: string }) => s.name)).toEqual([
      "default-env-skill",
    ]);

    // without the filter, the management surface lists every environment
    const all = await ctx.app.inject({ method: "GET", url: "/api/skills" });
    expect(all.json().data).toHaveLength(2);
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
});

import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import { seedCoverage } from "@/test/openappa-coverage";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./openappa-coverage.routes";

describe("GET /api/openappa/coverage/summary", () => {
  const ctx = useRouteTestApp(routes);
  beforeEach(async ({ makeMember }) => {
    config.openappa.enabled = true;
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  });

  const summary = async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/coverage/summary",
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };

  test("is not found while Guardrails v2 is disabled", async () => {
    config.openappa.enabled = false;
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/coverage/summary",
    });
    expect(response.statusCode).toBe(404);
  });

  test("an organization with nothing installed counts nothing", async () => {
    expect(await summary()).toEqual({
      totals: {
        tools: 0,
        root: 0,
        battery: 0,
        notEnforced: 0,
        catchAll: 0,
        builtInFallback: 0,
      },
      // The default policy includes the archestra battery, which has no
      // server to bind while the built-in catalog is not seeded.
      batteries: {
        active: [],
        broken: [{ name: "archestra", status: "refused", tools: 0 }],
        available: [],
      },
    });
  });

  test("counts each tool once by what judges it", async ({
    makeInternalMcpCatalog,
    makeTool,
    makeAgent,
    makeAgentTool,
  }) => {
    await seedCoverage({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      fixtures: { makeInternalMcpCatalog, makeTool, makeAgent, makeAgentTool },
      github: true,
    });

    const result = await summary();
    // The selector rule on docs__microsoft_docs_search adds a tools-table row,
    // not a tool. Linear has no tools, so it is not a server here.
    expect(result.totals).toEqual({
      tools: 10,
      root: 2,
      battery: 5,
      notEnforced: 2,
      catchAll: 1,
      builtInFallback: 0,
    });
    // Gh's battery needs a credential, so neither of its rules holds.
    expect(result.batteries).toEqual({
      active: [
        { name: "acme", tools: 3 },
        { name: "microsoft-learn", tools: 2 },
      ],
      broken: [{ name: "github", status: "missing_credentials", tools: 2 }],
      available: [],
    });
  });

  test("counts the tools a battery that is not installed would judge", async ({
    makeInternalMcpCatalog,
    makeTool,
    makeAgent,
    makeAgentTool,
  }) => {
    const { catalogIds } = await seedCoverage({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      fixtures: { makeInternalMcpCatalog, makeTool, makeAgent, makeAgentTool },
    });
    await makeTool({
      catalogId: catalogIds.linear,
      name: "linear__get_issue",
      rawName: "get_issue",
    });
    // The bundled linear battery names no such tool.
    await makeTool({
      catalogId: catalogIds.linear,
      name: "linear__summon_unicorn",
      rawName: "summon_unicorn",
    });

    const { batteries } = await summary();
    expect(batteries.available).toEqual([
      { name: "linear", servers: ["Linear"], tools: 1 },
    ]);
  });
});

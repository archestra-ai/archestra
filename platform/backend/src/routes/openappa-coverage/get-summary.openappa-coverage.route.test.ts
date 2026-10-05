import config from "@/config";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { beforeEach, describe, expect, test } from "@/test";
import { ruleLine, seedCoverage } from "@/test/openappa-coverage";
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
        notCovered: 0,
        catchAll: 0,
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
      notCovered: 1,
      catchAll: 0,
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
  for (const variant of ["noop", "annotator", "static", "missing"] as const) {
    test(`classifies ${variant} catch-all consistently in summary, filters, and server counts`, async ({
      makeInternalMcpCatalog,
      makeTool,
      makeAgent,
      makeAgentTool,
    }) => {
      const { content, catalogIds } = await seedCoverage({
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
        fixtures: {
          makeInternalMcpCatalog,
          makeTool,
          makeAgent,
          makeAgentTool,
        },
      });
      await makeTool({
        catalogId: catalogIds.linear,
        name: "linear__get_issue",
        rawName: "get_issue",
      });
      const wildcard = '[[policy.tool]]\nname = "*"\nannotator = "noop"';
      const replacement =
        variant === "annotator"
          ? '[[policy.tool]]\nname = "*"\nannotator = "classifier"'
          : variant === "static"
            ? '[[policy.tool]]\nname = "*"\ndelta = { trust = "suspicious" }'
            : variant === "missing"
              ? ""
              : wildcard;
      const policy =
        content.replace(wildcard, replacement) +
        (variant === "annotator"
          ? '\n[[policy.annotator]]\nname = "classifier"\n[externals.annotators.classifier]\nurl = "http://127.0.0.1:9000/classifier"\n'
          : "");
      const latest = await guardrailsPolicyService.get(ctx.organizationId);
      const update = guardrailsPolicyService.update({
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
        content: policy,
        expectedRevision: latest.revision,
      });
      if (variant === "static") {
        await expect(update).rejects.toThrow(
          'the wildcard tool "*" declares static semantics',
        );
        expect((await summary()).totals).toMatchObject({
          catchAll: 0,
          notCovered: 2,
        });
        return;
      }
      await update;
      const covered = variant === "annotator";
      expect((await summary()).totals).toMatchObject({
        root: 2,
        battery: 4,
        catchAll: covered ? 2 : 0,
        notCovered: covered ? 0 : 2,
      });
      const { batteries } = await summary();
      expect(batteries.available).toEqual(
        covered ? [] : [{ name: "linear", servers: ["Linear"], tools: 1 }],
      );
      for (const filter of ["catchall", "not_covered"] as const) {
        const response = await ctx.app.inject({
          method: "GET",
          url: `/api/openappa/coverage/tools?governedBy=${filter}&limit=100`,
        });
        expect(response.statusCode).toBe(200);
        expect(
          response
            .json()
            .data.map((tool: { fullName: string }) => tool.fullName)
            .sort(),
        ).toEqual(
          (filter === "catchall") === covered
            ? ["docs__list_pages", "linear__get_issue"]
            : [],
        );
      }
      const toolResponse = await ctx.app.inject({
        method: "GET",
        url: "/api/openappa/coverage/tools?search=docs__list_pages",
      });
      const tool = toolResponse.json().data[0];
      expect(tool).toMatchObject({
        policySource: covered ? "catchall" : "not_covered",
      });
      if (variant === "missing") expect(tool.rule).toBeNull();
      else
        expect(tool.rule).toMatchObject({
          source: "catchall",
          name: "*",
          line: ruleLine(policy, "*"),
          annotator: variant === "noop" ? "noop" : "classifier",
        });
      const entitiesResponse = await ctx.app.inject({
        method: "GET",
        url: `/api/openappa/coverage/entities?entityId=${catalogIds.docs}`,
      });
      expect(entitiesResponse.json().data[0]).toMatchObject({
        governedCount: covered ? 3 : 2,
        rules: {
          battery: 2,
          catchAll: covered ? 1 : 0,
          notCovered: covered ? 0 : 1,
        },
      });
    });
  }
});
